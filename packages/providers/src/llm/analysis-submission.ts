import { object, parseAnalysisInput } from './analysis-input.js';
import { parseAnalysisSettings } from './analysis-execution.js';
import { analysisCacheKey } from './analysis-contract.js';
import { prepareAnalysisRequest, generationRequest } from './analysis-runtime.js';

/** Accept data, never server-side paths or client credentials. */
export async function prepareAnalysisSubmission(value: unknown) {
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
  const prepared = prepareAnalysisRequest(loaded.packet, settings, transmission);
  const key = analysisCacheKey(prepared, settings);
  return { loaded, settings, transmission, prepared, key,
    snapshot: { evidence: body.evidence, bindings: loaded.bindings, settings, transmission },
    preview: { cacheKey: key, transmission: prepared.receipt, countRequest: prepared.body,
      analysisRequest: generationRequest(prepared, settings), externalRequests: 0 } };
}
