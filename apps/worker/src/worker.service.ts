import { loadConfig } from '@git-analyze/config';
import { JOB_NAMES } from '@git-analyze/core';
import { startWorker, type JobHandler } from './runner.js';
import type { JobName } from '@git-analyze/core';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { AnalysisJobStore, createDatabase } from '@git-analyze/database';
import { analysisHandler } from './analysis-handler.js';

@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  private database: ReturnType<typeof createDatabase> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private dispatch: Promise<void> | undefined;

  async run(args: readonly string[]): Promise<boolean> {
    const config = loadConfig();
    if (args.length === 1 && args[0] === '--check') {
      console.log(JSON.stringify({
        databaseConfigured: Boolean(config.databaseUrl),
        databaseConnectionTested: false,
        plannedQueues: JOB_NAMES,
        registeredHandlers: ['analyze_work_item'],
        status: 'configured',
      }, null, 2));
      return false;
    }
    if (args.length) throw new Error('Unknown worker arguments. Use pnpm worker:check.');
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required to start the worker');

    // Register real use cases here as they are implemented; never consume with no-op handlers.
    this.database = createDatabase(config.databaseUrl, { connectionTimeoutMillis: 5000, statementTimeoutMillis: 5000 });
    const store = new AnalysisJobStore(this.database.db.$client);
    const handlers: Partial<Record<JobName, JobHandler>> = { analyze_work_item: analysisHandler(store) };
    this.worker = await startWorker({
      connectionString: config.databaseUrl,
      handlers,
      onError: () => { console.error('Worker queue error'); process.exitCode = 1; },
    });
    const dispatch = async () => {
      for (const row of await store.pending()) {
        await this.worker!.enqueue('analyze_work_item', { ownerId: row.owner_id, repositoryId: row.repository_id,
          targetId: row.id, inputVersion: row.request_key });
      }
    };
    await dispatch();
    this.timer = setInterval(() => {
      if (this.dispatch) return;
      this.dispatch = dispatch().catch(() => { console.error('Analysis dispatch failed'); })
        .finally(() => { this.dispatch = undefined; });
    }, 5000);
    return true;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.dispatch;
    await this.worker?.stop();
    await this.database?.close();
  }
}
