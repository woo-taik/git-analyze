import { PROVIDER_CATALOG } from '@git-analyze/providers';
import { Injectable } from '@nestjs/common';

@Injectable()
export class RepositoryCatalogService {
  listProviders() {
    return PROVIDER_CATALOG;
  }
}
