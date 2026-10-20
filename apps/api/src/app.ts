import 'reflect-metadata';
import type { AppConfig } from '@git-analyze/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

export async function buildApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: { level: config.logLevel } }),
    { logger: false, abortOnError: false },
  );
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
