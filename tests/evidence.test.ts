import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executePrepare } from '../apps/cli/src/prepare.js';
import { executeEvidence } from '../apps/cli/src/evidence.js';
import { linePrefix, utf8Bytes } from '../packages/core/src/evidence-extraction.js';
import { toEvidencePacket, type LocalEvidencePacket } from '../packages/core/src/index.js';
import { collectLocalHistory, type LocalHistory } from '../packages/providers/src/git/local-history.js';
import { readGit } from '../packages/providers/src/git/command.js';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const email = 'fixture@example.com';
let temporaryBase: string;
let root: string;
let repo: string;
let input: string;
let history: LocalHistory;
let sequence = 0;
async function git(args: readonly string[]) {
  return (await execute('git', ['-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false',
    '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args], {
    cwd: repo, timeout: 15_000, windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: '2026-01-15T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-15T00:00:00Z' },
  })).stdout;
}
async function save(path: string, contents: string | Buffer) {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), contents);
}
async function commit(message: string) {
  await git(['add', '.']);
  await git(['commit', '-m', message]);
}
const oid = (message: string) => history.commits.find((item) => item.message === message)!.oid;
function options(extra: string[] = [], selected = oid('root')) {
  return ['--input', input, '--commit', selected, '--cache-dir', join(root, 'cache'),
    '--output', join(root, `evidence-${sequence++}`), ...extra];
}
async function packet(result: Awaited<ReturnType<typeof executeEvidence>>) {
  return JSON.parse(await readFile(result.jsonPath, 'utf8'));
}

beforeAll(async () => {
  temporaryBase = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryBase, 'git-analyze-evidence-'));
  repo = join(root, '한글 repo');
  await mkdir(repo);
  await git(['init', '-b', 'main']);
  await save('frontend/src/app.ts', 'export const count = 1;\n');
  await save('frontend/pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await save('frontend/dist/generated.js', 'generated\n');
  await save('frontend/[ui]/한글.txt', '원본\n');
  await save('backend/private.ts', 'OUTSIDE_BACKEND\n');
  await save('frontend-backup/old.ts', 'OUTSIDE_BACKUP\n');
  await commit('root');
  await save('frontend/src/app.ts', 'export const count = 2;\n');
  await save('frontend/image.bin', Buffer.from([1, 0, 2, 3]));
  await commit('feature');
  await git(['rm', 'frontend/src/app.ts']);
  await git(['mv', 'frontend/[ui]/한글.txt', 'frontend/[ui]/renamed.txt']);
  await commit('delete and rename');
  await save('frontend/large.txt', '긴 변경 사항 한글\n'.repeat(15_000));
  await commit('large');
  const rootOid = (await git(['rev-list', '--max-parents=0', 'HEAD'])).trim();
  await save('frontend/gitlink-note.txt', 'submodule reference\n');
  await git(['add', 'frontend/gitlink-note.txt']);
  await git(['update-index', '--add', '--cacheinfo', `160000,${rootOid},frontend/submodule`]);
  await git(['commit', '-m', 'gitlink']);
  await git(['checkout', '-b', 'feature']);
  await save('frontend/branch.txt', 'feature branch\n');
  await git(['add', 'frontend/branch.txt']);
  await git(['commit', '-m', 'branch work']);
  await git(['checkout', 'main']);
  await save('frontend/main.txt', 'main branch\n');
  await git(['add', 'frontend/main.txt']);
  await git(['commit', '-m', 'main work']);
  await git(['merge', '--no-ff', 'feature', '-m', 'merge feature']);
  history = await collectLocalHistory({ repositoryPath: repo, ref: 'HEAD', pathFilter: 'frontend',
    startAt: '2026-01-10T00:00:00Z', endAt: '2026-01-21T00:00:00Z' });
  const source = join(root, 'history.json');
  await writeFile(source, JSON.stringify(history));
  input = (await executePrepare(['--input', source, '--author', email, '--output', join(root, 'candidates')])).jsonPath;
  await save('frontend/dirty.txt', 'untracked working tree\n');
}, 30_000);

afterAll(async () => {
  if (!root) return;
  if (dirname(root) !== temporaryBase || !basename(root).startsWith('git-analyze-evidence-')) {
    throw new Error('Refusing to delete a path outside the test temporary directory');
  }
  await rm(root, { recursive: true, force: true });
});

