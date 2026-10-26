import { canonicalJson } from './canonical-json.js';
import { EXTRACTION_VERSION, type LocalEvidencePacket } from './evidence-extraction.js';
import type { EvidencePacket, EvidenceSourceBinding } from './evidence.js';
import type { RepositoryScope } from './repositories.js';

export const EVIDENCE_MAPPING_VERSION = 'local-analysis-evidence-v1';

function required(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Evidence identities must not be empty');
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Maps a typed extraction packet; parsing untrusted JSON remains an I/O boundary responsibility. */
export async function toEvidencePacket(input: RepositoryScope & {
  readonly workItemId: string;
  readonly contentVersion: string;
  readonly packet: LocalEvidencePacket;
  readonly sources: readonly EvidenceSourceBinding[];
}): Promise<EvidencePacket> {
  const { ownerId, repositoryId, workItemId, contentVersion } = input;
  for (const id of [ownerId, repositoryId, workItemId]) required(id);
  // Snapshot before hashing so caller mutations cannot race the asynchronous digest.
  const packet = structuredClone(input.packet);
  const sources = structuredClone(input.sources);
  if (packet.schemaVersion !== 1 || packet.extractionVersion !== EXTRACTION_VERSION) {
    throw new Error('Unsupported local evidence version');
  }
  if (await sha256(packet) !== contentVersion) throw new Error('Evidence content version does not match the packet');

  const commits = new Map(packet.commits.map((commit) => [commit.oid, commit]));
  const selected = new Set(packet.selection.commitOids);
  if (!commits.size || commits.size !== packet.commits.length || selected.size !== packet.selection.commitOids.length
    || selected.size !== commits.size || [...selected].some((oid) => !commits.has(oid))) {
    throw new Error('Evidence selection does not match its unique commits');
  }
  const bindings = new Map<string, EvidenceSourceBinding>();
  const sourceIds = new Set<string>();
  for (const source of sources) {
    required(source.sourceRecordId); required(source.sourceVersion);
    if (source.ownerId !== ownerId || source.repositoryId !== repositoryId) {
      throw new Error('Evidence source scope does not match the target');
    }
    if (!commits.has(source.commitOid) || bindings.has(source.commitOid) || sourceIds.has(source.sourceRecordId)) {
      throw new Error('Evidence sources must bind each commit exactly once');
    }
    bindings.set(source.commitOid, source);
    sourceIds.add(source.sourceRecordId);
  }
  if (bindings.size !== commits.size) throw new Error('Missing evidence source binding');

  const ids = new Set<string>();
  for (const excerpt of packet.excerpts) {
    required(excerpt.id); required(excerpt.locator);
    const commit = commits.get(excerpt.commitOid);
    if (ids.has(excerpt.id) || !commit?.available || excerpt.parentOid !== commit.parentOid
      || (excerpt.path !== null && !commit.files.some((file) => file.path === excerpt.path && file.excerptId === excerpt.id))) {
      throw new Error('Invalid or duplicate evidence excerpt reference');
    }
    ids.add(excerpt.id);
  }
  const byId = new Map(packet.excerpts.map((excerpt) => [excerpt.id, excerpt]));
  if (packet.commits.some((commit) => commit.files.some((file) => {
    if (file.excerptId === null) return false;
    const excerpt = byId.get(file.excerptId);
    return !excerpt || excerpt.commitOid !== commit.oid || excerpt.path !== file.path;
  }))) {
    throw new Error('Evidence file refers to a missing or unrelated excerpt');
  }
  if (packet.complete && (packet.excerpts.some((excerpt) => !excerpt.complete)
    || packet.commits.some((commit) => !commit.available || commit.issues.length
      || commit.files.some((file) => file.reason !== null)))) {
    throw new Error('Complete evidence contains omissions');
  }
  const { excerpts, complete, ...local } = packet;
  const mapped: Omit<EvidencePacket, 'version'> = {
    ownerId, repositoryId, workItemId,
    complete,
    provenance: { kind: 'local_git', mappingVersion: EVIDENCE_MAPPING_VERSION, contentVersion, local,
      sources: packet.commits.map((commit) => bindings.get(commit.oid)!) },
    excerpts: excerpts.map(({ id, text, complete: excerptComplete, commitOid, parentOid, path, locator }) => {
      const source = bindings.get(commitOid)!;
      return { id, text, complete: excerptComplete, commitOid, parentOid, path,
        reference: { sourceRecordId: source.sourceRecordId, sourceVersion: source.sourceVersion, locator } };
    }),
  };
  return { ...mapped, version: await sha256(mapped) };
}
