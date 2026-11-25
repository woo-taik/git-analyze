import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
export { AnalysisJobStore } from './analysis-jobs.js';
export type { AnalysisJobScope, AnalysisJobRow } from './analysis-jobs.js';

export * from './schema.js';
export { archiveWork, withArchivedReview, listArchivedWorks, ArchiveNotFoundError } from './work-archive.js';
export { startJobReview, updateArchivedReview, rebaseArchivedReview, ArchiveReviewExistsError, ArchiveReviewConflictError,
  ArchiveReviewChangesError, ArchiveReviewSameAnalysisError } from './work-archive.js';
export type { ArchiveScope, ArchivedAnalysis, ArchivedReview, WorkArchiveRevision,
  ArchivedReviewSnapshot, ArchivedWorkSummary } from './work-archive.js';

// Pool is lazy: importing this module does not connect or run migrations.
export function createDatabase(connectionString: string, options: {
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  readonly onIdleError?: () => void;
} = {}) {
  const pool = new pg.Pool({ connectionString, max: 5,
    ...(options.connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    ...(options.statementTimeoutMillis === undefined ? {} : { statement_timeout: options.statementTimeoutMillis }),
  });
  // Idle client failures arrive outside query promises. Keep the pool recoverable and never log connection details.
  pool.on('error', () => {
    if (options.onIdleError) options.onIdleError();
    else console.error('PostgreSQL idle connection failed');
  });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
