import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { buildLoggerOptions } from '../../lib/logging';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from '../auth/auth.service';
import { createDbAuthRepository } from '../auth/auth.repo';
import { createDbRegistrationRepository } from '../auth/registration.repo';
import { createRegistrationService } from '../auth/registration.service';
import { registerTestUser } from '../auth/testing/register-test-user';
import { createOrganizationService } from '../organization/organization.service';
import { createDbOrganizationRepository } from '../organization/organization.repo';
import { createEntitlementService } from '../entitlements/entitlement.service';
import { createDbEntitlementRepository } from '../entitlements/plan.repo';
import { createPlanService } from '../entitlements/plan.service';
import { createInMemoryAccountMailer } from '../mail/testing/in-memory-account-mailer';
import { createDbApiKeyRepository } from './api-key.repo';
import { createApiKeyService } from './api-key.service';
import { createApiKeyAuthenticator } from './api-key.authenticator';
import { createExternalProjectsService } from './external-projects.service';
import { createDbProjectRepository } from '../projects/project.repo';
import { createProjectService } from '../projects/project.service';

/**
 * DB-backed External API failed-auth write bounding (Sprint 19, ORG-PR-013).
 *
 * Proves against real PostgreSQL that an invalid-credential storm cannot grow
 * `security_events` one row per request: durable failed-auth writes are
 * bounded per source IP per window by `authFailEventsPerIpMax`, stored
 * metadata never contains the presented credential, the captured process logs
 * never contain it either, and a VALID key keeps authenticating normally
 * (including its route behavior) while the storm rages.
 *
 * Skips with a warning when no database is reachable; run via
 * `pnpm test:integration`.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping api-key.failed-auth.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

const EVENT_WRITE_ALLOWANCE = 3;
const STORM_SIZE = 25;
const STORM_IP = '198.51.100.66';
/** The invalid credential presented by the storm. Never a real secret. */
const INVALID_CREDENTIAL = 'okey_live_completely_invalid_storm_credential_000';

