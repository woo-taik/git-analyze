import { loadConfig } from '@git-analyze/config';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { startWorker } from '../apps/worker/src/runner.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  apps.push(app);
  return app.getHttpAdapter().getInstance();
}

describe('scaffold boundaries', () => {
  it('reports liveness without falsely reporting business readiness', async () => {
    const app = await createApp();
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', service: 'git-analyze-api' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().reason).toBe('business_pipeline_not_implemented');
  });

  it('distinguishes planned integration from documented provider support', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: '/v1/providers' });
    expect(response.statusCode).toBe(200);
    const sourceCommit = response.json().providers.find(
      (provider: { id: string }) => provider.id === 'ncloud-sourcecommit',
    );
    expect(sourceCommit).toMatchObject({
      implementationStatus: 'planned',
      documentedCapabilities: { commits: 'supported', reviews: 'unknown' },
    });
  });

  it('does not accept collection jobs before collection is implemented', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'POST', url: '/v1/repositories/sync', payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it('rejects invalid database configuration without echoing credentials', () => {
    const secret = 'sentinel-private-password';
    let error: unknown;
    try {
      loadConfig({ DATABASE_URL: `https://user:${secret}@example.com/db` });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('DATABASE_URL');
    expect((error as Error).message).not.toContain(secret);
  });

  it('refuses to open a queue connection when no handlers are registered', async () => {
    await expect(startWorker({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      handlers: {},
      onError: () => undefined,
    })).rejects.toThrow('No business handlers');
  });
});
