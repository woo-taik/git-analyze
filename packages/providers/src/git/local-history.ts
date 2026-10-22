import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CommitRecord } from '@git-analyze/core';
import { git } from './command.js';

const MAX_COMMITS = 1_000;

export interface LocalCommit extends Omit<CommitRecord, 'ownerId' | 'repositoryId'> {
  readonly files: readonly { readonly status: string; readonly path: string }[];
}

export interface LocalHistory {
  readonly schemaVersion: 1;
  readonly repositoryPath: string;
  readonly pathFilter: string | null;
  readonly ref: string;
  readonly tipOid: string;
  readonly collectedAt: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly timezone: 'Asia/Seoul';
  readonly dateBasis: 'committer';
  readonly fileComparison: 'first-parent';
  readonly commits: readonly LocalCommit[];
}

export function parseCommits(output: string, observedAt: string): Omit<LocalCommit, 'files'>[] {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % 9 !== 0) throw new Error('Invalid Git commit output');
  const commits: Omit<LocalCommit, 'files'>[] = [];
  for (let index = 0; index < fields.length; index += 9) {
    const [oid, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, message]
      = fields.slice(index, index + 9) as [string, string, string, string, string, string, string, string, string];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || !Number.isFinite(Date.parse(committedAt))) {
      throw new Error('Invalid Git commit metadata');
    }
    commits.push({
      oid, parentOids: parents ? parents.split(' ') : [],
      author: { name: authorName, email: authorEmail },
      committer: { name: committerName, email: committerEmail },
      authoredAt, committedAt, observedAt, message: message.trimEnd(),
    });
  }
  return commits;
}

export function normalizePathFilter(value: string | undefined): string | null {
  if (value === undefined) return null;
  const path = value.replaceAll('\\', '/');
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (!path.trim() || path.includes('\0') || path.startsWith('/')
    || /^[a-z]:/i.test(path) || parts.includes('..')) {
    throw new Error('--path must be a repository-root-relative path without ..');
  }
  return parts.join('/') || null;
}

export async function collectLocalHistory(input: {
  readonly repositoryPath: string;
  readonly ref: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly pathFilter?: string;
}): Promise<LocalHistory> {
  const pathFilter = normalizePathFilter(input.pathFilter);
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Collection period must have a valid start before its end');
  }
  if (!input.ref || input.ref.startsWith('-')) throw new Error('Invalid ref');

  let repositoryPath: string;
  try {
    repositoryPath = await realpath(resolve(input.repositoryPath));
  } catch {
    throw new Error('Repository path does not exist or cannot be accessed');
  }
  await git(repositoryPath, ['rev-parse', '--git-dir']);
  if ((await git(repositoryPath, ['rev-parse', '--is-bare-repository'])).trim() === 'false') {
    repositoryPath = await realpath((await git(repositoryPath, ['rev-parse', '--show-toplevel'])).trim());
  }
  if ((await git(repositoryPath, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    throw new Error('Shallow history is incomplete. Deepen the repository manually before collecting.');
  }
  const tipOid = (await git(repositoryPath, [
    'rev-parse', '--verify', '--end-of-options', `${input.ref}^{commit}`,
  ])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tipOid)) throw new Error('Invalid resolved commit OID');

  const collectedAt = new Date().toISOString();
  const output = await git(repositoryPath, [
    'log', '-z', '--no-show-signature', '--no-notes', '--no-decorate', '--encoding=UTF-8',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
    `--since-as-filter=${new Date(start - 1_000).toISOString()}`, `--until=${input.endAt}`,
    tipOid, '--',
  ]);
  const selected = parseCommits(output, collectedAt).filter((commit) => {
    const time = Date.parse(commit.committedAt);
    return start <= time && time < end;
  });
  if (selected.length > MAX_COMMITS) throw new Error('More than 1,000 commits in the time range before path filtering. Use a shorter period.');

  const commits: LocalCommit[] = [];
  for (const commit of selected) {
    const parent = commit.parentOids[0];
    const revisions = parent ? [parent, commit.oid] : ['--root', commit.oid];
    const filesOutput = await git(repositoryPath, [
      'diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '--no-renames',
      '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...revisions, '--',
      ...(pathFilter === null ? [] : [`:(top,literal)${pathFilter}`]),
    ]);
    const fields = filesOutput.split('\0');
    if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Invalid Git file output');
    const files: { status: string; path: string }[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      files.push({ status: fields[index]!, path: fields[index + 1]! });
    }
    if (pathFilter === null || files.length > 0) commits.push({ ...commit, files });
  }
  return {
    schemaVersion: 1, repositoryPath, pathFilter, ref: input.ref, tipOid, collectedAt,
    startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    timezone: 'Asia/Seoul', dateBasis: 'committer', fileComparison: 'first-parent', commits,
  };
}
