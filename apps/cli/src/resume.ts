import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeResumeBullet, RESUME_POLICY_VERSION, type ReviewContext } from '@git-analyze/core';
import { hash } from './analysis-cache.js';
import { object, readBoundedJson } from './analysis-input.js';
import { analysisSourceLines, renderAnalysisMarkdown, reserveAnalysisDirectory, saveAnalysisReports } from './analysis-report.js';
import { loadStoredReview, reviewScope, withReviewLock, type ReviewScope } from './review-store.js';
import { escapeMarkdownText as text } from './history-report.js';

export async function readResumeSnapshot(path: string, storeOverride?: string) {
  const report = object(await readBoundedJson(resolve(path), 32 * 1024 * 1024));
  if (report.schemaVersion !== 1 || report.status !== 'reviewed' || typeof report.storeDirectory !== 'string') throw new Error('Expected a review report');
  return { scope: reviewScope(report.scope), storeDirectory: resolve(storeOverride ?? report.storeDirectory),
    version: report.version, revision: report.revision, analysisVersion: report.analysisVersion };
}

export async function loadCurrentResumeReview(directory: string, snapshot: Awaited<ReturnType<typeof readResumeSnapshot>>) {
  const current = await loadStoredReview(directory, snapshot.scope);
  if (!current || current.version !== snapshot.version || current.stored.revision !== snapshot.revision
    || current.stored.analysisVersion !== snapshot.analysisVersion) throw new Error('Review snapshot is stale; refresh the review report before export');
  return current;
}

type LocalReview = Awaited<ReturnType<typeof loadCurrentResumeReview>>;
type ResumeReview = Pick<LocalReview, 'version'> & {
  context: ReviewContext;
  stored: Pick<LocalReview['stored'], 'state' | 'revision'>;
  saved: Pick<LocalReview['saved'], 'source'>;
};

export function buildResumeDraft(current: ResumeReview, claimIds: readonly string[], kind: 'achievement' | 'activity') {
  const bullet = composeResumeBullet(current.stored.state, current.context, claimIds, kind);
  const trace = bullet.clauses.map((clause) => ({ ...clause,
    confirmation: clause.confirmationId === null ? null : {
      record: current.stored.state.confirmations.find((record) => record.id === clause.confirmationId),
      event: current.stored.state.events.find((event) => event.id === clause.confirmationId),
    }, evidence: clause.evidence.map((reference) => {
      const excerpt = current.context.packet.excerpts.find((item) => hash(item.reference) === hash(reference));
      if (!excerpt) throw new Error('Missing original excerpt for selected claim');
      return { reference, excerptId: excerpt.id, commitOid: excerpt.commitOid, parentOid: excerpt.parentOid, path: excerpt.path, text: excerpt.text };
    }) }));
  const version = hash({ policyVersion: RESUME_POLICY_VERSION, reviewVersion: current.version, bullet });
  return { policyVersion: RESUME_POLICY_VERSION, version, source: current.saved.source, reviewVersion: current.version,
    reviewRevision: current.stored.revision, bullet, trace, review: current.stored.state };
}

export function renderResumeTrace(trace: ReturnType<typeof buildResumeDraft>['trace']) {
  return trace.flatMap((item) => [
    `- ${text(item.claimId)} / ${item.section} / 문자 위치 [${item.start}, ${item.end})`,
    ...(item.confirmation ? [`  - 사용자 확인: ${item.confirmation.record!.id} / ${text(item.confirmation.event!.actor)}`] : []),
    ...item.evidence.map((evidence) => `  - Git: ${evidence.commitOid} / ${text(evidence.path ?? '(커밋 메시지)')} / ${text(evidence.reference.locator ?? '(없음)')}`),
  ]);
}

export async function writeResumeDraft(scope: ReviewScope, current: ResumeReview, claimIds: readonly string[],
  kind: 'achievement' | 'activity', outputDirectory: string | undefined) {
  const draft = buildResumeDraft(current, claimIds, kind);
  const { bullet, trace, version } = draft;
  const result = { schemaVersion: 1, status: 'resume_draft', createdAt: new Date().toISOString(), scope, ...draft };
  const output = await reserveAnalysisDirectory(outputDirectory, 'resumes');
  const markdown = [`# ${bullet.kind === 'achievement' ? '완료 성과' : '활동'} 문장 초안`, '', `> ${text(bullet.text)}`, '',
    ...analysisSourceLines(current.saved.source), `- 검토 버전: ${current.version}`, `- 문장 버전: ${version}`,
    `- 사용자 확인 완료일: ${bullet.completion?.completedAt ?? '(미확인)'}`, '',
    '각 절은 선택한 주장 문구를 공백·끝 문장부호만 정리해 세미콜론으로 연결했다. 의미적 사실성과 문체는 사용자 검토가 필요하다.',
    '수집 기간은 활동 범위이며 완료일로 자동 해석하지 않는다. 철회 전 출력 파일은 당시 버전의 이력으로 남는다.', '',
    '## 문장 근거', '', ...renderResumeTrace(trace), '',
    renderAnalysisMarkdown(current.stored.state.analysis, current.saved.source, false, current.context.packet.complete, true)].join('\n');
  const files = await saveAnalysisReports(output, 'resume', result, markdown);
  return { status: 'resume_draft' as const, kind: bullet.kind, version, externalRequests: 0, ...files };
}

export async function executeResume(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    review: { type: 'string' }, claim: { type: 'string', multiple: true }, kind: { type: 'string' },
    'store-dir': { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.review?.trim() || !values.claim?.length) throw new Error('resume requires --review <review.json> and repeated --claim <id>');
  if (values.kind !== undefined && !['achievement', 'activity'].includes(values.kind)) throw new Error('Resume kind must be achievement or activity');
  for (const value of [values.output, values['store-dir']]) if (value !== undefined && !value.trim()) throw new Error('Resume paths cannot be empty');
  const snapshot = await readResumeSnapshot(values.review, values['store-dir']);
  const { scope, storeDirectory } = snapshot;
  return withReviewLock(storeDirectory, scope, async (directory) => {
    const current = await loadCurrentResumeReview(directory, snapshot);
    return writeResumeDraft(scope, current, values.claim!, values.kind === 'activity' ? 'activity' : 'achievement', values.output);
  });
}
