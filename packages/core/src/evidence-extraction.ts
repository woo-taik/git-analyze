import { isLowPriorityPath, type PreparedCommit } from './prepare-candidates.js';

export const EXTRACTION_VERSION = 'local-evidence-v1';
export interface EvidenceLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly includeLowPriority: boolean;
}
export interface GitChange {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
}
export interface InspectedCommit {
  readonly selected: PreparedCommit;
  readonly available: boolean;
  readonly changes: readonly GitChange[];
  readonly issues: readonly string[];
}
export type OmissionReason = 'low_priority' | 'file_limit' | 'total_budget' | 'file_budget'
  | 'binary' | 'non_utf8' | 'submodule' | 'unavailable';
export interface PatchRead {
  readonly text: string;
  readonly complete: boolean;
  readonly reason: 'binary' | 'non_utf8' | 'submodule' | 'unavailable' | null;
}
export interface LocalEvidenceExcerpt {
  readonly id: string;
  readonly commitOid: string;
  readonly parentOid: string | null;
  readonly path: string | null;
  readonly locator: string;
  readonly text: string;
  readonly complete: boolean;
}
export interface LocalEvidencePacket {
  readonly schemaVersion: 1;
  readonly extractionVersion: string;
  readonly repositoryScope: string;
  readonly pathFilter: string | null;
  readonly selection: { readonly kind: 'group' | 'manual'; readonly title: string; readonly groupId: string | null; readonly commitOids: readonly string[] };
  readonly limits: EvidenceLimits;
  readonly complete: boolean;
  readonly commits: readonly {
    readonly oid: string;
    readonly parentOid: string | null;
    readonly available: boolean;
    readonly author: PreparedCommit['original']['author'];
    readonly committer: PreparedCommit['original']['committer'];
    readonly authoredAt: string;
    readonly committedAt: string;
    readonly contribution: PreparedCommit['contribution'];
    readonly decision: PreparedCommit['decision'];
    readonly reasons: readonly string[];
    readonly issues: readonly string[];
    readonly files: readonly (GitChange & { readonly excerptId: string | null; readonly reason: OmissionReason | null })[];
  }[];
  readonly excerpts: readonly LocalEvidenceExcerpt[];
  readonly summary: { readonly excerptBytes: number; readonly files: number; readonly patchExcerpts: number; readonly omittedOrPartialFiles: number };
}

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).length;

// A clipped excerpt is an exact UTF-8 prefix ending at a complete patch/message line.
export function linePrefix(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && bytes[end - 1] !== 10) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export async function buildLocalEvidence(input: {
  readonly repositoryScope: string;
  readonly pathFilter: string | null;
  readonly selection: LocalEvidencePacket['selection'];
  readonly commits: readonly InspectedCommit[];
  readonly limits: EvidenceLimits;
  readonly readPatch: (commit: InspectedCommit, change: GitChange, maxBytes: number) => Promise<PatchRead>;
}): Promise<LocalEvidencePacket> {
  const excerpts: LocalEvidenceExcerpt[] = [];
  const commits: LocalEvidencePacket['commits'][number][] = [];
  let remaining = input.limits.maxTotalBytes;
  let readFiles = 0;
  let complete = true;
  // Reserve messages first, so later commits do not lose their only description to an earlier large patch.
  for (const commit of input.commits) {
    if (!commit.available) { complete = false; continue; }
    const original = commit.selected.original;
    const text = linePrefix(original.message, Math.min(4_096, remaining));
    const messageComplete = text === original.message;
    complete &&= messageComplete;
    remaining -= utf8Bytes(text);
    excerpts.push({ id: `git:${original.oid}:message`, commitOid: original.oid,
      parentOid: original.parentOids[0] ?? null, path: null, locator: 'commit-message', text, complete: messageComplete });
  }
  // Prefer source changes across the entire manual group, not only within each commit.
  const tasks = input.commits.flatMap((commit) => commit.changes.map((change) => ({ commit, change })))
    .sort((a, b) => Number(isLowPriorityPath(a.change.path)) - Number(isLowPriorityPath(b.change.path))
      || (a.commit.selected.original.oid + a.change.path < b.commit.selected.original.oid + b.change.path ? -1 : 1));
  const records = new Map<GitChange, LocalEvidencePacket['commits'][number]['files'][number]>();
  for (const { commit, change } of tasks) {
    let reason: OmissionReason | null = null;
    let excerptId: string | null = null;
    if (!input.limits.includeLowPriority && isLowPriorityPath(change.path)) reason = 'low_priority';
    else if (change.oldMode === '160000' || change.newMode === '160000') reason = 'submodule';
    else if (readFiles >= input.limits.maxFiles) reason = 'file_limit';
    else if (remaining === 0) reason = 'total_budget';
    else {
      readFiles++;
      const allowed = Math.min(remaining, input.limits.maxFileBytes);
      const patch = await input.readPatch(commit, change, allowed);
      reason = patch.reason;
      const text = linePrefix(patch.text, allowed);
      const patchComplete = patch.complete && text === patch.text;
      if (!reason && !patchComplete) reason = allowed < input.limits.maxFileBytes ? 'total_budget' : 'file_budget';
      if (text) {
        const oid = commit.selected.original.oid;
        const parentOid = commit.selected.original.parentOids[0] ?? null;
        const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        excerptId = `git:${oid}:${encodeURIComponent(change.path)}:patch:1-${lineCount}`;
        excerpts.push({ id: excerptId, commitOid: oid, parentOid, path: change.path,
          locator: `first-parent-patch-lines:1-${lineCount}`, text, complete: patchComplete });
        remaining -= utf8Bytes(text);
      }
    }
    if (reason) complete = false;
    records.set(change, { ...change, excerptId, reason });
  }
  for (const commit of input.commits) {
    const original = commit.selected.original;
    commits.push({ oid: original.oid, parentOid: original.parentOids[0] ?? null,
      available: commit.available, author: original.author, committer: original.committer,
      authoredAt: original.authoredAt, committedAt: original.committedAt,
      contribution: commit.selected.contribution, decision: commit.selected.decision,
      reasons: commit.selected.reasons, issues: commit.issues,
      files: commit.changes.map((change) => records.get(change)!) });
  }
  const files = commits.flatMap((commit) => commit.files);
  return {
    schemaVersion: 1, extractionVersion: EXTRACTION_VERSION, repositoryScope: input.repositoryScope,
    pathFilter: input.pathFilter, selection: input.selection, limits: input.limits, complete,
    commits, excerpts, summary: { excerptBytes: input.limits.maxTotalBytes - remaining, files: files.length,
      patchExcerpts: excerpts.filter((excerpt) => excerpt.path !== null).length,
      omittedOrPartialFiles: files.filter((file) => file.reason !== null).length },
  };
}
