import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hash } from './analysis-cache.js';
import { identity, object, readBoundedJson } from './analysis-input.js';
import { analysisSourceLines, reserveAnalysisDirectory, saveAnalysisReports } from './analysis-report.js';
import { resolveKstPeriod } from './collect-options.js';
import { escapeMarkdownText as text } from './history-report.js';
import { buildResumeDraft, loadCurrentResumeReview, readResumeSnapshot, renderResumeTrace } from './resume.js';
import { withReviewLock } from './review-store.js';

const PERIOD_POLICY_VERSION = 'local-resume-period-v1';
type Snapshot = Awaited<ReturnType<typeof readResumeSnapshot>>;
type Selection = { snapshot: Snapshot; claimIds: string[] };
type Entry = ReturnType<typeof buildResumeDraft> & {
  date: string;
  dateBasis: 'user_confirmed_completion' | 'git_committer_date';
  activityCommits: { oid: string; committedAt: string }[];
};
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function parsePeriodEnd(value: string): Date {
  const day = value.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00Z`);
  const end = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day || !Number.isFinite(end.getTime())) {
    throw new Error('--end must be an ISO 8601 timestamp with a timezone');
  }
  return end;
}

async function readSelections(path: string) {
  const manifest = object(await readBoundedJson(path, 1_048_576));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 50) {
    throw new Error('Expected a period input with 1 to 50 review selections');
  }
  const scope = { ownerId: identity(manifest.ownerId), repositoryId: identity(manifest.repositoryId) };
  const byWork = new Map<string, Selection>();
  for (const value of manifest.items) {
    const item = object(value);
    if (typeof item.review !== 'string' || !item.review.trim() || !Array.isArray(item.claimIds)
      || !item.claimIds.length || item.claimIds.length > 8) throw new Error('Each selection requires a review path and 1 to 8 claim IDs');
    const claimIds = item.claimIds.map(identity);
    if (new Set(claimIds).size !== claimIds.length) throw new Error('Duplicate claim IDs in a review selection');
    const snapshot = await readResumeSnapshot(resolve(dirname(path), item.review));
    const workId = snapshot.scope.workItemId;
    if (snapshot.scope.ownerId !== scope.ownerId || snapshot.scope.repositoryId !== scope.repositoryId) {
      throw new Error('Period review selection is outside the requested owner and repository');
    }
    const selection = { snapshot, claimIds };
    const previous = byWork.get(workId);
    if (previous && hash(previous) !== hash(selection)) throw new Error('Conflicting selections for the same work item');
    byWork.set(workId, selection);
  }
  return { scope, selections: [...byWork.values()].sort((a, b) => compareIds(a.snapshot.scope.workItemId, b.snapshot.scope.workItemId)) };
}

function renderEntries(heading: string, entries: readonly Entry[]) {
  return [`## ${heading}`, '', ...(!entries.length ? ['- (해당 없음)', ''] : []), ...entries.flatMap((entry) => [
    `### ${text(entry.bullet.workItemId)}`, '', `> ${text(entry.bullet.text)}`, '',
    `- ${entry.dateBasis === 'user_confirmed_completion' ? '사용자 확인 완료일' : '마지막 Git 커미터 시각'}: ${entry.date}`,
    `- 검토 버전: ${entry.reviewVersion}`, ...analysisSourceLines(entry.source), '', ...renderResumeTrace(entry.trace), '',
  ])];
}

export async function executeResumePeriod(args: readonly string[], now = new Date()) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    input: { type: 'string' }, period: { type: 'string' }, end: { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.input?.trim()) throw new Error('resume-period requires --input <selections.json>');
  if (values.output !== undefined && !values.output.trim()) throw new Error('Invalid --output');
  const window = { ...resolveKstPeriod(values.period, values.end === undefined ? now : parsePeriodEnd(values.end)), timezone: 'Asia/Seoul' };
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  const inWindow = (date: string) => Date.parse(date) >= start && Date.parse(date) < end;
  const { scope, selections } = await readSelections(resolve(values.input));
  const achievements: Entry[] = [];
  const activities: Entry[] = [];
  const outsidePeriodWorkItemIds: string[] = [];

  // Hold the same per-work locks as individual exports until every snapshot is validated and the report is written.
  async function exportWithLocks(index: number): Promise<{ jsonPath: string; markdownPath: string; version: string }> {
    const selection = selections[index];
    if (selection) {
      const { snapshot, claimIds } = selection;
      return withReviewLock(snapshot.storeDirectory, snapshot.scope, async (directory) => {
        const current = await loadCurrentResumeReview(directory, snapshot);
        const completion = current.stored.state.completion;
        const activityCommits = current.context.packet.provenance.local.commits.filter((commit) => inWindow(commit.committedAt))
          .map(({ oid, committedAt }) => ({ oid, committedAt }))
          .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt) || compareIds(a.oid, b.oid));
        if (completion?.status === 'completed' && completion.completedAt && inWindow(completion.completedAt)) {
          achievements.push({ ...buildResumeDraft(current, claimIds, 'achievement'), date: completion.completedAt,
            dateBasis: 'user_confirmed_completion', activityCommits });
        } else if (activityCommits.length) {
          activities.push({ ...buildResumeDraft(current, claimIds, 'activity'), date: activityCommits[0]!.committedAt,
            dateBasis: 'git_committer_date', activityCommits });
        } else {
          outsidePeriodWorkItemIds.push(snapshot.scope.workItemId);
        }
        return exportWithLocks(index + 1);
      });
    }
    const newest = (a: Entry, b: Entry) => Date.parse(b.date) - Date.parse(a.date) || compareIds(a.bullet.workItemId, b.bullet.workItemId);
    achievements.sort(newest);
    activities.sort(newest);
    const policyVersion = PERIOD_POLICY_VERSION;
    const version = hash({ policyVersion, scope, window, outsidePeriodWorkItemIds,
      achievements: achievements.map((item) => item.version), activities: activities.map((item) => item.version) });
    const report = { schemaVersion: 1, status: 'resume_period', policyVersion, version, scope, window,
      achievements, activities, outsidePeriodWorkItemIds };
    const markdown = ['# 기간별 성과와 활동', '', `- 기간 (${window.timezone}): [${window.startAt}, ${window.endAt})`,
      `- 보고서 버전: ${version}`, `- 완료 성과 ${achievements.length}건 / 기간 내 활동 ${activities.length}건`,
      `- 기간 외 작업 ${outsidePeriodWorkItemIds.length}건`, '',
      '완료 성과는 사용자가 확인한 완료일을 기준으로 한다. 활동 시점은 Git 커미터 시각으로 표시한다.', '',
      ...renderEntries('완료 성과', achievements), ...renderEntries('기간 내 활동', activities)].join('\n');
    const directory = await reserveAnalysisDirectory(values.output, 'resume-periods');
    return { ...await saveAnalysisReports(directory, 'resume-period', report, markdown), version };
  }

  const files = await exportWithLocks(0);
  return { status: 'resume_period' as const, externalRequests: 0, achievements: achievements.length, activities: activities.length,
    outsidePeriod: outsidePeriodWorkItemIds.length, ...files };
}
