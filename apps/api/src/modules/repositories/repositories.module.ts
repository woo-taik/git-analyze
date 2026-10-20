import { Module } from '@nestjs/common';
import { RepositoriesController } from './repositories.controller.js';
import { RepositoryCatalogService } from './repository-catalog.service.js';

@Module({
  controllers: [RepositoriesController],
  providers: [RepositoryCatalogService],
  exports: [RepositoryCatalogService],
})
export class RepositoriesModule {}
