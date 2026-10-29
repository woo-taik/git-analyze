import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyReviewChanges, createReviewState, parseReviewChanges, rebaseReviewState } from '@git-analyze/core';
import { readBoundedJson } from './analysis-input.js';
import { renderAnalysisMarkdown, reserveAnalysisDirectory, saveAnalysisReports } from './analysis-report.js';
import { loadSavedAnalysis } from './saved-analysis.js';
import { loadStoredReview, persistReview, reviewScope, withReviewLock } from './review-store.js';
import { escapeMarkdownText as text } from './history-report.js';

export async function executeReview(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    analysis: { type: 'string' }, changes: { type: 'string' }, actor: { type: 'string' }, rebase: { type: 'boolean' },
    'store-dir': { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.analysis?.trim()) throw new Error('review requires --analysis <analysis.json>');
  for (const value of [values.changes, values.actor, values.output, values['store-dir']]) {
    if (value !== undefined && !value.trim()) throw new Error('Review options cannot be empty');
  }
  if ((values.changes || values.rebase) && !values.actor?.trim()) throw new Error('Review changes and rebase require --actor <local-user-label>');
  const saved = await loadSavedAnalysis(values.analysis);
  const context = { ...saved.baseline, analysisVersion: saved.analysisVersion };
  const changes = values.changes ? parseReviewChanges(await readBoundedJson(resolve(values.changes), 1_048_576)) : null;
  const scope = reviewScope(saved.packet);
  const storeDirectory = resolve(values['store-dir'] ?? '.data/reviews');
  const metadata = { actor: values.actor ?? 'local-user', recordedAt: new Date().toISOString() };
  return withReviewLock(storeDirectory, scope, async (directory) => {
    const previous = await loadStoredReview(directory, scope);
    let state = previous?.stored.state ?? createReviewState(context);
    const changedBaseline = previous !== null && previous.stored.analysisVersion !== saved.analysisVersion;
    if (changedBaseline && !values.rebase) throw new Error('Analysis changed; use --rebase to preserve edits as unconfirmed drafts');
    if (values.rebase && !changedBaseline) throw new Error('Rebase requires a different analysis version');
    if (changedBaseline) state = rebaseReviewState(state, context, metadata);
    if (changes) state = applyReviewChanges(state, changes, context, metadata);
    const outputDirectory = await reserveAnalysisDirectory(values.output, 'review-reports');
    const current = previous && !changedBaseline && !changes ? { version: previous.version, stored: previous.stored }
      : await persistReview(directory, previous, saved.analysisFile, saved.analysisVersion, state);
    const report = { schemaVersion: 1, status: 'reviewed', createdAt: metadata.recordedAt, scope, storeDirectory,
      version: current.version, revision: current.stored.revision, analysisFile: saved.analysisFile,
      analysisVersion: saved.analysisVersion, source: saved.source, state };
    const markdown = [renderAnalysisMarkdown(state.analysis, saved.source, false, saved.baseline.packet.complete, true),
      '## 검토 이력', '', `- 검토 버전: ${current.version}; revision ${current.stored.revision}`,
      `- 완료 상태: ${state.completion?.status ?? 'unknown'}; 완료일: ${state.completion?.completedAt ?? '(미확인)'}`,
      '', ...state.events.map((event) => `- ${event.recordedAt} / ${text(event.actor)} / ${event.action.kind} / ${event.id}`),
      '', '확인 기록:', '', ...state.confirmations.map((record) => `- ${text(record.claimId)}: ${record.status}; ${record.id}`), ''].join('\n');
    const files = await saveAnalysisReports(outputDirectory, 'review', report, markdown);
    return { status: 'reviewed' as const, revision: current.stored.revision, version: current.version,
      unresolvedQuestions: state.analysis.missingQuestions.length, externalRequests: 0, ...files };
  });
}
