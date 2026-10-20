import { JOB_NAMES, type JobName, type JobPayload } from '@git-analyze/core';
import { PgBoss } from 'pg-boss';

export type JobHandler = (payload: JobPayload) => Promise<void>;

function parsePayload(value: unknown): JobPayload {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid job payload');
  for (const field of ['ownerId', 'repositoryId', 'targetId', 'inputVersion'] as const) {
    if (!(field in value) || typeof value[field as keyof typeof value] !== 'string'
      || !(value[field as keyof typeof value] as string).trim()) {
      throw new Error(`Invalid job payload field: ${field}`);
    }
  }
  return value as JobPayload;
}

export async function startWorker(options: {
  readonly connectionString: string;
  readonly handlers: Partial<Record<JobName, JobHandler>>;
  readonly onError: (error: Error) => void;
}) {
  const registered = JOB_NAMES.filter((name) => options.handlers[name]);
  if (registered.length === 0) {
    throw new Error('No business handlers are implemented. Use pnpm worker:check to inspect the scaffold.');
  }

  const boss = new PgBoss({ connectionString: options.connectionString });
  boss.on('error', options.onError);
  try {
    await boss.start();
    for (const name of registered) {
      const handler = options.handlers[name];
      if (!handler) continue;
      await boss.createQueue(name);
      await boss.work<unknown>(name, async (jobs) => {
        for (const job of jobs) await handler(parsePayload(job.data));
      });
    }
    return { stop: () => boss.stop() };
  } catch (error) {
    await boss.stop().catch(() => undefined);
    throw error;
  }
}
