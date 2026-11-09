import Anthropic from '@anthropic-ai/sdk';
import { ANALYSIS_CLAIM_FIELDS, ANALYSIS_SCHEMA_VERSION, MAX_ANALYSIS_JSON_BYTES, AnalysisValidationError, canonicalJson, parseWorkItemAnalysis,
  type EvidencePacket, type LlmAnalysisProvider, type LlmAnalysisRequestOptions, type LlmUsage } from '@git-analyze/core';
import { ANALYSIS_INSTRUCTIONS, ANALYSIS_GENERATION_SCHEMA, EXACT_CITATION_INSTRUCTION, NUMBERED_CITATION_SCHEMA } from './analysis-prompt.js';
import type { OpenAiAnalysisErrorCode, OpenAiAnalysisResult } from './openai-analysis.js';
import { prepareAnalysisTransmission } from './transmission.js';

const LEGACY_PROMPT_VERSION = 'claude-analysis-prompt-v1';
export const CLAUDE_ANALYSIS_PROMPT_VERSION = 'claude-analysis-prompt-v2';
export const CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION = 'claude-analysis-wire-v2';
const CLAUDE_ANALYSIS_INSTRUCTIONS = [
  ANALYSIS_INSTRUCTIONS.replace(EXACT_CITATION_INSTRUCTION,
    'In each claim, evidence is a list of distinct integer citationNumber values copied from the supplied excerpts. A source_supported claim must cite at least one excerpt. Never cite an excerpt that does not directly support the claim.'),
  'Write each claim as one short Korean sentence or phrase about one independently reviewable fact. Split distinct changes, effects or evidence into separate claims. Omit redundant claims.',
  'For library or framework settings, describe the exact code change first. Assert runtime semantics only when the supplied evidence directly shows them. A setting name or value alone does not prove an effect.',
  'Keep data freshness, cache retention, and refetch behavior separate. Never equate immediate staleness with disabled caching. If semantics are unproven, report the setting itself and leave any important effect as a question.',
  'Keep code changes, tests added, tests run and observed outcomes in separate claims. Do not combine an observed change with an inferred benefit in a source_supported claim.',
].join('\n');

