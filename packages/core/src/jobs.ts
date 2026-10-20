export const JOB_NAMES = [
  'sync_repository',
  'refresh_work_item',
  'analyze_work_item',
  'generate_resume',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobPayload {
  readonly ownerId: string;
  readonly repositoryId: string;
  readonly targetId: string;
  readonly inputVersion: string;
}
