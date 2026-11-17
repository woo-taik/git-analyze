import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '@git-analyze/config';
import { WorkArchiveModule } from './modules/work-archive/work-archive.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RepositoriesModule } from './modules/repositories/repositories.module.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return { module: AppModule, imports: [WorkArchiveModule.register(config), HealthModule, RepositoriesModule] };
  }
}
