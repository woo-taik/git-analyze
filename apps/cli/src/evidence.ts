import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildLocalEvidence, CANDIDATE_RULE_VERSION, EXTRACTION_VERSION, prepareCandidates,
  type EvidenceLimits, type LocalEvidencePacket,
} from '@git-analyze/core';
import { inspectLocalEvidence, readLocalPatch } from '@git-analyze/providers';
import { escapeMarkdownText as text, writeReportPair } from './history-report.js';
import { parseHistory } from './prepare.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid candidate object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid candidate string');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid candidate array');
  return value.map(string);
}
function limit(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`Evidence limit must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

// Canonical serialization is independent of property insertion order, clock time and output location.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

async function loadCandidates(inputFile: string) {
  const info = await stat(inputFile);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Candidate input must be a file no larger than 32 MiB');
  let value: unknown;
  try { value = JSON.parse(await readFile(inputFile, 'utf8')) as unknown; }
  catch { throw new Error('Candidate input is not valid JSON'); }
  const input = object(value);
  if (input.schemaVersion !== 1 || input.ruleVersion !== CANDIDATE_RULE_VERSION || !Array.isArray(input.commits)) {
    throw new Error('Unsupported candidate schema or rule version');
  }
  const source = object(input.source);
  const records = input.commits.map(object);
  const history = parseHistory({ ...source, schemaVersion: 1, timezone: 'Asia/Seoul',
    dateBasis: 'committer', fileComparison: 'first-parent', collectedAt: input.preparedAt,
    commits: records.map((record) => record.original) });
  // Recalculate decisions/groups with the saved explicit overrides instead of trusting arbitrary group OIDs.
  const preparation = prepareCandidates({ commits: history.commits, identityEmails: strings(input.identityEmails),
    includeOids: records.filter((record) => strings(record.reasons).includes('manual_include')).map((record) => string(object(record.original).oid)),
    excludeOids: records.filter((record) => strings(record.reasons).includes('manual_exclude')).map((record) => string(object(record.original).oid)),
  });
  for (const record of records) {
    const expected = preparation.commits.find((commit) => commit.original.oid === object(record.original).oid);
    if (!expected || record.decision !== expected.decision || record.contribution !== expected.contribution
      || canonical(record.reasons) !== canonical(expected.reasons)) throw new Error('Candidate decisions do not match the saved rules');
  }
  return { history, preparation };
}

interface EvidenceReport {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly source: { readonly inputFile: string; readonly repositoryPath: string; readonly tipOid: string; readonly startAt: string; readonly endAt: string };
  readonly cache: { readonly hit: boolean; readonly key: string; readonly stored: boolean };
  readonly contentVersion: string;
  readonly packet: LocalEvidencePacket;
}

export function renderEvidenceMarkdown(report: EvidenceReport): string {
  const { packet } = report;
  const lines = ['# 코드 변경 근거 패킷', '',
    `- 후보 입력: ${text(report.source.inputFile)}`, `- 저장소: ${text(report.source.repositoryPath)}`,
    `- 경로: ${packet.pathFilter === null ? '(전체 저장소)' : text(packet.pathFilter)}`,
    `- 묶기: ${packet.selection.kind}; ${text(packet.selection.title)}`, `- 내용 버전: ${report.contentVersion}`,
    `- 추출 규칙: ${packet.extractionVersion}; 캐시 재사용: ${report.cache.hit}`,
    `- 수집 범위 완전성: ${packet.complete}; 발췌 UTF-8 바이트: ${packet.summary.excerptBytes}/${packet.limits.maxTotalBytes}`,
    `- 파일 ${packet.summary.files}개 / patch 발췌 ${packet.summary.patchExcerpts}개 / 생략·부분 파일 ${packet.summary.omittedOrPartialFiles}개`, '',
    '코드 변경 근거이며 성과·본인 기여 범위·선택 이유·테스트 성공을 확정하지 않는다.',
    '완전성은 선택한 커밋·경로의 추출 범위에만 해당한다. PR·이슈·실행 검증은 포함하지 않는다.',
    '여러 커밋을 선택한 경우 각 커밋의 첫 부모 대비 변경을 보존한다. 최종 상태의 합산 diff가 아니다.',
    '바이트 상한은 메시지와 patch 발췌 본문 합계다. JSON 메타데이터나 모델 토큰 상한이 아니다.',
    '파일 위치는 hunk 헤더, locator는 정규화한 첫 부모 비교 patch의 줄 번호를 가리킨다. 잘린 patch는 적용용 파일이 아니다.', '',
  ];
  for (const commit of packet.commits) {
    lines.push(`## ${commit.oid}`, '', `- 부모: ${commit.parentOid ?? '(최초 커밋)'}`,
      `- 원본 객체 검증: ${commit.available}; 작성자: ${text(commit.author.email)}; 커미터: ${text(commit.committer.email)}`,
      `- 작성 시각: ${commit.authoredAt}; 커미터 시각: ${commit.committedAt}`,
      `- 기록상 기여: ${commit.contribution}; 후보 상태: ${commit.decision}`,
      `- 선별 사유: ${commit.reasons.map(text).join(', ')}`,
      `- 수집 문제: ${commit.issues.map(text).join(', ') || '(없음)'}`, '');
    for (const file of commit.files) lines.push(`- ${text(file.status)} ${text(JSON.stringify(file.path))}: ${file.reason ?? 'complete'}`);
    lines.push('');
    for (const excerpt of packet.excerpts.filter((item) => item.commitOid === commit.oid)) {
      lines.push(`### ${text(excerpt.path === null ? '커밋 메시지' : JSON.stringify(excerpt.path))}`, '',
        `- 근거 ID: ${text(excerpt.id)}`, `- 위치: ${text(excerpt.locator)}; 완전성: ${excerpt.complete}`, '',
        ...excerpt.text.split('\n').map((line) => `    ${line}`), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function executeEvidence(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    input: { type: 'string' }, group: { type: 'string' }, commit: { type: 'string', multiple: true },
    title: { type: 'string' }, repo: { type: 'string' }, output: { type: 'string' },
    'max-file-bytes': { type: 'string' }, 'max-total-bytes': { type: 'string' }, 'max-files': { type: 'string' },
    'include-low-priority': { type: 'boolean' }, 'cache-dir': { type: 'string' }, 'no-cache': { type: 'boolean' },
  } });
  if (!values.input?.trim()) throw new Error('evidence requires --input <candidates.json>');
  if (Boolean(values.group) === Boolean(values.commit?.length)) throw new Error('Select either --group <id> or repeated --commit <full-oid>');
  for (const value of [values.group, values.title, values.repo, values.output, values['cache-dir']]) {
    if (value !== undefined && !value.trim()) throw new Error('Evidence options cannot be empty');
  }
  const limits: EvidenceLimits = {
    maxFileBytes: limit(values['max-file-bytes'], 16_384, 262_144),
    maxTotalBytes: limit(values['max-total-bytes'], 65_536, 1_048_576),
    maxFiles: limit(values['max-files'], 20, 100), includeLowPriority: values['include-low-priority'] ?? false,
  };
  const inputFile = resolve(values.input);
  const { history, preparation } = await loadCandidates(inputFile);
  const group = values.group === undefined ? undefined : preparation.groups.find((item) => item.id === values.group);
  if (values.group !== undefined && !group) throw new Error('Candidate group was not found');
  const commitOids = [...new Set(group?.commitOids ?? values.commit ?? [])].sort();
  if (!commitOids.length || commitOids.length > 20) throw new Error('Select between 1 and 20 commits per evidence packet');
  const selected = commitOids.map((oid) => {
    const commit = preparation.commits.find((item) => item.original.oid === oid);
    if (!commit || commit.decision === 'excluded') throw new Error('Selected commit is absent or excluded; use prepare --include first');
    return commit;
  });
  const selection: LocalEvidencePacket['selection'] = {
    kind: group ? 'group' : 'manual', title: values.title ?? group?.title ?? 'Explicit commit selection',
    groupId: group?.id ?? null, commitOids,
  };
  const inspected = await inspectLocalEvidence({ repositoryPath: values.repo ?? history.repositoryPath,
    tipOid: history.tipOid, pathFilter: history.pathFilter, commits: selected });
  // Local cache scope shares linked worktrees; moving to another clone gets a distinct scope.
  const repositoryScope = hash({ localGitDirectory: inspected.gitDirectory });
  const key = hash({ repositoryScope, gitVersion: inspected.gitVersion, diffEnvironment: inspected.diffEnvironment,
    version: EXTRACTION_VERSION, contributionMapping: preparation.identityEmails, ruleVersion: preparation.ruleVersion,
    pathFilter: inspected.pathFilter, selection, limits,
    commits: inspected.commits.map((commit) => ({ ...commit, selected: {
      oid: commit.selected.original.oid, message: commit.selected.original.message,
      parentOids: commit.selected.original.parentOids, decision: commit.selected.decision,
      contribution: commit.selected.contribution, reasons: commit.selected.reasons,
    } })),
  });
  const cacheDirectory = resolve(values['cache-dir'] ?? '.cache/evidence');
  const cacheFile = join(cacheDirectory, `${key}.json`);
  const sourceAvailable = inspected.commits.every((commit) => commit.available);
  let packet: LocalEvidencePacket | undefined;
  let hit = false;
  let stored = false;
  if (!values['no-cache'] && sourceAvailable) {
    try {
      if ((await stat(cacheFile)).size > 16 * 1024 * 1024) throw new Error('Cache exceeds size limit');
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { key: string; contentVersion: string; packet: LocalEvidencePacket };
      if (cached.key !== key || cached.contentVersion !== hash(cached.packet)
        || cached.packet.schemaVersion !== 1 || cached.packet.extractionVersion !== EXTRACTION_VERSION
        || cached.packet.repositoryScope !== repositoryScope || !Array.isArray(cached.packet.excerpts)
        || !Array.isArray(cached.packet.commits) || cached.packet.commits.some((commit) =>
          typeof commit.available !== 'boolean' || typeof commit.author?.email !== 'string'
          || typeof commit.committer?.email !== 'string' || typeof commit.authoredAt !== 'string'
          || typeof commit.committedAt !== 'string')) throw new Error('Invalid extraction cache');
      packet = cached.packet; hit = true; stored = true;
    } catch { /* Missing, corrupt or outdated caches are rebuilt from verified local objects. */ }
  }
  if (!packet) {
    packet = await buildLocalEvidence({ repositoryScope, pathFilter: inspected.pathFilter, selection,
      commits: inspected.commits, limits,
      readPatch: (commit, change, maxBytes) => readLocalPatch(inspected.repositoryPath, commit, change, maxBytes) });
    const hasUnavailable = packet.commits.some((commit) => commit.issues.length || commit.files.some((file) => file.reason === 'unavailable'));
    if (!values['no-cache'] && sourceAvailable && !hasUnavailable) {
      await mkdir(cacheDirectory, { recursive: true });
      const temporaryFile = join(cacheDirectory, `${key}-${randomUUID()}.tmp`);
      await writeFile(temporaryFile, canonical({ key, contentVersion: hash(packet), packet }), { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryFile, cacheFile);
      stored = true;
    }
  }
  const report: EvidenceReport = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    source: { inputFile, repositoryPath: inspected.repositoryPath, tipOid: history.tipOid, startAt: history.startAt, endAt: history.endAt },
    cache: { hit, key, stored }, contentVersion: hash(packet), packet,
  };
  const files = await writeReportPair('evidence', report, renderEvidenceMarkdown(report), values.output);
  return { ...packet.summary, complete: packet.complete, contentVersion: report.contentVersion, cache: report.cache, ...files };
}
