import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildLocalEvidence, canonicalJson, EVIDENCE_MAPPING_VERSION, EXTRACTION_VERSION, toEvidencePacket,
  type EvidenceSourceBinding, type LocalEvidencePacket,
} from '../packages/core/src/index.js';

const scope = { ownerId: 'owner-1', repositoryId: 'repo-1' };
const oid = 'a'.repeat(40);
const parentOid = 'b'.repeat(40);
const digest = (packet: LocalEvidencePacket) => createHash('sha256').update(canonicalJson(packet)).digest('hex');
const sources: readonly EvidenceSourceBinding[] = [
  { ...scope, commitOid: oid, sourceRecordId: 'source-1', sourceVersion: 'snapshot-1' },
];

async function fixture({ available = true, includeLowPriority = false, patchComplete = true } = {}) {
  return buildLocalEvidence({ repositoryScope: 'local-git-directory-hash', pathFilter: 'src',
    selection: { kind: 'manual', title: '수동 선택', groupId: null, commitOids: [oid] },
    limits: { maxFileBytes: 1_000, maxTotalBytes: 2_000, maxFiles: 10, includeLowPriority },
    commits: [{ available, issues: available ? [] : ['commit_object_unavailable'], selected: {
      original: { oid, parentOids: [parentOid], author: { name: 'Author', email: 'author@example.com' },
        committer: { name: 'Committer', email: 'committer@example.com' }, authoredAt: '2026-10-20T00:00:00Z',
        committedAt: '2026-10-20T00:00:00Z', observedAt: '2026-10-21T00:00:00Z',
        message: '검증되지 않은 구현 설명\n', files: [] },
      contribution: 'committer_only', decision: 'review', reasons: ['committer_only', 'manual_include'],
      issueRefs: [], lowPriorityFiles: [],
    }, changes: available ? [
      { path: 'src/app.ts', status: 'M', oldMode: '100644', newMode: '100644', oldOid: 'c'.repeat(40), newOid: 'd'.repeat(40) },
      { path: 'src/dist/generated.js', status: 'A', oldMode: '000000', newMode: '100644', oldOid: '0'.repeat(40), newOid: 'e'.repeat(40) },
    ] : [] }],
    readPatch: async () => ({ text: '@@ -1 +1 @@\n-old\n+new\n', complete: patchComplete, reason: null }),
  });
}

function convert(packet: LocalEvidencePacket, bindings = sources) {
  return toEvidencePacket({ ...scope, workItemId: 'work-1', contentVersion: digest(packet), packet, sources: bindings });
}

