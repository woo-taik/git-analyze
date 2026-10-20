import { Controller, Get, Inject } from '@nestjs/common';
import { RepositoryCatalogService } from './repository-catalog.service.js';

@Controller('v1')
export class RepositoriesController {
  constructor(@Inject(RepositoryCatalogService) private readonly catalog: RepositoryCatalogService) {}

  @Get('providers')
  providers() {
    return { providers: this.catalog.listProviders() };
  }
}