describe.skipIf(!connectionString)(
  'external API failed-auth write bounding against live PostgreSQL',
  () => {
    const config = testConfig();
    let db: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    let mailer: ReturnType<typeof createInMemoryAccountMailer>;
    const capturedLogs: string[] = [];

    function authHeader(token: string): Record<string, string> {
      return { authorization: `Bearer ${token}` };
    }

    async function failedAuthEventCount(): Promise<number> {
      const rows = await db.sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM security_events
        WHERE event_type IN ('api_key.auth_malformed', 'api_key.auth_unknown')`;
      return Number(rows[0].count);
    }

    beforeAll(async () => {
      await runMigrations(connectionString as string);
      db = createDbClient(connectionString as string);

      const orgRepo = createDbOrganizationRepository(db.db);
      const entitlements = createEntitlementService({
        repo: createDbEntitlementRepository(db.db),
      });
      const apiKeyRepo = createDbApiKeyRepository(db.db);
      const projectRepo = createDbProjectRepository(db.db);
      mailer = createInMemoryAccountMailer();

      const authService = createAuthService({
        repo: createDbAuthRepository(db.db),
        jwtSecret: config.auth.jwtSecret,
        accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
        sessionTtlSeconds: config.auth.sessionTtlSeconds,
        refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
      });
      const registrationService = createRegistrationService({
        repo: createDbRegistrationRepository(db.db),
        mailer,
        webBaseUrl: config.web.url,
        completionTtlSeconds: config.registration.completionTtlSeconds,
        jwtSecret: config.auth.jwtSecret,
        accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
        sessionTtlSeconds: config.auth.sessionTtlSeconds,
        refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
      });

      const apiKeyAuthenticator = createApiKeyAuthenticator({
        apiKeys: apiKeyRepo,
        organizations: orgRepo,
        entitlements,
        rateLimiter: createInMemoryRateLimiter(),
        rateLimits: {
          windowSeconds: 3600, // one window across the whole suite
          perKeyMax: Number.MAX_SAFE_INTEGER,
          perOrgMax: Number.MAX_SAFE_INTEGER,
          authFailEventsPerIpMax: EVENT_WRITE_ALLOWANCE,
        },
        lastUsedThrottleSeconds: 60,
      });

      app = buildApp({
        config,
        readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
        authService,
        registrationService,
        organizationService: createOrganizationService({ repo: orgRepo }),
        planService: createPlanService({
          accessControl: orgRepo,
          entitlements,
        }),
        projectService: createProjectService({
          accessControl: orgRepo,
          projects: projectRepo,
        }),
        apiKeyService: createApiKeyService({
          accessControl: orgRepo,
          apiKeys: apiKeyRepo,
          entitlements,
        }),
        externalProjectsService: createExternalProjectsService({
          projects: projectRepo,
        }),
        apiKeyAuthenticator,
        // Real logger with the centralized redaction, captured in memory so
        // the "credential never in logs" claim is proven, not assumed.
        logger: buildLoggerOptions(config, {
          write: (chunk: string) => {
            capturedLogs.push(chunk);
          },
        }),
      });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await db?.close();
    });

    it('bounds durable failed-auth writes under an invalid-credential storm', async () => {
      const baseline = await failedAuthEventCount();

      for (let i = 0; i < STORM_SIZE; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/external/projects',
          remoteAddress: STORM_IP,
          headers: { authorization: `Bearer ${INVALID_CREDENTIAL}` },
        });
        // The response contract never changes: uniform generic 401.
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('API_KEY_UNAUTHORIZED');
      }

      const growth = (await failedAuthEventCount()) - baseline;
      expect(growth).toBeGreaterThan(0); // visibility retained…
      expect(growth).toBeLessThanOrEqual(EVENT_WRITE_ALLOWANCE); // …but bounded.
    });

    it('stores no raw credential in any security-event metadata', async () => {
      const rows = await db.sql<{ metadata: unknown; ip_address: string | null }[]>`
        SELECT metadata, ip_address FROM security_events
        WHERE event_type IN ('api_key.auth_malformed', 'api_key.auth_unknown')`;
      expect(rows.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(rows.map((r) => r.metadata));
      expect(serialized).not.toContain(INVALID_CREDENTIAL);
      expect(serialized.toLowerCase()).not.toContain('authorization');
    });

    it('keeps the raw credential out of the captured process logs', () => {
      const logs = capturedLogs.join('');
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).not.toContain(INVALID_CREDENTIAL);
    });

    it('keeps a VALID key fully functional during and after the storm', async () => {
      // Provision: user -> team org -> pro plan (api_keys_access) -> key.
      const owner = await registerTestUser(app, mailer, {
        email: 'storm.owner@example.com',
        password: 'a-strong-password-123',
        displayName: 'Storm Owner',
      });
      const orgResponse = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: authHeader(owner.accessToken),
        payload: { name: 'Storm Org' },
      });
      expect(orgResponse.statusCode).toBe(201);
      const orgId = orgResponse.json().data.organization.id;

      const planChange = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgId}/plan/demo`,
        headers: authHeader(owner.accessToken),
        payload: { planKey: 'pro' },
      });
      expect(planChange.statusCode).toBe(200);

      const keyResponse = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/api-keys`,
        headers: authHeader(owner.accessToken),
        payload: { name: 'storm-key', scopes: ['projects:read'] },
      });
      expect(keyResponse.statusCode).toBe(201);
      const rawKey = keyResponse.json().data.secret as string;

      // Interleave more invalid noise from the storm IP…
      for (let i = 0; i < 5; i += 1) {
        await app.inject({
          method: 'GET',
          url: '/v1/external/projects',
          remoteAddress: STORM_IP,
          headers: { authorization: `Bearer ${INVALID_CREDENTIAL}` },
        });
      }

      // …the valid key still authenticates and the external route behaves.
      const list = await app.inject({
        method: 'GET',
        url: '/v1/external/projects',
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().ok).toBe(true);
      expect(Array.isArray(list.json().data.items)).toBe(true);
    });
  },
);
