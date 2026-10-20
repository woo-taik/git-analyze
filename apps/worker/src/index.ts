import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { WorkerService } from './worker.service.js';

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  try {
    const running = await app.get(WorkerService).run(process.argv.slice(2));
    if (!running) await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && /^(DATABASE_URL|No business handlers|Unknown worker)/.test(error.message)
    ? error.message : 'Worker startup failed');
  process.exitCode = 1;
});