describe('local evidence to analysis input', () => {
  it('preserves all extraction information and binds excerpts to explicit source snapshots', async () => {
    const packet = await fixture();
    const before = structuredClone(packet);
    const result = await convert(packet);
    expect(result).toMatchObject({ ...scope, workItemId: 'work-1', complete: false,
      provenance: { kind: 'local_git', mappingVersion: EVIDENCE_MAPPING_VERSION, contentVersion: digest(packet), sources } });
    const { version, ...mapped } = result;
    expect(version).toBe(createHash('sha256').update(canonicalJson(mapped)).digest('hex'));
    const { excerpts, complete, ...local } = packet;
    expect(result.provenance.local).toEqual(local);
    expect(result.complete).toBe(complete);
    for (const [index, excerpt] of excerpts.entries()) {
      expect(result.excerpts[index]).toEqual({ id: excerpt.id, text: excerpt.text, complete: excerpt.complete,
        commitOid: excerpt.commitOid, parentOid: excerpt.parentOid, path: excerpt.path,
        reference: { sourceRecordId: 'source-1', sourceVersion: 'snapshot-1', locator: excerpt.locator } });
    }
    expect(result.provenance.local.commits[0]).toMatchObject({ contribution: 'committer_only', decision: 'review',
      reasons: ['committer_only', 'manual_include'], files: [{ reason: null }, { reason: 'low_priority', excerptId: null }] });
    expect(packet).toEqual(before);
    expect(result.provenance.local.commits).not.toBe(packet.commits);
  });

  it('retains truncation and unavailable commits without claiming semantic sufficiency', async () => {
    const partial = await convert(await fixture({ patchComplete: false }));
    expect(partial.excerpts.find((excerpt) => excerpt.path !== null)?.complete).toBe(false);
    expect(partial.excerpts.find((excerpt) => excerpt.path === null)?.complete).toBe(true);
    expect(partial.provenance.local.commits[0]?.files[0]?.reason).toBe('file_budget');
    const unavailable = await convert(await fixture({ available: false }));
    expect(unavailable).toMatchObject({ complete: false, excerpts: [], provenance: { local: {
      commits: [{ available: false, issues: ['commit_object_unavailable'], contribution: 'committer_only' }],
    } } });
    // A successful extraction is not an approved contribution or a completed work item.
    const result = await convert(await fixture({ includeLowPriority: true }));
    expect(result.complete).toBe(true);
    expect(result.provenance.local.commits[0]?.decision).toBe('review');
    expect(result).not.toHaveProperty('completedAt');
  });

  it('checks content integrity using the existing extraction hash and canonical property order', async () => {
    const packet = await fixture();
    const contentVersion = digest(packet);
    const reordered = Object.fromEntries(Object.entries(packet).reverse()) as unknown as LocalEvidencePacket;
    expect((await convert(reordered)).version).toBe((await convert(packet)).version);
    await expect(toEvidencePacket({ ...scope, workItemId: 'work-1', sources, contentVersion,
      packet: { ...packet, complete: true } })).rejects.toThrow('content version');
    await expect(toEvidencePacket({ ...scope, workItemId: 'work-1', sources, contentVersion: '', packet }))
      .rejects.toThrow('content version');
  });

  it('versions mapping changes independently of the extraction content version', async () => {
    const packet = await fixture();
    const original = await convert(packet);
    const changedSource = await convert(packet, [{ ...sources[0]!, sourceVersion: 'snapshot-2' }]);
    const changedWorkItem = await toEvidencePacket({ ...scope, workItemId: 'work-2', packet, sources,
      contentVersion: digest(packet) });
    for (const changed of [changedSource, changedWorkItem]) {
      expect(changed.version).not.toBe(original.version);
      expect(changed.provenance.contentVersion).toBe(original.provenance.contentVersion);
    }
    const movedScope = { ownerId: 'owner-2', repositoryId: 'repo-2' };
    const moved = await toEvidencePacket({ ...movedScope, workItemId: 'work-1', packet,
      contentVersion: digest(packet), sources: sources.map((source) => ({ ...source, ...movedScope })) });
    expect(moved.version).not.toBe(original.version);
  });

  it('takes a snapshot before asynchronous hashing and isolates the returned data', async () => {
    const packet = await fixture();
    const bindings = structuredClone([...sources]);
    const contentVersion = digest(packet);
    const pending = toEvidencePacket({ ...scope, workItemId: 'work-1', sources: bindings, contentVersion, packet });
    Object.assign(packet.selection, { title: 'changed during digest' });
    Object.assign(bindings[0]!, { sourceVersion: 'changed during digest' });
    const result = await pending;
    expect(result.provenance.local.selection.title).toBe('수동 선택');
    expect(result.excerpts[0]?.reference.sourceVersion).toBe('snapshot-1');
  });

  it('requires exact source bindings within the supplied owner and repository', async () => {
    const packet = await fixture();
    await expect(convert(packet, [])).rejects.toThrow('Missing');
    await expect(convert(packet, [...sources, ...sources])).rejects.toThrow('exactly once');
    for (const override of [{ ownerId: 'other' }, { repositoryId: 'other' }]) {
      await expect(convert(packet, [{ ...sources[0]!, ...override }])).rejects.toThrow('scope');
    }
    await expect(convert(packet, [{ ...sources[0]!, commitOid: parentOid }])).rejects.toThrow('exactly once');
    await expect(convert(packet, [{ ...sources[0]!, sourceVersion: ' ' }])).rejects.toThrow('empty');
    await expect(toEvidencePacket({ ...scope, workItemId: '', packet, sources, contentVersion: digest(packet) }))
      .rejects.toThrow('empty');
  });

  it('rejects unsupported versions, conflicting selections and broken excerpt references', async () => {
    const packet = await fixture();
    expect(packet.extractionVersion).toBe(EXTRACTION_VERSION);
    await expect(convert({ ...packet, extractionVersion: 'future' })).rejects.toThrow('Unsupported');
    await expect(convert({ ...packet, selection: { ...packet.selection, commitOids: [parentOid] } }))
      .rejects.toThrow('selection');
    await expect(convert({ ...packet, commits: [...packet.commits, ...packet.commits] })).rejects.toThrow('unique');
    await expect(convert({ ...packet, excerpts: [...packet.excerpts, packet.excerpts[0]!] })).rejects.toThrow('duplicate');
    await expect(convert({ ...packet, excerpts: packet.excerpts.map((excerpt) => ({ ...excerpt, parentOid: null })) }))
      .rejects.toThrow('reference');
    await expect(convert({ ...packet, excerpts: packet.excerpts.filter((excerpt) => excerpt.path === null) }))
      .rejects.toThrow('missing');
    await expect(convert({ ...packet, commits: packet.commits.map((commit) => ({ ...commit,
      files: commit.files.map((file) => ({ ...file, excerptId: packet.excerpts[0]!.id })),
    })) })).rejects.toThrow('reference');
    await expect(convert({ ...packet, complete: true })).rejects.toThrow('omissions');
  });
});
