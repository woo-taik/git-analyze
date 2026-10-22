import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { GitChange, InspectedCommit, PatchRead, PreparedCommit } from '@git-analyze/core';
import { git, readGit } from './command.js';
import { normalizePathFilter, parseCommits } from './local-history.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FORMAT = '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';
const DIFF_OPTIONS = ['--no-commit-id', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
const revisions = (commit: PreparedCommit) => commit.original.parentOids[0]
  ? [commit.original.parentOids[0], commit.original.oid] : ['--root', commit.original.oid];

function metadata(commit: Omit<PreparedCommit['original'], 'files'>) {
  return JSON.stringify([commit.oid, commit.parentOids, commit.author, commit.committer,
    Date.parse(commit.authoredAt), Date.parse(commit.committedAt), commit.message.trimEnd()]);
}

function parseChanges(text: string): GitChange[] {
  if (!text) return [];
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Invalid Git raw diff');
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([A-Z])$/.exec(fields[index]!);
    if (!match || !fields[index + 1]) throw new Error('Invalid Git raw file entry');
    changes.push({ oldMode: match[1]!, newMode: match[2]!, oldOid: match[3]!, newOid: match[4]!,
      status: match[5]!, path: fields[index + 1]! });
  }
  return changes;
}

export async function inspectLocalEvidence(input: {
  readonly repositoryPath: string;
  readonly tipOid: string;
  readonly pathFilter: string | null;
  readonly commits: readonly PreparedCommit[];
}) {
  if (!OID.test(input.tipOid) || input.commits.some((commit) => !OID.test(commit.original.oid)
    || commit.original.parentOids.some((parent) => !OID.test(parent)))) throw new Error('Invalid evidence OID');
  const pathFilter = normalizePathFilter(input.pathFilter ?? undefined);
  let repositoryPath = await realpath(resolve(input.repositoryPath));
  if ((await git(repositoryPath, ['rev-parse', '--is-bare-repository'])).trim() === 'false') {
    repositoryPath = await realpath((await git(repositoryPath, ['rev-parse', '--show-toplevel'])).trim());
  }
  if ((await git(repositoryPath, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    throw new Error('Shallow history is incomplete; evidence extraction requires complete local history');
  }
  await git(repositoryPath, ['cat-file', '-e', `${input.tipOid}^{commit}`]);
  const gitDirectory = await realpath((await git(repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const gitVersion = (await git(repositoryPath, ['--version'])).trim();
  const commits: InspectedCommit[] = [];
  for (const selected of input.commits) {
    let actual: ReturnType<typeof parseCommits>[number];
    try {
      const output = await git(repositoryPath, ['log', '-1', '-z', '--no-show-signature', '--no-use-mailmap', FORMAT, selected.original.oid, '--'], 1024 * 1024);
      actual = parseCommits(output, selected.original.observedAt)[0]!;
      if (!actual) throw new Error('Commit object unavailable');
    } catch {
      commits.push({ selected, available: false, changes: [], issues: ['commit_object_unavailable'] });
      continue;
    }
    // Do not attach authentic patches to forged authors, messages or parent relationships in an edited JSON.
    if (metadata(actual) !== metadata(selected.original)) {
      throw new Error('Saved commit metadata does not match the local Git object');
    }
    await git(repositoryPath, ['merge-base', '--is-ancestor', selected.original.oid, input.tipOid]);
    try {
      const raw = await git(repositoryPath, ['diff-tree', ...DIFF_OPTIONS, '--raw', '-z', '--no-abbrev',
        ...revisions(selected), '--', ...(pathFilter === null ? [] : [`:(top,literal)${pathFilter}`])], 1024 * 1024);
      commits.push({ selected, available: true, changes: parseChanges(raw), issues: [] });
    } catch {
      commits.push({ selected, available: false, changes: [], issues: ['parent_or_file_manifest_unavailable'] });
    }
  }
  const blobOids = [...new Set(commits.flatMap((commit) => commit.changes.flatMap((change) => [
    ...(change.oldMode === '160000' || /^0+$/.test(change.oldOid) ? [] : [change.oldOid]),
    ...(change.newMode === '160000' || /^0+$/.test(change.newOid) ? [] : [change.newOid]),
  ])))].sort();
  if (blobOids.length) {
    const checked = await git(repositoryPath, ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      4 * 1024 * 1024, `${blobOids.join('\n')}\n`);
    const missing = new Set(checked.trimEnd().split('\n').filter((line) => !line.endsWith(' blob')).map((line) => line.split(' ')[0]));
    for (let index = 0; index < commits.length; index++) {
      const commit = commits[index]!;
      if (commit.changes.some((change) => missing.has(change.oldOid) || missing.has(change.newOid))) {
        commits[index] = { selected: commit.selected, available: false, changes: [], issues: ['blob_object_unavailable'] };
      }
    }
  }
  // Git attributes/config can affect hunk headings even when external drivers and textconv are disabled.
  // Hash effective settings; never persist config text, which may contain credential-bearing URLs.
  const paths = [...new Set(commits.flatMap((commit) => commit.changes.map((change) => change.path)))].sort();
  const configuration = await git(repositoryPath, ['config', '--null', '--list'], 1024 * 1024);
  const attributes = paths.length ? await git(repositoryPath, ['check-attr', '-z', '--all', '--stdin'],
    4 * 1024 * 1024, `${paths.join('\0')}\0`) : '';
  const diffEnvironment = createHash('sha256').update(configuration).update('\0').update(attributes).digest('hex');
  return { repositoryPath, gitDirectory, gitVersion, diffEnvironment, pathFilter, commits };
}

export async function readLocalPatch(
  repositoryPath: string, commit: InspectedCommit, change: GitChange, maxBytes: number,
): Promise<PatchRead> {
  if (change.oldMode === '160000' || change.newMode === '160000') return { text: '', complete: false, reason: 'submodule' };
  try {
    // Probe the first 8,000 bytes, like Git's usual NUL heuristic, without materializing large blobs.
    for (const oid of [change.oldOid, change.newOid]) {
      if (/^0+$/.test(oid)) continue;
      const probe = await readGit(repositoryPath, ['cat-file', 'blob', oid], 8_000);
      if (probe.bytes.includes(0)) return { text: '', complete: false, reason: 'binary' };
      try { new TextDecoder('utf8', { fatal: true }).decode(probe.bytes, { stream: !probe.complete }); }
      catch { return { text: '', complete: false, reason: 'non_utf8' }; }
    }
    // Force object text comparison, then remove attribute-dependent function names from hunk headings.
    const result = await readGit(repositoryPath, [
      '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false',
      'diff-tree', ...DIFF_OPTIONS, '-p', '--text', '--full-index', '--no-color', '--no-relative',
      '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0',
      '--no-indent-heuristic', '--diff-algorithm=myers',
      ...revisions(commit.selected), '--', `:(top,literal)${change.path}`,
    ], maxBytes);
    let text: string;
    try { text = new TextDecoder('utf8', { fatal: true }).decode(result.bytes, { stream: !result.complete }); }
    catch { return { text: '', complete: false, reason: 'non_utf8' }; }
    if (!result.complete) text = text.slice(0, text.lastIndexOf('\n') + 1);
    text = text.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/gm, '$1');
    if (!text && result.complete) return { text: '', complete: false, reason: 'unavailable' };
    return { text, complete: result.complete, reason: null };
  } catch {
    return { text: '', complete: false, reason: 'unavailable' };
  }
}
