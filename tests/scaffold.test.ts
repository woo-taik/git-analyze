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
    expect(ready.json().message).toBe('archive_database_not_configured');
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

  it('validates archive requests and rejects nonlocal access before querying a database', async () => {
    const app = await createApp();
    const base = '/v1/owners/owner/repositories/repo/work-items';
    for (const suffix of ['?limit=0', '?limit=101', '?offset=-1', '?offset=1.5', '?limit=1&limit=2',
      '?offset=9007199254740991', '?unexpected=true', '/work/resume', '/work/resume?claim=x&claim=x',
      '/work/resume?claim=x&kind=other', '/work/resume?claim=x&reviewVersion=bad']) {
      expect((await app.inject({ method: 'GET', url: base + suffix })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(503);
    for (const ownerId of ['a'.repeat(512), '한'.repeat(512)]) {
      expect((await app.inject({ method: 'GET', url: base.replace('/owner/', `/${encodeURIComponent(ownerId)}/`) })).statusCode).toBe(503);
    }
    expect((await app.inject({ method: 'GET', url: base.replace('/owner/', `/${'a'.repeat(513)}/`) })).statusCode).toBe(400);
    for (const headers of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { origin: 'null' }]) {
      expect((await app.inject({ method: 'GET', url: base, headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: base, remoteAddress: '192.0.2.1' })).statusCode).toBe(403);
    await expect(buildApp(loadConfig({ HOST: '0.0.0.0', DATABASE_URL: 'postgresql://unused:unused@localhost/db' })))
      .rejects.toThrow('loopback HOST');
  });

  it('keeps liveness available and sanitizes archive connection failures', async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://unused:sentinel-private-password@127.0.0.1:1/unused' }));
    apps.push(app);
    const http = app.getHttpAdapter().getInstance();
    expect((await http.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const response = await http.inject({ method: 'GET', url: '/v1/owners/owner/repositories/repo/work-items' });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toBe('archive_unavailable');
    expect(response.body).not.toContain('sentinel-private-password');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
