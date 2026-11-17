import { Controller, Get, Header, Inject } from '@nestjs/common';
import { WorkArchiveService } from '../work-archive/work-archive.service.js';

@Controller()
export class HealthController {
  constructor(@Inject(WorkArchiveService) private readonly archive: WorkArchiveService) {}
  @Get('health')
  health() {
    return { status: 'ok', service: 'git-analyze-api' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  ready() {
    return this.archive.readiness();
  }
}
