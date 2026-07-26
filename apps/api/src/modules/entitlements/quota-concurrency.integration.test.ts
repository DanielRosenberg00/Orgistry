import { createDbClient, ROLE_IDS, runMigrations, schema } from '@orgistry/db';
import { eq, sql as rawSql } from 'drizzle-orm';
import { hashOpaqueToken } from '@orgistry/auth-core';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { createId } from '@orgistry/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireRow } from '../../lib/db-rows';
import { requireDefined } from '../../lib/invariant';
import { createDbApiKeyRepository } from '../api-keys/api-key.repo';
import { createDbInvitationRepository } from '../invitations/invitation.repo';
import { hashInvitationToken } from '../invitations/invitation.token';
import { createDbProjectRepository } from '../projects/project.repo';
import { createDbRegistrationRepository } from '../auth/registration.repo';
import { hashRegistrationCompletionToken } from '../auth/registration.token';
import type { CompleteRegistrationResult } from '../auth/registration.types';

/**
 * Real-PostgreSQL quota concurrency proof (Sprint 20 — ORG-PR-029/ORG-PR-044).
 *
 * Every test launches SEVERAL genuinely parallel attempts (separate pool
 * connections, so the transactions overlap and queue on the organization's
 * quota advisory lock) against a capacity of ONE, and asserts:
 *  - EXACTLY the allowed number of attempts succeeds;
 *  - the excess attempts fail with the safe QUOTA_EXCEEDED contract (or the
 *    documented invitation-unavailable completion outcome);
 *  - final DATABASE state matches: no ceiling overrun, no orphaned rows, and
 *    success events exactly match committed mutations.
 *
 * The repositories are driven directly (the same precedent as the Last-Owner
 * race test in member.integration.test.ts): permission/entitlement ordering is
 * covered by the route suites; what only a live database can prove is the
 * serialization of count + insert. If the quota lock (or the in-transaction
 * count) is removed, the exact-success-count assertions fail.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping quota-concurrency.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

/** Attempts fired per race; capacity is always ONE remaining seat/slot. */
const PARALLEL_ATTEMPTS = 6;

const ctx = { requestId: null, ipAddress: null, userAgent: null };

