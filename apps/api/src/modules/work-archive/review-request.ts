import { BadRequestException } from '@nestjs/common';

export function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException('invalid_identifier');
  }
  return value;
}

export function reviewVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new BadRequestException('invalid_review_version');
  }
  return value;
}

export function only(input: Record<string, unknown>, allowed: readonly string[], error = 'unknown_query_parameter') {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new BadRequestException(error);
}

export function reviewRequest(body: unknown, additionalFields: readonly string[] = [], unknownFieldError = 'invalid_review_request') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('invalid_review_request');
  const input = body as Record<string, unknown>;
  only(input, ['expectedReviewVersion', 'actor', ...additionalFields], unknownFieldError);
  return { input, expectedVersion: reviewVersion(input.expectedReviewVersion), actor: id(input.actor) };
}
