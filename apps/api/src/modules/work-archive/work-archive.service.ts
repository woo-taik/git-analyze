import { createHash } from 'node:crypto';
import { ambiguousEvidenceReferences, canonicalJson, composeResumeWithTrace, RESUME_POLICY_VERSION, ResumeOutputError } from '@git-analyze/core';
import { analysisJobs, ArchiveNotFoundError, createDatabase, listArchivedWorks, withArchivedReview, workAnalysisVersions, workReviewVersions, type ArchiveScope } from '@git-analyze/database';
import { ConflictException, HttpException, Inject, Injectable, NotFoundException,
  ServiceUnavailableException, UnprocessableEntityException, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@git-analyze/config';
import type { ReviewAction } from '@git-analyze/core';
import { rebaseArchivedReview, startJobReview, updateArchivedReview, ArchiveReviewConflictError, ArchiveReviewChangesError,
  ArchiveReviewExistsError, ArchiveReviewSameAnalysisError, type AnalysisJobRow, type ArchivedReviewSnapshot } from '@git-analyze/database';
import { restoreJobAnalysis } from '@git-analyze/providers';

export const ARCHIVE_CONFIG = Symbol('ARCHIVE_CONFIG');

function reviewDetail(scope: ArchiveScope, current: ArchivedReviewSnapshot) {
  return { scope, reviewVersion: current.version, reviewRevision: current.stored.revision,
    analysisVersion: current.context.analysisVersion, review: current.stored.state,
    evidence: current.context.packet, source: current.saved.source,
    ambiguousEvidence: ambiguousEvidenceReferences(current.context.packet) };
}

@Injectable()
export class WorkArchiveService implements OnModuleDestroy {
  private readonly database: ReturnType<typeof createDatabase> | undefined;

  constructor(@Inject(ARCHIVE_CONFIG) config: AppConfig) {
    this.database = config.databaseUrl ? createDatabase(config.databaseUrl,
      { connectionTimeoutMillis: 5_000, statementTimeoutMillis: 5_000 }) : undefined;
  }

  async onModuleDestroy() { await this.database?.close(); }

  private async query<T>(operation: (db: ReturnType<typeof createDatabase>['db']) => Promise<T>): Promise<T> {
    if (!this.database) throw new ServiceUnavailableException('archive_database_not_configured');
    try { return await operation(this.database.db); }
    catch (error) {
      if (error instanceof ArchiveNotFoundError) throw new NotFoundException('archived_work_not_found');
      if (error instanceof ArchiveReviewExistsError) throw new ConflictException('review_already_exists');
      if (error instanceof ArchiveReviewSameAnalysisError) throw new ConflictException('review_analysis_unchanged');
      if (error instanceof ArchiveReviewConflictError) throw new ConflictException('review_version_changed');
      if (error instanceof ArchiveReviewChangesError) throw new UnprocessableEntityException('review_changes_rejected');
      if (error instanceof ResumeOutputError) throw new UnprocessableEntityException(error.code);
      if (error instanceof HttpException) throw error;
      // Do not expose SQL parameters, connection credentials, or corrupted archived content.
      throw new ServiceUnavailableException('archive_unavailable');
    }
  }

  async readiness() {
    await this.query(async (db) => {
      await listArchivedWorks(db, { ownerId: '', repositoryId: '' }, { limit: 1, offset: 0 });
      // Check the tables/columns used by detail as well, without loading private payloads.
      await db.select().from(workAnalysisVersions).limit(0);
      await db.select().from(workReviewVersions).limit(0);
      await db.select().from(analysisJobs).limit(0);
    });
    return { status: 'ready', capabilities: { archiveRead: true, asyncAnalysis: true } };
  }

  list(scope: Pick<ArchiveScope, 'ownerId' | 'repositoryId'>, page: { limit: number; offset: number }) {
    return this.query(async (db) => ({ scope, ...await listArchivedWorks(db, scope, page), ...page }));
  }

  detail(scope: ArchiveScope) {
    return this.query((db) => withArchivedReview(db, scope, async current => reviewDetail(scope, current)));
  }

  startReview(scope: ArchiveScope, job: AnalysisJobRow) {
    return this.query(async db => {
      const analysis = await restoreJobAnalysis(job.request, job.request_key, job.result);
      const current = await startJobReview(db, scope, job.id, analysis);
      return { ...reviewDetail(scope, current), externalRequests: 0 };
    });
  }

  rebaseReview(scope: ArchiveScope, job: AnalysisJobRow, expectedVersion: string, actor: string) {
    return this.query(async db => {
      const analysis = await restoreJobAnalysis(job.request, job.request_key, job.result);
      const current = await rebaseArchivedReview(db, scope, job.id, analysis, expectedVersion, actor);
      return { ...reviewDetail(scope, current), externalRequests: 0 };
    });
  }

  updateReview(scope: ArchiveScope, expectedVersion: string, actions: readonly ReviewAction[], actor: string) {
    return this.query(async db => {
      const current = await updateArchivedReview(db, scope, expectedVersion, actions, actor);
      return { ...reviewDetail(scope, current), externalRequests: 0 };
    });
  }

  resume(scope: ArchiveScope, claimIds: readonly string[], kind: 'achievement' | 'activity', expectedVersion?: string) {
    return this.query((db) => withArchivedReview(db, scope, async (current) => {
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new ConflictException('review_version_changed');
      }
      const { bullet, trace } = composeResumeWithTrace(current.stored.state, current.context, claimIds, kind);
      const version = createHash('sha256').update(canonicalJson({ policyVersion: RESUME_POLICY_VERSION,
        reviewVersion: current.version, bullet })).digest('hex');
      return { schemaVersion: 1, status: 'resume_draft', scope, policyVersion: RESUME_POLICY_VERSION,
        version, reviewVersion: current.version, reviewRevision: current.stored.revision,
        source: current.saved.source, bullet, trace, review: current.stored.state, externalRequests: 0 };
    }));
  }
}
