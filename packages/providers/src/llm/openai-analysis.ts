import OpenAI from 'openai';
import {
  ANALYSIS_SCHEMA_VERSION, AnalysisValidationError, parseWorkItemAnalysis,
  type EvidencePacket, type LlmAnalysisProvider, type LlmAnalysisRequestOptions, type LlmResult,
  type LlmUsage, type WorkItemAnalysis,
} from '@git-analyze/core';
import { ANALYSIS_INSTRUCTIONS, OPENAI_ANALYSIS_PROMPT_VERSION, OPENAI_ANALYSIS_SCHEMA,
  OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION } from './openai-schema.js';
import { prepareAnalysisTransmission, type AnalysisTransmissionReceipt } from './transmission.js';

export type OpenAiAnalysisErrorCode = 'invalid_options' | 'input_budget' | 'context_budget' | 'output_budget'
  | 'http_error' | 'transport_error' | 'timeout' | 'aborted' | 'invalid_response' | 'failed' | 'incomplete' | 'refused' | 'invalid_analysis';
export class OpenAiAnalysisError extends Error {
  constructor(readonly code: OpenAiAnalysisErrorCode, readonly stage: 'count' | 'analysis',
    readonly usage: LlmUsage | null = null, readonly httpStatus: number | null = null,
    readonly validationCode: string | null = null, readonly countedInputTokens: number | null = null) {
    super(`OpenAI analysis failed: ${code} (${stage})`);
    this.name = 'OpenAiAnalysisError';
  }
}

export interface OpenAiAnalysisConfig {
  readonly apiKey: string;
  // No implicit model or context-window assumptions; use a supported model/revision.
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly timeoutMs?: number;
}

export interface OpenAiAnalysisResult extends LlmResult<WorkItemAnalysis> {
  readonly request: {
    readonly requestedModel: string;
    readonly promptVersion: string;
    readonly analysisSchemaVersion: string;
    readonly wireSchemaVersion: string;
    readonly countedInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxInputTokens: number;
    readonly contextWindowTokens: number;
    readonly transmission: AnalysisTransmissionReceipt;
  };
}

function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function readUsage(response: Record<string, unknown>): LlmUsage | null {
  const usage = object(response.usage);
  const cached = object(usage?.input_tokens_details)?.cached_tokens;
  const reasoning = object(usage?.output_tokens_details)?.reasoning_tokens;
  if (!usage || !integer(usage.input_tokens) || !integer(usage.output_tokens) || !integer(cached)
    || cached > usage.input_tokens || !integer(usage.total_tokens)
    || usage.total_tokens !== usage.input_tokens + usage.output_tokens
    || (reasoning !== undefined && (!integer(reasoning) || reasoning > usage.output_tokens))
    || typeof response.model !== 'string' || !response.model.trim()) return null;
  return { provider: 'openai', model: response.model, inputTokens: usage.input_tokens, cachedInputTokens: cached,
    outputTokens: usage.output_tokens, reasoningTokens: reasoning === undefined ? null : reasoning as number,
    requestId: typeof response._request_id === 'string' ? response._request_id : null };
}

/** Pure, offline preparation shared by the CLI preview and the actual requests. */
export function prepareOpenAiAnalysisRequest(packet: EvidencePacket, model: string,
  transmission: LlmAnalysisRequestOptions['transmission']) {
  if (typeof model !== 'string' || !model.trim()) throw new OpenAiAnalysisError('invalid_options', 'count');
  const prepared = prepareAnalysisTransmission(structuredClone(packet), structuredClone(transmission));
  return { ...prepared, body: { model, instructions: ANALYSIS_INSTRUCTIONS,
    input: [{ role: 'user' as const, content: prepared.input }],
    text: { format: { type: 'json_schema' as const, name: 'work_item_analysis', strict: true,
      schema: structuredClone(OPENAI_ANALYSIS_SCHEMA) } }, truncation: 'disabled' as const } };
}

