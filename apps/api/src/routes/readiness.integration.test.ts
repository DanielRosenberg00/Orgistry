import { createDbClient, pingDatabase } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { testConfig } from '../testing/build-test-app';
import type { ReadinessProbe } from '../lib/readiness';

// Integration entry point: load the root `.env` so this runs locally with only
// `cp .env.example .env`. CI sets these variables directly (no `.env` present).
loadWorkspaceEnv();

/**
 * Live readiness integration test.
 *
 * Exercises the real PostgreSQL + Redis probe path that unit tests stub out.
 * Requires both `DATABASE_URL` and `REDIS_URL` to point at reachable services;
 * when either is missing the suite skips with a printed warning (never a silent
 * pass). Excluded from `pnpm test` (the `*.integration.test.ts` suffix) and run
 * by `pnpm test:integration` / CI with infrastructure up.
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const canRun = Boolean(databaseUrl && redisUrl);

if (!canRun) {
  console.warn(
    '[api] Skipping readiness.integration.test.ts: set DATABASE_URL and REDIS_URL to reachable services to run it.',
  );
}

describe.skipIf(!canRun)('GET /ready against live dependencies', () => {
  // Clients are created in beforeAll (not at collection time) so a skipped run
  // never opens connections or emits stray client errors.
  let db: ReturnType<typeof createDbClient>;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createDbClient(databaseUrl as string);
    redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });

    const probes: ReadinessProbe[] = [
      { name: 'postgres', check: () => pingDatabase(db.sql) },
      {
        name: 'redis',
        check: async () => {
          await redis.ping();
        },
      },
    ];

    app = buildApp({ config: testConfig(), readinessProbes: probes, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    redis.disconnect();
  });

  it('returns 200 and a healthy success envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ready');
    expect(body.data.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('reports liveness independently of dependencies', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { status: 'ok' } });
  });
});
