import type { CandidatePreparation, CandidateReason, PreparedCommit } from '@git-analyze/core';
import { escapeMarkdownText as text, writeReportPair } from './history-report.js';

export interface PreparedCandidateReport extends CandidatePreparation {
  readonly preparedAt: string;
  readonly source: {
    readonly inputFile: string;
    readonly repositoryPath: string;
    readonly pathFilter: string | null;
    readonly ref: string;
    readonly tipOid: string;
    readonly startAt: string;
    readonly endAt: string;
  };
}

const REASONS = {
  author_matched: '작성자 이메일 일치', co_author_trailer: '공동 작성 trailer 확인 필요',
  committer_only: '커미터만 일치: 작성 기여 미확인', identity_not_matched: '지정한 이메일과 일치하지 않음',
  merge_commit: '병합 커밋: 중복·해결 변경 확인 필요', low_priority_files_only: 'lockfile·생성 경로 등 낮은 우선순위 파일만 변경',
  no_file_changes: '변경 파일 없음', multiple_issue_references: '여러 참조가 있어 자동 묶기 보류',
  manual_include: '사용자가 후보 포함 선택', manual_exclude: '사용자가 제외 선택',
} satisfies Record<CandidateReason, string>;

function describe(commit: PreparedCommit): string {
  return [
    `- ${commit.original.oid}: ${text(commit.original.message.split(/\r?\n/)[0] || '(메시지 없음)')}`,
    `  - 작성자: ${text(commit.original.author.email)}; 커미터: ${text(commit.original.committer.email)}`,
    `  - 기여 구분: ${commit.contribution}; 상태: ${commit.decision}`,
    `  - 사유: ${commit.reasons.map((reason) => REASONS[reason]).join('; ')}`,
    `  - 파일 ${commit.original.files.length}개, 낮은 우선순위 파일 ${commit.lowPriorityFiles.length}개`,
  ].join('\n');
}

export function renderCandidateMarkdown(report: PreparedCandidateReport): string {
  const { summary, source } = report;
  const lines = [
    '# 성과 후보 선별 결과', '',
    `- 원본: ${text(source.inputFile)}`,
    `- 저장소: ${text(source.repositoryPath)}`,
    `- 경로: ${source.pathFilter ? text(source.pathFilter) : '(전체 저장소)'}`,
    `- 기준 커밋: ${source.tipOid}; ref: ${text(source.ref)}`,
    `- 원본 기간: [${source.startAt}, ${source.endAt})`,
    `- 선택 이메일: ${report.identityEmails.map(text).join(', ')}`,
    `- 규칙 버전: ${report.ruleVersion}; 처리 시각: ${report.preparedAt}`,
    `- 입력 ${summary.inputCommits}건, 중복 ${summary.duplicateCommits}건`,
    `- 분석 후보 ${summary.candidateCommits}건 / 검토 필요 ${summary.reviewCommits}건 / 제외 ${summary.excludedCommits}건`,
    `- 분석 후보 묶음 ${summary.candidateGroups}개 / 검토 묶음 ${summary.reviewGroups}개`, '',
    '이 결과는 분석할 후보이며 이력서 성과·본인 기여의 범위·업무 완료를 확정하지 않는다.',
    '작성자·커미터·공동 작성 기록을 구분한다. 병합과 낮은 우선순위 변경은 삭제하지 않고 검토에 남긴다.',
    '명시적 참조로 묶은 결과도 같은 문제인지 확인해야 한다. 제목·경로·시간이 비슷하다는 이유로 합치지 않는다.',
    '수동 포함은 기여 확인이 아니다. 제외 사유와 원본 커밋·파일은 JSON에 모두 보존한다.', '',
  ];
  const byOid = new Map(report.commits.map((commit) => [commit.original.oid, commit]));
  for (const decision of ['candidate', 'review'] as const) {
    lines.push(decision === 'candidate' ? '## 분석 후보' : '## 검토 필요', '');
    const groups = report.groups.filter((group) => group.decision === decision);
    if (!groups.length) lines.push('해당 없음.', '');
    for (const group of groups) {
      lines.push(`### ${text(group.title)}`, '',
        `- ID: ${text(group.id)}`, `- 묶기: ${group.grouping}`, '');
      for (const oid of group.commitOids) lines.push(describe(byOid.get(oid)!), '');
    }
  }
  lines.push('## 제외 기록', '');
  const excluded = report.commits.filter((commit) => commit.decision === 'excluded');
  if (!excluded.length) lines.push('해당 없음.', '');
  for (const commit of excluded) lines.push(describe(commit), '');
  return `${lines.join('\n')}\n`;
}

export async function writeCandidateReports(report: PreparedCandidateReport, outputDirectory?: string) {
  return writeReportPair('candidates', report, renderCandidateMarkdown(report), outputDirectory);
}
