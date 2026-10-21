import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'git-analyze-api' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  ready() {
    return { status: 'not_ready', reason: 'business_pipeline_not_implemented' };
  }
}
