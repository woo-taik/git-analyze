import { parseArgs } from 'node:util';
import { loadConfig } from '@git-analyze/config';
import { archiveWork, createDatabase, withArchivedReview, type WorkArchiveRevision } from '@git-analyze/database';
import { loadCurrentResumeReview, readResumeSnapshot, writeResumeDraft } from './resume.js';
import { loadReviewVersion, reviewScope, withReviewLock } from './review-store.js';

async function withDatabase<T>(operation: (db: ReturnType<typeof createDatabase>['db']) => Promise<T>) {
  const { databaseUrl } = loadConfig();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const { db, close } = createDatabase(databaseUrl);
  try { return await operation(db); }
  catch (error) {
    if (error instanceof Error && error.constructor.name === 'DrizzleQueryError') {
      const cause = error.cause;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      if (code === '42P01' || code === '42703') throw new Error('PostgreSQL archive schema is missing. Run pnpm db:migrate.');
      throw new Error('PostgreSQL archive query failed');
    }
    throw error;
  }
  finally { await close(); }
}

export async function executeDbArchive(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, options: { review: { type: 'string' } } });
  if (!values.review?.trim()) throw new Error('db-archive requires --review <latest-review.json>');
  const snapshot = await readResumeSnapshot(values.review);
  return withReviewLock(snapshot.storeDirectory, snapshot.scope, async (directory) => {
    let current = await loadCurrentResumeReview(directory, snapshot);
    const revisions: WorkArchiveRevision[] = [];
    let bytes = 0;
    while (true) {
      const { version, stored, saved } = current;
      const { promptVersion, wireSchemaVersion, requestedModel } = saved.result.request;
      const revision: WorkArchiveRevision = { version, review: stored, analysis: { analysisVersion: saved.analysisVersion,
        ...saved.baseline, source: saved.source, usage: saved.result.usage, request: { promptVersion, wireSchemaVersion, requestedModel } } };
      bytes += Buffer.byteLength(JSON.stringify(revision));
      if (bytes > 32 * 1024 * 1024 || revisions.length === 1_001) throw new Error('Local review history exceeds the archive limit');
      revisions.push(revision);
      if (stored.previousVersion === null) break;
      current = await loadReviewVersion(directory, snapshot.scope, stored.previousVersion, stored.revision - 1);
    }
    const result = await withDatabase((db) => archiveWork(db, snapshot.scope, revisions.reverse()));
    return { status: 'archived' as const, scope: snapshot.scope, ...result, externalRequests: 0 };
  });
}

export async function executeResumeDb(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, options: {
    owner: { type: 'string' }, repository: { type: 'string' }, 'work-item': { type: 'string' },
    claim: { type: 'string', multiple: true }, kind: { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.owner?.trim() || !values.repository?.trim() || !values['work-item']?.trim() || !values.claim?.length) {
    throw new Error('resume-db requires --owner, --repository, --work-item and repeated --claim <id>');
  }
  if (values.kind !== undefined && !['achievement', 'activity'].includes(values.kind)) throw new Error('Resume kind must be achievement or activity');
  if (values.output !== undefined && !values.output.trim()) throw new Error('Invalid --output');
  const scope = reviewScope({ ownerId: values.owner, repositoryId: values.repository, workItemId: values['work-item'] });
  return withDatabase((db) => withArchivedReview(db, scope, (current) => writeResumeDraft(scope, current, values.claim!,
    values.kind === 'activity' ? 'activity' : 'achievement', values.output)));
}
