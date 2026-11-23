import { BadRequestException, Body, Controller, Get, Header, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { parseReviewChanges } from '@git-analyze/core';
import { WorkArchiveService } from './work-archive.service.js';
import { LocalArchiveGuard } from './local-archive.guard.js';

function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException('invalid_identifier');
  }
  return value;
}
function number(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new BadRequestException('invalid_pagination');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new BadRequestException('invalid_pagination');
  return parsed;
}
function only(query: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new BadRequestException('unknown_query_parameter');
}

@Controller('v1/owners/:ownerId/repositories/:repositoryId/work-items')
@UseGuards(LocalArchiveGuard)
export class WorkArchiveController {
  constructor(@Inject(WorkArchiveService) private readonly archive: WorkArchiveService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('ownerId') ownerId: string, @Param('repositoryId') repositoryId: string, @Query() query: Record<string, unknown>) {
    only(query, ['limit', 'offset']);
    const limit = number(query.limit, 20, 1, 100);
    const offset = number(query.offset, 0, 0, Number.MAX_SAFE_INTEGER - limit);
    return this.archive.list({ ownerId: id(ownerId), repositoryId: id(repositoryId) }, { limit, offset });
  }

  @Get(':workItemId')
  @Header('Cache-Control', 'no-store')
  detail(@Param('ownerId') ownerId: string, @Param('repositoryId') repositoryId: string,
    @Param('workItemId') workItemId: string, @Query() query: Record<string, unknown>) {
    only(query, []);
    return this.archive.detail({ ownerId: id(ownerId), repositoryId: id(repositoryId), workItemId: id(workItemId) });
  }

  @Get(':workItemId/resume')
  @Header('Cache-Control', 'no-store')
  resume(@Param('ownerId') ownerId: string, @Param('repositoryId') repositoryId: string,
    @Param('workItemId') workItemId: string, @Query() query: Record<string, unknown>) {
    only(query, ['claim', 'kind', 'reviewVersion']);
    const claimIds = (Array.isArray(query.claim) ? query.claim : [query.claim]).map(id);
    if (claimIds.length > 8 || new Set(claimIds).size !== claimIds.length) throw new BadRequestException('invalid_claim_selection');
    const kind = query.kind ?? 'achievement';
    if (kind !== 'achievement' && kind !== 'activity') throw new BadRequestException('invalid_resume_kind');
    const expected = query.reviewVersion;
    if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) {
      throw new BadRequestException('invalid_review_version');
    }
    return this.archive.resume({ ownerId: id(ownerId), repositoryId: id(repositoryId), workItemId: id(workItemId) }, claimIds, kind, expected);
  }

  @Post(':workItemId/review')
  @Header('Cache-Control', 'no-store')
  updateReview(@Param('ownerId') ownerId: string, @Param('repositoryId') repositoryId: string,
    @Param('workItemId') workItemId: string, @Query() query: Record<string, unknown>, @Body() body: unknown) {
    only(query, []);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('invalid_review_request');
    const input = body as Record<string, unknown>;
    only(input, ['expectedReviewVersion', 'actor', 'changes']);
    if (typeof input.expectedReviewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedReviewVersion)) {
      throw new BadRequestException('invalid_review_version');
    }
    const actor = id(input.actor);
    let actions;
    try { actions = parseReviewChanges(input.changes); }
    catch { throw new BadRequestException('invalid_review_changes'); }
    return this.archive.updateReview({ ownerId: id(ownerId), repositoryId: id(repositoryId), workItemId: id(workItemId) },
      input.expectedReviewVersion, actions, actor);
  }
}
