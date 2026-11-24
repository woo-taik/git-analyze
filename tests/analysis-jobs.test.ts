import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildLocalEvidence } from '../packages/core/src/index.js';
import { analysisCacheKey, hash, prepareAnalysisRequest, prepareAnalysisSubmission } from '../packages/providers/src/index.js';
import { AnalysisJobStore, createDatabase } from '../packages/database/src/index.js';
import { analysisHandler } from '../apps/worker/src/analysis-handler.js';
import { loadSavedAnalysis } from '../apps/cli/src/saved-analysis.js';
import { loadConfig } from '@git-analyze/config';
import { buildApp } from '../apps/api/src/app.js';

async function fixture() {
  const oid = 'a'.repeat(40);
  const packet = await buildLocalEvidence({ repositoryScope: 'fixture', pathFilter: null,
    selection: { kind: 'manual', title: 'Example', groupId: null, commitOids: [oid] },
    limits: { maxFileBytes: 1000, maxTotalBytes: 5000, maxFiles: 10, includeLowPriority: false },
    commits: [{ available: true, issues: [], selected: {
      original: { oid, parentOids: [], author: { name: 'A', email: 'a@example.com' },
        committer: { name: 'A', email: 'a@example.com' }, authoredAt: '2026-10-26T00:00:00Z',
        committedAt: '2026-10-26T00:00:00Z', observedAt: '2026-10-26T00:00:00Z', message: 'Validate input', files: [] },
      contribution: 'author', decision: 'candidate', reasons: ['author_matched'], issueRefs: [], lowPriorityFiles: [],
    }, changes: [] }], readPatch: async () => { throw new Error('unexpected'); } });
  return { evidence: { schemaVersion: 1, createdAt: '2026-10-26T00:00:00Z', contentVersion: hash(packet), packet,
    source: { inputFile: 'candidates.json', repositoryPath: 'offline', ref: 'main', tipOid: oid,
      startAt: '2026-10-20T00:00:00Z', endAt: '2026-10-27T00:00:00Z' } },
    bindings: { schemaVersion: 1, ownerId: 'owner', repositoryId: 'repo', workItemId: 'work',
      sources: [{ ownerId: 'owner', repositoryId: 'repo', commitOid: oid, sourceRecordId: 'source', sourceVersion: 'v1' }] },
    settings: { provider: 'openai', model: 'fixture', modelEpoch: 'v1', contextWindowTokens: 16000,
      maxInputTokens: 8000, maxOutputTokens: 1000, timeoutMs: 1000 },
    transmission: { allowedExcerptIds: [packet.excerpts[0]!.id], redactValues: [] } };
}
function memoryStore(request: unknown, key: string) {
  const row = { id: randomUUID(), owner_id: 'owner', repository_id: 'repo', work_item_id: 'work',
    request_key: key, request, status: 'queued', lease_token: randomUUID(), result: null as any, error: null as any };
  const store = {
    queued: vi.fn(async () => row.status === 'queued' ? row : undefined),
    claim: vi.fn(async () => { if (row.status !== 'queued') return undefined; row.status = 'running'; return row; }),
    finish: vi.fn(async (_id, _token, status, result, error) => { Object.assign(row, { status, result, error }); }),
  };
  return { row, store: store as unknown as AnalysisJobStore, payload: { ownerId: 'owner', repositoryId: 'repo', targetId: row.id, inputVersion: key } };
}
describe('asynchronous analysis', () => {
  it('previews offline, binds consent to scope and exact request, and rejects foreign origins', async () => {
    const body = await fixture();
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    try {
      const http = app.getHttpAdapter().getInstance();
      const url = '/v1/owners/owner/repositories/repo/work-items/work/analysis-jobs';
      const preview = await http.inject({ method: 'POST', url: url + '/preview', payload: body });
      expect(preview.statusCode).toBe(201);
      expect(preview.json().externalRequests).toBe(0);
      expect((await http.inject({ method: 'POST', url, payload: body })).statusCode).toBe(400);
      expect((await http.inject({ method: 'POST', url, payload: { ...body, confirmedRequestKey: preview.json().cacheKey } })).statusCode).toBe(503);
      expect((await http.inject({ method: 'POST', url: url.replace('/owner/', '/other/') + '/preview', payload: body })).statusCode).toBe(400);
      expect((await http.inject({ method: 'POST', url: url + '/preview', payload: body, headers: { origin: 'https://foreign.example' } })).statusCode).toBe(403);
      const changed = await prepareAnalysisSubmission({ ...body, settings: { ...body.settings, modelEpoch: 'v2' } });
      expect(changed.key).not.toBe(preview.json().cacheKey);
    } finally { await app.close(); }
  });
  it('executes concurrent deliveries once and exports a review-readable self-contained result', async () => {
    const body = await fixture(), request = await prepareAnalysisSubmission(body);
    const { row, store, payload } = memoryStore(request.snapshot, request.key);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith('/input_tokens')) return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      const sent = JSON.parse(JSON.parse(init!.body as string).input[0].content);
      const value = { workItemId: sent.workItemId, inputVersion: sent.inputVersion, problem: [], constraints: [],
        alternatives: [], decision: [], implementation: [], results: [], verification: [], contribution: [], missingQuestions: [] };
      return Response.json({ model: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
    });
    const handler = analysisHandler(store, { OPENAI_API_KEY: 'fixture-key' }, fetch);
    await Promise.all([handler(payload), handler(payload)]);
    expect(row.status, JSON.stringify(row.error)).toBe('succeeded'); expect(fetch).toHaveBeenCalledTimes(2);
    await handler(payload); expect(fetch).toHaveBeenCalledTimes(2);
    const dir = await mkdtemp(join(tmpdir(), 'analysis-job-'));
    try {
      const path = join(dir, 'analysis.json'); await writeFile(path, JSON.stringify(row.result));
      const saved = await loadSavedAnalysis(path);
      expect(saved.bindings.workItemId).toBe('work');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('records missing keys and uncertain transport failures without automatic paid retries', async () => {
    const request = await prepareAnalysisSubmission(await fixture());
    for (const env of [{}, { OPENAI_API_KEY: 'fixture' }]) {
      const { row, store, payload } = memoryStore(request.snapshot, request.key);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('SECRET transport error'); });
      const handler = analysisHandler(store, env, fetch);
      await handler(payload); await handler(payload);
      expect(row.status).toBe('needs_input');
      expect(JSON.stringify(row.error)).not.toContain('SECRET');
      expect(fetch.mock.calls.length).toBe('OPENAI_API_KEY' in env ? 1 : 0);
    }
  });
  it.each(['claude-analysis-prompt-v2', 'claude-analysis-prompt-v3'])('executes the prompt approved at submission (%s)', async promptVersion => {
    const body = await fixture();
    const request = await prepareAnalysisSubmission({ ...body, settings: { ...body.settings, provider: 'claude' } });
    const { promptVersion: storedVersion, ...legacySnapshot } = request.snapshot;
    const prepared = prepareAnalysisRequest(request.loaded.packet, request.settings, request.transmission, promptVersion);
    const key = analysisCacheKey(prepared, request.settings);
    const legacy = promptVersion !== storedVersion;
    const { row, store, payload } = memoryStore(legacy ? legacySnapshot : request.snapshot, key);
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
      const value = { workItemId: prepared.validationPacket.workItemId, inputVersion: prepared.validationPacket.version,
        problem: [], constraints: [], alternatives: [], decision: [], implementation: [],
        results: [], verification: [], contribution: [], missingQuestions: [] };
      return Response.json({ type: 'message', role: 'assistant', model: 'claude-fixture', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(value) }], usage: { input_tokens: 100, output_tokens: 50 } });
    });
    await analysisHandler(store, { ANTHROPIC_API_KEY: 'fixture-key' }, fetch)(payload);
    expect(row.status).toBe('succeeded');
    expect(row.result.result.request.promptVersion).toBe(promptVersion);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(init!.body as string).system).toBe(prepared.body.system);
    }
  });
  it.runIf(Boolean(process.env.GIT_ANALYZE_TEST_DATABASE_URL))('deduplicates DB submissions, isolates scopes and recovers abandoned executions', async () => {
    const db = createDatabase(process.env.GIT_ANALYZE_TEST_DATABASE_URL!);
    const store = new AnalysisJobStore(db.db.$client);
    const scope = { ownerId: randomUUID(), repositoryId: 'repo', workItemId: 'work' };
    try {
      const jobs = await Promise.all([store.submit(scope, 'key', {}), store.submit(scope, 'key', {})]);
      expect(jobs[0]!.id).toBe(jobs[1]!.id);
      expect(await store.get({ ...scope, ownerId: 'other' }, jobs[0]!.id)).toBeUndefined();
      const claimed = await Promise.all([store.claim(jobs[0]!.id, scope, 'key'), store.claim(jobs[0]!.id, scope, 'key')]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
      await db.db.$client.query("UPDATE analysis_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobs[0]!.id]);
      await store.pending();
      expect((await store.get(scope, jobs[0]!.id))!.status).toBe('needs_input');
      expect(await store.claim(jobs[0]!.id, scope, 'key')).toBeUndefined();
    } finally {
      await db.db.$client.query('DELETE FROM analysis_jobs WHERE owner_id=$1', [scope.ownerId]); await db.close();
    }
  });
});

