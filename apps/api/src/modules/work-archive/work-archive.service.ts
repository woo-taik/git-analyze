import { createHash } from 'node:crypto';
import { canonicalJson, composeResumeWithTrace, RESUME_POLICY_VERSION, ResumeOutputError } from '@git-analyze/core';
import { analysisJobs, ArchiveNotFoundError, createDatabase, listArchivedWorks, withArchivedReview, workAnalysisVersions, workReviewVersions, type ArchiveScope } from '@git-analyze/database';
import { ConflictException, HttpException, Inject, Injectable, NotFoundException,
  ServiceUnavailableException, UnprocessableEntityException, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@git-analyze/config';

export const ARCHIVE_CONFIG = Symbol('ARCHIVE_CONFIG');

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
    return this.query((db) => withArchivedReview(db, scope, async (current) => ({
      scope, reviewVersion: current.version, reviewRevision: current.stored.revision,
      analysisVersion: current.context.analysisVersion, review: current.stored.state,
      evidence: current.context.packet, source: current.saved.source,
    })));
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
