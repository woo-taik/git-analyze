import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '@git-analyze/config';
import { WorkArchiveController } from './work-archive.controller.js';
import { ARCHIVE_CONFIG, WorkArchiveService } from './work-archive.service.js';
import { LocalArchiveGuard } from './local-archive.guard.js';

@Module({})
export class WorkArchiveModule {
  static register(config: AppConfig): DynamicModule {
    return { module: WorkArchiveModule, global: true, controllers: [WorkArchiveController],
      providers: [{ provide: ARCHIVE_CONFIG, useValue: config }, WorkArchiveService, LocalArchiveGuard], exports: [WorkArchiveService] };
  }
}
