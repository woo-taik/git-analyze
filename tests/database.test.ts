import { randomUUID } from 'node:crypto';
import { loadConfig } from '@git-analyze/config';
import { buildApp } from '../apps/api/src/app.js';
import { createDatabase } from '../packages/database/src/index.js';
import { describe, expect, it, vi } from 'vitest';

const testDatabaseUrl = process.env.GIT_ANALYZE_TEST_DATABASE_URL;

describe('database pool lifecycle', () => {
  it('handles idle connection failures without leaking connection details or terminating the process', async () => {
    const database = createDatabase('postgresql://unused:sentinel-private-password@127.0.0.1:1/unused');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => database.db.$client.emit('error', new Error('sentinel-private-password'))).not.toThrow();
      expect(log).toHaveBeenCalledExactlyOnceWith('PostgreSQL idle connection failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain('sentinel-private-password');
    } finally {
      log.mockRestore();
      await database.close();
    }
  });

  it('notifies an optional error observer without passing sensitive driver errors', async () => {
    const onIdleError = vi.fn();
    const database = createDatabase('postgresql://unused:unused@127.0.0.1:1/unused', { onIdleError });
    try {
      database.db.$client.emit('error', new Error('private driver error'));
      expect(onIdleError).toHaveBeenCalledExactlyOnceWith();
    } finally { await database.close(); }
  });
});

describe('PostgreSQL archive availability', () => {
  it.runIf(Boolean(testDatabaseUrl))('recovers after PostgreSQL terminates an idle pooled connection', async () => {
    const onIdleError = vi.fn();
    const database = createDatabase(testDatabaseUrl!, { onIdleError, connectionTimeoutMillis: 5_000 });
    const control = createDatabase(testDatabaseUrl!, { connectionTimeoutMillis: 5_000 });
    try {
      // pool.query releases this exact backend to the idle pool before resolving.
      const before = await database.db.$client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = before.rows[0]!.pid;
      const terminated = await control.db.$client.query<{ terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated', [pid]);
      expect(terminated.rows[0]!.terminated).toBe(true);
      await vi.waitFor(() => expect(onIdleError).toHaveBeenCalled(), { timeout: 5_000 });
      expect(onIdleError).toHaveBeenCalledWith();
      const after = await database.db.$client.query<{ pid: number; value: number }>('SELECT pg_backend_pid() AS pid, 1 AS value');
      expect(after.rows[0]!.value).toBe(1);
      expect(after.rows[0]!.pid).not.toBe(pid);
    } finally { await Promise.all([database.close(), control.close()]); }
  }, 30_000);

  it.runIf(Boolean(testDatabaseUrl))('reports unready when listing works but the analysis table is absent', async () => {
    const admin = createDatabase(testDatabaseUrl!, { connectionTimeoutMillis: 5_000 });
    const schema = `archive_readiness_${randomUUID().replaceAll('-', '')}`;
    // Only this freshly generated schema is created or removed; existing archive tables are untouched.
    if (!/^archive_readiness_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid temporary schema name');
    let created = false;
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await admin.db.$client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      for (const table of ['owners', 'repositories', 'work_items', 'work_review_versions'] as const) {
        await admin.db.$client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}")`);
      }
      const url = new URL(testDatabaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: url.toString() }));
      const http = app.getHttpAdapter().getInstance();
      const list = await http.inject({ method: 'GET', url: '/v1/owners/owner/repositories/repo/work-items' });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toEqual([]);
      const ready = await http.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().message).toBe('archive_unavailable');
      expect((await http.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      try { await app?.close(); }
      finally {
        try { if (created) await admin.db.$client.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.close(); }
      }
    }
  }, 30_000);
});
