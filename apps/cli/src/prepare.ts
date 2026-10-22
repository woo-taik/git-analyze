import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareCandidates } from '@git-analyze/core';
import type { LocalCommit, LocalHistory } from '@git-analyze/providers';
import { writeCandidateReports, type PreparedCandidateReport } from './candidate-report.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history object');
  return value as Record<string, unknown>;
}

function string(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new Error('Invalid history string field');
  return value;
}

function timestamp(value: unknown): string {
  const result = string(value);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error('Invalid history timestamp');
  }
  return result;
}

function oid(value: unknown): string {
  const result = string(value);
  if (!OID.test(result)) throw new Error('Invalid history commit OID');
  return result;
}

export function parseHistory(value: unknown): LocalHistory {
  const source = object(value);
  if (source.schemaVersion !== 1 || source.timezone !== 'Asia/Seoul'
    || source.dateBasis !== 'committer' || source.fileComparison !== 'first-parent'
    || !Array.isArray(source.commits) || source.commits.length > 1_000) {
    throw new Error('Unsupported history schema or more than 1,000 input commits');
  }
  const startAt = timestamp(source.startAt);
  const endAt = timestamp(source.endAt);
  if (Date.parse(startAt) >= Date.parse(endAt)) throw new Error('Invalid history time range');
  const commits: LocalCommit[] = source.commits.map((value: unknown) => {
    const commit = object(value);
    const author = object(commit.author);
    const committer = object(commit.committer);
    if (!Array.isArray(commit.parentOids) || !Array.isArray(commit.files)) throw new Error('Invalid history commit arrays');
    const committedAt = timestamp(commit.committedAt);
    if (Date.parse(committedAt) < Date.parse(startAt) || Date.parse(committedAt) >= Date.parse(endAt)) {
      throw new Error('Input commit is outside the declared history period');
    }
    return {
      oid: oid(commit.oid), parentOids: commit.parentOids.map(oid),
      author: { name: string(author.name, true), email: string(author.email, true) },
      committer: { name: string(committer.name, true), email: string(committer.email, true) },
      authoredAt: timestamp(commit.authoredAt), committedAt, observedAt: timestamp(commit.observedAt),
      message: string(commit.message, true),
      files: commit.files.map((value: unknown) => {
        const file = object(value);
        const status = string(file.status);
        if (!/^[A-Z][0-9]*$/.test(status)) throw new Error('Invalid history file status');
        return { status, path: string(file.path) };
      }),
    };
  });
  return {
    schemaVersion: 1, repositoryPath: string(source.repositoryPath),
    pathFilter: source.pathFilter == null ? null : string(source.pathFilter),
    ref: string(source.ref), tipOid: oid(source.tipOid), collectedAt: timestamp(source.collectedAt),
    startAt, endAt, timezone: 'Asia/Seoul', dateBasis: 'committer', fileComparison: 'first-parent', commits,
  };
}

export async function executePrepare(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args], strict: true, allowPositionals: false,
    options: {
      input: { type: 'string' }, author: { type: 'string', multiple: true },
      alias: { type: 'string', multiple: true }, output: { type: 'string' },
      include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    },
  });
  if (!values.input?.trim()) throw new Error('prepare requires --input <history.json>');
  if (!values.author?.length) throw new Error('prepare requires --author <email>');
  if (values.output !== undefined && !values.output.trim()) throw new Error('Invalid --output');
  const inputFile = resolve(values.input);
  const info = await stat(inputFile);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('History input must be a file no larger than 32 MiB');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputFile, 'utf8')) as unknown;
  } catch {
    throw new Error('History input is not valid UTF-8 JSON');
  }
  const history = parseHistory(value);
  const preparation = prepareCandidates({
    commits: history.commits,
    identityEmails: [...values.author, ...(values.alias ?? [])],
    includeOids: values.include ?? [], excludeOids: values.exclude ?? [],
  });
  const report: PreparedCandidateReport = {
    ...preparation, preparedAt: new Date().toISOString(),
    source: {
      inputFile, repositoryPath: history.repositoryPath, pathFilter: history.pathFilter,
      ref: history.ref, tipOid: history.tipOid, startAt: history.startAt, endAt: history.endAt,
    },
  };
  const files = await writeCandidateReports(report, values.output);
  return { ...report.summary, ...files };
}
