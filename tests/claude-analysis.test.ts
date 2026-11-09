import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildLocalEvidence, toEvidencePacket, type EvidencePacket } from '../packages/core/src/index.js';
import { ClaudeAnalysisProvider } from '../packages/providers/src/index.js';
import { executeAnalyze } from '../apps/cli/src/analyze.js';
import { executeReview } from '../apps/cli/src/review.js';
import { loadSavedAnalysis } from '../apps/cli/src/saved-analysis.js';
import { hash } from '../apps/cli/src/analysis-cache.js';

const oid = 'a'.repeat(40);
const config = { apiKey: 'CLAUDE_KEY_SENTINEL', model: 'claude-fixture', contextWindowTokens: 16000 };
let packet: EvidencePacket;
let input: string;
let bindings: string;
let root: string;
let temporaryBase: string;
let sequence = 0;
const output = () => join(root, `output-${sequence++}`);
const options = () => ({ maxInputTokens: 8000, maxOutputTokens: 2000,
  transmission: { allowedExcerptIds: packet.excerpts.map((excerpt) => excerpt.id) } });

function harness(modify?: (body: any) => unknown, count = 1000) {
  const requests: { url: string; body: any }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: count });
    const sent = JSON.parse(body.messages[0].content);
    const analysis = { workItemId: sent.workItemId, inputVersion: sent.inputVersion, problem: [], constraints: [], alternatives: [], decision: [],
      implementation: [{ id: 'i1', text: '입력 검증을 추가함', status: 'source_supported', evidence: [sent.excerpts[0].reference] }],
      results: [], verification: [], contribution: [], missingQuestions: ['테스트 실행 기록이 있나요?'] };
    let response: any = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture-revision', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(analysis) }], usage: { input_tokens: 1000, cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50, output_tokens: 400, output_tokens_details: { thinking_tokens: 20 } } };
    if (modify) response = modify(response);
    return Response.json(response, { headers: { 'request-id': 'req_claude_fixture' } });
  });
  return { requests, fetch, provider: new ClaudeAnalysisProvider(config, { fetch }) };
}

beforeAll(async () => {
  temporaryBase = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryBase, 'git-analyze-claude-'));
  const local = await buildLocalEvidence({ repositoryScope: 'fixture', pathFilter: null,
    selection: { kind: 'manual', title: 'Fixture', groupId: null, commitOids: [oid] },
    limits: { maxFileBytes: 1000, maxTotalBytes: 5000, maxFiles: 10, includeLowPriority: false },
    commits: [{ available: true, issues: [], selected: { original: { oid, parentOids: [], author: { name: 'Fixture', email: 'fixture@example.com' },
      committer: { name: 'Fixture', email: 'fixture@example.com' }, authoredAt: '2026-10-26T00:00:00Z', committedAt: '2026-10-26T00:00:00Z',
      observedAt: '2026-10-26T00:00:00Z', message: '입력 검증 추가\n', files: [] }, contribution: 'author', decision: 'candidate',
      reasons: ['author_matched'], issueRefs: [], lowPriorityFiles: [] }, changes: [] }],
    readPatch: async () => { throw new Error('No patches'); } });
  const sourceBindings = { schemaVersion: 1, ownerId: 'owner', repositoryId: 'repo', workItemId: 'work',
    sources: [{ ownerId: 'owner', repositoryId: 'repo', commitOid: oid, sourceRecordId: 'record', sourceVersion: oid }] };
  packet = await toEvidencePacket({ ...sourceBindings, packet: local, contentVersion: hash(local) });
  input = join(root, 'evidence.json'); bindings = join(root, 'bindings.json');
  await writeFile(bindings, JSON.stringify(sourceBindings));
  await writeFile(input, JSON.stringify({ schemaVersion: 1, createdAt: '2026-10-26T00:00:00Z', contentVersion: hash(local), packet: local,
    source: { inputFile: 'fixture-candidates.json', repositoryPath: 'Z:/offline-fixture', ref: 'main', tipOid: oid,
      startAt: '2026-10-20T00:00:00Z', endAt: '2026-10-27T00:00:00Z' } }));
});
afterAll(async () => {
  if (!root) return;
  if (dirname(root) !== temporaryBase || !basename(root).startsWith('git-analyze-claude-')) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});