export type ClaudeAnalysisResult = OpenAiAnalysisResult;
export class ClaudeAnalysisError extends Error {
  constructor(readonly code: OpenAiAnalysisErrorCode, readonly stage: 'count' | 'analysis', readonly usage: LlmUsage | null = null,
    readonly httpStatus: number | null = null, readonly validationCode: string | null = null, readonly countedInputTokens: number | null = null) {
    super(`Claude analysis failed: ${code} (${stage})`); this.name = 'ClaudeAnalysisError';
  }
}
export function prepareClaudeAnalysisRequest(packet: EvidencePacket, model: string, transmission: LlmAnalysisRequestOptions['transmission'],
  promptVersion: string = CLAUDE_ANALYSIS_PROMPT_VERSION) {
  if (typeof model !== 'string' || !model.trim()) throw new ClaudeAnalysisError('invalid_options', 'count');
  if (promptVersion !== LEGACY_PROMPT_VERSION && promptVersion !== CLAUDE_ANALYSIS_PROMPT_VERSION) {
    throw new Error('Unsupported saved Claude prompt version');
  }
  const prepared = prepareAnalysisTransmission(structuredClone(packet), structuredClone(transmission));
  const legacy = promptVersion === LEGACY_PROMPT_VERSION;
  const content = legacy ? prepared.input : canonicalJson({ ...prepared.payload,
    excerpts: prepared.payload.excerpts.map((excerpt, index) => ({ ...excerpt, citationNumber: index + 1 })) });
  return { ...prepared, promptVersion, wireSchemaVersion: legacy ? 'claude-analysis-wire-v1' : CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION,
    body: { model, system: legacy ? ANALYSIS_INSTRUCTIONS : CLAUDE_ANALYSIS_INSTRUCTIONS,
      messages: [{ role: 'user' as const, content }],
      output_config: { format: { type: 'json_schema' as const,
        schema: structuredClone(legacy ? ANALYSIS_GENERATION_SCHEMA : NUMBERED_CITATION_SCHEMA) } } } };
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function expandCitations(raw: string, packet: EvidencePacket): string {
  if (Buffer.byteLength(raw, 'utf8') > MAX_ANALYSIS_JSON_BYTES) throw new AnalysisValidationError('output_limit', '/');
  let value;
  try { value = object(JSON.parse(raw)); }
  catch { throw new AnalysisValidationError('invalid_json', '/'); }
  for (const section of ANALYSIS_CLAIM_FIELDS) {
    const claims = value?.[section];
    if (!Array.isArray(claims)) continue;
    for (const [index, rawClaim] of claims.entries()) {
      const claim = object(rawClaim);
      if (!claim || !Array.isArray(claim.evidence)) continue;
      claim.evidence = claim.evidence.map((number, position) => {
        const excerpt = integer(number) && number > 0 ? packet.excerpts[number - 1] : undefined;
        if (!excerpt) throw new AnalysisValidationError('unknown_evidence', `/${section}/${index}/evidence/${position}`);
        return excerpt.reference;
      });
    }
  }
  return JSON.stringify(value);
}
function usageOf(response: Record<string, unknown>, requestId: string | null): LlmUsage | null {
  const usage = object(response.usage);
  const created = usage?.cache_creation_input_tokens ?? 0;
  const cached = usage?.cache_read_input_tokens ?? 0;
  const thinking = object(usage?.output_tokens_details)?.thinking_tokens ?? null;
  if (!usage || !integer(usage.input_tokens) || !integer(usage.output_tokens) || !integer(created) || !integer(cached)
    || (thinking !== null && (!integer(thinking) || thinking > usage.output_tokens))
    || typeof response.model !== 'string' || !response.model.trim()) return null;
  const inputTokens = usage.input_tokens + created + cached;
  if (!integer(inputTokens)) return null;
  return { provider: 'anthropic', model: response.model, inputTokens, cachedInputTokens: cached, cacheCreationInputTokens: created,
    outputTokens: usage.output_tokens, reasoningTokens: thinking, requestId };
}

/** Same reviewed-evidence boundary as other adapters; only Anthropic is contacted and retries are disabled. */
export class ClaudeAnalysisProvider implements LlmAnalysisProvider {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private readonly config: { readonly apiKey: string; readonly model: string; readonly contextWindowTokens: number; readonly timeoutMs?: number };
  constructor(config: { readonly apiKey: string; readonly model: string; readonly contextWindowTokens: number; readonly timeoutMs?: number },
    dependencies: { readonly fetch?: typeof fetch } = {}) {
    this.config = { ...config };
    this.timeoutMs = config.timeoutMs ?? 60_000;
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || !config.model?.trim() || !integer(config.contextWindowTokens)
      || config.contextWindowTokens < 1 || !integer(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new ClaudeAnalysisError('invalid_options', 'count');
    this.client = new Anthropic({ apiKey: config.apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0,
      timeout: this.timeoutMs, logLevel: 'off', ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
  }
  async analyze(packet: EvidencePacket, options: LlmAnalysisRequestOptions): Promise<ClaudeAnalysisResult> {
    const { maxInputTokens, maxOutputTokens } = options;
    if (!integer(maxInputTokens) || maxInputTokens < 1 || !integer(maxOutputTokens) || maxOutputTokens < 1
      || maxOutputTokens > this.config.contextWindowTokens) throw new ClaudeAnalysisError('invalid_options', 'count');
    const prepared = prepareClaudeAnalysisRequest(packet, this.config.model, options.transmission);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const call = async <T>(stage: 'count' | 'analysis', operation: () => Promise<T>): Promise<T> => {
      try { signal.throwIfAborted(); const value = await operation(); signal.throwIfAborted(); return value; }
      catch (error) {
        if (signal.aborted) throw new ClaudeAnalysisError(options.signal?.aborted ? 'aborted' : 'timeout', stage);
        if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ClaudeAnalysisError('timeout', stage);
        if (error instanceof Anthropic.APIError && integer(error.status)) throw new ClaudeAnalysisError('http_error', stage, null, error.status);
        throw new ClaudeAnalysisError('transport_error', stage);
      }
    };
    const count = object(await call('count', () => this.client.messages.countTokens(prepared.body, { signal })));
    if (!count || !integer(count.input_tokens)) throw new ClaudeAnalysisError('invalid_response', 'count');
    const countedInputTokens = count.input_tokens;
    if (countedInputTokens > maxInputTokens) throw new ClaudeAnalysisError('input_budget', 'count', null, null, null, countedInputTokens);
    if (countedInputTokens + maxOutputTokens > this.config.contextWindowTokens) throw new ClaudeAnalysisError('context_budget', 'count', null, null, null, countedInputTokens);
    const raw = await call('analysis', () => this.client.messages.create({ ...prepared.body, max_tokens: maxOutputTokens, stream: false }, { signal }).withResponse());
    const response = object(raw.data);
    if (!response) throw new ClaudeAnalysisError('invalid_response', 'analysis');
    const usage = usageOf(response, raw.response.headers.get('request-id'));
    if (response.stop_reason === 'refusal') throw new ClaudeAnalysisError('refused', 'analysis', usage);
    if (response.stop_reason !== 'end_turn') throw new ClaudeAnalysisError('incomplete', 'analysis', usage);
    if (response.type !== 'message' || response.role !== 'assistant' || !Array.isArray(response.content) || !usage) throw new ClaudeAnalysisError('invalid_response', 'analysis', usage);
    const text = response.content.filter((block) => object(block)?.type === 'text');
    if (text.length !== 1 || typeof object(text[0])?.text !== 'string'
      || response.content.some((block) => !['text', 'thinking', 'redacted_thinking'].includes(String(object(block)?.type)))) throw new ClaudeAnalysisError('invalid_response', 'analysis', usage);
    if (usage.inputTokens > maxInputTokens) throw new ClaudeAnalysisError('input_budget', 'analysis', usage);
    if (usage.outputTokens > maxOutputTokens) throw new ClaudeAnalysisError('output_budget', 'analysis', usage);
    if (usage.inputTokens + maxOutputTokens > this.config.contextWindowTokens) throw new ClaudeAnalysisError('context_budget', 'analysis', usage);
    let value;
    try { value = parseWorkItemAnalysis(expandCitations(object(text[0])!.text as string, prepared.validationPacket), { packet: prepared.validationPacket }); }
    catch (error) { throw new ClaudeAnalysisError('invalid_analysis', 'analysis', usage, null, error instanceof AnalysisValidationError ? error.code : null); }
    return { value, usage, request: { requestedModel: this.config.model, promptVersion: prepared.promptVersion,
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION, wireSchemaVersion: prepared.wireSchemaVersion,
      countedInputTokens, maxInputTokens, maxOutputTokens, contextWindowTokens: this.config.contextWindowTokens, transmission: prepared.receipt } };
  }
}
