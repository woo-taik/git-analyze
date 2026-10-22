import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareCandidates, type CandidateCommit } from '../packages/core/src/prepare-candidates.js';
import { executePrepare } from '../apps/cli/src/prepare.js';

const execute = promisify(execFile);
const email = 'me@example.com';
const oid = (number: number) => number.toString(16).padStart(40, '0');
const date = '2026-01-15T00:00:00Z';
function commit(number: number, overrides: Partial<CandidateCommit> = {}): CandidateCommit {
  return {
    oid: oid(number), parentOids: [oid(0)],
    author: { name: 'Author', email }, committer: { name: 'Committer', email: 'bot@example.com' },
    authoredAt: date, committedAt: date, observedAt: date, message: 'implement feature',
    files: [{ status: 'M', path: 'frontend/src/app.ts' }], ...overrides,
  };
}
function history(commits: readonly CandidateCommit[]) {
  return {
    schemaVersion: 1, repositoryPath: 'Z:/nonexistent/offline-fixture', pathFilter: 'frontend',
    ref: 'HEAD', tipOid: oid(99), collectedAt: date,
    startAt: '2026-01-10T00:00:00Z', endAt: '2026-01-21T00:00:00Z',
    timezone: 'Asia/Seoul', dateBasis: 'committer', fileComparison: 'first-parent', commits,
  };
}
const prepare = (commits: readonly CandidateCommit[]) => prepareCandidates({ commits, identityEmails: [email] });
let temporaryBase: string;
let root: string;
let sequence = 0;
beforeAll(async () => {
  temporaryBase = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryBase, 'git-analyze-prepare-'));
});
afterAll(async () => {
  if (!root) return;
  if (dirname(root) !== temporaryBase || !basename(root).startsWith('git-analyze-prepare-')) {
    throw new Error('Refusing to delete a path outside the test temporary directory');
  }
  await rm(root, { recursive: true, force: true });
});
async function inputFile(value: unknown) {
  const path = join(root, `history-${sequence++}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}
function args(input: string) {
  return ['--input', input, '--author', email, '--output', join(root, `report-${sequence++}`)];
}

describe('candidate selection and traceability', () => {
  it('normalizes explicit aliases and never guesses similar identities', () => {
    const result = prepareCandidates({
      commits: [commit(1), commit(2, { author: { name: 'Alias', email: 'ALT@example.com' } }),
        commit(3, { author: { name: 'Author', email: 'me+work@example.com' } })],
      identityEmails: [' ME@example.com ', email, 'alt@example.com'],
    });
    expect(result.identityEmails).toEqual(['alt@example.com', email]);
    expect(result.commits.map((item) => item.decision)).toEqual(['candidate', 'candidate', 'excluded']);
    expect(() => prepareCandidates({ commits: [], identityEmails: [] })).toThrow('email');
    expect(() => prepareCandidates({ commits: [], identityEmails: ['invalid'] })).toThrow('email');
  });

  it('keeps committer-only and co-author evidence in review without claiming authorship', () => {
    const other = { name: 'Other', email: 'other@example.com' };
    const result = prepare([
      commit(1, { author: other, committer: { name: 'Me', email } }),
      commit(2, { author: other, message: `feature\n\nCo-authored-by: Me <${email}>\nSigned-off-by: Other <other@example.com>` }),
      commit(3, { author: other, message: `Example:\nCo-authored-by: Me <${email}>\n\nUnrelated final paragraph` }),
    ]);
    expect(result.commits.map(({ contribution, decision }) => [contribution, decision]))
      .toEqual([['committer_only', 'review'], ['co_author', 'review'], ['none', 'excluded']]);
  });

  it('retains merges, generated-only changes and empty changes for review', () => {
    const result = prepare([
      commit(1, { parentOids: [oid(90), oid(91)] }),
      commit(2, { files: [{ status: 'M', path: 'frontend/pnpm-lock.yaml' }, { status: 'A', path: 'frontend/dist/app.js' }] }),
      commit(3, { files: [] }),
      commit(4, { files: [{ status: 'M', path: 'frontend/pnpm-lock.yaml' }, { status: 'M', path: 'frontend/src/app.ts' }] }),
      commit(5, { files: [{ status: 'M', path: 'frontend/README.md' }] }),
    ]);
    expect(result.commits.map((item) => item.decision)).toEqual(['review', 'review', 'review', 'candidate', 'candidate']);
    expect(result.commits[0]?.reasons).toContain('merge_commit');
    expect(result.commits[1]?.reasons).toContain('low_priority_files_only');
    expect(result.commits[2]?.reasons).toContain('no_file_changes');
    expect(result.commits[3]?.lowPriorityFiles).toEqual(['frontend/pnpm-lock.yaml']);
  });

  it('groups only explicit single references and does not treat PR numbers as issue links', () => {
    const result = prepare([
      commit(1, { message: 'APP-42 implement' }), commit(2, { message: 'APP-42 follow-up' }),
      commit(3, { message: 'fixes #7' }), commit(4, { message: 'Refs: #7' }),
      commit(5, { message: 'same title (#99)' }), commit(6, { message: 'same title (#99)' }),
      commit(7, { message: 'APP-42 and APP-43' }),
      commit(8, { message: 'APP-42 merge', parentOids: [oid(90), oid(91)] }),
    ]);
    expect(result.groups.find((group) => group.id === 'candidate:issue:APP-42')?.commitOids).toEqual([oid(1), oid(2)]);
    expect(result.groups.find((group) => group.issueRef === '#7')?.commitOids).toEqual([oid(3), oid(4)]);
    expect(result.groups.filter((group) => group.grouping === 'single_commit')).toHaveLength(3);
    expect(result.commits[6]?.reasons).toContain('multiple_issue_references');
    expect(result.groups.flatMap((group) => group.commitOids)).toHaveLength(8);
    expect(new Set(result.groups.flatMap((group) => group.commitOids)).size).toBe(8);
    expect(result.groups.find((group) => group.id === 'review:issue:APP-42')?.commitOids).toEqual([oid(8)]);
  });

  it('supports reversible overrides while preserving identity, reasons and original records', () => {
    const source = [commit(1), commit(2, { author: { name: 'Other', email: 'other@example.com' } })];
    const original = JSON.stringify(source);
    const result = prepareCandidates({ commits: source, identityEmails: [email], includeOids: [oid(2)], excludeOids: [oid(1)] });
    expect(result.commits[0]).toMatchObject({ decision: 'excluded', reasons: ['author_matched', 'manual_exclude'], original: source[0] });
    expect(result.commits[1]).toMatchObject({ decision: 'candidate', contribution: 'none', reasons: ['identity_not_matched', 'manual_include'] });
    expect(JSON.stringify(source)).toBe(original);
    expect(prepare(source).commits.map((item) => item.decision)).toEqual(['candidate', 'excluded']);
    expect(() => prepareCandidates({ commits: source, identityEmails: [email], includeOids: [oid(9)] })).toThrow('not found');
    expect(() => prepareCandidates({ commits: source, identityEmails: [email], includeOids: [oid(1)], excludeOids: [oid(1)] })).toThrow('both');
  });

  it('deduplicates observations but rejects conflicting records for the same OID', () => {
    const first = commit(1);
    const result = prepare([first, { ...first, observedAt: '2026-01-16T00:00:00Z' }]);
    expect(result.summary).toMatchObject({ inputCommits: 2, duplicateCommits: 1, candidateCommits: 1 });
    expect(() => prepare([first, { ...first, message: 'different' }])).toThrow('Conflicting');
    expect(() => prepare([first, { ...first, files: [] }])).toThrow('Conflicting');
    expect(prepare([first])).toEqual(prepare([first]));
  });
});

describe('offline prepare command', () => {
  it('runs the compiled Nest CLI, preserves source bytes and writes reviewable escaped reports', async () => {
    const source = history([commit(1, { message: '<script>alert(1)</script> [title]' }),
      commit(2, { parentOids: [oid(90), oid(91)] }),
      commit(3, { author: { name: 'Other', email: 'other@example.com' } })]);
    const input = await inputFile(source);
    const before = await readFile(input);
    const { stdout } = await execute(process.execPath, ['apps/cli/dist/index.js', 'prepare', ...args(input)], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15_000,
    });
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({ inputCommits: 3, candidateCommits: 1, reviewCommits: 1, excludedCommits: 1 });
    const saved = JSON.parse(await readFile(summary.jsonPath, 'utf8'));
    expect(saved.source.repositoryPath).toBe(source.repositoryPath);
    expect(saved.commits.map((item: { original: CandidateCommit }) => item.original)).toEqual(source.commits);
    const markdown = await readFile(summary.markdownPath, 'utf8');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('## 제외 기록');
    expect(markdown).toContain('병합 커밋');
    expect(await readFile(input)).toEqual(before);
    await expect(executePrepare(['--input', input, '--author', email, '--output', dirname(summary.jsonPath)]))
      .rejects.toThrow('already exists');
    expect(JSON.parse(await readFile(summary.jsonPath, 'utf8'))).toEqual(saved);
  });

  it('accepts repeated author and alias flags and forwards full-OID overrides', async () => {
    const input = await inputFile(history([commit(1), commit(2, { author: { name: 'Alias', email: 'alias@example.com' } })]));
    const result = await executePrepare([...args(input), '--author', 'second@example.com', '--alias', 'alias@example.com',
      '--exclude', oid(1), '--include', oid(2)]);
    expect(result).toMatchObject({ candidateCommits: 1, excludedCommits: 1 });
    const saved = JSON.parse(await readFile(result.jsonPath, 'utf8'));
    expect(saved.identityEmails).toEqual(['alias@example.com', email, 'second@example.com']);
    expect(saved.commits[1].reasons).toContain('manual_include');
  });

  it('rejects missing options, unknown options and invalid JSON', async () => {
    await expect(executePrepare([])).rejects.toThrow('--input');
    await expect(executePrepare(['--input', 'unused'])).rejects.toThrow('--author');
    await expect(executePrepare(['--unknown'])).rejects.toThrow();
    const input = join(root, 'invalid.json');
    await writeFile(input, '{invalid');
    await expect(executePrepare(args(input))).rejects.toThrow('JSON');
  });

  it.each([
    ['schema', { ...history([]), schemaVersion: 2 }, 'schema'],
    ['time range', { ...history([]), endAt: '2026-01-01T00:00:00Z' }, 'time range'],
    ['OID', history([commit(1, { oid: 'short' })]), 'OID'],
    ['outside period', history([commit(1, { committedAt: '2026-01-21T00:00:00Z' })]), 'outside'],
    ['status', history([commit(1, { files: [{ status: 'invalid', path: 'a' }] })]), 'status'],
    ['timezone', history([commit(1, { authoredAt: '2026-01-15T00:00:00' })]), 'timestamp'],
    ['input limit', history(Array.from({ length: 1_001 }, (_, index) => commit(index))), '1,000'],
  ])('rejects invalid %s before creating a report', async (_label, value, error) => {
    await expect(executePrepare(args(await inputFile(value)))).rejects.toThrow(error);
  });
});
