import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '@git-analyze/config';
import { WorkArchiveController } from './work-archive.controller.js';
import { ARCHIVE_CONFIG, WorkArchiveService } from './work-archive.service.js';
import { LocalArchiveGuard } from './local-archive.guard.js';
import { AnalysisJobsController } from './analysis-jobs.controller.js';

@Module({})
export class WorkArchiveModule {
  static register(config: AppConfig): DynamicModule {
    return { module: WorkArchiveModule, global: true, controllers: [WorkArchiveController, AnalysisJobsController],
      providers: [{ provide: ARCHIVE_CONFIG, useValue: config }, WorkArchiveService, LocalArchiveGuard], exports: [WorkArchiveService] };
  }
}
