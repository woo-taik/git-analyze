import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildLocalEvidence, type ReviewAction } from '../packages/core/src/index.js';
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
function claudeResponse(packet: { workItemId: string; version: string }, fields: Record<string, unknown> = {}) {
  return vi.fn<typeof globalThis.fetch>(async url => {
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
    const value = { workItemId: packet.workItemId, inputVersion: packet.version,
      problem: [], constraints: [], alternatives: [], decision: [], implementation: [],
      results: [], verification: [], contribution: [], missingQuestions: [], ...fields };
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
      const rebaseUrl = `${url}/${randomUUID()}/review/rebase`;
      const rebaseInput = { expectedReviewVersion: 'a'.repeat(64), actor: 'author' };
      const missing = await http.inject({ method: 'POST', url: rebaseUrl });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().message).toBe('invalid_review_request');
      for (const [payload, message] of [
        [{ ...rebaseInput, unexpected: true }, 'invalid_review_request'],
        [{ ...rebaseInput, expectedReviewVersion: 'A'.repeat(64) }, 'invalid_review_version'],
        [{ ...rebaseInput, actor: ' ' }, 'invalid_identifier'],
      ] as const) {
        const invalid = await http.inject({ method: 'POST', url: rebaseUrl, payload });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().message).toBe(message);
      }
      expect((await http.inject({ method: 'POST', url: rebaseUrl, payload: rebaseInput })).statusCode).toBe(503);
      expect((await http.inject({ method: 'POST', url: rebaseUrl, payload: rebaseInput,
        headers: { origin: 'https://foreign.example' } })).statusCode).toBe(403);
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
  it.runIf(Boolean(process.env.GIT_ANALYZE_TEST_DATABASE_URL))('rebases a scoped review once and preserves its history and user drafts', async () => {
    const databaseUrl = process.env.GIT_ANALYZE_TEST_DATABASE_URL!;
    const db = createDatabase(databaseUrl);
    const store = new AnalysisJobStore(db.db.$client);
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: databaseUrl }));
    const ownerId = randomUUID();
    const scope = { ownerId, repositoryId: 'repo', workItemId: 'work' };
    try {
      const http = app.getHttpAdapter().getInstance();
      const body = await fixture();
      const workUrl = `/v1/owners/${ownerId}/repositories/repo/work-items/work`;
      const jobUrl = (id: string) => `${workUrl}/analysis-jobs/${id}/review`;
      const rebase = (id: string, expectedReviewVersion: string, actor = 'reviewer') => http.inject({ method: 'POST',
        url: `${jobUrl(id)}/rebase`, payload: { expectedReviewVersion, actor } });
      const edit = (expectedReviewVersion: string, actions: ReviewAction[]) => http.inject({ method: 'POST',
        url: `${workUrl}/review`, payload: { expectedReviewVersion, actor: 'author', changes: { schemaVersion: 1, actions } } });
      const resume = (version: string) => http.inject({ method: 'GET',
        url: `${workUrl}/resume?claim=implementation-1&claim=result-1&claim=contribution-1&reviewVersion=${version}` });
      const question = 'Was the result checked?';
      const initialClaims = { implementation: [{ id: 'implementation-1', text: 'Validated input', status: 'source_supported', evidence: [1] }],
        missingQuestions: [question] };
      async function submit(epoch: string, sourceVersion: string, claims: Record<string, unknown> = initialClaims) {
        const request = await prepareAnalysisSubmission({ ...body, settings: { ...body.settings, provider: 'claude', modelEpoch: epoch },
          bindings: { ...body.bindings, ownerId, sources: body.bindings.sources.map(source => ({ ...source, ownerId, sourceVersion })) } });
        const job = await store.submit(scope, request.key, request.snapshot);
        const fetch = claudeResponse(request.prepared.validationPacket, claims);
        return { job, request, fetch };
      }
      async function run({ job, request, fetch }: Awaited<ReturnType<typeof submit>>) {
        await analysisHandler(store, { ANTHROPIC_API_KEY: 'fixture' }, fetch)({ ...scope, targetId: job.id, inputVersion: request.key });
        const stored = await store.get(scope, job.id);
        expect(stored?.status, JSON.stringify(stored?.error)).toBe('succeeded');
      }

      const original = await submit('v1', 'source-v1');
      const sameAnalysis = await submit('v2', 'source-v1');
      const next = await submit('v3', 'source-v2', { ...initialClaims,
        implementation: [{ ...initialClaims.implementation[0]!, text: 'New model description' }] });
      const later = await submit('v4', 'source-v3');
      const collision = await submit('v5', 'source-v4', { implementation: [], results: initialClaims.implementation });
      const firstVersion = 'a'.repeat(64);
      const pending = await rebase(next.job.id, firstVersion);
      expect(pending.statusCode).toBe(409);
      expect(pending.json().message).toBe('analysis_job_not_succeeded');
      await Promise.all([original, sameAnalysis, next, later, collision].map(run));
      const absent = await rebase(next.job.id, firstVersion);
      expect(absent.statusCode).toBe(404);
      expect(absent.json().message).toBe('archived_work_not_found');
      const foreign = await http.inject({ method: 'POST', url: `${jobUrl(next.job.id).replace(ownerId, 'other')}/rebase`,
        payload: { expectedReviewVersion: firstVersion, actor: 'reviewer' } });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().message).toBe('analysis_job_not_found');

      const opened = await http.inject({ method: 'POST', url: jobUrl(original.job.id) });
      expect(opened.statusCode).toBe(200);
      const initial = opened.json();
      const edited = await edit(initial.reviewVersion, [
        { kind: 'edit', claimId: 'implementation-1', text: 'Verified input guard' },
        { kind: 'confirm', claimId: 'implementation-1', text: 'Verified input guard' },
        { kind: 'answer', section: 'results', claimId: 'result-1', text: 'Checked the result', question },
        { kind: 'confirm', claimId: 'result-1', text: 'Checked the result' },
        { kind: 'answer', section: 'contribution', claimId: 'contribution-1', text: 'Implemented input validation', question: null },
        { kind: 'confirm', claimId: 'contribution-1', text: 'Implemented input validation' },
        { kind: 'completion', status: 'completed', completedAt: '2026-10-26T00:00:00Z', note: 'Checked completion' },
      ]);
      expect(edited.statusCode).toBe(201);
      const approved = edited.json();
      expect(approved.review).toMatchObject({ completion: { status: 'completed' }, analysis: { missingQuestions: [] } });
      expect((await resume(approved.reviewVersion)).statusCode).toBe(200);
      const unchanged = await rebase(sameAnalysis.job.id, approved.reviewVersion);
      expect(unchanged.statusCode).toBe(409);
      expect(unchanged.json().message).toBe('review_analysis_unchanged');
      const stale = await rebase(next.job.id, initial.reviewVersion);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().message).toBe('review_version_changed');
      const movedClaim = await rebase(collision.job.id, approved.reviewVersion);
      expect(movedClaim.statusCode).toBe(422);
      expect(movedClaim.json().message).toBe('review_changes_rejected');

      const [first, second] = await Promise.all([rebase(next.job.id, approved.reviewVersion), rebase(next.job.id, approved.reviewVersion)]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      const rebased = first.json();
      expect(second.json()).toEqual(rebased);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(rebased).toMatchObject({ scope, reviewRevision: 3, externalRequests: 0, review: {
        completion: null, answers: approved.review.answers,
        analysis: { missingQuestions: [question],
          implementation: [{ id: 'implementation-1', text: 'Verified input guard', status: 'inferred', evidence: [] }],
          results: [{ id: 'result-1', text: 'Checked the result', status: 'inferred', evidence: [] }] },
      } });
      expect(rebased.evidence).toEqual(next.request.prepared.validationPacket);
      expect(rebased.review.confirmations).toEqual(approved.review.confirmations.map((record: object) => ({ ...record, status: 'revoked' })));
      expect(rebased.review.events.slice(0, -1)).toEqual(approved.review.events);
      expect(rebased.review.events.at(-1)).toMatchObject({ actor: 'reviewer', action: { kind: 'rebase' } });
      expect((await resume(approved.reviewVersion)).statusCode).toBe(409);
      expect((await resume(rebased.reviewVersion)).statusCode).toBe(422);
      expect((await rebase(next.job.id, approved.reviewVersion, 'other reviewer')).statusCode).toBe(409);
      expect((await rebase(later.job.id, approved.reviewVersion)).statusCode).toBe(409);

      const [rebaseRace, editRace] = await Promise.all([rebase(later.job.id, rebased.reviewVersion),
        edit(rebased.reviewVersion, [{ kind: 'edit', claimId: 'implementation-1', text: 'Concurrent edit' }])]);
      const won = rebaseRace.statusCode === 200 ? rebaseRace : editRace;
      expect([rebaseRace.statusCode, editRace.statusCode]).toEqual(rebaseRace.statusCode === 200 ? [200, 409] : [409, 201]);
      expect(won.json().reviewRevision).toBe(4);
      expect((await rebase(next.job.id, approved.reviewVersion)).json()).toEqual(rebased);
      const detail = await http.inject({ method: 'GET', url: workUrl });
      expect(detail.json().reviewVersion).toBe(won.json().reviewVersion);
      const fromPreviousAnalysis = await rebase(original.job.id, detail.json().reviewVersion);
      expect(fromPreviousAnalysis.statusCode).toBe(200);
      expect(fromPreviousAnalysis.json()).toMatchObject({ reviewRevision: 5, evidence: initial.evidence, externalRequests: 0 });

      const { rows } = await db.db.$client.query(`SELECT r.revision, r.version, r.previous_version, r.snapshot_version, r.payload->'state' AS review
        FROM work_review_versions r JOIN work_items w ON w.id=r.work_item_id JOIN owners o ON o.id=w.owner_id
        WHERE o.external_id=$1 ORDER BY r.revision`, [ownerId]);
      expect(rows.map(row => row.revision)).toEqual([1, 2, 3, 4, 5]);
      expect(rows.map(row => row.previous_version)).toEqual([null, initial.reviewVersion, approved.reviewVersion, rebased.reviewVersion,
        detail.json().reviewVersion]);
      expect(rows[1]?.review).toEqual(approved.review);
      expect(rows[2]?.snapshot_version).not.toBe(rows[1]?.snapshot_version);
      expect(rows[4]?.snapshot_version).toBe(rows[0]?.snapshot_version);
      for (const result of [original, sameAnalysis, next, later, collision]) expect(result.fetch).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
      await db.db.$client.query('DELETE FROM analysis_jobs WHERE owner_id=$1', [ownerId]);
      await db.close();
    }
  }, 15_000);
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

