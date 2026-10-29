import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeAnalyze } from '../apps/cli/src/analyze.js';
import { executeReview } from '../apps/cli/src/review.js';
import { executeResume } from '../apps/cli/src/resume.js';
import { loadSavedAnalysis } from '../apps/cli/src/saved-analysis.js';
import { hash } from '../apps/cli/src/analysis-cache.js';
import { loadStoredReview, persistReview, reviewDirectory } from '../apps/cli/src/review-store.js';
import { applyReviewChanges, buildLocalEvidence, composeResumeBullet, createReviewState, parseReviewChanges,
  validateReviewState, type ReviewAction } from '../packages/core/src/index.js';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const oid = 'a'.repeat(40);
const question = '실제 테스트 실행 결과는 무엇인가요?';
const actor = { actor: 'fixture-user', recordedAt: '2026-10-29T00:00:00Z' };
let temporaryBase: string;
let root: string;
let analysisFile: string;
let alternateFile: string;
let redactedFile: string;
let sequence = 0;
let saved: Awaited<ReturnType<typeof loadSavedAnalysis>>;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function save(value: unknown) {
  const path = join(root, `input-${sequence++}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}
const output = () => join(root, `output-${sequence++}`);
const store = () => join(root, `store-${sequence++}`);
function context() { return { ...saved.baseline, analysisVersion: saved.analysisVersion }; }
const confirm = (claimId: string, text: string): ReviewAction => ({ kind: 'confirm', claimId, text });
const approvals: ReviewAction[] = [
  { kind: 'answer', section: 'results', claimId: 'user-result', text: '동시 요청 10건에서 주문 생성 1건을 확인함', question },
  confirm('user-result', '동시 요청 10건에서 주문 생성 1건을 확인함'),
  confirm('contribution-1', '멱등성 처리 구현을 담당함'),
  { kind: 'completion', status: 'completed', completedAt: '2026-10-26T03:00:00+09:00', note: '검증 결과와 반영 완료를 직접 확인함' },
];
async function review(storeDirectory: string, actions?: readonly ReviewAction[], extra: string[] = []) {
  return executeReview(['--analysis', analysisFile, '--store-dir', storeDirectory, '--output', output(),
    ...(actions ? ['--changes', await save({ schemaVersion: 1, actions }), '--actor', 'fixture-user'] : []), ...extra]);
}
async function resume(reviewFile: string, extra: string[] = []) {
  return executeResume(['--review', reviewFile, '--claim', 'problem-1', '--claim', 'implementation-1',
    '--claim', 'user-result', '--claim', 'contribution-1', '--output', output(), ...extra]);
}

beforeAll(async () => {
  temporaryBase = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryBase, 'git-analyze-review-'));
  const local = await buildLocalEvidence({ repositoryScope: 'fixture-local', pathFilter: null,
    selection: { kind: 'manual', title: 'Fixture', groupId: null, commitOids: [oid] },
    limits: { maxFileBytes: 1000, maxTotalBytes: 5000, maxFiles: 10, includeLowPriority: false },
    commits: [{ available: true, issues: [], selected: { original: { oid, parentOids: [], author: { name: 'Fixture', email: 'fixture@example.com' },
      committer: { name: 'Fixture', email: 'fixture@example.com' }, authoredAt: '2026-10-26T00:00:00Z', committedAt: '2026-10-26T00:00:00Z',
      observedAt: '2026-10-26T00:00:00Z', message: '중복 주문 방지\n', files: [{ path: 'src/app.ts', status: 'A' }] },
      contribution: 'author', decision: 'candidate', reasons: ['author_matched'], issueRefs: [], lowPriorityFiles: [] },
    changes: [{ path: 'src/app.ts', status: 'A', oldMode: '000000', newMode: '100644', oldOid: '0'.repeat(40), newOid: 'b'.repeat(40) }] }],
    readPatch: async () => ({ text: '@@ -0,0 +1 @@\n+deduplicate(input); // PRIVATE_SENTINEL\n', complete: true, reason: null }),
  });
  const evidence = await save({ schemaVersion: 1, createdAt: '2026-10-26T00:00:00Z', contentVersion: hash(local), packet: local,
    cache: { hit: false, key: 'c'.repeat(64), stored: false },
    source: { inputFile: 'fixture-candidates.json', repositoryPath: 'Z:/offline/fixture', ref: 'main', tipOid: oid,
      startAt: '2026-10-20T00:00:00Z', endAt: '2026-10-27T00:00:00Z' } });
  const bindings = await save({ schemaVersion: 1, ownerId: 'owner', repositoryId: 'repo', workItemId: 'work',
    sources: [{ ownerId: 'owner', repositoryId: 'repo', commitOid: oid, sourceRecordId: 'source-1', sourceVersion: 'source-v1' }] });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/input_tokens')) return Response.json({ object: 'response.input_tokens', input_tokens: 1200 });
    const body = JSON.parse(init!.body as string);
    const sent = JSON.parse(body.input[0].content);
    const reference = sent.excerpts.find((excerpt: { id: string }) => excerpt.id.includes('src%2Fapp.ts')).reference;
    const value = { workItemId: sent.workItemId, inputVersion: sent.inputVersion,
      problem: [{ id: 'problem-1', text: '동시 요청에서 중복 주문이 발생함.', status: 'source_supported', evidence: [reference] }],
      constraints: [], alternatives: [], decision: [],
      implementation: [{ id: 'implementation-1', text: '멱등성 키 기반 중복 검사를 구현함.', status: 'source_supported', evidence: [reference] }],
      results: [{ id: 'result-missing', text: '실행 결과 확인 필요', status: 'missing', evidence: [] }], verification: [],
      contribution: [{ id: 'contribution-1', text: '멱등성 처리 구현을 담당함', status: 'inferred', evidence: [reference] }], missingQuestions: [question] };
    return Response.json({ model: 'fixture-revision', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500,
      input_tokens_details: { cached_tokens: 0 } } });
  });
  for (const [epoch, redact] of [['v1', false], ['v2', false], ['v1', true]] as const) {
    const redactions = redact ? await save(['PRIVATE_SENTINEL']) : null;
    const result = await executeAnalyze(['--input', evidence, '--bindings', bindings,
      ...local.excerpts.flatMap((excerpt) => ['--excerpt', excerpt.id]), '--model', 'fixture-model', '--model-epoch', epoch,
      '--context-window', '16000', '--output', output(), '--cache-dir', join(root, 'analysis-cache'),
      ...(redactions ? ['--redactions-file', redactions] : [])], { fetch, env: { OPENAI_API_KEY: 'FIXTURE_KEY' } });
    if (redact) redactedFile = result.jsonPath;
    else if (epoch === 'v1') analysisFile = result.jsonPath;
    else alternateFile = result.jsonPath;
  }
  saved = await loadSavedAnalysis(analysisFile);
}, 20_000);
afterAll(async () => {
  if (!root) return;
  if (dirname(root) !== temporaryBase || !basename(root).startsWith('git-analyze-review-')) throw new Error('Unsafe cleanup path');
  await rm(root, { recursive: true, force: true });
});

describe('review and sentence domain policy', () => {
  it('keeps answers unconfirmed until their exact text is explicitly confirmed and reopens revoked questions', () => {
    const initial = createReviewState(context());
    const draft = applyReviewChanges(initial, [approvals[0]!], context(), actor);
    expect(draft.analysis.missingQuestions).toEqual([question]);
    expect(draft.analysis.results.at(-1)?.status).toBe('inferred');
    const confirmed = applyReviewChanges(draft, [approvals[1]!], context(), actor);
    expect(confirmed.analysis.missingQuestions).toEqual([]);
    const revoked = applyReviewChanges(confirmed, [{ kind: 'revoke', confirmationId: confirmed.confirmations[0]!.id }], context(), actor);
    expect(revoked.analysis.missingQuestions).toEqual([question]);
    expect(revoked.confirmations[0]?.status).toBe('revoked');
    expect(initial.events).toHaveLength(0);
  });

  it('composes exactly selected authorized text and maps every sentence span back to a claim', () => {
    const state = applyReviewChanges(createReviewState(context()), approvals, context(), actor);
    const ids = ['problem-1', 'implementation-1', 'user-result', 'contribution-1'];
    const bullet = composeResumeBullet(state, context(), ids);
    expect(bullet.text).toBe('동시 요청에서 중복 주문이 발생함; 멱등성 키 기반 중복 검사를 구현함; 동시 요청 10건에서 주문 생성 1건을 확인함; 멱등성 처리 구현을 담당함.');
    for (const clause of bullet.clauses) expect(bullet.text.slice(clause.start, clause.end)).toBe(clause.text);
    expect(bullet.clauses[2]?.confirmationId).toBe(state.confirmations[0]?.id);
    expect(() => composeResumeBullet(state, context(), ['implementation-1', 'contribution-1'])).toThrow('completion_and_result');
    expect(() => composeResumeBullet(state, context(), [...ids, 'result-missing'])).toThrow('unconfirmed');
  });

  it('refuses unapproved personal contribution, missing completion, invalid dates, multi-sentence claims, and wrong scope', () => {
    const initial = createReviewState(context());
    expect(() => composeResumeBullet(initial, context(), ['implementation-1', 'contribution-1'], 'activity')).toThrow();
    const approved = applyReviewChanges(initial, approvals.slice(0, 3), context(), actor);
    expect(() => composeResumeBullet(approved, context(), ['implementation-1', 'user-result', 'contribution-1'])).toThrow('completion_and_result');
    expect(composeResumeBullet(approved, context(), ['implementation-1', 'contribution-1'], 'activity').kind).toBe('activity');
    expect(() => applyReviewChanges(initial, [{ ...approvals[3]!, completedAt: 'not-a-date' } as ReviewAction], context(), actor)).toThrow('completion_date');
    expect(() => applyReviewChanges(initial, [confirm('contribution-1', '문구 바꾸기')], context(), actor)).toThrow('text_mismatch');
    const edited = applyReviewChanges(approved, [{ kind: 'edit', claimId: 'implementation-1', text: '첫 문장. 다른 문장.' },
      confirm('implementation-1', '첫 문장. 다른 문장.')], context(), actor);
    expect(() => composeResumeBullet(edited, context(), ['implementation-1', 'contribution-1'], 'activity')).toThrow('multiple_sentences');
    expect(() => validateReviewState(approved, { ...context(), packet: { ...context().packet, ownerId: 'another' } })).toThrow('scope');
    const tampered = structuredClone(approved) as any;
    tampered.confirmations[0].text = '위조 확인 문구';
    expect(() => validateReviewState(tampered, context())).toThrow('confirmation_history');
  });

  it('rejects malformed actions and discards every mutation when a later action in the batch fails', () => {
    expect(() => parseReviewChanges({ schemaVersion: 1, actions: [{ kind: 'confirm', claimId: 'a', text: 'b', approval: true }] })).toThrow();
    expect(() => parseReviewChanges({ schemaVersion: 1, actions: [] })).toThrow();
    const initial = createReviewState(context());
    expect(() => applyReviewChanges(initial, [approvals[0]!, confirm('unknown', 'x')], context(), actor)).toThrow();
    expect(initial.analysis.results).toHaveLength(1);
    expect(initial.events).toHaveLength(0);
  });

  it('withdrawing completion blocks an achievement while still permitting a verified activity draft', () => {
    const approved = applyReviewChanges(createReviewState(context()), approvals, context(), actor);
    const withdrawn = applyReviewChanges(approved, [{ kind: 'completion', status: 'unknown', completedAt: null, note: '완료 판단 재검토' }], context(), actor);
    expect(() => composeResumeBullet(withdrawn, context(), ['implementation-1', 'user-result', 'contribution-1'])).toThrow('completion_and_result');
    expect(composeResumeBullet(withdrawn, context(), ['implementation-1', 'contribution-1'], 'activity').kind).toBe('activity');
    expect(approved.completion?.status).toBe('completed');
  });
});

describe('offline review persistence and export', () => {
  it('can publish an intact orphaned version after a failed HEAD update without overwriting history', async () => {
    const directory = join(root, `orphan-${sequence++}`);
    await mkdir(directory);
    await mkdir(join(directory, 'HEAD.json'));
    const initial = createReviewState(context());
    await expect(persistReview(directory, null, saved.analysisFile, saved.analysisVersion, initial)).rejects.toThrow();
    await rmdir(join(directory, 'HEAD.json'));
    const retried = await persistReview(directory, null, saved.analysisFile, saved.analysisVersion, initial);
    const restored = await loadStoredReview(directory, { ownerId: 'owner', repositoryId: 'repo', workItemId: 'work' });
    expect(restored?.version).toBe(retried.version);
    expect(restored?.stored.revision).toBe(1);
  });
  it('runs analysis → review → sentence with traceable user confirmation and Git references', async () => {
    const storeDirectory = store();
    const first = await review(storeDirectory);
    expect(first).toMatchObject({ revision: 1, externalRequests: 0, unresolvedQuestions: 1 });
    const approved = await review(storeDirectory, approvals);
    expect(approved).toMatchObject({ revision: 2, unresolvedQuestions: 0 });
    const result = await resume(approved.jsonPath);
    expect(result).toMatchObject({ status: 'resume_draft', kind: 'achievement', externalRequests: 0 });
    const report = await json(result.jsonPath);
    expect(report.trace[0].evidence[0]).toMatchObject({ commitOid: oid, path: 'src/app.ts', reference: { sourceRecordId: 'source-1' } });
    expect(report.trace[2].confirmation.event).toMatchObject({ actor: 'fixture-user', action: { kind: 'confirm' } });
    expect(report.review.events).toHaveLength(4);
    expect(report.bullet.text).not.toContain('실행 결과 확인 필요');
    const repeated = await resume(approved.jsonPath);
    expect(repeated.version).toBe(result.version);
    expect(await readFile(result.markdownPath, 'utf8')).toContain('문장 근거');
    expect((await json(first.jsonPath)).state.analysis.results).toHaveLength(1);
  });

  it('makes old review snapshots stale after revocation and blocks the revoked claim in a fresh report', async () => {
    const storeDirectory = store();
    const approved = await review(storeDirectory, approvals);
    const beforeRevoke = await resume(approved.jsonPath);
    const original = await json(approved.jsonPath);
    const confirmationId = original.state.confirmations[0].id;
    const revoked = await review(storeDirectory, [{ kind: 'revoke', confirmationId }]);
    await expect(resume(approved.jsonPath)).rejects.toThrow('stale');
    await expect(resume(revoked.jsonPath)).rejects.toThrow('unconfirmed');
    const refreshed = await review(storeDirectory, [confirm('user-result', '동시 요청 10건에서 주문 생성 1건을 확인함')]);
    const result = await resume(refreshed.jsonPath);
    expect(result.version).not.toBe(beforeRevoke.version);
    const current = await json(refreshed.jsonPath);
    expect(current.state.confirmations).toHaveLength(3);
    expect(current.state.confirmations[0].status).toBe('revoked');
  });

  it('revokes an old confirmation on edits and preserves edited drafts across changed analysis inputs', async () => {
    const storeDirectory = store();
    const approved = await review(storeDirectory, [...approvals,
      { kind: 'edit', claimId: 'implementation-1', text: '사용자 편집 구현 설명 <script>' },
      confirm('implementation-1', '사용자 편집 구현 설명 <script>')]);
    const original = await json(approved.jsonPath);
    // A different model epoch alone has the same analysis/input version and does not erase review state.
    const same = await review(storeDirectory, undefined, ['--analysis', alternateFile]);
    expect(same.version).toBe(approved.version);
    // A changed transmission version requires an explicit rebase and drops approvals while retaining user text.
    await expect(review(storeDirectory, undefined, ['--analysis', redactedFile])).rejects.toThrow('use --rebase');
    const rebased = await review(storeDirectory, undefined, ['--analysis', redactedFile, '--rebase', '--actor', 'fixture-user']);
    const next = await json(rebased.jsonPath);
    expect(next.state.analysis.implementation[0]).toMatchObject({ text: '사용자 편집 구현 설명 <script>', status: 'inferred' });
    expect(next.state.analysis.results.at(-1)).toMatchObject({ id: 'user-result', status: 'inferred' });
    expect(next.state.confirmations.every((record: { status: string }) => record.status === 'revoked')).toBe(true);
    expect(next.state.completion).toBeNull();
    expect(next.state.analysis.missingQuestions).toEqual([question]);
    expect(next.state.events.length).toBe(original.state.events.length + 1);
    expect(await readFile(rebased.markdownPath, 'utf8')).toContain('&lt;script&gt;');
    await expect(resume(approved.jsonPath)).rejects.toThrow('stale');
  });

  it('rejects changed source inputs, tampered versions, busy stores and failed batches without updating the review head', async () => {
    const storeDirectory = store();
    const approved = await review(storeDirectory, approvals);
    const directory = reviewDirectory(storeDirectory, { ownerId: 'owner', repositoryId: 'repo', workItemId: 'work' });
    const head = await readFile(join(directory, 'HEAD.json'), 'utf8');
    await expect(review(storeDirectory, [{ kind: 'edit', claimId: 'implementation-1', text: '수정' }, confirm('missing', '실패')])).rejects.toThrow();
    expect(await readFile(join(directory, 'HEAD.json'), 'utf8')).toBe(head);
    const report = await json(analysisFile);
    report.result.value.inputVersion = 'f'.repeat(64);
    const corruptAnalysis = await save(report);
    await expect(review(storeDirectory, undefined, ['--analysis', corruptAnalysis])).rejects.toThrow();
    await mkdir(join(directory, '.lock'));
    await expect(resume(approved.jsonPath)).rejects.toThrow('busy');
    await rmdir(join(directory, '.lock'));
    const versionFile = join(directory, `${approved.version}.json`);
    const original = await readFile(versionFile, 'utf8');
    await writeFile(versionFile, '{broken');
    await expect(resume(approved.jsonPath)).rejects.toThrow();
    await writeFile(versionFile, original);
    const ok = await resume(approved.jsonPath);
    expect(ok.status).toBe('resume_draft');
  });

  it('rejects saved masking or citation modifications and reads authentic sanitized analyses without secret values', async () => {
    const authentic = await loadSavedAnalysis(redactedFile);
    expect(authentic.baseline.packet.excerpts.some((excerpt) => excerpt.text.includes('[REDACTED]'))).toBe(true);
    const report = await json(redactedFile);
    const patch = report.sentInput.excerpts.find((excerpt: { id: string }) => excerpt.id.includes('src%2Fapp.ts'));
    patch.text = 'invented result [REDACTED]';
    await expect(loadSavedAnalysis(await save(report))).rejects.toThrow();
    const citation = await json(analysisFile);
    citation.result.value.implementation[0].evidence[0].sourceVersion = 'unrelated';
    await expect(loadSavedAnalysis(await save(citation))).rejects.toThrow();
  });

  it('does not overwrite review or sentence output and requires an actor for user actions', async () => {
    const storeDirectory = store();
    const approved = await review(storeDirectory, approvals);
    const used = dirname(approved.jsonPath);
    await expect(review(storeDirectory, [confirm('problem-1', '동시 요청에서 중복 주문이 발생함.')], ['--output', used])).rejects.toThrow('already exists');
    const refreshed = await review(storeDirectory);
    expect(refreshed.version).toBe(approved.version);
    await expect(executeReview(['--analysis', analysisFile, '--changes', await save({ schemaVersion: 1, actions: approvals })])).rejects.toThrow('--actor');
    await expect(resume(approved.jsonPath, ['--output', used])).rejects.toThrow('already exists');
  });

  it('supports review and resume from the built Nest CLI without any API key', async () => {
    const reviewOutput = output();
    const storeDirectory = store();
    const changed = await save({ schemaVersion: 1, actions: approvals });
    const env = { ...process.env, OPENAI_API_KEY: '' };
    const first = await run(process.execPath, ['apps/cli/dist/index.js', 'review', '--analysis', analysisFile,
      '--changes', changed, '--actor', 'fixture-user', '--store-dir', storeDirectory, '--output', reviewOutput],
    { cwd: projectRoot, env, timeout: 15_000, windowsHide: true });
    expect(JSON.parse(first.stdout)).toMatchObject({ status: 'reviewed', externalRequests: 0 });
    const last = await run(process.execPath, ['apps/cli/dist/index.js', 'resume', '--review', join(reviewOutput, 'review.json'),
      '--claim', 'implementation-1', '--claim', 'user-result', '--claim', 'contribution-1', '--output', output()],
    { cwd: projectRoot, env, timeout: 15_000, windowsHide: true });
    expect(JSON.parse(last.stdout)).toMatchObject({ status: 'resume_draft', externalRequests: 0 });
    expect(last.stdout).not.toContain('중복 주문');
  }, 30_000);
});
