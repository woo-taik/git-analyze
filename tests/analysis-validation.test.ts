import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ANALYSIS_CLAIM_FIELDS, AnalysisValidationError, buildLocalEvidence, canonicalJson, MAX_ANALYSIS_JSON_BYTES,
  parseWorkItemAnalysis, toEvidencePacket, validateWorkItemAnalysis, WORK_ITEM_ANALYSIS_SCHEMA,
  type ClaimConfirmation, type EvidencePacket,
} from '../packages/core/src/index.js';

let packet: EvidencePacket;

beforeAll(async () => {
  const oid = 'a'.repeat(40);
  const local = await buildLocalEvidence({ repositoryScope: 'local-fixture', pathFilter: null,
    selection: { kind: 'manual', title: 'fixture', groupId: null, commitOids: [oid] },
    limits: { maxFileBytes: 1_000, maxTotalBytes: 2_000, maxFiles: 10, includeLowPriority: false },
    commits: [{ available: true, changes: [], issues: [], selected: {
      original: { oid, parentOids: [], author: { name: 'Me', email: 'me@example.com' },
        committer: { name: 'Me', email: 'me@example.com' }, authoredAt: '2026-10-26T00:00:00Z',
        committedAt: '2026-10-26T00:00:00Z', observedAt: '2026-10-26T00:00:00Z',
        message: '요청별 입력 검증 추가\n', files: [] }, contribution: 'author', decision: 'candidate',
      reasons: ['author_matched'], issueRefs: [], lowPriorityFiles: [],
    } }], readPatch: async () => { throw new Error('No files in this fixture'); },
  });
  packet = await toEvidencePacket({ ownerId: 'owner', repositoryId: 'repo', workItemId: 'work', packet: local,
    contentVersion: createHash('sha256').update(canonicalJson(local)).digest('hex'), sources: [
      { ownerId: 'owner', repositoryId: 'repo', commitOid: oid, sourceRecordId: 'record', sourceVersion: 'source-v1' },
    ] });
});

const sourceClaim = () => ({ id: 'implementation-1', text: '요청별 입력 검증을 추가했다.',
  status: 'source_supported', evidence: [structuredClone(packet.excerpts[0]!.reference)] });
const valid = () => ({ workItemId: packet.workItemId, inputVersion: packet.version,
  problem: [], constraints: [], alternatives: [], decision: [], implementation: [sourceClaim()],
  results: [], verification: [], contribution: [], missingQuestions: ['테스트 실행 결과가 있나요?'] });
const confirmedClaim = () => ({ id: 'result-1', text: '사용자가 검증 실행 결과를 확인했다.',
  status: 'user_confirmed', evidence: [], confirmationId: 'confirmation-1' });
const confirmation = (): ClaimConfirmation => ({ id: 'confirmation-1', ownerId: packet.ownerId,
  repositoryId: packet.repositoryId, workItemId: packet.workItemId, inputVersion: packet.version,
  claimId: 'result-1', text: confirmedClaim().text, status: 'confirmed' });

