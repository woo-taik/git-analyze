import 'reflect-metadata';
import type { AppConfig } from '@git-analyze/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { isLoopbackHost } from './modules/work-archive/local-archive.guard.js';

export async function buildApp(config: AppConfig): Promise<NestFastifyApplication> {
  if (config.databaseUrl && !isLoopbackHost(config.host)) throw new Error('Archive API requires a loopback HOST');
  const adapter = new FastifyAdapter({ logger: { level: config.logLevel }, routerOptions: { maxParamLength: 6144 } });
  adapter.getInstance().addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    adapter,
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
