import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { LocalHistory } from '@git-analyze/providers';

function text(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
}

export function renderHistoryMarkdown(history: LocalHistory): string {
  const lines = [
    '# Git 커밋 수집 결과', '',
    `- 저장소: ${text(history.repositoryPath)}`,
    `- 경로 필터: ${history.pathFilter ? text(history.pathFilter) : '(전체 저장소)'}`,
    `- Ref: ${text(history.ref)} (${history.tipOid})`,
    `- 기간: [${history.startAt}, ${history.endAt})`,
    '- 시간 기준: 커미터 날짜. 기간 계산 시간대: Asia/Seoul.',
    `- 수집 시각: ${history.collectedAt}`,
    `- 커밋 수: ${history.commits.length}`, '',
    '선택한 ref에서 도달 가능한 모든 작성자의 커밋이다. 작성자 필터·미커밋 변경·원격 갱신은 포함하지 않는다.',
    '경로 필터를 지정하면 해당 경로에 변경 파일이 있는 커밋만 남기고, 파일 목록도 그 경로로 제한한다. 커밋 메시지는 원문을 유지한다.',
    '변경 파일은 첫 부모와 비교하며, 최초 커밋은 빈 트리와 비교한다. 이름 변경은 삭제와 추가로 표시하고 submodule 변경은 수집하지 않는다.',
    '코드 patch·LLM 분석·이력서 성과 문장은 포함하지 않는다. 커밋 시각을 실제 배포일이나 완료일로 해석하지 않는다.', '',
  ];
  if (!history.commits.length) lines.push('해당 기간에 포함된 커밋이 없다.', '');
  for (const commit of history.commits) {
    const subject = commit.message.split(/\r?\n/)[0] || '(메시지 없음)';
    lines.push(
      `## ${commit.oid.slice(0, 12)} ${text(subject)}`, '',
      `- OID: ${commit.oid}`,
      `- 부모: ${commit.parentOids.join(', ') || '(최초 커밋)'}`,
      `- 작성자: ${text(commit.author.name)} (${text(commit.author.email)})`,
      `- 커미터: ${text(commit.committer.name)} (${text(commit.committer.email)})`,
      `- 작성: ${commit.authoredAt}; 커미터: ${commit.committedAt}; 관측: ${commit.observedAt}`,
      '', '커밋 메시지:', '',
      ...commit.message.split(/\r?\n/).map((line) => `    ${line}`),
      '', '변경 파일:', '',
      ...commit.files.map((file) => `- ${text(file.status)} ${text(JSON.stringify(file.path))}`),
      ...(commit.files.length ? [] : ['- 파일 변경 없음']), '',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function writeHistoryReports(history: LocalHistory, outputDirectory?: string) {
  const directory = resolve(outputDirectory ?? join(
    '.data', 'collections', `${Date.now()}-${randomUUID().slice(0, 8)}`,
  ));
  await mkdir(dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch {
    throw new Error('Output directory already exists or cannot be created. Choose a new --output directory.');
  }
  const jsonPath = join(directory, 'history.json');
  const markdownPath = join(directory, 'history.md');
  await writeFile(jsonPath, `${JSON.stringify(history, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(markdownPath, renderHistoryMarkdown(history), { encoding: 'utf8', flag: 'wx' });
  return { jsonPath, markdownPath };
}
