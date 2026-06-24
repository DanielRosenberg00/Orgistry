import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PROJECT_EVENT_TYPES } from './project.events';
import {
  buildProjectsTestApp,
  type ProjectsTestContext,
} from './testing/build-projects-test-app';

/**
 * End-to-end Projects route behavior, exercised through `app.inject` over the
 * shared in-memory store. Covers authentication, membership + permission gating
 * (by permission key, never role name), cross-tenant isolation, soft-delete
 * lifecycle, cursor pagination, and the action-event seam.
 *
 * Every assertion proves BACKEND enforcement — there is no UI to hide behind.
 */
let ctx: ProjectsTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Project User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `project.user.${emailSeq}@example.com`,
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

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
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

/** Directly seed an active membership (no invite flow exists yet). */
function addMembership(
  organizationId: string,
  userId: string,
  roleId: string,
): string {
  const now = new Date();
  const id = createId('mem');
  ctx.orgStore.memberships.push({
    id,
    userId,
    organizationId,
    roleId,
    status: 'active',
    invitedByUserId: null,
    joinedAt: now,
    removedAt: null,
    removedByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Create a project via the API and return its id (owner has projects.create). */
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

beforeEach(async () => {
  ctx = await buildProjectsTestApp();
  app = ctx.app;
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/organizations/:id/projects (create)', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      payload: { name: 'Launch' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (a stranger gets a uniform 404)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(stranger.token),
      payload: { name: 'Launch' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('requires projects.create — a Viewer is forbidden', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(viewer.token),
      payload: { name: 'Launch' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('creates a project, records the creator, and writes project.created', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
      payload: { name: 'Launch Plan' },
    });
    expect(response.statusCode).toBe(201);
    const project = response.json().data.project;
    expect(project.id).toMatch(/^prj_/);
    expect(project.organizationId).toBe(orgId);
    expect(project.name).toBe('Launch Plan');
    expect(project.createdByUserId).toBe(owner.userId);

    const events = ctx.orgStore.securityEvents.filter(
      (e) => e.eventType === PROJECT_EVENT_TYPES.created,
    );
    expect(events).toHaveLength(1);
    expect(events[0].organizationId).toBe(orgId);
    expect(events[0].userId).toBe(owner.userId);
    expect(events[0].metadata.targetProjectId).toBe(project.id);
  });

  it('ignores an organizationId smuggled into the body (route is the authority)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const otherOwner = await registerUser('Other');
    const otherOrgId = await createTeamOrg(otherOwner.token, 'Other');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
      payload: { name: 'Launch', organizationId: otherOrgId },
    });
    expect(response.statusCode).toBe(201);
    // The project is created under the ROUTE organization, not the body's.
    expect(response.json().data.project.organizationId).toBe(orgId);
  });

  it('rejects a blank name with a validation error', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
      payload: { name: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('does not expose soft-delete internals in the DTO', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
      payload: { name: 'Launch' },
    });
    const raw = JSON.stringify(response.json());
    expect(raw).not.toContain('deletedAt');
    expect(raw).not.toContain('deleted_at');
    expect(raw).not.toContain('deletedByUserId');
  });
});