describe('Claude analysis adapter and CLI default', () => {
  it('uses Anthropic count and generation with identical full sanitized inputs and schema, then validates output and inclusive usage', async () => {
    const { provider, requests } = harness();
    const result = await provider.analyze(packet, options());
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/v1/messages/count_tokens', '/v1/messages']);
    expect(requests.every((request) => new URL(request.url).hostname === 'api.anthropic.com')).toBe(true);
    expect(requests[0]!.body.messages).toEqual(requests[1]!.body.messages);
    expect(requests[0]!.body.output_config).toEqual(requests[1]!.body.output_config);
    expect(requests[0]!.body.system).toContain('untrusted evidence data');
    expect(requests[1]!.body.max_tokens).toBe(2000);
    expect(JSON.stringify(requests[1]!.body.output_config)).not.toMatch(/user_confirmed/);
    expect(JSON.stringify(requests[1]!.body)).not.toContain('CLAUDE_KEY_SENTINEL');
    expect(result.usage).toMatchObject({ provider: 'anthropic', inputTokens: 1150, cachedInputTokens: 100,
      cacheCreationInputTokens: 50, reasoningTokens: 20, requestId: 'req_claude_fixture' });
  });

  it('blocks invalid selections and secrets before count, and enforces count budgets before generation', async () => {
    const { provider, requests } = harness();
    await expect(provider.analyze(packet, { ...options(), transmission: { allowedExcerptIds: ['missing'] } })).rejects.toThrow();
    expect(requests).toHaveLength(0);
    await expect(provider.analyze(packet, { ...options(), maxInputTokens: 999 })).rejects.toMatchObject({ code: 'input_budget', stage: 'count' });
    expect(requests).toHaveLength(1);
    const secret = structuredClone(packet);
    Object.assign(secret.excerpts[0]!, { text: `-----BEGIN PRIVATE KEY-----\n` });
    await expect(provider.analyze(secret, options())).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('snapshots model and budgets instead of letting caller mutations change a request', async () => {
    const network = harness();
    const mutable = { ...config };
    const provider = new ClaudeAnalysisProvider(mutable, { fetch: network.fetch });
    mutable.model = 'changed-after-construction'; mutable.contextWindowTokens = 1;
    const result = await provider.analyze(packet, options());
    expect(result.request.requestedModel).toBe(config.model);
    expect(result.request.contextWindowTokens).toBe(config.contextWindowTokens);
    expect(network.requests.every((request) => request.body.model === config.model)).toBe(true);
  });

  it.each(['max_tokens', 'refusal', 'tool_use'])('rejects stop reason %s and preserves billed usage', async (stop_reason) => {
    const { provider } = harness((response) => ({ ...response, stop_reason }));
    await expect(provider.analyze(packet, options())).rejects.toMatchObject({ code: stop_reason === 'refusal' ? 'refused' : 'incomplete',
      usage: { provider: 'anthropic', outputTokens: 400 } });
  });

  it.each(['bad_citation', 'missing_usage', 'tool_block', 'truncated_json', 'excess_usage'])('rejects %s without retrying', async (kind) => {
    const { provider, requests } = harness((response) => {
      if (kind === 'bad_citation') {
        const value = JSON.parse(response.content[0].text); value.implementation[0].evidence[0].sourceVersion = 'wrong'; response.content[0].text = JSON.stringify(value);
      }
      if (kind === 'missing_usage') delete response.usage;
      if (kind === 'tool_block') response.content.push({ type: 'tool_use', id: 'call', name: 'shell', input: {} });
      if (kind === 'truncated_json') response.content[0].text = '{';
      if (kind === 'excess_usage') response.usage.output_tokens = 2001;
      return response;
    });
    await expect(provider.analyze(packet, options())).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it('defaults CLI to Claude, persists compatible review input, and reuses cache with no API key or count', async () => {
    const network = harness();
    const args = ['--input', input, '--bindings', bindings, '--excerpt', packet.excerpts[0]!.id, '--model', 'claude-fixture',
      '--model-epoch', 'fixture-v1', '--context-window', '16000', '--cache-dir', join(root, 'cache')];
    const first = await executeAnalyze([...args, '--output', output()], { ...network, env: { ANTHROPIC_API_KEY: config.apiKey } });
    expect(first).toMatchObject({ cacheHit: false, externalRequests: 2 });
    const restored = await loadSavedAnalysis(first.jsonPath);
    expect(restored.baseline.analysis.implementation).toHaveLength(1);
    const saved = JSON.parse(await readFile(first.jsonPath, 'utf8'));
    expect(saved.settings.provider).toBe('claude');
    expect(saved.result.usage.cacheCreationInputTokens).toBe(50);
    const second = await executeAnalyze([...args, '--output', output()], { ...network, env: {} });
    expect(second).toMatchObject({ cacheHit: true, externalRequests: 0 });
    expect(network.requests).toHaveLength(2);
    const review = await executeReview(['--analysis', first.jsonPath, '--store-dir', join(root, 'reviews'), '--output', output()]);
    expect(review.externalRequests).toBe(0);
    const preview = await executeAnalyze([...args, '--dry-run', '--output', output()], { ...network, env: {} });
    const data = JSON.parse(await readFile(preview.jsonPath, 'utf8'));
    expect(data.countRequest.model).toBe('claude-fixture');
    expect(data.analysisRequest.max_tokens).toBe(6000);
    expect(data.analysisRequest).not.toHaveProperty('max_output_tokens');
  });
});
