import { object, parseAnalysisInput } from './analysis-input.js';
import { parseAnalysisSettings } from './analysis-execution.js';
import { analysisCacheKey } from './analysis-contract.js';
import { prepareAnalysisRequest, generationRequest, providerMetadata } from './analysis-runtime.js';
import { PREVIOUS_CLAUDE_ANALYSIS_PROMPT_VERSION } from './claude-analysis.js';

/** Accept data, never server-side paths or client credentials. */
export async function prepareAnalysisSubmission(value: unknown, savedRequestKey?: string) {
  const body = object(value);
  const loaded = await parseAnalysisInput(body.evidence, body.bindings, 'api-submission');
  const settings = parseAnalysisSettings(body.settings);
  const policy = object(body.transmission);
  if (!Array.isArray(policy.allowedExcerptIds) || policy.allowedExcerptIds.length < 1
    || policy.allowedExcerptIds.some(v => typeof v !== 'string')
    || (policy.redactValues !== undefined && (!Array.isArray(policy.redactValues)
      || policy.redactValues.some(v => typeof v !== 'string' || !v.trim())))) throw new Error('Invalid transmission');
  const transmission = { allowedExcerptIds: policy.allowedExcerptIds as string[],
    redactValues: (policy.redactValues ?? []) as string[] };
  // Requests stored before prompt pinning used Claude v2. Reconstruct that exact approved request.
  let promptVersion: string | undefined;
  if (savedRequestKey !== undefined) {
    const saved = body.promptVersion;
    if (saved !== undefined && typeof saved !== 'string') throw new Error('Invalid stored prompt version');
    promptVersion = saved ?? PREVIOUS_CLAUDE_ANALYSIS_PROMPT_VERSION;
  }
  const prepared = prepareAnalysisRequest(loaded.packet, settings, transmission, promptVersion);
  const key = analysisCacheKey(prepared, settings);
  if (savedRequestKey !== undefined && key !== savedRequestKey) throw new Error('Stored request key does not match');
  return { loaded, settings, transmission, prepared, key,
    snapshot: { evidence: body.evidence, bindings: loaded.bindings, settings, transmission,
      promptVersion: providerMetadata(prepared).promptVersion },
    preview: { cacheKey: key, transmission: prepared.receipt, countRequest: prepared.body,
      analysisRequest: generationRequest(prepared, settings), externalRequests: 0 } };
}
