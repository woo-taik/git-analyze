import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeAnalyze } from '../apps/cli/src/analyze.js';
import { hash } from '../apps/cli/src/analysis-cache.js';
import { loadAnalysisInput, readBoundedJson } from '../apps/cli/src/analysis-input.js';
import { loadSavedAnalysis } from '../apps/cli/src/saved-analysis.js';
import { buildLocalEvidence, canonicalJson, validateLocalEvidencePacket, type LocalEvidencePacket } from '../packages/core/src/index.js';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const oid = 'a'.repeat(40);
let temporaryBase: string;
let root: string;
let local: LocalEvidencePacket;
let input: string;
let bindings: string;
let sequence = 0;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const env = { OPENAI_API_KEY: 'FIXTURE_API_KEY_DO_NOT_SAVE' };

function report(packet: unknown = local) {
  return { schemaVersion: 1, createdAt: '2026-10-26T00:00:00Z',
    source: { inputFile: 'offline-candidates.json', repositoryPath: 'Z:/offline/repository', ref: 'main', tipOid: oid,
      startAt: '2026-10-20T00:00:00Z', endAt: '2026-10-27T00:00:00Z' },
    cache: { hit: false, stored: false, key: 'c'.repeat(64) }, contentVersion: digest(packet), packet };
}
function bindingData() {
  return { schemaVersion: 1, ownerId: 'owner', repositoryId: 'repo', workItemId: 'work',
    sources: [{ ownerId: 'owner', repositoryId: 'repo', commitOid: oid, sourceRecordId: 'source-1', sourceVersion: 'source-v1' }] };
}
async function jsonFile(name: string, value: unknown) {
  const path = join(root, `${name}-${sequence++}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}
function runPaths() {
  const name = `run-${sequence++}`;
  return { output: join(root, name), cache: join(root, `${name}-cache`) };
}
function args(paths: ReturnType<typeof runPaths>, extra: string[] = []) {
  return ['--input', input, '--bindings', bindings, '--excerpt', `git:${oid}:message`,
    '--excerpt', local.excerpts.find((excerpt) => excerpt.path === 'src/app.ts')!.id,
    '--model', 'fixture-model', '--model-epoch', 'fixture-epoch-1', '--context-window', '16000',
    '--output', paths.output, '--cache-dir', paths.cache, ...extra];
}
type Request = { path: string; body: Record<string, any> };
function harness(handler?: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const request: Request = { path: new URL(String(url)).pathname, body: JSON.parse(init!.body as string) };
    requests.push(request);
    if (handler) return handler(request);
    if (request.path.endsWith('/input_tokens')) return Response.json({ object: 'response.input_tokens', input_tokens: 1200 });
    const sent = JSON.parse(request.body.input[0].content);
    const value = { workItemId: sent.workItemId, inputVersion: sent.inputVersion,
      problem: [], constraints: [], alternatives: [], decision: [],
      implementation: [{ id: 'implementation-1', text: '입력 검증 추가 <script> **text**', status: 'source_supported',
        evidence: [sent.excerpts.find((excerpt: { id: string }) => excerpt.id.includes('src%2Fapp.ts')).reference] }],
      results: [], verification: [], contribution: [], missingQuestions: ['테스트 실행 결과가 있나요?'] };
    return Response.json({ model: 'fixture-revision', status: 'completed',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
      usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500, input_tokens_details: { cached_tokens: 500 },
        output_tokens_details: { reasoning_tokens: 100 } } }, { headers: { 'x-request-id': 'fixture-request' } });
  });
  return { fetch, requests };
}

beforeAll(async () => {
  temporaryBase = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryBase, 'git-analyze-analysis-'));
  local = await buildLocalEvidence({ repositoryScope: 'fixture-local', pathFilter: null,
    selection: { kind: 'manual', title: 'PRIVATE_TITLE_NOT_FOR_TRANSMISSION', groupId: null, commitOids: [oid] },
    limits: { maxFileBytes: 1000, maxTotalBytes: 5000, maxFiles: 10, includeLowPriority: false },
    commits: [{ available: true, issues: [], selected: {
      original: { oid, parentOids: [], author: { name: 'Author', email: 'private-author@example.com' },
        committer: { name: 'Committer', email: 'private-committer@example.com' },
        authoredAt: '2026-10-26T00:00:00Z', committedAt: '2026-10-26T00:00:00Z', observedAt: '2026-10-26T00:00:00Z',
        message: '입력 검증 추가\n', files: ['src/app.ts', '.env'].map((path) => ({ path, status: 'A' })) },
      contribution: 'author', decision: 'candidate', reasons: ['author_matched'], issueRefs: [], lowPriorityFiles: [],
    }, changes: ['src/app.ts', '.env'].map((path) => ({ path, status: 'A', oldMode: '000000', newMode: '100644',
      oldOid: '0'.repeat(40), newOid: 'b'.repeat(40) })) }],
    readPatch: async (_commit, file) => ({ complete: true, reason: null,
      text: file.path === '.env' ? '+ENV_SECRET_MUST_STAY_LOCAL\n' : '@@ -0,0 +1 @@\n+validate(input);\n' }),
  });
  input = await jsonFile('evidence', report());
  bindings = await jsonFile('bindings', bindingData());
});
afterAll(async () => {
  if (!root) return;
  if (dirname(root) !== temporaryBase || !basename(root).startsWith('git-analyze-analysis-')) throw new Error('Unsafe test cleanup path');
  await rm(root, { recursive: true, force: true });
});

describe('analysis CLI assembly', () => {
  it('previews the exact sanitized request offline, without a key, Git checkout, or cache', async () => {
    const paths = runPaths();
    const network = harness();
    const result = await executeAnalyze(args(paths, ['--dry-run', '--excerpt', local.excerpts.find((excerpt) => excerpt.path === '.env')!.id]),
      { fetch: network.fetch, env: {} });
    expect(result).toMatchObject({ status: 'preview', externalRequests: 0 });
    expect(network.fetch).not.toHaveBeenCalled();
    const preview = JSON.parse(await readFile(result.jsonPath, 'utf8'));
    expect(preview.transmission.omitted).toContainEqual(expect.objectContaining({ reason: 'sensitive_path' }));
    expect(preview.countRequest.input).toEqual(preview.analysisRequest.input);
    expect(preview.countRequest.text).toEqual(preview.analysisRequest.text);
    expect(JSON.stringify(preview.countRequest)).not.toMatch(/ENV_SECRET|PRIVATE_TITLE|private-author|Z:\/offline/);
    expect(preview.countRequest.instructions).toContain('untrusted evidence data');
    expect(preview.analysisRequest).toMatchObject({ store: false, max_output_tokens: 1000, stream: false });
    expect(preview.source).toMatchObject({ ref: 'main', commitCount: 1, repositoryPath: 'Z:/offline/repository' });
    const markdown = await readFile(result.markdownPath, 'utf8');
    expect(markdown).toContain('    +validate(input);');
    expect(markdown).not.toContain('ENV_SECRET_MUST_STAY_LOCAL');
  });

  it('runs through the real SDK, saves traceable analysis, then reuses it without a key or even token counting', async () => {
    const paths = runPaths();
    const network = harness();
    const first = await executeAnalyze(args(paths), { ...network, env });
    expect(first).toMatchObject({ status: 'analyzed', cacheHit: false, cacheStored: true, externalRequests: 2, cacheWarning: null });
    const second = await executeAnalyze(args({ ...paths, output: `${paths.output}-repeat` }), { ...network, env: {} });
    expect(second).toMatchObject({ cacheHit: true, externalRequests: 0 });
    expect(network.requests.map((request) => request.path)).toEqual(['/v1/responses/input_tokens', '/v1/responses']);
    const saved = JSON.parse(await readFile(first.jsonPath, 'utf8'));
    expect(saved.result).toMatchObject({ usage: { model: 'fixture-revision', requestId: 'fixture-request' },
      value: { inputVersion: saved.transmission.inputVersion } });
    expect(saved.bindings.sources[0].sourceRecordId).toBe('source-1');
    const savedText = await readFile(first.jsonPath, 'utf8');
    expect(savedText).not.toMatch(/FIXTURE_API_KEY_DO_NOT_SAVE|ENV_SECRET_MUST_STAY_LOCAL/);
    const markdown = await readFile(first.markdownPath, 'utf8');
    expect(markdown).toContain('source-1');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).toContain('\\*\\*text\\*\\*');
    const preview = await executeAnalyze(args({ ...paths, output: `${paths.output}-preview` }, ['--dry-run']), { ...network, env: {} });
    const previewJson = JSON.parse(await readFile(preview.jsonPath, 'utf8'));
    expect(previewJson.countRequest).toEqual(network.requests[0]!.body);
    expect(previewJson.analysisRequest).toEqual(network.requests[1]!.body);
  });

  it('does not overwrite an existing output or call the provider when output cannot be reserved', async () => {
    const paths = runPaths();
    await mkdir(paths.output);
    await writeFile(join(paths.output, 'keep.txt'), 'keep');
    const network = harness();
    await expect(executeAnalyze(args(paths), { ...network, env })).rejects.toThrow('Output directory');
    expect(network.fetch).not.toHaveBeenCalled();
    expect(await readFile(join(paths.output, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects malformed packets, stale hashes, and unrelated source mappings before any external call', async () => {
    const network = harness();
    const mutations = [
      (value: any) => { value.packet.commits[0].available = 'true'; },
      (value: any) => { value.packet.selection.commitOids = ['b'.repeat(40)]; value.contentVersion = digest(value.packet); },
      (value: any) => { value.packet.excerpts[0].text = 'changed'; },
      (value: any) => { value.packet.summary.excerptBytes = 0; value.contentVersion = digest(value.packet); },
      (value: any) => { value.packet.excerpts[0].locator = 'fake'; value.contentVersion = digest(value.packet); },
      (value: any) => { value.packet.commits[0].files[0].path = '../outside'; value.contentVersion = digest(value.packet); },
      (value: any) => { value.packet.extractionVersion = 'future'; value.contentVersion = digest(value.packet); },
      (value: any) => { value.packet.complete = true; value.packet.excerpts[0].complete = false; value.contentVersion = digest(value.packet); },
      (value: any) => { value.source.endAt = '2026-10-25T00:00:00Z'; },
      (value: any) => { value.packet.selection.groupId = 'wrong-kind'; value.contentVersion = digest(value.packet); },
    ];
    for (const mutate of mutations) {
      const value = report();
      const copy = structuredClone(value);
      mutate(copy);
      const bad = await jsonFile('bad-evidence', copy);
      await expect(executeAnalyze(args(runPaths(), ['--input', bad]), { ...network, env })).rejects.toThrow();
    }
    const badBindings = bindingData();
    badBindings.sources[0]!.ownerId = 'other-owner';
    const path = await jsonFile('bad-bindings', badBindings);
    await expect(executeAnalyze(args(runPaths(), ['--bindings', path]), { ...network, env })).rejects.toThrow('scope');
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('requires valid explicit selection, credentials on misses, and bounded options', async () => {
    const network = harness();
    await expect(executeAnalyze(args(runPaths()), { ...network, env: {} })).rejects.toThrow('OPENAI_API_KEY');
    for (const extra of [['--excerpt', 'missing'], ['--excerpt', `git:${oid}:message`], ['--context-window', '0'],
      ['--max-output-tokens', '16001'], ['--timeout-ms', '60001'], ['--max-input-tokens', '1.1']]) {
      await expect(executeAnalyze(args(runPaths(), extra), { ...network, env })).rejects.toThrow();
    }
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized, invalid UTF-8 and malformed JSON files without echoing contents', async () => {
    const sentinel = 'DO_NOT_ECHO_FILE_CONTENT';
    const path = join(root, `bad-utf8-${sequence++}`);
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(readBoundedJson(path, 100)).rejects.toThrow('valid UTF-8 JSON');
    await writeFile(path, sentinel);
    await expect(readBoundedJson(path, 10)).rejects.toThrow('10 bytes');
    await expect(readBoundedJson(path, 100)).rejects.not.toThrow(sentinel);
  });

  it('changes cache identity for model epoch, scope, source version, budgets and transmission selection', async () => {
    const paths = runPaths();
    const network = harness();
    const first = await executeAnalyze(args(paths), { ...network, env });
    const cases = [['--model-epoch', 'epoch-2'], ['--model', 'another-fixture'], ['--max-input-tokens', '8100'],
      ['--max-output-tokens', '1100'], ['--context-window', '17000'], ['--timeout-ms', '31000']];
    for (const extra of cases) {
      const result = await executeAnalyze(args({ ...paths, output: `${paths.output}-${sequence++}` }, extra), { ...network, env });
      expect(result).toMatchObject({ cacheHit: false, externalRequests: 2 });
      expect(result.cacheKey).not.toBe(first.cacheKey);
    }
    for (const change of ['owner', 'repo', 'work', 'source']) {
      const data = bindingData();
      if (change === 'owner') { data.ownerId = 'new-owner'; data.sources[0]!.ownerId = data.ownerId; }
      if (change === 'repo') { data.repositoryId = 'new-repo'; data.sources[0]!.repositoryId = data.repositoryId; }
      if (change === 'work') data.workItemId = 'new-work';
      if (change === 'source') data.sources[0]!.sourceVersion = 'source-v2';
      const path = await jsonFile('changed-binding', data);
      const result = await executeAnalyze(args({ ...paths, output: `${paths.output}-${sequence++}` }, ['--bindings', path]), { ...network, env });
      expect(result.cacheHit).toBe(false);
      expect(result.cacheKey).not.toBe(first.cacheKey);
    }
    const alternate = await executeAnalyze(args({ ...paths, output: `${paths.output}-alternate` })
      .filter((value, index, values) => value !== `git:${oid}:message` && !(value === '--excerpt' && values[index + 1] === `git:${oid}:message`)),
    { ...network, env });
    expect(alternate.cacheKey).not.toBe(first.cacheKey);
  });

  it('reuses analysis when only report path, period, or observation metadata changes', async () => {
    const paths = runPaths();
    const network = harness();
    const first = await executeAnalyze(args(paths), { ...network, env });
    const changed = report();
    changed.createdAt = '2026-10-28T00:00:00Z';
    changed.source.startAt = '2026-10-01T00:00:00Z';
    const path = await jsonFile('another-period', changed);
    const next = await executeAnalyze(args({ ...paths, output: `${paths.output}-repeat` }, ['--input', path]), { ...network, env: {} });
    expect(next).toMatchObject({ cacheHit: true, externalRequests: 0, cacheKey: first.cacheKey });
    expect(network.requests).toHaveLength(2);
  });

  it('blocks corrupt or semantically invalid caches without silently billing another request', async () => {
    const paths = runPaths();
    const network = harness();
    const result = await executeAnalyze(args(paths), { ...network, env });
    const cachePath = join(paths.cache, `${result.cacheKey}.json`);
    const original = await readFile(cachePath, 'utf8');
    await writeFile(cachePath, '{broken');
    await expect(executeAnalyze(args({ ...paths, output: `${paths.output}-bad` }), { ...network, env })).rejects.toThrow('cache is invalid');
    const cache = JSON.parse(original);
    cache.result.value.implementation[0].evidence[0].sourceVersion = 'wrong-version';
    cache.digest = hash(cache.result);
    await writeFile(cachePath, JSON.stringify(cache));
    await expect(executeAnalyze(args({ ...paths, output: `${paths.output}-bad-again` }), { ...network, env })).rejects.toThrow('cache is invalid');
    expect(network.requests).toHaveLength(2);
  });

  it('redacts via a file and never persists redaction values or sends excluded source contents', async () => {
    const changed = structuredClone(local);
    (changed.excerpts.find((excerpt) => excerpt.path === 'src/app.ts') as { text: string }).text += '+PRIVATE_VALUE\n';
    (changed.summary as { excerptBytes: number }).excerptBytes += Buffer.byteLength('+PRIVATE_VALUE\n');
    const patch = changed.excerpts.find((excerpt) => excerpt.path === 'src/app.ts')!;
    const oldId = patch.id;
    (patch as { id: string; locator: string }).id = `git:${oid}:src%2Fapp.ts:patch:1-3`;
    (patch as { locator: string }).locator = 'first-parent-patch-lines:1-3';
    (changed.commits[0]!.files.find((file) => file.excerptId === oldId) as { excerptId: string }).excerptId = patch.id;
    const source = await jsonFile('secret-evidence', report(changed));
    const redactions = await jsonFile('redactions', ['PRIVATE_VALUE']);
    const paths = runPaths();
    const network = harness();
    const command = args(paths, ['--input', source, '--redactions-file', redactions]).map((value) => value === oldId ? patch.id : value);
    const saved = await executeAnalyze(command, { ...network, env });
    const serialized = await readFile(saved.jsonPath, 'utf8');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('PRIVATE_VALUE');
    expect(JSON.stringify(network.requests)).not.toMatch(/PRIVATE_VALUE|ENV_SECRET_MUST_STAY_LOCAL/);
    expect(JSON.parse(serialized).transmission).toMatchObject({ complete: false, redactedExcerptIds: [patch.id] });
    const restored = await loadSavedAnalysis(saved.jsonPath);
    expect(restored.baseline.packet.excerpts.some((excerpt) => excerpt.text.includes('[REDACTED]'))).toBe(true);
  });

  it('restores a saved analysis when explicitly selected sensitive paths and empty messages were omitted', async () => {
    const changed = structuredClone(local);
    const message = changed.excerpts.find((excerpt) => excerpt.path === null)!;
    (changed.summary as { excerptBytes: number }).excerptBytes -= Buffer.byteLength(message.text);
    (message as { text: string }).text = '';
    const source = await jsonFile('empty-message', report(changed));
    const network = harness();
    const result = await executeAnalyze(args(runPaths(), ['--input', source,
      '--excerpt', changed.excerpts.find((excerpt) => excerpt.path === '.env')!.id]), { ...network, env });
    const restored = await loadSavedAnalysis(result.jsonPath);
    expect(restored.baseline.packet.excerpts).toHaveLength(1);
    expect(restored.baseline.packet.complete).toBe(false);
  });

  it('saves failures and their usage without putting them into the successful result cache', async () => {
    const paths = runPaths();
    const network = harness(({ path }) => Response.json(path.endsWith('/input_tokens')
      ? { object: 'response.input_tokens', input_tokens: 1200 }
      : { model: 'fixture-revision', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 1200, output_tokens: 1000, total_tokens: 2200, input_tokens_details: { cached_tokens: 0 } } }));
    await expect(executeAnalyze(args(paths), { ...network, env })).rejects.toThrow('incomplete');
    const failure = JSON.parse(await readFile(join(paths.output, 'failure.json'), 'utf8'));
    expect(failure).toMatchObject({ status: 'failed', error: { code: 'incomplete', stage: 'analysis', usage: { outputTokens: 1000 } } });
    const retry = harness();
    const result = await executeAnalyze(args({ ...paths, output: `${paths.output}-retry` }), { ...retry, env });
    expect(result.cacheHit).toBe(false);
    expect(retry.requests).toHaveLength(2);
  });

  it('disables cache reads and writes only when explicitly requested', async () => {
    const paths = runPaths();
    const network = harness();
    for (const output of [paths.output, `${paths.output}-repeat`]) {
      const result = await executeAnalyze(args({ ...paths, output }, ['--no-cache']), { ...network, env });
      expect(result).toMatchObject({ cacheHit: false, cacheStored: false, externalRequests: 2 });
    }
    expect(network.requests).toHaveLength(4);
  });

  it('preserves a paid result and reports a cache-write failure instead of losing the analysis', async () => {
    const paths = runPaths();
    const preview = await executeAnalyze(args({ ...paths, output: `${paths.output}-preview` }, ['--dry-run']), { env: {} });
    const normal = harness();
    const network = harness(async ({ path, body }) => {
      if (!path.endsWith('/input_tokens')) await mkdir(join(paths.cache, `${preview.cacheKey}.json`));
      return normal.fetch(`https://api.openai.com${path}`, { body: JSON.stringify(body) });
    });
    const saved = await executeAnalyze(args(paths), { ...network, env });
    expect(saved).toMatchObject({ cacheStored: false, cacheWarning: 'cache_write_failed', externalRequests: 2 });
    const report = JSON.parse(await readFile(saved.jsonPath, 'utf8'));
    expect(report.result.value.implementation).toHaveLength(1);
  });

  it('rejects concurrent duplicate cache misses before a second external request', async () => {
    const paths = runPaths();
    let release!: () => void;
    let started!: () => void;
    const signal = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const normal = harness();
    const network = harness(async ({ path, body }) => {
      if (path.endsWith('/input_tokens')) {
        started(); await blocked;
        return Response.json({ object: 'response.input_tokens', input_tokens: 1200 });
      }
      return normal.fetch(`https://api.openai.com${path}`, { body: JSON.stringify(body) });
    });
    const first = executeAnalyze(args(paths), { ...network, env });
    await signal;
    try {
      await expect(executeAnalyze(args({ ...paths, output: `${paths.output}-concurrent` }), { ...network, env })).rejects.toThrow('busy');
      expect(network.requests).toHaveLength(1);
    } finally { release(); }
    await first;
  });

  it('exposes analyze in the built Nest CLI and previews offline without leaking source bodies to stdout', async () => {
    const paths = runPaths();
    const result = await execute(process.execPath, ['apps/cli/dist/index.js', 'analyze', ...args(paths, ['--dry-run'])],
      { cwd: projectRoot, env: { ...process.env, OPENAI_API_KEY: '' }, timeout: 15_000, windowsHide: true });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'preview', externalRequests: 0 });
    expect(result.stdout).not.toContain('validate(input)');
    const help = await execute(process.execPath, ['apps/cli/dist/index.js', 'help'], { cwd: projectRoot, windowsHide: true });
    expect(help.stdout).toContain('analyze --input');
    expect(help.stdout).toContain('--dry-run');
  }, 20_000);
});

describe('local evidence runtime validation', () => {
  it('accepts generated packets and returns a detached value', async () => {
    const result = validateLocalEvidencePacket(local);
    expect(result).toEqual(local);
    expect(result).not.toBe(local);
    const loaded = await loadAnalysisInput(input, bindings);
    expect(loaded.packet.provenance.contentVersion).toBe(digest(local));
  });
});