describe('GET /v1/organizations/:id/projects (list)', () => {
  it('requires projects.read — handled, and returns only the org\'s active projects', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await createProject(owner.token, orgId, 'Alpha');
    await createProject(owner.token, orgId, 'Beta');

    // A separate org whose projects must NOT appear here.
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other Org');
    await createProject(other.token, otherOrgId, 'Foreign');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .data.items.map((p: { name: string }) => p.name);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
    expect(names).not.toContain('Foreign');
  });

  it('omits soft-deleted projects from the list', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const keepId = await createProject(owner.token, orgId, 'Keep');
    const dropId = await createProject(owner.token, orgId, 'Drop');

    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${dropId}`,
      headers: authHeader(owner.token),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
    });
    const ids = response.json().data.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(keepId);
    expect(ids).not.toContain(dropId);
  });

  it('paginates with an opaque cursor and enforces the requested limit', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 5; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }

    const first = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects?limit=2`,
      headers: authHeader(owner.token),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.items).toHaveLength(2);
    expect(first.json().data.hasMore).toBe(true);
    const cursor = first.json().data.nextCursor;
    expect(cursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: authHeader(owner.token),
    });
    expect(second.json().data.items).toHaveLength(2);

    // The two pages do not overlap (stable keyset ordering).
    const firstIds = first.json().data.items.map((p: { id: string }) => p.id);
    const secondIds = second.json().data.items.map((p: { id: string }) => p.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('defaults the page limit to 20 when none is given', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 25; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
    });
    expect(response.json().data.items).toHaveLength(20); // DEFAULT_PAGE_LIMIT
    expect(response.json().data.hasMore).toBe(true);
  });

  it('rejects a limit above the maximum (100)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects?limit=101`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed cursor with BAD_REQUEST', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects?cursor=not-a-valid-cursor`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('lets a Viewer (projects.read) list projects', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);
    await createProject(owner.token, orgId, 'Visible');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(1);
  });
});

describe('GET /v1/organizations/:id/projects/:projectId (read)', () => {
  it('reads a project the caller can see (projects.read)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Readable');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.project.id).toBe(projectId);
  });

  it('returns a safe PROJECT_NOT_FOUND for a cross-tenant project', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    const foreignId = await createProject(other.token, otherOrgId, 'Foreign');

    // Owner is a member of orgId; addressing the foreign project under THEIR org.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/${foreignId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns a safe PROJECT_NOT_FOUND for a soft-deleted project', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Doomed');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('PATCH /v1/organizations/:id/projects/:projectId (update)', () => {
  it('requires projects.update — a Viewer is forbidden', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);
    const projectId = await createProject(owner.token, orgId, 'Original');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(viewer.token),
      payload: { name: 'Renamed' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('updates the name and records project.updated', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Original');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
      payload: { name: 'Renamed' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.project.name).toBe('Renamed');
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === PROJECT_EVENT_TYPES.updated,
      ),
    ).toBe(true);
  });

  it('returns a safe PROJECT_NOT_FOUND for a cross-tenant update', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    const foreignId = await createProject(other.token, otherOrgId, 'Foreign');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/projects/${foreignId}`,
      headers: authHeader(owner.token),
      payload: { name: 'Hijacked' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns a safe PROJECT_NOT_FOUND when updating a deleted project', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Doomed');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
      payload: { name: 'Resurrect' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('DELETE /v1/organizations/:id/projects/:projectId (soft delete)', () => {
  it('requires projects.delete — a Member is forbidden', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const projectId = await createProject(owner.token, orgId, 'Target');

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('soft-deletes the project, sets markers, and records project.deleted', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Target');

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ id: projectId, deleted: true });

    const stored = ctx.orgStore.projects.find((p) => p.id === projectId)!;
    expect(stored.deletedAt).not.toBeNull(); // not hard-deleted
    expect(stored.deletedByUserId).toBe(owner.userId);
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === PROJECT_EVENT_TYPES.deleted,
      ),
    ).toBe(true);
  });

  it('a repeated delete fails safely with PROJECT_NOT_FOUND', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Target');

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns a safe PROJECT_NOT_FOUND for a cross-tenant delete', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    const foreignId = await createProject(other.token, otherOrgId, 'Foreign');

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${foreignId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');

    // The foreign project is untouched (still active in its own org).
    const stored = ctx.orgStore.projects.find((p) => p.id === foreignId)!;
    expect(stored.deletedAt).toBeNull();
  });
});

describe('removed membership loses project access', () => {
  it('a removed member can no longer list or create projects', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const memId = addMembership(orgId, member.userId, ROLE_IDS.member);

    // Sanity: the member can list while active.
    const before = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(member.token),
    });
    expect(before.statusCode).toBe(200);

    // Remove the membership directly (soft-removed).
    ctx.orgStore.memberships.find((m) => m.id === memId)!.status = 'removed';

    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(member.token),
    });
    expect(list.statusCode).toBe(404);
    expect(list.json().error.code).toBe('ORGANIZATION_NOT_FOUND');

    const create = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(member.token),
      payload: { name: 'Nope' },
    });
    expect(create.statusCode).toBe(404);
  });
});

describe('route param resolution (the org/member safe-not-found convention)', () => {
  it('treats a malformed project id as a uniform PROJECT_NOT_FOUND, not a probe', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    // A structurally garbage project id is resolved server-side (not prefix-
    // validated at the edge), so it surfaces the SAME safe 404 as an unknown but
    // well-formed id — existence never leaks, and the error carries the request id.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/not-a-real-id`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
    expect(typeof response.json().error.requestId).toBe('string');
    expect(response.json().error.requestId.length).toBeGreaterThan(0);
  });

  it('updating/deleting a malformed project id is also a safe PROJECT_NOT_FOUND', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/projects/garbage`,
      headers: authHeader(owner.token),
      payload: { name: 'x' },
    });
    expect(update.statusCode).toBe(404);
    expect(update.json().error.code).toBe('PROJECT_NOT_FOUND');

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/garbage`,
      headers: authHeader(owner.token),
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('valid route params still resolve the project', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const projectId = await createProject(owner.token, orgId, 'Real');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.project.id).toBe(projectId);
  });
});

describe('cursor pagination tie-breaker (equal created_at)', () => {
  it('pages stably with no duplicates or skips when timestamps tie', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 5; i += 1) {
      await createProject(owner.token, orgId, `Tie ${i}`);
    }

    // Force a worst-case tie: every project in the org shares the SAME created_at.
    // Stable ordering must then fall back to the id tiebreaker (id DESC), which the
    // cursor predicate `created_at < c OR (created_at = c AND id < c.id)` handles.
    const sharedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    const orgProjects = ctx.orgStore.projects.filter(
      (p) => p.organizationId === orgId,
    );
    expect(orgProjects).toHaveLength(5);
    for (const project of orgProjects) {
      project.createdAt = sharedCreatedAt;
    }

    // Walk every page of size 2 to exhaustion via the opaque cursor only.
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
      expect(cursor).toBeTruthy();
    }

    // Every project appears exactly once (no duplicates, no skips)...
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // ...and ordering is the stable id-DESC tiebreaker for the shared timestamp.
    const expectedOrder = orgProjects
      .map((p) => p.id)
      .sort((a, b) => (a < b ? 1 : -1));
    expect(seen).toEqual(expectedOrder);
  });
});
