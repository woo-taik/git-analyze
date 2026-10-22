import type { CommitRecord } from './repositories.js';

export const CANDIDATE_RULE_VERSION = 'candidates-v1';
export type CandidateCommit = Omit<CommitRecord, 'ownerId' | 'repositoryId'> & {
  readonly files: readonly { readonly status: string; readonly path: string }[];
};
export type CandidateDecision = 'candidate' | 'review' | 'excluded';
export type ContributionKind = 'author' | 'co_author' | 'committer_only' | 'none';
export type CandidateReason =
  | 'author_matched' | 'co_author_trailer' | 'committer_only' | 'identity_not_matched'
  | 'merge_commit' | 'low_priority_files_only' | 'no_file_changes'
  | 'multiple_issue_references' | 'manual_include' | 'manual_exclude';

export interface PreparedCommit {
  readonly original: CandidateCommit;
  readonly contribution: ContributionKind;
  readonly decision: CandidateDecision;
  readonly reasons: readonly CandidateReason[];
  readonly issueRefs: readonly string[];
  readonly lowPriorityFiles: readonly string[];
}

export interface CandidateGroup {
  readonly id: string;
  readonly decision: 'candidate' | 'review';
  readonly title: string;
  readonly grouping: 'explicit_reference' | 'single_commit';
  readonly issueRef: string | null;
  readonly commitOids: readonly string[];
}

export interface CandidatePreparation {
  readonly schemaVersion: 1;
  readonly ruleVersion: string;
  readonly identityEmails: readonly string[];
  readonly commits: readonly PreparedCommit[];
  readonly groups: readonly CandidateGroup[];
  readonly summary: {
    readonly inputCommits: number;
    readonly duplicateCommits: number;
    readonly candidateCommits: number;
    readonly reviewCommits: number;
    readonly excludedCommits: number;
    readonly candidateGroups: number;
    readonly reviewGroups: number;
  };
}

const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'pipfile.lock',
  'composer.lock', 'gemfile.lock', 'go.sum',
]);
const GENERATED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt']);

function lowPriority(path: string): boolean {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1) ?? '';
  return LOCKFILES.has(name) || parts.some((part) => GENERATED_DIRECTORIES.has(part))
    || /(?:\.generated\.|\.min\.(?:js|css)$|\.map$)/.test(name);
}

function references(message: string): string[] {
  const refs = new Set<string>();
  for (const match of message.matchAll(/\b[A-Z][A-Z0-9]{1,15}-[1-9]\d*\b/g)) refs.add(match[0]);
  const githubRefs = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|refs?|issue)\s*:?\s+#([1-9]\d*)\b/gi;
  for (const match of message.matchAll(githubRefs)) refs.add(`#${match[1]}`);
  return [...refs].sort();
}

function contributionOf(commit: CandidateCommit, emails: ReadonlySet<string>): ContributionKind {
  if (emails.has(commit.author.email.trim().toLowerCase())) return 'author';
  const trailers = commit.message.trimEnd().split(/\r?\n\s*\r?\n/).at(-1) ?? '';
  for (const match of trailers.matchAll(/^Co-authored-by:\s*[^<>\r\n]*<([^<>\s]+)>\s*$/gim)) {
    if (emails.has(match[1]!.toLowerCase())) return 'co_author';
  }
  return emails.has(commit.committer.email.trim().toLowerCase()) ? 'committer_only' : 'none';
}

function contentOf(commit: CandidateCommit): string {
  return JSON.stringify([
    commit.parentOids, commit.author.name, commit.author.email,
    commit.committer.name, commit.committer.email, commit.authoredAt,
    commit.committedAt, commit.message,
    commit.files.map((file) => [file.status, file.path]).sort(),
  ]);
}

