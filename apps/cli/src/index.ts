import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CliModule } from './cli.module.js';
import { CommandService } from './command.service.js';

async function main() {
  const app = await NestFactory.createApplicationContext(CliModule, { logger: false, abortOnError: false });
  try {
    await app.get(CommandService).run();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'CLI failed');
  process.exitCode = 1;
});