function rejects(value: unknown, code: AnalysisValidationError['code'], confirmations?: readonly ClaimConfirmation[]) {
  try {
    validateWorkItemAnalysis(value, { packet, ...(confirmations ? { confirmations } : {}) });
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisValidationError);
    expect((error as AnalysisValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected validation failure: ${code}`);
}

describe('structured analysis output', () => {
  it('accepts the existing analysis shape and returns an isolated validated snapshot', () => {
    const value = valid();
    const result = parseWorkItemAnalysis(JSON.stringify(value), { packet });
    expect(result).toEqual(value);
    expect(validateWorkItemAnalysis(value, { packet })).toEqual(result);
    value.implementation[0]!.text = 'changed later';
    expect(result.implementation[0]!.text).toBe('요청별 입력 검증을 추가했다.');
    expect(WORK_ITEM_ANALYSIS_SCHEMA.required).toEqual(['workItemId', 'inputVersion', ...ANALYSIS_CLAIM_FIELDS, 'missingQuestions']);
  });

  it('does not invent facts for missing or inferred sections, including incomplete source input', () => {
    const value = { ...valid(), problem: [{ id: 'unknown-problem', text: '문제의 배경을 확인할 근거가 없다.',
      status: 'missing', evidence: [] }], decision: [{ id: 'inferred-decision', text: '입력 오류 대응으로 추정된다.',
      status: 'inferred', evidence: [packet.excerpts[0]!.reference] }] };
    const incomplete = { ...packet, complete: false };
    expect(validateWorkItemAnalysis(value, { packet: incomplete })).toEqual(value);
    expect(incomplete.complete).toBe(false);
    expect(value.verification).toEqual([]);
  });

  it('rejects missing fields, null arrays, unknown statuses and extra fields without fixing them', () => {
    const missing = { ...valid() } as Record<string, unknown>;
    delete missing.results;
    const cases = [null, [], 'response', missing, { ...valid(), results: null },
      { ...valid(), score: 99 }, { ...valid(), implementation: [{ ...sourceClaim(), status: 'approved' }] },
      { ...valid(), implementation: [{ ...sourceClaim(), confidence: 1 }] },
      { ...valid(), implementation: [{ ...sourceClaim(), confirmationId: 'forged' }] },
      { ...valid(), implementation: [{ ...sourceClaim(), evidence: [] }] },
      { ...valid(), implementation: [{ ...sourceClaim(), evidence: [{ sourceRecordId: 'record', sourceVersion: 'source-v1' }] }] },
      { ...valid(), implementation: [{ ...sourceClaim(), evidence: [{ ...packet.excerpts[0]!.reference, extra: true }] }] }];
    for (const value of cases) {
      const before = structuredClone(value);
      rejects(value, 'invalid_schema');
      expect(value).toEqual(before);
    }
  });

  it('enforces nonblank text, bounds and unique evidence references', () => {
    for (const claim of [{ ...sourceClaim(), text: ' \n\t' }, { ...sourceClaim(), id: '' },
      { ...sourceClaim(), text: 'x'.repeat(4_097) },
      { ...sourceClaim(), evidence: [packet.excerpts[0]!.reference, packet.excerpts[0]!.reference] }]) {
      rejects({ ...valid(), implementation: [claim] }, 'invalid_schema');
    }
    rejects({ ...valid(), missingQuestions: [' '] }, 'invalid_schema');
    rejects({ ...valid(), missingQuestions: ['same', 'same'] }, 'invalid_schema');
    rejects({ ...valid(), implementation: Array.from({ length: 33 }, (_, index) => ({ ...sourceClaim(), id: `claim-${index}` })) }, 'invalid_schema');
  });

  it('rejects different work items, stale inputs and duplicate IDs across analysis sections', () => {
    rejects({ ...valid(), workItemId: 'other' }, 'work_item_mismatch');
    rejects({ ...valid(), inputVersion: 'f'.repeat(64) }, 'input_version_mismatch');
    rejects({ ...valid(), results: [sourceClaim()] }, 'duplicate_claim_id');
    rejects({ ...valid(), implementation: [sourceClaim(), { ...sourceClaim(), text: 'another claim' }] }, 'duplicate_claim_id');
  });

  it('requires exact original record, version and locator within the supplied excerpts', () => {
    for (const override of [{ sourceRecordId: 'other' }, { sourceVersion: 'stale' },
      { locator: 'first-parent-patch-lines:1-999' }, { locator: null }]) {
      rejects({ ...valid(), implementation: [{ ...sourceClaim(), evidence: [{ ...packet.excerpts[0]!.reference, ...override }] }] }, 'unknown_evidence');
    }
    const value = valid();
    expect(() => validateWorkItemAnalysis(value, { packet: { ...packet, excerpts: [] } })).toThrow(AnalysisValidationError);
    expect(() => validateWorkItemAnalysis(value, { packet: { ...packet,
      excerpts: packet.excerpts.map((excerpt) => ({ ...excerpt, text: '' })) } })).toThrow(AnalysisValidationError);
    rejects({ ...valid(), problem: [{ ...sourceClaim(), id: 'inferred', status: 'inferred',
      evidence: [{ ...packet.excerpts[0]!.reference, sourceVersion: 'stale' }] }] }, 'unknown_evidence');
  });

  it('accepts user confirmation only from an external record tied to the exact claim and input', () => {
    const value = { ...valid(), results: [confirmedClaim()] };
    const confirmations = [confirmation()];
    expect(validateWorkItemAnalysis(value, { packet, confirmations })).toEqual(value);
    rejects(value, 'invalid_confirmation');
    rejects(value, 'invalid_confirmation', [confirmation(), confirmation()]);
    for (const override of [{ id: 'other' }, { status: 'revoked' as const }, { ownerId: 'other' },
      { repositoryId: 'other' }, { workItemId: 'other' }, { inputVersion: 'f'.repeat(64) },
      { claimId: 'other' }, { text: 'different approved text' }]) {
      rejects(value, 'invalid_confirmation', [{ ...confirmation(), ...override }]);
    }
    rejects({ ...valid(), results: [confirmedClaim()], confirmations: [confirmation()] }, 'invalid_schema');
    rejects({ ...valid(), results: [{ ...confirmedClaim(), text: `${confirmedClaim().text} 추가 주장` }] },
      'invalid_confirmation', confirmations);
  });

  it('reports bounded diagnostics without quoting model or source contents', () => {
    const secret = 'sentinel-private-content';
    for (const value of [{ ...valid(), [secret]: 'value' },
      { ...valid(), implementation: [{ ...sourceClaim(), text: '', evidence: [], [secret]: secret }] }]) {
      try { validateWorkItemAnalysis(value, { packet }); }
      catch (error) {
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).toContain('invalid_schema');
      }
    }
  });

  it('rejects malformed, fenced, truncated, refusal and oversized responses', () => {
    for (const json of ['{', JSON.stringify(valid()).slice(0, -1), `\u0060\u0060\u0060json\n${JSON.stringify(valid())}\n\u0060\u0060\u0060`,
      `${JSON.stringify(valid())} trailing text`]) {
      expect(() => parseWorkItemAnalysis(json, { packet })).toThrow(expect.objectContaining({ code: 'invalid_json' }));
    }
    expect(() => parseWorkItemAnalysis('{"refusal":"No"}', { packet })).toThrow(expect.objectContaining({ code: 'invalid_schema' }));
    // Byte limit must reject multibyte responses whose character count is under the limit.
    const tooLarge = '한'.repeat(Math.floor(MAX_ANALYSIS_JSON_BYTES / 3) + 1);
    expect(tooLarge.length).toBeLessThan(MAX_ANALYSIS_JSON_BYTES);
    expect(() => parseWorkItemAnalysis(tooLarge, { packet })).toThrow(expect.objectContaining({ code: 'output_limit' }));
  });
});
