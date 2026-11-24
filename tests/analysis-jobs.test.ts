import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildLocalEvidence } from '../packages/core/src/index.js';
import { analysisCacheKey, hash, prepareAnalysisRequest, prepareAnalysisSubmission, restoreJobAnalysis } from '../packages/providers/src/index.js';
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
function claudeResponse(packet: { workItemId: string; version: string }) {
  return vi.fn<typeof globalThis.fetch>(async url => {
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
    const value = { workItemId: packet.workItemId, inputVersion: packet.version,
      problem: [], constraints: [], alternatives: [], decision: [], implementation: [],
      results: [], verification: [], contribution: [], missingQuestions: [] };
    return Response.json({ type: 'message', role: 'assistant', model: 'claude-fixture', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(value) }], usage: { input_tokens: 100, output_tokens: 50 } });
  });
}
describe('asynchronous analysis', () => {
  it('previews offline, binds consent to scope and exact request, and rejects foreign origins', async () => {
    const body = await fixture();
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    try {
      const http = app.getHttpAdapter().getInstance();
      const url = '/v1/owners/owner/repositories/repo/work-items/work/analysis-jobs';
      expect((await http.inject({ method: 'POST', url: url + '/bad-id/review' })).statusCode).toBe(400);
      expect((await http.inject({ method: 'POST', url: url + '/' + randomUUID() + '/review' })).statusCode).toBe(503);
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
  it.each(['claude-analysis-prompt-v2', 'claude-analysis-prompt-v3', 'claude-analysis-prompt-v4'])('executes the prompt approved at submission (%s)', async promptVersion => {
    const body = await fixture();
    const request = await prepareAnalysisSubmission({ ...body, settings: { ...body.settings, provider: 'claude' } });
    const { promptVersion: _storedVersion, ...legacySnapshot } = request.snapshot;
    const prepared = prepareAnalysisRequest(request.loaded.packet, request.settings, request.transmission, promptVersion);
    const key = analysisCacheKey(prepared, request.settings);
    const snapshot = promptVersion === 'claude-analysis-prompt-v2' ? legacySnapshot : { ...request.snapshot, promptVersion };
    const { row, store, payload } = memoryStore(snapshot, key);
    const fetch = claudeResponse(prepared.validationPacket);
    await analysisHandler(store, { ANTHROPIC_API_KEY: 'fixture-key' }, fetch)(payload);
    expect(row.status).toBe('succeeded');
    expect(row.result.result.request.promptVersion).toBe(promptVersion);
    const restored = await restoreJobAnalysis(row.request, key, row.result);
    expect(restored.request.promptVersion).toBe(promptVersion);
    expect(restored.packet).toEqual(prepared.validationPacket);
    await expect(restoreJobAnalysis(row.request, key, { ...row.result, sentInput: {} })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(init!.body as string).system).toBe(prepared.body.system);
    }
  });
  it.runIf(Boolean(process.env.GIT_ANALYZE_TEST_DATABASE_URL))('starts one review from a scoped job and preserves subsequent edits on replay', async () => {
    const databaseUrl = process.env.GIT_ANALYZE_TEST_DATABASE_URL!;
    const db = createDatabase(databaseUrl);
    const store = new AnalysisJobStore(db.db.$client);
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: databaseUrl }));
    const ownerId = randomUUID();
    try {
      const http = app.getHttpAdapter().getInstance();
      const body = await fixture();
      const scope = { ownerId, repositoryId: 'repo', workItemId: 'work' };
      const input = { ...body, settings: { ...body.settings, provider: 'claude' },
        bindings: { ...body.bindings, ownerId, sources: body.bindings.sources.map(source => ({ ...source, ownerId })) },
        transmission: { ...body.transmission, redactValues: ['Validate'] } };
      const workUrl = `/v1/owners/${ownerId}/repositories/repo/work-items/work`;
      const start = (id: string, url = workUrl) => http.inject({ method: 'POST', url: `${url}/analysis-jobs/${id}/review` });
      const request = await prepareAnalysisSubmission(input);
      const job = await store.submit(scope, request.key, request.snapshot);
      expect((await start(job.id)).statusCode).toBe(409);
      for (const url of [workUrl.replace(ownerId, 'other'), workUrl.replace('/repo/', '/other/'), workUrl + '-other']) {
        expect((await start(job.id, url)).statusCode).toBe(404);
      }
      const fetch = claudeResponse(request.prepared.validationPacket);
      const run = analysisHandler(store, { ANTHROPIC_API_KEY: 'fixture' }, fetch);
      await run({ ownerId, repositoryId: 'repo', targetId: job.id, inputVersion: request.key });
      const [first, second] = await Promise.all([start(job.id), start(job.id)]);
      expect(first.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      const initial = first.json();
      expect(initial).toMatchObject({ scope, reviewRevision: 1, externalRequests: 0, review: { events: [], completion: null } });
      expect(initial.evidence).toEqual(request.prepared.validationPacket);
      expect(initial.evidence.excerpts[0].text).toContain('[REDACTED]');
      const detail = await http.inject({ method: 'GET', url: workUrl });
      expect(detail.json().reviewVersion).toBe(initial.reviewVersion);
      const edit = await http.inject({ method: 'POST', url: workUrl + '/review', payload: {
        expectedReviewVersion: initial.reviewVersion, actor: 'author', changes: { schemaVersion: 1, actions: [
          { kind: 'answer', section: 'results', claimId: 'result-1', text: 'Reviewed result', question: null }] } } });
      expect(edit.statusCode).toBe(201);
      expect(edit.json().reviewRevision).toBe(2);
      expect((await start(job.id)).json()).toEqual(edit.json());
      expect(fetch).toHaveBeenCalledTimes(2);
      const other = await prepareAnalysisSubmission({ ...input, settings: { ...input.settings, modelEpoch: 'v2' } });
      const next = await store.submit(scope, other.key, other.snapshot);
      await run({ ownerId, repositoryId: 'repo', targetId: next.id, inputVersion: other.key });
      const conflict = await start(next.id);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().message).toBe('review_already_exists');
      expect((await start(job.id)).json().reviewVersion).toBe(edit.json().reviewVersion);
    } finally {
      await app.close();
      await db.db.$client.query('DELETE FROM analysis_jobs WHERE owner_id=$1', [ownerId]);
      await db.close();
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

