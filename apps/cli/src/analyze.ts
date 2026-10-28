import { mkdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAiAnalysisError, OpenAiAnalysisProvider, prepareOpenAiAnalysisRequest } from '@git-analyze/providers';
import { analysisCacheKey, loadAnalysisCache, storeAnalysisCache, validateAnalysisResult, type AnalysisSettings } from './analysis-cache.js';
import { identity, loadAnalysisInput, readBoundedJson } from './analysis-input.js';
import { analysisSourceLines, renderAnalysisMarkdown, renderPreviewMarkdown, reserveAnalysisDirectory, saveAnalysisReports } from './analysis-report.js';

function positive(value: string | undefined, fallback?: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error('Analysis token/context/timeout options must be positive bounded integers');
  }
  return Number(value);
}

/** File-only assembly around the provider; fetch injection is for offline integration tests. */
export async function executeAnalyze(args: readonly string[], dependencies: {
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
} = {}) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    input: { type: 'string' }, bindings: { type: 'string' }, excerpt: { type: 'string', multiple: true },
    'redactions-file': { type: 'string' }, model: { type: 'string' }, 'model-epoch': { type: 'string' },
    'context-window': { type: 'string' }, 'max-input-tokens': { type: 'string' }, 'max-output-tokens': { type: 'string' },
    'timeout-ms': { type: 'string' }, 'dry-run': { type: 'boolean' }, output: { type: 'string' },
    'cache-dir': { type: 'string' }, 'no-cache': { type: 'boolean' },
  } });
  if (!values.input?.trim() || !values.bindings?.trim()) throw new Error('analyze requires --input <evidence.json> and --bindings <bindings.json>');
  if (!values.excerpt?.length) throw new Error('analyze requires explicitly reviewed --excerpt <id> selections');
  for (const value of [values.output, values['cache-dir'], values['redactions-file']]) {
    if (value !== undefined && !value.trim()) throw new Error('Analysis file/directory options cannot be empty');
  }
  const settings: AnalysisSettings = { model: identity(values.model), modelEpoch: identity(values['model-epoch']),
    contextWindowTokens: positive(values['context-window']), maxInputTokens: positive(values['max-input-tokens'], 8_000),
    maxOutputTokens: positive(values['max-output-tokens'], 1_000), timeoutMs: positive(values['timeout-ms'], 30_000, 60_000) };
  if (settings.maxOutputTokens > settings.contextWindowTokens) throw new Error('Output reservation exceeds context window');
  const loaded = await loadAnalysisInput(values.input, values.bindings);
  const redactions: unknown = values['redactions-file'] === undefined ? []
    : await readBoundedJson(resolve(values['redactions-file']), 1_048_576);
  if (!Array.isArray(redactions) || redactions.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Redactions file must contain a JSON array of nonempty strings');
  }
  const transmission = { allowedExcerptIds: values.excerpt, redactValues: redactions as string[] };
  const prepared = prepareOpenAiAnalysisRequest(loaded.packet, settings.model, transmission);
  const key = analysisCacheKey(prepared, settings);
  const cacheDirectory = resolve(values['cache-dir'] ?? join('.cache', 'analysis'));
  if (values['dry-run']) {
    const preview = { schemaVersion: 1, status: 'preview', createdAt: new Date().toISOString(), source: loaded.source,
      bindings: loaded.bindings, settings, cacheKey: key, transmission: prepared.receipt,
      countRequest: prepared.body, analysisRequest: { ...prepared.body, max_output_tokens: settings.maxOutputTokens, store: false, stream: false } };
    const directory = await reserveAnalysisDirectory(values.output);
    const files = await saveAnalysisReports(directory, 'preview', preview, renderPreviewMarkdown(loaded.source, prepared));
    return { status: 'preview' as const, externalRequests: 0, cacheKey: key, ...files };
  }

  let locked = false;
  const lockPath = join(cacheDirectory, `${key}.lock`);
  try {
    let result = values['no-cache'] ? null : await loadAnalysisCache(cacheDirectory, key, prepared, settings);
    let cacheHit = result !== null;
    if (!result && !values['no-cache']) {
      await mkdir(cacheDirectory, { recursive: true });
      try { await mkdir(lockPath); locked = true; }
      catch { throw new Error('Analysis cache key is busy or cannot be locked; no external request was sent'); }
      // Another process may have completed between the first read and acquiring the lock.
      result = await loadAnalysisCache(cacheDirectory, key, prepared, settings);
      cacheHit = result !== null;
    }
    const apiKey = (dependencies.env ?? process.env).OPENAI_API_KEY;
    if (!result && (typeof apiKey !== 'string' || !apiKey.trim())) throw new Error('OPENAI_API_KEY is required on an analysis cache miss');
    // Reserve writable output before any paid request; existing results are never overwritten.
    const directory = await reserveAnalysisDirectory(values.output);
    let cacheStored = false;
    if (!result) {
      try {
        const provider = new OpenAiAnalysisProvider({ apiKey: apiKey!, model: settings.model,
          contextWindowTokens: settings.contextWindowTokens, timeoutMs: settings.timeoutMs },
        dependencies.fetch ? { fetch: dependencies.fetch } : {});
        result = validateAnalysisResult(await provider.analyze(loaded.packet, { maxInputTokens: settings.maxInputTokens,
          maxOutputTokens: settings.maxOutputTokens, transmission }), prepared, settings);
      } catch (error) {
        const failure = { schemaVersion: 1, status: 'failed', createdAt: new Date().toISOString(), source: loaded.source,
          settings, cacheKey: key, transmission: prepared.receipt, error: error instanceof OpenAiAnalysisError
            ? { code: error.code, stage: error.stage, usage: error.usage, httpStatus: error.httpStatus,
              validationCode: error.validationCode, countedInputTokens: error.countedInputTokens }
            : { code: 'analysis_failed', usage: null } };
        const files = await saveAnalysisReports(directory, 'failure', failure, ['# 분석 실패', '',
          ...analysisSourceLines(loaded.source), '', `- 오류: ${failure.error.code}`,
          '- 정상 결과 캐시에 저장하지 않았다. 사용량이 null이어도 무과금을 의미하지 않는다.', ''].join('\n'));
        throw new Error(`Analysis failed: ${failure.error.code}. Failure report: ${files.jsonPath}`);
      }
      if (!values['no-cache']) {
        try { await storeAnalysisCache(cacheDirectory, key, result); cacheStored = true; }
        catch { /* The report still preserves a successful paid result; expose the cache-write failure below. */ }
      }
    }
    const report = { schemaVersion: 1, status: 'analyzed', createdAt: new Date().toISOString(), source: loaded.source,
      bindings: loaded.bindings, settings, cache: { hit: cacheHit, stored: cacheStored, key, enabled: !values['no-cache'] },
      transmission: prepared.receipt, sentInput: JSON.parse(prepared.input) as unknown, result };
    const files = await saveAnalysisReports(directory, 'analysis', report,
      renderAnalysisMarkdown(result.value, loaded.source, cacheHit, prepared.receipt.complete));
    return { status: 'analyzed' as const, cacheHit, cacheStored, cacheKey: key,
      externalRequests: cacheHit ? 0 : 2, cacheWarning: !values['no-cache'] && !cacheHit && !cacheStored ? 'cache_write_failed' : null, ...files };
  } finally {
    if (locked) await rmdir(lockPath);
  }
}