describe.skipIf(!connectionString)('quota enforcement under real concurrency', () => {
  let db: ReturnType<typeof createDbClient>;
  let projectRepo: ReturnType<typeof createDbProjectRepository>;
  let apiKeyRepo: ReturnType<typeof createDbApiKeyRepository>;
  let invitationRepo: ReturnType<typeof createDbInvitationRepository>;
  let registrationRepo: ReturnType<typeof createDbRegistrationRepository>;
  let seq = 0;

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    projectRepo = createDbProjectRepository(db.db);
    apiKeyRepo = createDbApiKeyRepository(db.db);
    invitationRepo = createDbInvitationRepository(db.db);
    registrationRepo = createDbRegistrationRepository(db.db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.sql.unsafe(
      'TRUNCATE pending_registrations, memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
  });

  async function insertUser(label: string): Promise<{ id: string; email: string }> {
    seq += 1;
    const email = `quota.${label}.${seq}@example.com`;
    const user = requireRow(
      await db.db
        .insert(schema.users)
        .values({
          email,
          normalizedEmail: email,
          passwordHash: 'x-not-a-real-hash',
          displayName: label,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: schema.users.id }),
      'inserted user',
    );
    return { id: user.id, email };
  }

  /** Team org owned by `ownerId`, with plan state (default free). */
  async function insertTeamOrg(ownerId: string, planKey = 'free'): Promise<string> {
    seq += 1;
    const org = requireRow(
      await db.db
        .insert(schema.organizations)
        .values({
          name: `Quota Org ${seq}`,
          slug: `quota-org-${seq}`,
          type: 'team',
          createdByUserId: ownerId,
        })
        .returning({ id: schema.organizations.id }),
      'inserted organization',
    );
    await db.db.insert(schema.memberships).values({
      userId: ownerId,
      organizationId: org.id,
      roleId: ROLE_IDS.owner,
      status: 'active',
    });
    await db.db.insert(schema.organizationPlans).values({
      id: createId('oplan'),
      organizationId: org.id,
      planKey: planKey as 'free' | 'pro' | 'business',
      changedByUserId: ownerId,
    });
    return org.id;
  }

  async function insertActiveMember(orgId: string, userId: string): Promise<void> {
    await db.db.insert(schema.memberships).values({
      userId,
      organizationId: orgId,
      roleId: ROLE_IDS.member,
      status: 'active',
    });
  }

  /** Pending invitation for `email`; returns the raw token. */
  async function insertInvitation(orgId: string, inviterId: string, email: string): Promise<string> {
    seq += 1;
    const rawToken = `race-token-${seq}-${createId('inv')}`;
    await db.db.insert(schema.invitations).values({
      id: createId('inv'),
      organizationId: orgId,
      invitedEmail: email,
      invitedEmailNormalized: email,
      roleId: ROLE_IDS.member,
      tokenHash: hashInvitationToken(rawToken),
      status: 'pending',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return rawToken;
  }

  /**
   * Force the pool to open one live connection per parallel attempt BEFORE the
   * race. postgres.js opens connections lazily; on a cold pool the connection
   * handshakes stagger the racers enough to serialize them by accident, and
   * the race being tested never actually happens (verified empirically: with
   * a cold pool a lock-free build still "passed"; with a warmed pool it
   * overruns every time). Concurrent transactions each reserve a distinct
   * connection, so this genuinely widens the pool.
   */
  async function warmPool(connections = PARALLEL_ATTEMPTS): Promise<void> {
    await Promise.all(
      Array.from({ length: connections }, () =>
        db.db.transaction((tx) => tx.execute(rawSql`SELECT pg_sleep(0.05)`)),
      ),
    );
  }

  function isQuotaExceeded(reason: unknown): boolean {
    return (
      typeof reason === 'object' &&
      reason !== null &&
      (reason as { code?: unknown }).code === 'QUOTA_EXCEEDED'
    );
  }

  it('concurrent project creates cannot exceed max_projects (capacity 1 → exactly 1 wins)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id); // free: max_projects = 3
    // Fill to limit - 1 (one seat left). One row is soft-deleted to prove the
    // counting basis: deleted projects never occupy a slot.
    await db.db.insert(schema.projects).values([
      { id: createId('prj'), organizationId: orgId, name: 'P1', createdByUserId: owner.id },
      { id: createId('prj'), organizationId: orgId, name: 'P2', createdByUserId: owner.id },
      { id: createId('prj'), organizationId: orgId, name: 'Gone', createdByUserId: owner.id, deletedAt: new Date(), deletedByUserId: owner.id },
    ]);

    await warmPool();
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_ATTEMPTS }, (_, i) =>
        projectRepo.createProject({
          organizationId: orgId,
          name: `Race ${i}`,
          createdByUserId: owner.id,
          ctx: { actorUserId: owner.id, actorMembershipId: 'mem_x', ...ctx },
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL_ATTEMPTS - 1);
    for (const r of rejected) {
      expect(isQuotaExceeded(r.reason)).toBe(true);
    }

    // Final state: exactly at the ceiling, and success events exactly match
    // committed projects (the event insert shares the creation transaction).
    const active = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM projects
      WHERE organization_id = ${orgId} AND deleted_at IS NULL`;
    expect(active[0]?.count).toBe('3');
    const events = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE organization_id = ${orgId} AND event_type = 'project.created'`;
    expect(events[0]?.count).toBe('1');
  });

  it('concurrent API key creates cannot exceed max_api_keys (capacity 1 → exactly 1 wins)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'pro'); // pro: max_api_keys = 5
    const now = new Date();
    // 4 active keys + 1 revoked + 1 expired (the last two must NOT count).
    const baseKey = (n: number) => ({
      id: createId('key'),
      organizationId: orgId,
      name: `K${n}`,
      displayPrefix: `orgistry_TEST${n}`,
      secretHash: hashOpaqueToken(`seed-secret-${seq}-${n}`),
      scopes: ['projects:read'] as ['projects:read'],
      createdByUserId: owner.id,
    });
    await db.db.insert(schema.apiKeys).values([
      baseKey(1),
      baseKey(2),
      baseKey(3),
      baseKey(4),
      { ...baseKey(5), revokedAt: now, revokedByUserId: owner.id },
      { ...baseKey(6), expiresAt: new Date(now.getTime() - 1000) },
    ]);

    await warmPool();
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_ATTEMPTS }, (_, i) =>
        apiKeyRepo.createApiKey({
          organizationId: orgId,
          name: `Race ${i}`,
          displayPrefix: `orgistry_RACE${i}`,
          secretHash: hashOpaqueToken(`race-secret-${seq}-${i}`),
          scopes: ['projects:read'],
          expiresAt: null,
          createdByUserId: owner.id,
          now,
          ctx: { actorUserId: owner.id, actorMembershipId: 'mem_x', ...ctx },
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL_ATTEMPTS - 1);
    for (const r of rejected) {
      expect(isQuotaExceeded(r.reason)).toBe(true);
    }

    const active = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM api_keys
      WHERE organization_id = ${orgId} AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`;
    expect(active[0]?.count).toBe('5');
    const events = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE organization_id = ${orgId} AND event_type = 'api_key.created'`;
    expect(events[0]?.count).toBe('1');
  });

  it('concurrent acceptances of DISTINCT invitations cannot exceed max_members (capacity 1 → exactly 1 joins)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id); // free: max_members = 3
    const second = await insertUser('member');
    await insertActiveMember(orgId, second.id); // 2 active members → 1 seat left

    const invitees = await Promise.all(
      Array.from({ length: 4 }, () => insertUser('invitee')),
    );
    const tokens: string[] = [];
    for (const invitee of invitees) {
      tokens.push(await insertInvitation(orgId, owner.id, invitee.email));
    }

    await warmPool();
    const results = await Promise.allSettled(
      invitees.map((invitee, i) =>
        invitationRepo.acceptInvitation({
          selector: {
            tokenHash: hashInvitationToken(
              requireDefined(tokens[i], `invitation token ${i}`),
            ),
          },
          acceptingUserId: invitee.id,
          acceptingUserNormalizedEmail: invitee.email,
          ctx: { actorUserId: invitee.id, actorMembershipId: null, ...ctx },
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(isQuotaExceeded(r.reason)).toBe(true);
    }

    // Exactly at the member ceiling; exactly one invitation consumed (single
    // use); the losers remain pending and re-usable once capacity frees up.
    const members = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships
      WHERE organization_id = ${orgId} AND status = 'active'`;
    expect(members[0]?.count).toBe('3');
    const invitationStates = await db.sql<{ status: string; count: string }[]>`
      SELECT status, count(*)::text AS count FROM invitations
      WHERE organization_id = ${orgId} GROUP BY status ORDER BY status`;
    expect(invitationStates).toEqual([
      { status: 'accepted', count: '1' },
      { status: 'pending', count: '3' },
    ]);
    const accepted = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE organization_id = ${orgId} AND event_type = 'invitation.accepted'`;
    expect(accepted[0]?.count).toBe('1');
    const provenance = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE organization_id = ${orgId} AND event_type = 'membership.created_from_invitation'`;
    expect(provenance[0]?.count).toBe('1');
  });

  it('concurrent invited registration completions cannot exceed max_members (accounts commit; exactly 1 membership)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id); // free: max_members = 3
    const second = await insertUser('member');
    await insertActiveMember(orgId, second.id); // 1 seat left

    // 4 pending registrations for NEW emails, each carrying a DISTINCT
    // invitation into the same organization.
    const completions = [];
    for (let i = 0; i < 4; i += 1) {
      seq += 1;
      const email = `race.registrant.${seq}@example.com`;
      const rawInvitationToken = await insertInvitation(orgId, owner.id, email);
      // Resolve the id of the invitation just inserted (tokenHash is unique).
      const invitationRow = requireRow(
        await db.db
          .select({ id: schema.invitations.id })
          .from(schema.invitations)
          .where(
            eq(
              schema.invitations.tokenHash,
              hashInvitationToken(rawInvitationToken),
            ),
          )
          .limit(1),
        'inserted invitation',
      );
      const rawCompletionToken = `race-completion-${seq}`;
      await db.db.insert(schema.pendingRegistrations).values({
        email,
        normalizedEmail: email,
        passwordHash: 'x-not-a-real-hash',
        displayName: `Racer ${i}`,
        tokenHash: hashRegistrationCompletionToken(rawCompletionToken),
        invitationId: invitationRow.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      completions.push({ rawCompletionToken, invitationId: invitationRow.id, email });
    }

    await warmPool(completions.length);
    const now = new Date();
    const results = await Promise.all(
      completions.map((c, i) =>
        registrationRepo.completeRegistration({
          tokenHash: hashRegistrationCompletionToken(c.rawCompletionToken),
          session: {
            ipAddress: null,
            userAgent: null,
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          },
          refreshToken: {
            tokenHash: hashOpaqueToken(`race-refresh-${seq}-${i}`),
            familyId: createId('rtok'),
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          },
          invitation: {
            invitationId: c.invitationId,
            eventContext: ctx,
          },
          now,
        }),
      ),
    );

    // EVERY account commits (Sprint 18 policy: a no-longer-honorable
    // invitation never blocks account creation) …
    const statuses = results.map((r: CompleteRegistrationResult) => r.status);
    expect(statuses).toEqual(['completed', 'completed', 'completed', 'completed']);
    // … but EXACTLY ONE membership was admitted under the quota lock.
    const outcomes = results
      .map((r) => (r.status === 'completed' ? r.invitation : 'missing'))
      .sort();
    expect(outcomes).toEqual(['accepted', 'unavailable', 'unavailable', 'unavailable']);

    const members = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships
      WHERE organization_id = ${orgId} AND status = 'active'`;
    expect(members[0]?.count).toBe('3');

    // No partial state for ANY completion: each registrant has a user row, an
    // active personal workspace, a session, and a consumed pending row.
    for (const c of completions) {
      const users = await db.sql<{ id: string }[]>`
        SELECT id FROM users WHERE normalized_email = ${c.email}`;
      expect(users).toHaveLength(1);
      const userRow = requireRow(users, `registrant user for ${c.email}`);
      const personal = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM organizations
        WHERE created_by_user_id = ${userRow.id} AND type = 'personal' AND status = 'active'`;
      expect(personal[0]?.count).toBe('1');
      const sessions = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM sessions WHERE user_id = ${userRow.id}`;
      expect(sessions[0]?.count).toBe('1');
    }
    const unusedPending = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pending_registrations WHERE used_at IS NULL`;
    expect(unusedPending[0]?.count).toBe('0');

    // Invitation ledger matches: one accepted, three untouched (pending).
    const invitationStates = await db.sql<{ status: string; count: string }[]>`
      SELECT status, count(*)::text AS count FROM invitations
      WHERE organization_id = ${orgId} GROUP BY status ORDER BY status`;
    expect(invitationStates).toEqual([
      { status: 'accepted', count: '1' },
      { status: 'pending', count: '3' },
    ]);
  });

  it('concurrent invitation creates cannot over-reserve seats (capacity 1 → exactly 1 reservation)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id); // free: max_members = 3
    const second = await insertUser('member');
    await insertActiveMember(orgId, second.id); // 2 members + 0 pending → 1 seat

    await warmPool();
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_ATTEMPTS }, (_, i) =>
        invitationRepo.createInvitation({
          organizationId: orgId,
          invitedEmail: `race.invitee.${i}@example.com`,
          invitedEmailNormalized: `race.invitee.${i}@example.com`,
          roleId: ROLE_IDS.member,
          tokenHash: hashInvitationToken(`create-race-${seq}-${i}`),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          ctx: { actorUserId: owner.id, actorMembershipId: 'mem_x', ...ctx },
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL_ATTEMPTS - 1);
    for (const r of rejected) {
      expect(isQuotaExceeded(r.reason)).toBe(true);
    }

    const pending = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM invitations
      WHERE organization_id = ${orgId} AND status = 'pending'`;
    expect(pending[0]?.count).toBe('1');
    const events = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE organization_id = ${orgId} AND event_type = 'invitation.created'`;
    expect(events[0]?.count).toBe('1');
  });
});