describe('bounded local evidence', () => {
  it('clips at complete UTF-8 lines and never counts characters as bytes', () => {
    const text = '한글\nsecond\n';
    expect(utf8Bytes('한글')).toBe(6);
    expect(linePrefix(text, 6)).toBe('');
    expect(linePrefix(text, 8)).toBe('한글\n');
    expect(linePrefix(text, 100)).toBe(text);
  });

  it('collects root changes only within the path, retaining low-priority omissions and source state', async () => {
    const before = { status: await git(['status', '--porcelain=v1']), head: await git(['rev-parse', 'HEAD']), input: await readFile(input) };
    const result = await executeEvidence(options(['--no-cache']));
    const report = await packet(result);
    expect(result).toMatchObject({ complete: false, files: 4, patchExcerpts: 2, omittedOrPartialFiles: 2 });
    expect(report.packet.commits[0].parentOid).toBeNull();
    expect(report.packet.commits[0].files.filter((file: { reason: string }) => file.reason === 'low_priority')).toHaveLength(2);
    const patches = report.packet.excerpts.filter((excerpt: { path: string | null }) => excerpt.path !== null);
    expect(patches.some((excerpt: { text: string }) => excerpt.text.includes('+export const count = 1;'))).toBe(true);
    expect(patches.some((excerpt: { text: string }) => excerpt.text.includes('+원본'))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/OUTSIDE_BACKEND|OUTSIDE_BACKUP|dirty\.txt/);
    expect(await git(['status', '--porcelain=v1'])).toBe(before.status);
    expect(await git(['rev-parse', 'HEAD'])).toBe(before.head);
    expect(await readFile(input)).toEqual(before.input);
  });

  it('supports group selection and explicit multi-commit grouping without net-diff inference', async () => {
    const groupId = `candidate:commit:${oid('feature')}`;
    const result = await executeEvidence(['--input', input, '--group', groupId, '--no-cache', '--output', join(root, `group-${sequence++}`)]);
    const report = await packet(result);
    expect(report.packet.selection).toMatchObject({ kind: 'group', groupId, commitOids: [oid('feature')] });
    const combined = await packet(await executeEvidence(options(['--commit', oid('feature'), '--title', '<script>manual</script>', '--no-cache'])));
    expect(combined.packet.selection.commitOids).toEqual([oid('root'), oid('feature')].sort());
    expect(combined.packet.commits).toHaveLength(2);
    expect(combined.packet.excerpts.filter((excerpt: { path: string }) => excerpt.path === 'frontend/src/app.ts')).toHaveLength(2);
  });

  it('maps a real CLI report to scoped analysis input without losing extraction provenance', async () => {
    const result = await executeEvidence(options(['--commit', oid('feature'), '--no-cache']));
    const report = JSON.parse(await readFile(result.jsonPath, 'utf8')) as {
      packet: LocalEvidencePacket; contentVersion: string;
    };
    const sources = report.packet.commits.map((commit) => ({ ownerId: 'fixture-owner', repositoryId: 'fixture-repo',
      commitOid: commit.oid, sourceRecordId: `fixture-record:${commit.oid}`, sourceVersion: commit.oid }));
    const mapped = await toEvidencePacket({ ownerId: 'fixture-owner', repositoryId: 'fixture-repo',
      workItemId: 'fixture-work', packet: report.packet, contentVersion: report.contentVersion, sources });
    const again = await toEvidencePacket({ ownerId: 'fixture-owner', repositoryId: 'fixture-repo',
      workItemId: 'fixture-work', packet: report.packet, contentVersion: report.contentVersion, sources: [...sources].reverse() });
    expect(mapped).toEqual(again);
    expect(mapped.provenance.local.commits).toHaveLength(2);
    expect(mapped.complete).toBe(false);
    expect(mapped.provenance.local.commits.flatMap((commit) => commit.files).map((file) => file.reason))
      .toContain('binary');
    const reconstructed = { ...mapped.provenance.local, complete: mapped.complete,
      excerpts: mapped.excerpts.map((excerpt) => ({ id: excerpt.id, commitOid: excerpt.commitOid,
        parentOid: excerpt.parentOid, path: excerpt.path, locator: excerpt.reference.locator,
        text: excerpt.text, complete: excerpt.complete })) };
    expect(reconstructed).toEqual(report.packet);
    expect(mapped.excerpts.every((excerpt) => excerpt.reference.sourceRecordId === `fixture-record:${excerpt.commitOid}`)).toBe(true);
    expect(mapped).not.toHaveProperty('source.repositoryPath');
  });

  it('distinguishes binary omissions and preserves deletion/rename-as-delete-add patches', async () => {
    const feature = await packet(await executeEvidence(options(['--no-cache'], oid('feature'))));
    expect(feature.packet.commits[0].files.find((file: { path: string }) => file.path.endsWith('image.bin')).reason).toBe('binary');
    const deleted = await packet(await executeEvidence(options(['--no-cache'], oid('delete and rename'))));
    expect(deleted.packet.complete).toBe(true);
    expect(deleted.packet.commits[0].files.map((file: { status: string }) => file.status).sort()).toEqual(['A', 'D', 'D']);
    expect(deleted.packet.excerpts.some((excerpt: { text: string }) => excerpt.text.includes('-export const count = 2;'))).toBe(true);
  });

  it('marks submodules without traversing or fetching them', async () => {
    const report = await packet(await executeEvidence(options(['--no-cache'], oid('gitlink'))));
    expect(report.packet.complete).toBe(false);
    expect(report.packet.commits[0].files.find((file: { path: string }) => file.path === 'frontend/submodule').reason).toBe('submodule');
    expect(report.packet.summary.patchExcerpts).toBe(1);
  });

  it('compares a selected merge to its first parent and preserves its review status', async () => {
    const report = await packet(await executeEvidence(options(['--no-cache'], oid('merge feature'))));
    expect(report.packet.commits).toMatchObject([{ issues: [], files: [{ path: 'frontend/branch.txt', reason: null }] }]);
    expect(report.packet.complete).toBe(true);
    expect(report.packet.commits[0]).toMatchObject({ decision: 'review', parentOid: history.commits.find((item) => item.oid === oid('merge feature'))?.parentOids[0] });
    expect(report.packet.commits[0].reasons).toContain('merge_commit');
    expect(report.packet.commits[0].files.map((file: { path: string }) => file.path)).toEqual(['frontend/branch.txt']);
  });

  it('enforces file, total-byte and file-count limits and allows low-priority override', async () => {
    const partial = await packet(await executeEvidence(options(['--no-cache', '--max-file-bytes', '512'], oid('large'))));
    expect(partial.packet.commits[0].files[0].reason).toBe('file_budget');
    expect(partial.packet.excerpts.find((excerpt: { path: string }) => excerpt.path)?.text).not.toContain('�');
    expect(partial.packet.excerpts.filter((excerpt: { path: string | null }) => excerpt.path !== null)
      .every((excerpt: { text: string }) => Buffer.byteLength(excerpt.text) <= 512)).toBe(true);
    const total = await packet(await executeEvidence(options(['--no-cache', '--max-total-bytes', '10'], oid('large'))));
    expect(total.packet.summary.excerptBytes).toBeLessThanOrEqual(10);
    expect(total.packet.complete).toBe(false);
    const files = await packet(await executeEvidence(options(['--no-cache', '--include-low-priority', '--max-files', '1'])));
    expect(files.packet.summary.patchExcerpts).toBe(1);
    expect(files.packet.commits[0].files.some((file: { reason: string }) => file.reason === 'file_limit')).toBe(true);
    const all = await executeEvidence(options(['--no-cache', '--include-low-priority']));
    expect(all).toMatchObject({ complete: true, patchExcerpts: 4 });
  });

  it('reuses content across output locations and observation times but invalidates policy changes', async () => {
    const first = await executeEvidence(options(['--include-low-priority']));
    expect(first.cache.hit).toBe(false);
    const second = await executeEvidence(options(['--include-low-priority']));
    expect(second.cache.hit).toBe(true);
    expect(second.contentVersion).toBe(first.contentVersion);
    const saved = JSON.parse(await readFile(input, 'utf8'));
    saved.preparedAt = '2026-02-01T00:00:00Z';
    for (const record of saved.commits) record.original.observedAt = '2026-02-01T00:00:00Z';
    const copiedInput = join(root, 'copied-candidates.json');
    await writeFile(copiedInput, JSON.stringify(saved));
    const copiedOptions = options(['--include-low-priority']);
    copiedOptions[1] = copiedInput;
    const copied = await executeEvidence(copiedOptions);
    expect(copied.cache.hit).toBe(true);
    expect(copied.contentVersion).toBe(first.contentVersion);
    const changed = await executeEvidence(options(['--include-low-priority', '--max-file-bytes', '1000']));
    expect(changed.cache.key).not.toBe(first.cache.key);
    expect(changed.cache.hit).toBe(false);
    // Corrupt caches are rebuilt, not returned as successful packets.
    await writeFile(join(root, 'cache', `${first.cache.key}.json`), '{broken');
    const repaired = await executeEvidence(options(['--include-low-priority']));
    expect(repaired.cache.hit).toBe(false);
    expect(repaired.contentVersion).toBe(first.contentVersion);
    await git(['config', 'diff.context', '7']);
    const environmentChanged = await executeEvidence(options(['--include-low-priority']));
    expect(environmentChanged.cache.key).not.toBe(first.cache.key);
    await git(['config', '--unset', 'diff.context']);
  }, 30_000);

  it('isolates cache entries by repository and literal path scope', async () => {
    const first = await executeEvidence(options());
    const saved = JSON.parse(await readFile(input, 'utf8'));
    saved.source.pathFilter = 'frontend/[ui]';
    const narrowInput = join(root, 'narrow-candidates.json');
    await writeFile(narrowInput, JSON.stringify(saved));
    const narrowOptions = options(); narrowOptions[1] = narrowInput;
    const narrow = await executeEvidence(narrowOptions);
    expect(narrow.cache.key).not.toBe(first.cache.key);
    expect(narrow).toMatchObject({ files: 1, patchExcerpts: 1, complete: true });
    const clonePath = join(root, 'another-clone');
    await git(['clone', '--no-local', repo, clonePath]);
    const cloned = await executeEvidence(options(['--repo', clonePath]));
    expect(cloned.cache.hit).toBe(false);
    expect(cloned.cache.key).not.toBe(first.cache.key);
    expect((await packet(cloned)).packet.repositoryScope).not.toBe((await packet(first)).packet.repositoryScope);
  }, 30_000);

  it('does not hide a subsequently missing blob behind a cached packet', async () => {
    await executeEvidence(options(['--include-low-priority']));
    const blobOid = (await git(['rev-parse', `${oid('root')}:frontend/src/app.ts`])).trim();
    const blobPath = resolve(repo, (await git(['rev-parse', '--git-path', `objects/${blobOid.slice(0, 2)}/${blobOid.slice(2)}`])).trim());
    const relativeBlob = relative(root, blobPath);
    if (isAbsolute(relativeBlob) || relativeBlob.startsWith('..')) throw new Error('Blob path escaped test directory');
    const backupPath = join(root, 'temporarily-unavailable-blob');
    await rename(blobPath, backupPath);
    try {
      const result = await executeEvidence(options(['--include-low-priority']));
      expect(result).toMatchObject({ complete: false, cache: { hit: false, stored: false } });
      expect((await packet(result)).packet.commits[0].issues).toContain('blob_object_unavailable');
    } finally { await rename(backupPath, blobPath); }
  });

  it('rejects forged metadata and reports unavailable selected objects without caching them', async () => {
    const saved = JSON.parse(await readFile(input, 'utf8'));
    const record = saved.commits.find((item: { original: { oid: string } }) => item.original.oid === oid('root'));
    record.original.message = 'forged message';
    const forgedInput = join(root, 'forged.json');
    await writeFile(forgedInput, JSON.stringify(saved));
    const forgedOptions = options(); forgedOptions[1] = forgedInput;
    await expect(executeEvidence(forgedOptions)).rejects.toThrow('metadata');
    record.original.oid = 'f'.repeat(40);
    await writeFile(forgedInput, JSON.stringify(saved));
    const unavailableOptions = options([], record.original.oid); unavailableOptions[1] = forgedInput;
    const unavailable = await executeEvidence(unavailableOptions);
    expect(unavailable).toMatchObject({ complete: false, patchExcerpts: 0, cache: { hit: false, stored: false } });
    expect((await packet(unavailable)).packet.commits[0].issues).toContain('commit_object_unavailable');
  });

  it('runs the compiled CLI and renders untrusted titles as text while refusing existing output directories', async () => {
    const cliOptions = options(['--title', '<script>title</script>', '--no-cache'], oid('delete and rename'));
    const { stdout } = await execute(process.execPath, ['apps/cli/dist/index.js', 'evidence', ...cliOptions], { cwd: projectRoot, timeout: 20_000 });
    const result = JSON.parse(stdout);
    const markdown = await readFile(result.markdownPath, 'utf8');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('first-parent-patch-lines');
    const original = await readFile(result.jsonPath);
    await expect(executeEvidence(cliOptions)).rejects.toThrow('already exists');
    expect(await readFile(result.jsonPath)).toEqual(original);
  });

  it('bounds subprocess output while marking an incomplete prefix', async () => {
    const result = await readGit(repo, ['show', `${oid('large')}:frontend/large.txt`], 100);
    expect(result.bytes.length).toBe(100);
    expect(result.complete).toBe(false);
  });

  it('rejects invalid selectors, limits, unknown or excluded commits', async () => {
    await expect(executeEvidence([])).rejects.toThrow('--input');
    await expect(executeEvidence(['--input', input])).rejects.toThrow('either');
    await expect(executeEvidence([...options(), '--group', 'unused'])).rejects.toThrow('either');
    await expect(executeEvidence(options(['--max-files', '0']))).rejects.toThrow('integer');
    await expect(executeEvidence(options(['--max-total-bytes', '999999999']))).rejects.toThrow('integer');
    await expect(executeEvidence(options([], 'unknown'))).rejects.toThrow('absent');
    const source = join(root, 'excluded-history.json');
    await writeFile(source, JSON.stringify(history));
    const excluded = await executePrepare(['--input', source, '--author', email, '--exclude', oid('root'), '--output', join(root, 'excluded')]);
    const excludedOptions = options(); excludedOptions[1] = excluded.jsonPath;
    await expect(executeEvidence(excludedOptions)).rejects.toThrow('excluded');
  });
});
