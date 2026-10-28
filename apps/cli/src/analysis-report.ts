import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ANALYSIS_CLAIM_FIELDS, type WorkItemAnalysis } from '@git-analyze/core';
import type { prepareOpenAiAnalysisRequest } from '@git-analyze/providers';
import { escapeMarkdownText as text } from './history-report.js';
import type { loadAnalysisInput } from './analysis-input.js';

export async function reserveAnalysisDirectory(output: string | undefined) {
  const directory = resolve(output ?? join('.data', 'analyses', `${Date.now()}-${randomUUID().slice(0, 8)}`));
  await mkdir(dirname(directory), { recursive: true });
  try { await mkdir(directory); }
  catch { throw new Error('Output directory already exists or cannot be created. Choose a new --output directory.'); }
  return directory;
}

export async function saveAnalysisReports(directory: string, stem: 'preview' | 'analysis' | 'failure', data: unknown, markdown: string) {
  const jsonPath = join(directory, `${stem}.json`);
  const markdownPath = join(directory, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await writeFile(markdownPath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { jsonPath, markdownPath };
}

type Source = Awaited<ReturnType<typeof loadAnalysisInput>>['source'];
export function analysisSourceLines(source: Source): string[] {
  return [`- 저장소: ${text(source.repositoryPath)}`, `- Ref: ${text(source.ref ?? '(기존 보고서에 없음)')} (${source.tipOid})`,
    `- 기간: [${source.startAt}, ${source.endAt}); Asia/Seoul 기준 수집 구간`,
    `- 분석 범위: ${text(source.pathFilter ?? '(전체 저장소)')}; 선택 커밋 ${source.commitCount}개`,
    `- 근거 입력: ${text(source.inputFile)}`, `- 원본 내용 버전: ${source.contentVersion}`];
}

export function renderPreviewMarkdown(source: Source, prepared: ReturnType<typeof prepareOpenAiAnalysisRequest>): string {
  const lines = ['# 외부 전송 미리보기', '', ...analysisSourceLines(source),
    `- 전송 입력 버전: ${prepared.receipt.inputVersion}`, `- 전송 근거 완전성: ${prepared.receipt.complete}`, '',
    '외부 요청 0회. 토큰 계산도 실행하지 않았다. 아래 본문은 제외·마스킹 적용 후의 전송 발췌다.',
    'JSON의 countRequest와 analysisRequest에는 지시문·출력 스키마를 포함한 전체 요청을 보존한다.', ''];
  for (const excerpt of prepared.validationPacket.excerpts) {
    lines.push(`## ${text(excerpt.id)}`, '',
      `- 원본: ${text(excerpt.reference.sourceRecordId)} / ${text(excerpt.reference.sourceVersion)}`,
      `- 위치: ${text(excerpt.reference.locator ?? '(없음)')}; 완전성: ${excerpt.complete}`, '',
      ...excerpt.text.split('\n').map((line) => `    ${line}`), '');
  }
  lines.push('## 전송 생략', '', ...prepared.receipt.omitted.map((item) => `- ${text(item.id)}: ${item.reason}`), '');
  return lines.join('\n');
}

const labels: Record<(typeof ANALYSIS_CLAIM_FIELDS)[number], string> = { problem: '문제', constraints: '제약',
  alternatives: '대안', decision: '선택과 이유', implementation: '구현', results: '결과', verification: '검증', contribution: '기여' };
export function renderAnalysisMarkdown(value: WorkItemAnalysis, source: Source, cacheHit: boolean, complete: boolean): string {
  const lines = ['# 작업 분석 초안', '', ...analysisSourceLines(source), `- 분석 입력 버전: ${value.inputVersion}`,
    `- 전송 근거 완전성: ${complete}; 캐시 재사용: ${cacheHit}`, '',
    '사용자 확인 전의 구조화 분석이다. 인용의 존재가 내용의 사실성·업무 완료·테스트 성공을 보장하지 않는다.',
    '캐시 재사용 시 usage는 최초 생성의 사용량이며 이번 실행의 새 청구량이 아니다.', ''];
  for (const field of ANALYSIS_CLAIM_FIELDS) {
    lines.push(`## ${labels[field]}`, '');
    if (!value[field].length) lines.push('- (근거 부족 또는 기록 없음)', '');
    for (const claim of value[field]) {
      lines.push(`- [${claim.status}] ${text(claim.text)} (${text(claim.id)})`);
      for (const evidence of claim.evidence) {
        lines.push(`  - 근거: ${text(evidence.sourceRecordId)} / ${text(evidence.sourceVersion)} / ${text(evidence.locator ?? '(없음)')}`);
      }
    }
    lines.push('');
  }
  lines.push('## 보충 질문', '', ...value.missingQuestions.map((question) => `- ${text(question)}`), '');
  return lines.join('\n');
}
