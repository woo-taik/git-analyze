import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenAiAnalysisResult } from '@git-analyze/providers';
import { object, readBoundedJson } from './analysis-input.js';
import { type prepareAnalysisRequest } from './analysis-runtime.js';

export { ANALYSIS_CACHE_VERSION, hash, analysisCacheKey, validateAnalysisResult } from '@git-analyze/providers';
export type { AnalysisSettings } from '@git-analyze/providers';
import { ANALYSIS_CACHE_VERSION, hash, validateAnalysisResult, type AnalysisSettings } from '@git-analyze/providers';
type Prepared = ReturnType<typeof prepareAnalysisRequest>;
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
