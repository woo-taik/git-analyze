import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';
import { RepositoriesModule } from './modules/repositories/repositories.module.js';

@Module({ imports: [HealthModule, RepositoriesModule] })
export class AppModule {}
