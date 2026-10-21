import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCollectOptions } from '../apps/cli/src/collect-options.js';
import { renderHistoryMarkdown, writeHistoryReports } from '../apps/cli/src/history-report.js';
import { collectLocalHistory, type LocalHistory } from '../packages/providers/src/git/local-history.js';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const startAt = '2026-01-10T00:00:00.000Z';
const endAt = '2026-01-21T00:00:00.000Z';
let temporaryBase: string;
let root: string;
let repo: string;
let history: LocalHistory;

async function git(args: readonly string[], date?: string, cwd = repo) {
  return (await execute('git', [
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false',
    '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args,
  ], {
    cwd, timeout: 15_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.com',
      ...(date ? { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: date } : {}),
    },
  })).stdout;
}

beforeAll(async () => {
  temporaryBase = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryBase, 'git-analyze-collect-'));
  repo = join(root, '한글 repo');
  await mkdir(repo);
  await git(['init', '-b', 'main']);
  await writeFile(join(repo, 'original.txt'), 'root\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'start-inclusive root'], '2026-01-10T00:00:00Z');
  await git(['mv', 'original.txt', '[한글] renamed.txt']);
  await git(['commit', '-m', 'older child'], '2026-01-05T00:00:00Z');
  await git(['checkout', '-b', 'feature']);
  await writeFile(join(repo, 'feature.txt'), 'feature\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'feature work'], '2026-01-11T00:00:00Z');
  await git(['checkout', 'main']);
  await writeFile(join(repo, '[한글] renamed.txt'), 'changed\n');
  await git(['add', '.']);
  await git(['commit', '-m', '<script>title</script> [text]\n\nBody\n\u001e delimiter'], '2026-01-20T00:00:00Z');
  await git(['merge', '--no-ff', 'feature', '-m', 'merge feature'], '2026-01-20T12:00:00Z');
  await git(['commit', '--allow-empty', '-m', 'end-exclusive'], '2026-01-21T00:00:00Z');
  await git(['checkout', '-b', 'unmerged']);
  await writeFile(join(repo, 'unmerged.txt'), 'not in main\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'unmerged work'], '2026-01-20T18:00:00Z');
  await git(['checkout', 'main']);
  await writeFile(join(repo, '[한글] renamed.txt'), 'dirty working tree\n');
  await writeFile(join(repo, 'untracked.txt'), 'untracked\n');
  history = await collectLocalHistory({ repositoryPath: repo, ref: 'HEAD', startAt, endAt });
}, 30_000);

afterAll(async () => {
  if (!root) return;
  if (dirname(root) !== temporaryBase || !basename(root).startsWith('git-analyze-collect-')) {
    throw new Error('Refusing to delete a path outside the test temporary directory');
  }
  await rm(root, { recursive: true, force: true });
});

describe('period and argument validation', () => {
  it.each([
    ['1w', '2026-03-31T14:30:00Z', '2026-03-24T14:30:00.000Z'],
    ['1m', '2026-03-31T14:30:00Z', '2026-02-28T14:30:00.000Z'],
    ['1m', '2024-03-31T14:30:00Z', '2024-02-29T14:30:00.000Z'],
    ['1m', '2026-03-31T16:30:00Z', '2026-02-28T16:30:00.000Z'],
    ['3m', '2026-01-31T14:30:00Z', '2025-10-31T14:30:00.000Z'],
    ['6m', '2026-08-31T14:30:00Z', '2026-02-28T14:30:00.000Z'],
  ])('resolves %s at %s in KST with month-end clamping', (period, now, expected) => {
    expect(parseCollectOptions(['--repo', repo, '--period', period], new Date(now)).startAt).toBe(expected);
  });

  it('rejects missing repositories, unsupported periods and unknown options', () => {
    expect(() => parseCollectOptions([])).toThrow('--repo');
    expect(() => parseCollectOptions(['--repo', repo, '--period', '2w'])).toThrow('--period');
    expect(() => parseCollectOptions(['--repo', repo, '--typo', 'value'])).toThrow();
    expect(() => parseCollectOptions(['--repo', repo, '--path', ''])).toThrow('--path');
    expect(parseCollectOptions(['--repo', repo, '--path', 'frontend']).pathFilter).toBe('frontend');
  });
});

describe('local Git collection', () => {
  it('uses [start, end) and committer dates without stopping at an older child', () => {
    expect(history.commits).toHaveLength(4);
    expect(history.commits.some((commit) => commit.message === 'start-inclusive root')).toBe(true);
    expect(history.commits.some((commit) => commit.message === 'end-exclusive')).toBe(false);
    expect(history.commits.every((commit) => commit.authoredAt.startsWith('2000-'))).toBe(true);
  });

  it('collects root files, Unicode paths and first-parent merge changes', () => {
    const initial = history.commits.find((commit) => commit.parentOids.length === 0);
    expect(initial?.files).toEqual([{ status: 'A', path: 'original.txt' }]);
    const merge = history.commits.find((commit) => commit.parentOids.length === 2);
    expect(merge?.files).toEqual([{ status: 'A', path: 'feature.txt' }]);
    expect(history.commits.flatMap((commit) => commit.files).some((file) => file.path === '[한글] renamed.txt')).toBe(true);
    expect(history.commits.some((commit) => commit.message.includes('\u001e delimiter'))).toBe(true);
    expect(history.commits.flatMap((commit) => commit.files).some((file) => file.path === 'unmerged.txt')).toBe(false);
  });

  it('does not change the branch, tracked modifications or untracked files', async () => {
    const before = await git(['status', '--porcelain', '-z']);
    const branch = await git(['symbolic-ref', 'HEAD']);
    await collectLocalHistory({ repositoryPath: repo, ref: 'HEAD', startAt, endAt });
    expect(await git(['status', '--porcelain', '-z'])).toBe(before);
    expect(await git(['symbolic-ref', 'HEAD'])).toBe(branch);
    expect(await readFile(join(repo, '[한글] renamed.txt'), 'utf8')).toBe('dirty working tree\n');
  });

  it('treats a rename as deletion and addition when requested through another ref', async () => {
    const result = await collectLocalHistory({
      repositoryPath: repo, ref: 'feature', startAt: '2026-01-01T00:00:00Z', endAt,
    });
    expect(result.commits.find((commit) => commit.message === 'older child')?.files).toEqual([
      { status: 'A', path: '[한글] renamed.txt' }, { status: 'D', path: 'original.txt' },
    ]);
  });

  it('rejects invalid directories and refs and reports zero matches normally', async () => {
    await expect(collectLocalHistory({ repositoryPath: root, ref: 'HEAD', startAt, endAt })).rejects.toThrow('Git');
    await expect(collectLocalHistory({ repositoryPath: repo, ref: '--all', startAt, endAt })).rejects.toThrow('ref');
    const result = await collectLocalHistory({ repositoryPath: repo, ref: 'HEAD', startAt: '2030-01-01T00:00:00Z', endAt: '2030-02-01T00:00:00Z' });
    expect(result.commits).toEqual([]);
  });

  it('resolves a subdirectory to its repository root and reports an unborn HEAD', async () => {
    const subdirectory = join(repo, 'nested');
    await mkdir(subdirectory);
    const result = await collectLocalHistory({ repositoryPath: subdirectory, ref: 'HEAD', startAt, endAt });
    expect(result.repositoryPath).toBe(await realpath(repo));
    expect(result.commits.map((commit) => commit.oid)).toEqual(history.commits.map((commit) => commit.oid));
    const empty = join(root, 'empty');
    await mkdir(empty);
    await git(['init', '-b', 'main', empty]);
    await expect(collectLocalHistory({ repositoryPath: empty, ref: 'HEAD', startAt, endAt })).rejects.toThrow('rev-parse');
  });

  it('rejects shallow history instead of claiming a partial history is complete', async () => {
    const shallow = join(root, 'shallow');
    await git(['clone', '--depth', '1', '--branch', 'main', pathToFileURL(repo).href, shallow]);
    await expect(collectLocalHistory({ repositoryPath: shallow, ref: 'HEAD', startAt, endAt })).rejects.toThrow('Shallow');
  });

  it.each(['../frontend', '/frontend', 'C:\\frontend', 'frontend/../backend'])('rejects a path outside the repository: %s', async (pathFilter) => {
    await expect(collectLocalHistory({ repositoryPath: repo, ref: 'HEAD', startAt, endAt, pathFilter })).rejects.toThrow('--path');
  });

  it('filters both commits and file lists while preserving first-parent merges and literal paths', async () => {
    const scoped = join(root, 'scoped');
    await mkdir(scoped);
    const scopedGit = (args: readonly string[], date?: string) => git(args, date, scoped);
    await scopedGit(['init', '-b', 'main']);
    for (const folder of ['frontend', 'frontend-backup', 'backend', '[ui]']) {
      await mkdir(join(scoped, folder));
    }
    for (const file of ['frontend/app.ts', 'frontend/old.ts', 'frontend-backup/app.ts', 'backend/api.ts', '[ui]/component.ts']) {
      await writeFile(join(scoped, file), 'initial\n');
    }
    await scopedGit(['add', '.']);
    await scopedGit(['commit', '-m', 'scoped root'], '2026-01-10T00:00:00Z');
    await writeFile(join(scoped, 'frontend/app.ts'), 'frontend change\n');
    await writeFile(join(scoped, 'backend/api.ts'), 'backend change\n');
    await scopedGit(['add', '.']);
    await scopedGit(['commit', '-m', 'mixed change'], '2026-01-11T00:00:00Z');
    await writeFile(join(scoped, 'backend/api.ts'), 'backend only\n');
    await scopedGit(['add', '.']);
    await scopedGit(['commit', '-m', 'backend only'], '2026-01-12T00:00:00Z');
    await scopedGit(['mv', 'frontend/old.ts', 'backend/moved.ts']);
    await scopedGit(['commit', '-m', 'move outside frontend'], '2026-01-13T00:00:00Z');
    await scopedGit(['checkout', '-b', 'topic']);
    await writeFile(join(scoped, 'frontend/topic.ts'), 'topic\n');
    await scopedGit(['add', '.']);
    await scopedGit(['commit', '-m', 'frontend topic'], '2026-01-14T00:00:00Z');
    await scopedGit(['checkout', 'main']);
    await scopedGit(['merge', '--no-ff', 'topic', '-m', 'merge frontend'], '2026-01-15T00:00:00Z');

    const input = { repositoryPath: scoped, ref: 'HEAD', startAt, endAt };
    const result = await collectLocalHistory({ ...input, pathFilter: '.\\frontend\\' });
    expect(result.pathFilter).toBe('frontend');
    expect(result.commits).toHaveLength(5);
    expect(result.commits.every((commit) => commit.files.length > 0 && commit.files.every((file) => file.path.startsWith('frontend/')))).toBe(true);
    expect(result.commits.some((commit) => commit.message === 'backend only')).toBe(false);
    expect(result.commits.find((commit) => commit.message === 'mixed change')?.files).toEqual([{ status: 'M', path: 'frontend/app.ts' }]);
    expect(result.commits.find((commit) => commit.message === 'move outside frontend')?.files).toEqual([{ status: 'D', path: 'frontend/old.ts' }]);
    expect(result.commits.find((commit) => commit.parentOids.length === 2)?.files).toEqual([{ status: 'A', path: 'frontend/topic.ts' }]);
    const literal = await collectLocalHistory({ ...input, pathFilter: '[ui]' });
    expect(literal.commits).toHaveLength(1);
    expect(literal.commits[0]?.files).toEqual([{ status: 'A', path: '[ui]/component.ts' }]);
    expect((await collectLocalHistory({ ...input, pathFilter: 'missing' })).commits).toEqual([]);
    const all = await collectLocalHistory({ ...input, pathFilter: '.' });
    expect(all.pathFilter).toBeNull();
    expect(all.commits).toHaveLength(6);

    const { stdout } = await execute(process.execPath, [
      join(projectRoot, 'apps', 'cli', 'dist', 'index.js'),
      'collect', '--repo', scoped, '--path', 'frontend', '--output', join(root, 'scoped-cli'),
    ], { cwd: projectRoot, timeout: 15_000 });
    const paths = JSON.parse(stdout) as { jsonPath: string; markdownPath: string };
    expect((JSON.parse(await readFile(paths.jsonPath, 'utf8')) as LocalHistory).pathFilter).toBe('frontend');
    expect(await readFile(paths.markdownPath, 'utf8')).toContain('경로 필터: frontend');
  }, 30_000);
});

describe('reports and actual CLI', () => {
  it('writes complete JSON and escaped Markdown without overwriting earlier output', async () => {
    const target = join(root, 'reports');
    const paths = await writeHistoryReports(history, target);
    expect(JSON.parse(await readFile(paths.jsonPath, 'utf8'))).toEqual(history);
    const markdown = await readFile(paths.markdownPath, 'utf8');
    expect(markdown).toContain('&lt;script&gt;title&lt;/script&gt;');
    expect(markdown).toContain('    <script>title</script>');
    expect(markdown).toContain('LLM 분석');
    await expect(writeHistoryReports(history, target)).rejects.toThrow('already exists');
    expect(await readFile(paths.markdownPath, 'utf8')).toBe(markdown);
    expect(renderHistoryMarkdown({ ...history, commits: [] })).toContain('해당 기간에 포함된 커밋이 없다');
  });

  it('runs the compiled Nest CLI and returns existing report files', async () => {
    const { stdout } = await execute(process.execPath, [
      join(projectRoot, 'apps', 'cli', 'dist', 'index.js'),
      'collect', '--repo', repo, '--period', '6m', '--output', join(root, 'cli-output'),
    ], { cwd: projectRoot, timeout: 15_000 });
    const result = JSON.parse(stdout) as { count: number; jsonPath: string; markdownPath: string };
    const saved = JSON.parse(await readFile(result.jsonPath, 'utf8')) as LocalHistory;
    expect(result.count).toBe(saved.commits.length);
    expect(saved.repositoryPath).toBe(await realpath(repo));
    expect(await readFile(result.markdownPath, 'utf8')).toContain('Git 커밋 수집 결과');
  }, 20_000);
});