/** One preflight count and at most one generation. Construction/imports never send a request. */
export class OpenAiAnalysisProvider implements LlmAnalysisProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly contextWindowTokens: number;
  private readonly timeoutMs: number;

  constructor(config: OpenAiAnalysisConfig, dependencies: { readonly fetch?: typeof fetch } = {}) {
    const timeoutMs = config.timeoutMs ?? 30_000;
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || typeof config.model !== 'string'
      || !config.model.trim() || !integer(config.contextWindowTokens) || config.contextWindowTokens < 1
      || !integer(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new OpenAiAnalysisError('invalid_options', 'count');
    this.model = config.model;
    this.contextWindowTokens = config.contextWindowTokens;
    this.timeoutMs = timeoutMs;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: 'https://api.openai.com/v1',
      organization: null, project: null, maxRetries: 0, timeout: timeoutMs, logLevel: 'off',
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
  }

  async analyze(packet: EvidencePacket, options: LlmAnalysisRequestOptions): Promise<OpenAiAnalysisResult> {
    const { maxInputTokens, maxOutputTokens, signal: callerSignal } = options;
    if (!integer(maxInputTokens) || maxInputTokens < 1 || !integer(maxOutputTokens) || maxOutputTokens < 1
      || maxOutputTokens > this.contextWindowTokens) throw new OpenAiAnalysisError('invalid_options', 'count');
    // Snapshot before the first await; neither policy nor evidence may change after counting.
    const prepared = prepareOpenAiAnalysisRequest(packet, this.model, options.transmission);
    const { body } = prepared;
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const checkAbort = (stage: 'count' | 'analysis') => {
      if (signal.aborted) throw new OpenAiAnalysisError(callerSignal?.aborted ? 'aborted' : 'timeout', stage);
    };
    const call = async (stage: 'count' | 'analysis', operation: () => Promise<unknown>) => {
      checkAbort(stage);
      try { return await operation(); }
      catch (error) {
        checkAbort(stage);
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new OpenAiAnalysisError('timeout', stage);
        if (error instanceof OpenAI.APIError && integer(error.status)) {
          throw new OpenAiAnalysisError('http_error', stage, null, error.status);
        }
        throw new OpenAiAnalysisError('transport_error', stage);
      }
    };
    const count = object(await call('count', () => this.client.responses.inputTokens.count(body, { signal })));
    checkAbort('count');
    if (count?.object !== 'response.input_tokens' || !integer(count.input_tokens)) throw new OpenAiAnalysisError('invalid_response', 'count');
    const countedInputTokens = count.input_tokens;
    if (countedInputTokens > maxInputTokens) throw new OpenAiAnalysisError('input_budget', 'count', null, null, null, countedInputTokens);
    if (countedInputTokens + maxOutputTokens > this.contextWindowTokens) throw new OpenAiAnalysisError('context_budget', 'count', null, null, null, countedInputTokens);

    const response = object(await call('analysis', () => this.client.responses.create({ ...body,
      max_output_tokens: maxOutputTokens, store: false, stream: false }, { signal })));
    checkAbort('analysis');
    if (!response) throw new OpenAiAnalysisError('invalid_response', 'analysis');
    const usage = readUsage(response);
    if (response.status === 'failed' || response.error != null) throw new OpenAiAnalysisError('failed', 'analysis', usage);
    if (response.status !== 'completed' || response.incomplete_details != null) {
      throw new OpenAiAnalysisError('incomplete', 'analysis', usage);
    }
    if (!Array.isArray(response.output)) throw new OpenAiAnalysisError('invalid_response', 'analysis', usage);
    const messages: Record<string, unknown>[] = [];
    for (const raw of response.output) {
      const item = object(raw);
      if (item?.type === 'reasoning' && (item.status === undefined || item.status === 'completed')) continue;
      if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
        throw new OpenAiAnalysisError('invalid_response', 'analysis', usage);
      }
      if (item.content.some((content) => object(content)?.type === 'refusal')) throw new OpenAiAnalysisError('refused', 'analysis', usage);
      messages.push(item);
    }
    const content = messages.length === 1 ? messages[0]!.content as unknown[] : [];
    const text = content.length === 1 ? object(content[0]) : null;
    if (text?.type !== 'output_text' || typeof text.text !== 'string' || !usage) {
      throw new OpenAiAnalysisError('invalid_response', 'analysis', usage);
    }
    if (usage.inputTokens > maxInputTokens) throw new OpenAiAnalysisError('input_budget', 'analysis', usage);
    if (usage.outputTokens > maxOutputTokens) throw new OpenAiAnalysisError('output_budget', 'analysis', usage);
    if (usage.inputTokens + maxOutputTokens > this.contextWindowTokens) throw new OpenAiAnalysisError('context_budget', 'analysis', usage);
    let value: WorkItemAnalysis;
    try { value = parseWorkItemAnalysis(text.text, { packet: prepared.validationPacket }); }
    catch (error) {
      if (error instanceof AnalysisValidationError) throw new OpenAiAnalysisError('invalid_analysis', 'analysis', usage, null, error.code);
      throw new OpenAiAnalysisError('invalid_analysis', 'analysis', usage);
    }
    return { value, usage, request: { requestedModel: this.model, promptVersion: OPENAI_ANALYSIS_PROMPT_VERSION,
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION, wireSchemaVersion: OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION,
      countedInputTokens, maxInputTokens, maxOutputTokens, contextWindowTokens: this.contextWindowTokens,
      transmission: prepared.receipt } };
  }
}