export function prepareCandidates(input: {
  readonly commits: readonly CandidateCommit[];
  readonly identityEmails: readonly string[];
  readonly includeOids?: readonly string[];
  readonly excludeOids?: readonly string[];
}): CandidatePreparation {
  const identityEmails = [...new Set(input.identityEmails.map((email) => email.trim().toLowerCase()))].sort();
  if (!identityEmails.length || identityEmails.some((email) => !/^[^\s@]+@[^\s@]+$/.test(email))) {
    throw new Error('At least one valid author email is required');
  }
  const emails = new Set(identityEmails);
  const include = new Set(input.includeOids ?? []);
  const exclude = new Set(input.excludeOids ?? []);
  const unique = new Map<string, CandidateCommit>();
  for (const commit of input.commits) {
    const previous = unique.get(commit.oid);
    if (previous && contentOf(previous) !== contentOf(commit)) {
      throw new Error('Conflicting source records for the same commit OID');
    }
    if (!previous) unique.set(commit.oid, commit);
  }
  for (const oid of [...include, ...exclude]) {
    if (!unique.has(oid)) throw new Error('Override OID was not found in the input history');
    if (include.has(oid) && exclude.has(oid)) throw new Error('The same OID cannot be both included and excluded');
  }

  const commits: PreparedCommit[] = [];
  for (const commit of unique.values()) {
    const contribution = contributionOf(commit, emails);
    const issueRefs = references(commit.message);
    const lowPriorityFiles = commit.files.filter((file) => lowPriority(file.path)).map((file) => file.path);
    const reasons: CandidateReason[] = [];
    let decision: CandidateDecision = contribution === 'author' ? 'candidate' : 'review';
    if (contribution === 'author') reasons.push('author_matched');
    if (contribution === 'co_author') reasons.push('co_author_trailer');
    if (contribution === 'committer_only') reasons.push('committer_only');
    if (contribution === 'none') {
      reasons.push('identity_not_matched');
      decision = 'excluded';
    }
    if (commit.parentOids.length > 1) reasons.push('merge_commit');
    if (commit.files.length === 0) reasons.push('no_file_changes');
    else if (lowPriorityFiles.length === commit.files.length) reasons.push('low_priority_files_only');
    if (issueRefs.length > 1) reasons.push('multiple_issue_references');
    if (decision !== 'excluded' && reasons.some((reason) => [
      'merge_commit', 'no_file_changes', 'low_priority_files_only', 'multiple_issue_references',
    ].includes(reason))) decision = 'review';
    if (include.has(commit.oid)) {
      decision = 'candidate';
      reasons.push('manual_include');
    }
    if (exclude.has(commit.oid)) {
      decision = 'excluded';
      reasons.push('manual_exclude');
    }
    commits.push({ original: commit, contribution, decision, reasons, issueRefs, lowPriorityFiles });
  }

  const groups = new Map<string, CandidateGroup>();
  for (const commit of commits) {
    if (commit.decision === 'excluded') continue;
    const issueRef = commit.issueRefs.length === 1 ? commit.issueRefs[0]! : null;
    const id = `${commit.decision}:${issueRef ? `issue:${issueRef}` : `commit:${commit.original.oid}`}`;
    const existing = groups.get(id);
    groups.set(id, {
      id, decision: commit.decision,
      title: issueRef ?? (commit.original.message.split(/\r?\n/)[0] || '(메시지 없음)'),
      grouping: issueRef ? 'explicit_reference' : 'single_commit', issueRef,
      commitOids: [...(existing?.commitOids ?? []), commit.original.oid],
    });
  }
  return {
    schemaVersion: 1, ruleVersion: CANDIDATE_RULE_VERSION, identityEmails,
    commits, groups: [...groups.values()],
    summary: {
      inputCommits: input.commits.length, duplicateCommits: input.commits.length - unique.size,
      candidateCommits: commits.filter((commit) => commit.decision === 'candidate').length,
      reviewCommits: commits.filter((commit) => commit.decision === 'review').length,
      excludedCommits: commits.filter((commit) => commit.decision === 'excluded').length,
      candidateGroups: [...groups.values()].filter((group) => group.decision === 'candidate').length,
      reviewGroups: [...groups.values()].filter((group) => group.decision === 'review').length,
    },
  };
}
