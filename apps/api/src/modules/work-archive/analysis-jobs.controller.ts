import { Body, BadRequestException, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query,
  ServiceUnavailableException, UseGuards, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@git-analyze/config';
import { AnalysisJobStore, createDatabase, type AnalysisJobRow } from '@git-analyze/database';
import { identity, object, prepareAnalysisSubmission } from '@git-analyze/providers';
import { ARCHIVE_CONFIG, WorkArchiveService } from './work-archive.service.js';
import { LocalArchiveGuard } from './local-archive.guard.js';
import { only, reviewRequest } from './review-request.js';

const publicJob = (job: AnalysisJobRow) => ({ jobId: job.id, status: job.status, requestKey: job.request_key,
  createdAt: job.created_at, updatedAt: job.updated_at, result: job.result, error: job.error });

@Controller('v1/owners/:ownerId/repositories/:repositoryId/work-items/:workItemId/analysis-jobs')
@UseGuards(LocalArchiveGuard)
export class AnalysisJobsController implements OnModuleDestroy {
  private readonly database;
  private readonly store;
  constructor(@Inject(ARCHIVE_CONFIG) config: AppConfig, @Inject(WorkArchiveService) private readonly archive: WorkArchiveService) {
    this.database = config.databaseUrl ? createDatabase(config.databaseUrl,
      { connectionTimeoutMillis: 5000, statementTimeoutMillis: 5000 }) : undefined;
    this.store = this.database ? new AnalysisJobStore(this.database.db.$client) : undefined;
  }
  async onModuleDestroy() { await this.database?.close(); }
  private scope(params: Record<string, string>) {
    try { return { ownerId: identity(params.ownerId), repositoryId: identity(params.repositoryId), workItemId: identity(params.workItemId) }; }
    catch { throw new BadRequestException('invalid_scope'); }
  }
  private async prepare(params: Record<string, string>, body: unknown) {
    const scope = this.scope(params);
    try {
      const request = await prepareAnalysisSubmission(body);
      if (Object.entries(scope).some(([key, value]) => request.loaded.bindings[key as keyof typeof scope] !== value)) throw new Error();
      return { scope, request };
    } catch { throw new BadRequestException('invalid_analysis_request'); }
  }
  @Post('preview')
  async preview(@Param() params: Record<string, string>, @Body() body: unknown) {
    return (await this.prepare(params, body)).request.preview;
  }
  @Post()
  async submit(@Param() params: Record<string, string>, @Body() body: unknown) {
    const { scope, request } = await this.prepare(params, body);
    // Bind explicit consent to the exact preview, including model and masking policy.
    if (object(body).confirmedRequestKey !== request.key) throw new BadRequestException('preview_confirmation_required');
    if (!this.store) throw new ServiceUnavailableException('analysis_database_not_configured');
    try { return publicJob(await this.store.submit(scope, request.key, request.snapshot)); }
    catch { throw new ServiceUnavailableException('analysis_jobs_unavailable'); }
  }
  private async loadJob(params: Record<string, string>) {
    const scope = this.scope(params);
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(params.jobId ?? '')) throw new BadRequestException('invalid_job_id');
    if (!this.store) throw new ServiceUnavailableException('analysis_database_not_configured');
    let job;
    try { job = await this.store.get(scope, params.jobId!); }
    catch { throw new ServiceUnavailableException('analysis_jobs_unavailable'); }
    if (!job) throw new NotFoundException('analysis_job_not_found');
    return { scope, job };
  }

  private async loadSucceededJob(params: Record<string, string>) {
    const current = await this.loadJob(params);
    if (current.job.status !== 'succeeded') throw new ConflictException('analysis_job_not_succeeded');
    return current;
  }

  @Get(':jobId')
  async get(@Param() params: Record<string, string>) {
    return publicJob((await this.loadJob(params)).job);
  }
  @Post(':jobId/review')
  @HttpCode(200)
  async startReview(@Param() params: Record<string, string>) {
    const { scope, job } = await this.loadSucceededJob(params);
    return this.archive.startReview(scope, job);
  }

  @Post(':jobId/review/rebase')
  @HttpCode(200)
  async rebaseReview(@Param() params: Record<string, string>, @Query() query: Record<string, unknown>, @Body() body: unknown) {
    only(query, []);
    const { expectedVersion, actor } = reviewRequest(body);
    const { scope, job } = await this.loadSucceededJob(params);
    return this.archive.rebaseReview(scope, job, expectedVersion, actor);
  }

  @Post(':jobId/retry')
  async retry(@Param() params: Record<string, string>, @Body() body: unknown) {
    const current = await this.get(params);
    let key: unknown;
    try { key = object(body).confirmedRequestKey; } catch { throw new BadRequestException('invalid_retry'); }
    if (key !== current.requestKey) throw new BadRequestException('preview_confirmation_required');
    let job;
    try { job = await this.store!.retryMissingKey(this.scope(params), params.jobId!, current.requestKey); }
    catch { throw new ServiceUnavailableException('analysis_jobs_unavailable'); }
    if (!job) throw new ConflictException('execution_not_safe_to_retry');
    return publicJob(job);
  }
}
