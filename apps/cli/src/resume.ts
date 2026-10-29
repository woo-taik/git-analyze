import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeResumeBullet, RESUME_POLICY_VERSION } from '@git-analyze/core';
import { hash } from './analysis-cache.js';
import { object, readBoundedJson } from './analysis-input.js';
import { analysisSourceLines, renderAnalysisMarkdown, reserveAnalysisDirectory, saveAnalysisReports } from './analysis-report.js';
import { loadStoredReview, reviewScope, withReviewLock } from './review-store.js';
import { escapeMarkdownText as text } from './history-report.js';

export async function executeResume(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    review: { type: 'string' }, claim: { type: 'string', multiple: true }, kind: { type: 'string' },
    'store-dir': { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.review?.trim() || !values.claim?.length) throw new Error('resume requires --review <review.json> and repeated --claim <id>');
  if (values.kind !== undefined && !['achievement', 'activity'].includes(values.kind)) throw new Error('Resume kind must be achievement or activity');
  for (const value of [values.output, values['store-dir']]) if (value !== undefined && !value.trim()) throw new Error('Resume paths cannot be empty');
  const report = object(await readBoundedJson(resolve(values.review), 32 * 1024 * 1024));
  if (report.schemaVersion !== 1 || report.status !== 'reviewed' || typeof report.storeDirectory !== 'string') throw new Error('Expected a review report');
  const scope = reviewScope(report.scope);
  const storeDirectory = resolve(values['store-dir'] ?? report.storeDirectory);
  return withReviewLock(storeDirectory, scope, async (directory) => {
    const current = await loadStoredReview(directory, scope);
    if (!current || current.version !== report.version || current.stored.revision !== report.revision
      || current.stored.analysisVersion !== report.analysisVersion) throw new Error('Review snapshot is stale; refresh the review report before export');
    const bullet = composeResumeBullet(current.stored.state, current.context, values.claim!, (values.kind ?? 'achievement') as 'achievement' | 'activity');
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
    const result = { schemaVersion: 1, status: 'resume_draft', policyVersion: RESUME_POLICY_VERSION, version,
      createdAt: new Date().toISOString(), scope, source: current.saved.source, reviewVersion: current.version,
      reviewRevision: current.stored.revision, bullet, trace, review: current.stored.state };
    const output = await reserveAnalysisDirectory(values.output, 'resumes');
    const markdown = [`# ${bullet.kind === 'achievement' ? '완료 성과' : '활동'} 문장 초안`, '', `> ${text(bullet.text)}`, '',
      ...analysisSourceLines(current.saved.source), `- 검토 버전: ${current.version}`, `- 문장 버전: ${version}`,
      `- 사용자 확인 완료일: ${bullet.completion?.completedAt ?? '(미확인)'}`, '',
      '각 절은 선택한 주장 문구를 공백·끝 문장부호만 정리해 세미콜론으로 연결했다. 의미적 사실성과 문체는 사용자 검토가 필요하다.',
      '수집 기간은 활동 범위이며 완료일로 자동 해석하지 않는다. 철회 전 출력 파일은 당시 버전의 이력으로 남는다.', '',
      '## 문장 근거', '', ...trace.flatMap((item) => [
        `- ${text(item.claimId)} / ${item.section} / 문자 위치 [${item.start}, ${item.end})`,
        ...(item.confirmation ? [`  - 사용자 확인: ${item.confirmation.record!.id} / ${text(item.confirmation.event!.actor)}`] : []),
        ...item.evidence.map((evidence) => `  - Git: ${evidence.commitOid} / ${text(evidence.path ?? '(커밋 메시지)')} / ${text(evidence.reference.locator ?? '(없음)')}`),
      ]), '', renderAnalysisMarkdown(current.stored.state.analysis, current.saved.source, false, current.context.packet.complete, true)].join('\n');
    const files = await saveAnalysisReports(output, 'resume', result, markdown);
    return { status: 'resume_draft' as const, kind: bullet.kind, version, externalRequests: 0, ...files };
  });
}
