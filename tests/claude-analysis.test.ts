import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildLocalEvidence, LEGACY_EVIDENCE_MAPPING_VERSION, toEvidencePacket, type EvidencePacket } from '../packages/core/src/index.js';
import { CLAUDE_ANALYSIS_PROMPT_VERSION, CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION, ClaudeAnalysisProvider,
  prepareClaudeAnalysisRequest } from '../packages/providers/src/index.js';
import { executeAnalyze } from '../apps/cli/src/analyze.js';
import { renderAnalysisMarkdown } from '../apps/cli/src/analysis-report.js';
import { executeReview } from '../apps/cli/src/review.js';
import { loadSavedAnalysis } from '../apps/cli/src/saved-analysis.js';
import { analysisCacheKey, hash } from '../apps/cli/src/analysis-cache.js';

const oid = 'a'.repeat(40);
const config = { apiKey: 'CLAUDE_KEY_SENTINEL', model: 'claude-fixture', contextWindowTokens: 16000 };
let packet: EvidencePacket;
let legacyPacket: EvidencePacket;
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
      implementation: [{ id: 'i1', text: '입력 검증을 추가함', status: 'source_supported', evidence: [sent.excerpts[0].citationNumber] }],
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
  legacyPacket = await toEvidencePacket({ ...sourceBindings, packet: local, contentVersion: hash(local),
    mappingVersion: LEGACY_EVIDENCE_MAPPING_VERSION });
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
  it('preserves the released v5 request body and key and requires evidence in the new wire schema', () => {
    const settings = { provider: 'claude' as const, model: config.model, modelEpoch: 'fixture-v1', contextWindowTokens: 16000,
      maxInputTokens: 12000, maxOutputTokens: 6000, timeoutMs: 60000 };
    const transmission = options().transmission;
    const v5 = prepareClaudeAnalysisRequest(legacyPacket, settings.model, transmission, 'claude-analysis-prompt-v5');
    const v6 = prepareClaudeAnalysisRequest(legacyPacket, settings.model, transmission, 'claude-analysis-prompt-v6');
    const v7 = prepareClaudeAnalysisRequest(packet, settings.model, transmission);
    // Fingerprints recorded from the released v5 request for this fixture.
    expect(hash(v5.body)).toBe('53882f8981e30d9484b3a5da488cb6da28287e5018f72001b4220113d9f5df6b');
    expect(analysisCacheKey(v5, settings)).toBe('c22ef686d00f4bf9e8fe49762d5373573531a1d972ff4d8e3cdcce19cf94ddf5');
    expect(v6.promptVersion).toBe('claude-analysis-prompt-v6');
    expect(v6.wireSchemaVersion).toBe(v5.wireSchemaVersion);
    expect(v6.body.messages).toEqual(v5.body.messages);
    expect(v6.body.output_config).toEqual(v5.body.output_config);
    expect(analysisCacheKey(v6, settings)).not.toBe(analysisCacheKey(v5, settings));
    expect(v7.promptVersion).toBe(CLAUDE_ANALYSIS_PROMPT_VERSION);
    expect(v7.wireSchemaVersion).toBe(CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION);
    expect(v7.body.system).toBe(v6.body.system);
    const branch = (v7.body.output_config.format.schema.$defs as {
      claim: { anyOf: { properties: { status: { enum: string[] }; evidence: { minItems?: number } } }[] };
    }).claim.anyOf;
    expect(branch.find(item => item.properties.status.enum[0] === 'source_supported')?.properties.evidence.minItems).toBe(1);
    expect(branch.find(item => item.properties.status.enum[0] === 'inferred')?.properties.evidence.minItems).toBeUndefined();
  });

  it('normalizes repeated numbers after validating them while retaining required evidence and raw limits', async () => {
    const citations = (numbers: number[]) => harness(response => {
      const value = JSON.parse(response.content[0].text);
      value.implementation[0].evidence = numbers;
      response.content[0].text = JSON.stringify(value);
      return response;
    }).provider.analyze(packet, options());
    expect((await citations([1, 1])).value.implementation[0]?.evidence).toEqual([packet.excerpts[0]!.reference]);
    await expect(citations([1, 0, 1])).rejects.toMatchObject({
      validationCode: 'unknown_evidence', validationPath: '/implementation/0/evidence/1',
    });
    await expect(citations([])).rejects.toMatchObject({ validationRule: 'minItems' });
    await expect(citations(Array(21).fill(1))).rejects.toMatchObject({ validationRule: 'maxItems' });
  });

  it('asks v6 to ground the headline quantity or fall back to observable behavior', () => {
    const { body: { system } } = prepareClaudeAnalysisRequest(packet, config.model, options().transmission);
    expect(system).toContain('directly tied to the current change');
    expect(system).toContain('same measured target, unit, scope and comparable conditions');
    expect(system).toContain('A documented delta alone is sufficient; never reconstruct missing totals');
    expect(system).toContain('If evidence records only one local run, say so in the sentence');
    expect(system).toContain('both the old and new counts of a relevant behavior');
    expect(system).toContain('do not infer zero from missing context');
    expect(system).toContain('Keep a generic library benchmark, estimated size, earlier unrelated measurement and rollout target out of metric-1');
    expect(system).toContain('When the work only documents an earlier experiment, report the documentation change');
    expect(system).toContain('give metric-1 status missing with no evidence. Use effect-1 for the observable, source-supported behavior');
    expect(system).toContain('Do not infer a language or character class');
    expect(system).not.toContain('give the name, BEFORE numeral, AFTER numeral');
  });

  it('uses Anthropic count and generation with identical full sanitized inputs and schema, then validates output and inclusive usage', async () => {
    const { provider, requests } = harness();
    const result = await provider.analyze(packet, options());
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/v1/messages/count_tokens', '/v1/messages']);
    expect(requests.every((request) => new URL(request.url).hostname === 'api.anthropic.com')).toBe(true);
    expect(requests[0]!.body.messages).toEqual(requests[1]!.body.messages);
    expect(requests[0]!.body.output_config).toEqual(requests[1]!.body.output_config);
    expect(requests[0]!.body.system).toEqual(requests[1]!.body.system);
    expect(requests[0]!.body.system).toContain('untrusted evidence data');
    expect(requests[0]!.body.system).toContain('one independently reviewable fact');
    expect(requests[0]!.body.system).toContain('Never equate immediate staleness with disabled caching');
    expect(result.request.promptVersion).toBe(CLAUDE_ANALYSIS_PROMPT_VERSION);
    expect(result.value.implementation[0]!.evidence).toEqual([packet.excerpts[0]!.reference]);
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
        const value = JSON.parse(response.content[0].text); value.implementation[0].evidence = [packet.excerpts.length + 1]; response.content[0].text = JSON.stringify(value);
      }
      if (kind === 'missing_usage') delete response.usage;
      if (kind === 'tool_block') response.content.push({ type: 'tool_use', id: 'call', name: 'shell', input: {} });
      if (kind === 'truncated_json') response.content[0].text = '{';
      if (kind === 'excess_usage') response.usage.output_tokens = 2001;
      return response;
    });
    if (kind === 'bad_citation') {
      await expect(provider.analyze(packet, options())).rejects.toMatchObject({ code: 'invalid_analysis', validationCode: 'unknown_evidence' });
    } else {
      await expect(provider.analyze(packet, options())).rejects.toThrow();
    }
    expect(requests).toHaveLength(2);
  });

  it('defaults CLI to Claude, persists compatible review input, and reuses cache with no API key or count', async () => {
    const effect = '입력 검증 항목을 0개에서 1개로 늘렸다.';
    const network = harness(response => {
      const value = JSON.parse(response.content[0].text);
      value.problem = [
        { id: 'problem-1', text: '입력 검증이 없었다.', status: 'source_supported', evidence: [1] },
        { id: 'cause-1', text: '검증 함수가 호출되지 않았다.', status: 'inferred', evidence: [1] },
      ];
      value.alternatives = [
        { id: 'alternative-1', text: '분석상 대안으로 별도 검증 계층을 둘 수 있다.', status: 'inferred', evidence: [1] },
        { id: 'tradeoff-1', text: '분석상 검증을 공용화할 수 있지만 호출 위치가 추가된다.', status: 'inferred', evidence: [1] },
      ];
      value.decision = [{ id: 'decision-1', text: '잘못된 입력을 먼저 걸러내도록\n요청 시점에 검증한다.',
        status: 'source_supported', evidence: [1] }];
      value.results = [
        { id: 'effect-2', text: '응답 시간이 개선됐을 수 있다.', status: 'inferred', evidence: [] },
        { id: 'effect-1', text: '입력 검증을 추가했다.', status: 'source_supported', evidence: [1] },
        { id: 'metric-1', text: effect, status: 'source_supported', evidence: [1] },
      ];
      response.content[0].text = JSON.stringify(value);
      return response;
    });
    const args = ['--input', input, '--bindings', bindings, '--excerpt', packet.excerpts[0]!.id, '--model', 'claude-fixture',
      '--model-epoch', 'fixture-v1', '--context-window', '16000', '--cache-dir', join(root, 'cache')];
    const first = await executeAnalyze([...args, '--output', output()], { ...network, env: { ANTHROPIC_API_KEY: config.apiKey } });
    expect(first).toMatchObject({ cacheHit: false, externalRequests: 2, impactSummary: effect });
    const markdown = await readFile(first.markdownPath, 'utf8');
    expect(markdown.trimEnd().split('\n')).toEqual([
      `- **${effect}**`, '- 잘못된 입력을 먼저 걸러내도록 요청 시점에 검증한다.',
    ]);
    const restored = await loadSavedAnalysis(first.jsonPath);
    expect(restored.baseline.analysis.implementation).toHaveLength(1);
    const saved = JSON.parse(await readFile(first.jsonPath, 'utf8'));
    expect(saved.settings.provider).toBe('claude');
    expect(saved.result.usage.cacheCreationInputTokens).toBe(50);
    const second = await executeAnalyze([...args, '--output', output()], { ...network, env: {} });
    expect(second).toMatchObject({ cacheHit: true, externalRequests: 0, impactSummary: effect });
    expect(await readFile(second.markdownPath, 'utf8')).toBe(markdown);
    expect(network.requests).toHaveLength(2);
    const review = await executeReview(['--analysis', first.jsonPath, '--store-dir', join(root, 'reviews'), '--output', output()]);
    expect(review.externalRequests).toBe(0);
    const preview = await executeAnalyze([...args, '--dry-run', '--output', output()], { ...network, env: {} });
    const data = JSON.parse(await readFile(preview.jsonPath, 'utf8'));
    expect(data.countRequest.model).toBe('claude-fixture');
    expect(data.analysisRequest.max_tokens).toBe(6000);
    expect(data.analysisRequest).not.toHaveProperty('max_output_tokens');

    expect(JSON.parse(data.countRequest.messages[0].content).excerpts[0].citationNumber).toBe(1);
    const currentKey = saved.cache.key;
    const legacyFile = join(root, 'legacy-analysis.json');
    expect(data.countRequest.system).toContain('one or two short Korean sentences in total');
    for (const [legacyVersion, citationNumber] of [['claude-analysis-prompt-v1', undefined], ['claude-analysis-prompt-v2', 1],
      ['claude-analysis-prompt-v3', 1], ['claude-analysis-prompt-v4', 1], ['claude-analysis-prompt-v5', 1], ['claude-analysis-prompt-v6', 1]] as const) {
      const legacy = prepareClaudeAnalysisRequest(packet, config.model, options().transmission, legacyVersion);
      expect(JSON.parse(legacy.body.messages[0]!.content).excerpts[0].citationNumber).toBe(citationNumber);
      const legacyKey = analysisCacheKey(legacy, saved.settings);
      expect(legacyKey).not.toBe(currentKey);
      saved.result.request.promptVersion = legacyVersion;
      saved.result.request.wireSchemaVersion = legacy.wireSchemaVersion;
      saved.cache.key = legacyKey;
      await writeFile(legacyFile, JSON.stringify(saved));
      const loaded = await loadSavedAnalysis(legacyFile);
      expect(loaded.baseline).toEqual(restored.baseline);
      if (legacyVersion === 'claude-analysis-prompt-v5') {
        expect(renderAnalysisMarkdown(loaded.baseline.analysis, loaded.source, false, loaded.baseline.packet.complete, true, legacyVersion))
          .toContain(`> **효과 한 줄** — ${effect}`);
      }
    }
    saved.result.request.promptVersion = CLAUDE_ANALYSIS_PROMPT_VERSION;
    saved.result.request.wireSchemaVersion = CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION;
    await writeFile(legacyFile, JSON.stringify(saved));
    await expect(loadSavedAnalysis(legacyFile)).rejects.toThrow('cache identity does not match');
  });

  it('renders the supported change when the metric is missing and a benchmark belongs to another scope', async () => {
    const effect = '현재 변경에서 입력을 검증하도록 했다.';
    const network = harness(response => {
      const value = JSON.parse(response.content[0].text);
      value.verification = [{
        id: 'verification-1', text: '별도 라이브러리 비교에서 gzip 차이는 약 14 KB였다.', status: 'source_supported', evidence: [1],
      }];
      value.results = [
        { id: 'metric-1', text: '현재 작업의 전후 측정치는 없다.', status: 'missing', evidence: [] },
        { id: 'effect-1', text: effect, status: 'source_supported', evidence: [1] },
      ];
      value.implementation = [];
      response.content[0].text = JSON.stringify(value);
      return response;
    });
    const args = ['--input', input, '--bindings', bindings, '--excerpt', packet.excerpts[0]!.id, '--model', 'claude-fixture',
      '--model-epoch', 'fixture-v6', '--context-window', '16000', '--no-cache', '--output', output()];
    const result = await executeAnalyze(args, { ...network, env: { ANTHROPIC_API_KEY: config.apiKey } });
    expect(result).toMatchObject({ impactSummary: effect });
    expect(await readFile(result.markdownPath, 'utf8')).toBe(`- **${effect}**\n`);
  });
});
