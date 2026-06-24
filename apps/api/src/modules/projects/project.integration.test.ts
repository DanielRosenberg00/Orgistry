import { createDbClient, ROLE_IDS, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { createId } from '@orgistry/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from '../auth/auth.service';
import { createDbAuthRepository } from '../auth/auth.repo';
import { createOrganizationService } from '../organization/organization.service';
import { createDbOrganizationRepository } from '../organization/organization.repo';
import { createProjectService } from './project.service';
import { createDbProjectRepository } from './project.repo';
import { PROJECT_EVENT_TYPES } from './project.events';
import { createEntitlementService } from '../entitlements/entitlement.service';
import { createDbEntitlementRepository } from '../entitlements/plan.repo';

/**
 * DB-backed Projects integration test.
 *
 * Proves the persistence invariants the in-memory unit tests cannot: the
 * projects table migrates from scratch, every active query is scoped by
 * organization id, soft delete writes the lifecycle markers (and the row is
 * never hard-deleted), cross-tenant access fails safely, and project actions are
 * recorded on the organization-scoped event seam.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping project.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('projects against live PostgreSQL', () => {
  const config = testConfig();
  let db: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let emailSeq = 0;

  function authHeader(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function registerUser(displayName = 'Test User'): Promise<{
    token: string;
    userId: string;
  }> {
    emailSeq += 1;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `project.int.${emailSeq}@example.com`,
        password: 'a-strong-password-123',
        displayName,
      },
    });
    expect(response.statusCode).toBe(201);
    return {
      token: response.json().data.tokens.accessToken,
      userId: response.json().data.user.id,
    };
  }

  async function createTeamOrg(token: string, name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: authHeader(token),
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json().data.organization.id;
  }

  async function addMembership(
    organizationId: string,
    userId: string,
    roleId: string,
  ): Promise<string> {
    const id = createId('mem');
    await db.sql`
      INSERT INTO memberships (id, user_id, organization_id, role_id, status)
      VALUES (${id}, ${userId}, ${organizationId}, ${roleId}, 'active')`;
    return id;
  }

  async function createProject(
    token: string,
    organizationId: string,
    name: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/projects`,
      headers: authHeader(token),
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json().data.project.id;
  }

  /**
   * Lift the organization onto the Business demo plan so its `max_projects`
   * quota does not interfere with a pagination test that needs many projects.
   * Quota enforcement itself is proven in the dedicated quota tests.
   */
  async function liftProjectQuota(organizationId: string): Promise<void> {
    await db.sql`
      UPDATE organization_plans SET plan_key = 'business'
      WHERE organization_id = ${organizationId}`;
  }

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    const orgRepo = createDbOrganizationRepository(db.db);

    const authService = createAuthService({
      repo: createDbAuthRepository(db.db),
      jwtSecret: config.auth.jwtSecret,
      accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
      refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    });
    app = buildApp({
      config,
      readinessProbes: [passingProbe('postgres')],
      authService,
      organizationService: createOrganizationService({ repo: orgRepo }),
      projectService: createProjectService({
        accessControl: orgRepo,
        projects: createDbProjectRepository(db.db),
        entitlements: createEntitlementService({
          repo: createDbEntitlementRepository(db.db),
        }),
      }),
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    // Truncate domain tables; PRESERVE the seeded roles/permissions baseline.
    await db.sql.unsafe(
      'TRUNCATE projects, memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
  });

  it('migrates the projects table from scratch with its indexes', async () => {
    const table = await db.sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.projects') IS NOT NULL AS exists`;
    expect(table[0].exists).toBe(true);

    const rows = await db.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'projects'`;
    const present = new Set(rows.map((r) => r.indexname));
    expect(present.has('ix_projects_org_created_active')).toBe(true);
    expect(present.has('ix_projects_org_id')).toBe(true);
  });

  it('creates, reads, lists, and updates a project and records events', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    const projectId = await createProject(owner.token, orgId, 'Launch');

    const stored = await db.sql<
      { organization_id: string; created_by_user_id: string; name: string }[]
    >`SELECT organization_id, created_by_user_id, name FROM projects WHERE id = ${projectId}`;
    expect(stored[0].organization_id).toBe(orgId);
    expect(stored[0].created_by_user_id).toBe(owner.userId);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.project.name).toBe('Launch');

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
      payload: { name: 'Launch v2' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.project.name).toBe('Launch v2');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
    });
    expect(list.json().data.items.map((p: { id: string }) => p.id)).toContain(
      projectId,
    );

    const events = await db.sql<{ event_type: string; organization_id: string }[]>`
      SELECT event_type, organization_id FROM security_events
      WHERE event_type IN ('project.created', 'project.updated') ORDER BY event_type`;
    expect(events.map((e) => e.event_type)).toEqual([
      PROJECT_EVENT_TYPES.created,
      PROJECT_EVENT_TYPES.updated,
    ]);
    expect(events.every((e) => e.organization_id === orgId)).toBe(true);
  });

  it('soft-deletes with lifecycle markers, keeps the row, and hides it', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Doomed');

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.sql<
      { deleted_at: string | null; deleted_by_user_id: string | null }[]
    >`SELECT deleted_at, deleted_by_user_id FROM projects WHERE id = ${projectId}`;
    expect(rows).toHaveLength(1); // not hard-deleted
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].deleted_by_user_id).toBe(owner.userId);

    // Hidden from active read & list.
    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(read.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
    });
    expect(list.json().data.items).toHaveLength(0);

    const events = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events WHERE event_type = 'project.deleted'`;
    expect(events[0].count).toBe('1');
  });

  it('scopes every flow by organization id (cross-tenant is a safe 404)', async () => {
    const owner = await registerUser('Owner A');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const other = await registerUser('Owner B');
    const otherOrgId = await createTeamOrg(other.token, 'Beta');
    const foreignId = await createProject(other.token, otherOrgId, 'Foreign');

    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `/v1/organizations/${orgId}/projects/${foreignId}`,
        headers: authHeader(owner.token),
        ...(method === 'PATCH' ? { payload: { name: 'x' } } : {}),
      });
      expect(response.statusCode, `${method} should 404`).toBe(404);
      expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
    }

    // The foreign project is untouched and still active in its own org.
    const rows = await db.sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM projects WHERE id = ${foreignId}`;
    expect(rows[0].deleted_at).toBeNull();
  });

  it('enforces project permissions by key, not role name', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await addMembership(orgId, viewer.userId, ROLE_IDS.viewer);
    const projectId = await createProject(owner.token, orgId, 'Target');

    // Viewer has projects.read (can list/read) but not create/update/delete.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(viewer.token),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(viewer.token),
      payload: { name: 'Nope' },
    });
    expect(create.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(viewer.token),
    });
    expect(del.statusCode).toBe(403);
  });

  it('paginates a tenant\'s projects with a stable cursor', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await liftProjectQuota(orgId);
    for (let i = 0; i < 5; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }

    const first = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects?limit=2`,
      headers: authHeader(owner.token),
    });
    expect(first.json().data.items).toHaveLength(2);
    const cursor = first.json().data.nextCursor as string;

    const second = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: authHeader(owner.token),
    });
    const firstIds = first.json().data.items.map((p: { id: string }) => p.id);
    const secondIds = second.json().data.items.map((p: { id: string }) => p.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('keyset-paginates correctly when every project shares a created_at (SQL tie-breaker)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    // Insert 5 projects with the IDENTICAL created_at directly, so the only thing
    // distinguishing them in the keyset is the id tiebreaker. This exercises the
    // real SQL predicate `created_at < c OR (created_at = c AND id < c.id)` — a
    // predicate that only compared created_at would skip or duplicate rows here.
    const sharedCreatedAt = '2026-01-01T00:00:00.000Z';
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = createId('prj');
      ids.push(id);
      await db.sql`
        INSERT INTO projects (id, organization_id, name, created_by_user_id, created_at, updated_at)
        VALUES (${id}, ${orgId}, ${`Tie ${i}`}, ${owner.userId}, ${sharedCreatedAt}, ${sharedCreatedAt})`;
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url =
        `/v1/organizations/${orgId}/projects?limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const page = await app.inject({
        method: 'GET',
        url,
        headers: authHeader(owner.token),
      });
      expect(page.statusCode).toBe(200);
      const body = page.json().data as {
        items: { id: string }[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      seen.push(...body.items.map((p) => p.id));
      if (!body.hasMore) {
        break;
      }
      cursor = body.nextCursor;
    }

    // Every project exactly once, in the stable id-DESC tiebreaker order.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...ids].sort((a, b) => (a < b ? 1 : -1)));
  });
});
