import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANALYSIS_SCHEMA_VERSION, canonicalJson, parseWorkItemAnalysis } from '@git-analyze/core';
import { OPENAI_ANALYSIS_PROMPT_VERSION, OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION,
  type OpenAiAnalysisResult, type prepareOpenAiAnalysisRequest } from '@git-analyze/providers';
import { object, readBoundedJson } from './analysis-input.js';

export const ANALYSIS_CACHE_VERSION = 'local-analysis-cache-v1';
export const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface AnalysisSettings {
  readonly model: string;
  readonly modelEpoch: string;
  readonly contextWindowTokens: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}
type Prepared = ReturnType<typeof prepareOpenAiAnalysisRequest>;
export function analysisCacheKey(prepared: Prepared, settings: AnalysisSettings) {
  return hash({ version: ANALYSIS_CACHE_VERSION, provider: 'openai', ownerId: prepared.validationPacket.ownerId,
    repositoryId: prepared.validationPacket.repositoryId, workItemId: prepared.validationPacket.workItemId,
    transmission: prepared.receipt, settings, confirmationVersion: 'none-v1',
    promptVersion: OPENAI_ANALYSIS_PROMPT_VERSION, schemaVersion: ANALYSIS_SCHEMA_VERSION,
    wireSchemaVersion: OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION, body: prepared.body });
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Revalidate cached output and receipts against this invocation; a digest is corruption detection, not authorization. */
export function validateAnalysisResult(raw: unknown, prepared: Prepared, settings: AnalysisSettings): OpenAiAnalysisResult {
  const result = object(raw);
  const request = object(result.request);
  const usage = object(result.usage);
  if (request.requestedModel !== settings.model || request.promptVersion !== OPENAI_ANALYSIS_PROMPT_VERSION
    || request.analysisSchemaVersion !== ANALYSIS_SCHEMA_VERSION || request.wireSchemaVersion !== OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION
    || request.contextWindowTokens !== settings.contextWindowTokens || request.maxInputTokens !== settings.maxInputTokens
    || request.maxOutputTokens !== settings.maxOutputTokens || !integer(request.countedInputTokens)
    || request.countedInputTokens > settings.maxInputTokens
    || request.countedInputTokens + settings.maxOutputTokens > settings.contextWindowTokens
    || canonicalJson(request.transmission) !== canonicalJson(prepared.receipt)
    || usage.provider !== 'openai' || typeof usage.model !== 'string' || !usage.model.trim() || usage.model.length > 512
    || !integer(usage.inputTokens) || !integer(usage.outputTokens) || !integer(usage.cachedInputTokens)
    || usage.cachedInputTokens > usage.inputTokens || usage.inputTokens > settings.maxInputTokens
    || usage.outputTokens > settings.maxOutputTokens || usage.inputTokens + settings.maxOutputTokens > settings.contextWindowTokens
    || (usage.reasoningTokens !== null && (!integer(usage.reasoningTokens) || usage.reasoningTokens > usage.outputTokens))
    || (usage.requestId !== null && (typeof usage.requestId !== 'string' || usage.requestId.length > 512))) {
    throw new Error('Invalid saved analysis metadata');
  }
  const value = parseWorkItemAnalysis(JSON.stringify(result.value), { packet: prepared.validationPacket });
  // Preserve only the known, validated fields rather than arbitrary cached properties.
  return { value, usage: { provider: 'openai', model: usage.model, inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens as number | null, requestId: usage.requestId as string | null },
  request: { requestedModel: settings.model, promptVersion: OPENAI_ANALYSIS_PROMPT_VERSION,
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION, wireSchemaVersion: OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION,
    contextWindowTokens: settings.contextWindowTokens, maxInputTokens: settings.maxInputTokens,
    maxOutputTokens: settings.maxOutputTokens, countedInputTokens: request.countedInputTokens, transmission: prepared.receipt } };
}

export async function loadAnalysisCache(directory: string, key: string, prepared: Prepared, settings: AnalysisSettings) {
  const path = join(directory, `${key}.json`);
  // Only absence is a miss. Corruption must never silently trigger another paid request.
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot inspect analysis cache');
  }
  try {
    const cache = object(await readBoundedJson(path, 16 * 1024 * 1024));
    if (cache.version !== ANALYSIS_CACHE_VERSION || cache.key !== key || cache.digest !== hash(cache.result)) throw new Error();
    return validateAnalysisResult(cache.result, prepared, settings);
  } catch { throw new Error('Analysis cache is invalid; inspect it or explicitly use --no-cache'); }
}

export async function storeAnalysisCache(directory: string, key: string, result: OpenAiAnalysisResult) {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ version: ANALYSIS_CACHE_VERSION, key, digest: hash(result), result }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, `${key}.json`));
  } finally { await unlink(temporary).catch(() => undefined); }
}
