import { loadConfig } from '@git-analyze/config';
import { JOB_NAMES } from '@git-analyze/core';
import { startWorker, type JobHandler } from './runner.js';
import type { JobName } from '@git-analyze/core';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private worker: Awaited<ReturnType<typeof startWorker>> | undefined;

  async run(args: readonly string[]): Promise<boolean> {
    const config = loadConfig();
    if (args.length === 1 && args[0] === '--check') {
      console.log(JSON.stringify({
        databaseConfigured: Boolean(config.databaseUrl),
        databaseConnectionTested: false,
        plannedQueues: JOB_NAMES,
        registeredHandlers: [],
        status: 'scaffold',
      }, null, 2));
      return false;
    }
    if (args.length) throw new Error('Unknown worker arguments. Use pnpm worker:check.');
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required to start the worker');

    // Register real use cases here as they are implemented; never consume with no-op handlers.
    const handlers: Partial<Record<JobName, JobHandler>> = {};
    this.worker = await startWorker({
      connectionString: config.databaseUrl,
      handlers,
      onError: () => { console.error('Worker queue error'); process.exitCode = 1; },
    });
    return true;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.stop();
  }
}
