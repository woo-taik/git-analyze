import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateReviewState, type ReviewState } from '@git-analyze/core';
import { hash } from './analysis-cache.js';
import { identity, object, readBoundedJson } from './analysis-input.js';
import { loadSavedAnalysis } from './saved-analysis.js';

export interface ReviewScope { readonly ownerId: string; readonly repositoryId: string; readonly workItemId: string }
export interface StoredReview {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly previousVersion: string | null;
  readonly analysisFile: string;
  readonly analysisVersion: string;
  readonly state: ReviewState;
}
export function reviewScope(value: unknown): ReviewScope {
  const input = object(value);
  return { ownerId: identity(input.ownerId), repositoryId: identity(input.repositoryId), workItemId: identity(input.workItemId) };
}
export function reviewDirectory(root: string, scope: ReviewScope): string { return join(resolve(root), hash(scope)); }
const version = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function withReviewLock<T>(root: string, scope: ReviewScope, operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = reviewDirectory(root, scope);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.lock');
  try { await mkdir(lock); }
  catch { throw new Error('Review is busy or cannot be locked'); }
  try { return await operation(directory); }
  finally { await rmdir(lock); }
}

export async function loadStoredReview(directory: string, scope: ReviewScope) {
  const headFile = join(directory, 'HEAD.json');
  try { await lstat(headFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot inspect review head');
  }
  const head = object(await readBoundedJson(headFile, 4096));
  if (!version(head.version) || !Number.isSafeInteger(head.revision) || (head.revision as number) < 1) throw new Error('Invalid review head');
  const value = object(await readBoundedJson(join(directory, `${head.version}.json`), 32 * 1024 * 1024));
  if (hash(value) !== head.version || value.schemaVersion !== 1 || value.revision !== head.revision
    || (value.revision === 1 ? value.previousVersion !== null : !version(value.previousVersion))
    || typeof value.analysisFile !== 'string' || !version(value.analysisVersion)) throw new Error('Invalid review version');
  const saved = await loadSavedAnalysis(value.analysisFile);
  if (saved.analysisVersion !== value.analysisVersion || hash(reviewScope(saved.packet)) !== hash(scope)) throw new Error('Review baseline has changed');
  const context = { ...saved.baseline, analysisVersion: saved.analysisVersion };
  const state = validateReviewState(value.state, context);
  const stored: StoredReview = { schemaVersion: 1, revision: head.revision as number, previousVersion: value.previousVersion as string | null,
    analysisFile: saved.analysisFile, analysisVersion: saved.analysisVersion, state };
  return { version: head.version, stored, saved, context };
}

export async function persistReview(directory: string, previous: Awaited<ReturnType<typeof loadStoredReview>>,
  analysisFile: string, analysisVersion: string, state: ReviewState) {
  const stored: StoredReview = { schemaVersion: 1, revision: (previous?.stored.revision ?? 0) + 1,
    previousVersion: previous?.version ?? null, analysisFile, analysisVersion, state };
  const json = JSON.stringify(stored);
  if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('Review store limit reached');
  const version = hash(stored);
  const versionFile = join(directory, `${version}.json`);
  try { await writeFile(versionFile, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch (error) {
    // A crash between the immutable write and HEAD publication may leave this exact candidate behind.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || hash(await readBoundedJson(versionFile, 32 * 1024 * 1024)) !== version) throw new Error('Cannot persist an intact review version');
  }
  const temporary = join(directory, `HEAD.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ version, revision: stored.revision }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'HEAD.json'));
  } finally { await unlink(temporary).catch(() => undefined); }
  return { version, stored };
}
