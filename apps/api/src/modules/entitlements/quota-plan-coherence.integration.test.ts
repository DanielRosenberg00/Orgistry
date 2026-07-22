import { createDbClient, ROLE_IDS, runMigrations, schema } from '@orgistry/db';
import { sql as rawSql } from 'drizzle-orm';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { createId } from '@orgistry/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDbApiKeyRepository } from '../api-keys/api-key.repo';
import { createDbInvitationRepository } from '../invitations/invitation.repo';
import { hashInvitationToken } from '../invitations/invitation.token';
import { createDbProjectRepository } from '../projects/project.repo';

/**
 * Plan/quota transactional-coherence proof (Sprint 20 correctness refinement,
 * ORG-PR-029).
 *
 * Plan assignment is runtime-mutable (`PATCH …/plan/demo`), so a plan-derived
 * ceiling resolved BEFORE the quota-protected transaction can be stale by the
 * time the transaction counts and writes. After the refinement, no caller can
 * even supply a ceiling — the repository mutation contracts carry no
 * `max*` parameters — and these tests prove the behavioral consequence: every
 * quota decision reflects the plan state COMMITTED at the moment the
 * protected transaction resolves it (plan row `FOR SHARE`), never an earlier
 * observation. The in-flight test additionally proves the FOR SHARE read
 * SERIALIZES against a concurrent plan mutation's `FOR UPDATE` instead of
 * reading past it.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping quota-plan-coherence.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

const ctx = { requestId: null, ipAddress: null, userAgent: null };

describe.skipIf(!connectionString)('quota decisions use the transaction-current plan', () => {
  let db: ReturnType<typeof createDbClient>;
  let projectRepo: ReturnType<typeof createDbProjectRepository>;
  let apiKeyRepo: ReturnType<typeof createDbApiKeyRepository>;
  let invitationRepo: ReturnType<typeof createDbInvitationRepository>;
  let seq = 0;

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    projectRepo = createDbProjectRepository(db.db);
    apiKeyRepo = createDbApiKeyRepository(db.db);
    invitationRepo = createDbInvitationRepository(db.db);
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
    const email = `coherence.${label}.${seq}@example.com`;
    const [user] = await db.db
      .insert(schema.users)
      .values({
        email,
        normalizedEmail: email,
        passwordHash: 'x-not-a-real-hash',
        displayName: label,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    return { id: user.id, email };
  }

  async function insertTeamOrg(ownerId: string, planKey: 'free' | 'pro' | 'business'): Promise<string> {
    seq += 1;
    const [org] = await db.db
      .insert(schema.organizations)
      .values({
        name: `Coherence Org ${seq}`,
        slug: `coherence-org-${seq}`,
        type: 'team',
        createdByUserId: ownerId,
      })
      .returning({ id: schema.organizations.id });
    await db.db.insert(schema.memberships).values({
      userId: ownerId,
      organizationId: org.id,
      roleId: ROLE_IDS.owner,
      status: 'active',
    });
    await db.db.insert(schema.organizationPlans).values({
      id: createId('oplan'),
      organizationId: org.id,
      planKey,
      changedByUserId: ownerId,
    });
    return org.id;
  }

  async function setPlan(orgId: string, planKey: string): Promise<void> {
    await db.sql`UPDATE organization_plans SET plan_key = ${planKey} WHERE organization_id = ${orgId}`;
  }

  async function insertProjects(orgId: string, ownerId: string, count: number): Promise<void> {
    await db.db.insert(schema.projects).values(
      Array.from({ length: count }, (_, i) => ({
        id: createId('prj'),
        organizationId: orgId,
        name: `P${i}`,
        createdByUserId: ownerId,
      })),
    );
  }

  function createProject(orgId: string, ownerId: string, name: string) {
    return projectRepo.createProject({
      organizationId: orgId,
      name,
      createdByUserId: ownerId,
      ctx: { actorUserId: ownerId, actorMembershipId: 'mem_x', ...ctx },
    });
  }

  it('a committed plan DOWNGRADE is authoritative for the very next create (no stale higher ceiling)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'pro'); // max_projects = 20
    await insertProjects(orgId, owner.id, 5); // fine under pro

    // The downgrade commits; the next create's transaction must resolve the
    // NEW plan (free: max_projects = 3) and reject with ITS ceiling — under
    // the pre-refinement design a service-resolved pro limit (20) would have
    // admitted the row.
    await setPlan(orgId, 'free');
    await expect(
      createProject(orgId, owner.id, 'Should not fit'),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { quota: 'max_projects', limit: 3, current: 5 },
    });

    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM projects WHERE organization_id = ${orgId}`;
    expect(rows[0].count).toBe('5');
  });

  it('a committed plan UPGRADE is authoritative for the very next create', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'free'); // max_projects = 3
    await insertProjects(orgId, owner.id, 3); // at the free ceiling

    await expect(createProject(orgId, owner.id, 'Blocked')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 3 },
    });

    await setPlan(orgId, 'pro'); // max_projects = 20
    await expect(createProject(orgId, owner.id, 'Now fits')).resolves.toMatchObject({
      organizationId: orgId,
    });
  });

  it('an IN-FLIGHT plan change serializes against the create (FOR SHARE vs FOR UPDATE)', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'free'); // max_projects = 3
    await insertProjects(orgId, owner.id, 3); // at the free ceiling

    // Coordinate deterministically (no sleeps): the plan-change transaction
    // signals once it HOLDS the plan row FOR UPDATE; only then is the create
    // fired. The create's FOR SHARE snapshot read must WAIT for the plan
    // change to commit and then see the upgraded plan — a design that read
    // the plan before/without the lock would either see stale 'free' (and
    // wrongly reject) or not block at all.
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => (lockHeld = resolve));
    const planChange = db.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organizationPlans.id })
        .from(schema.organizationPlans)
        .where(rawSql`${schema.organizationPlans.organizationId} = ${orgId}`)
        .for('update');
      lockHeld();
      await tx
        .update(schema.organizationPlans)
        .set({ planKey: 'pro' })
        .where(rawSql`${schema.organizationPlans.organizationId} = ${orgId}`);
    });

    await held;
    const created = await createProject(orgId, owner.id, 'After upgrade');
    await planChange;

    expect(created.organizationId).toBe(orgId);
    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM projects
      WHERE organization_id = ${orgId} AND deleted_at IS NULL`;
    expect(rows[0].count).toBe('4'); // over free's 3, legal under pro's 20
  });

  it('API key creation re-checks access AND ceiling from ONE transaction-current snapshot', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'pro'); // api_keys_access = true

    // Downgrade commits; the create transaction must re-derive BOTH the
    // access gate and the ceiling from the CURRENT plan — free revokes
    // api_keys_access entirely.
    await setPlan(orgId, 'free');
    await expect(
      apiKeyRepo.createApiKey({
        organizationId: orgId,
        name: 'Stale-plan key',
        displayPrefix: 'orgistry_STALE',
        secretHash: `coherence-hash-${seq}`,
        scopes: ['projects:read'],
        expiresAt: null,
        createdByUserId: owner.id,
        now: new Date(),
        ctx: { actorUserId: owner.id, actorMembershipId: 'mem_x', ...ctx },
      }),
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_REQUIRED' });

    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM api_keys WHERE organization_id = ${orgId}`;
    expect(rows[0].count).toBe('0');
  });

  it('invitation acceptance resolves max_members inside its transaction', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'free'); // max_members = 3
    for (const label of ['m1', 'm2']) {
      const member = await insertUser(label);
      await db.db.insert(schema.memberships).values({
        userId: member.id,
        organizationId: orgId,
        roleId: ROLE_IDS.member,
        status: 'active',
      });
    }
    const invitee = await insertUser('invitee');
    seq += 1;
    const rawToken = `coherence-token-${seq}`;
    await db.db.insert(schema.invitations).values({
      id: createId('inv'),
      organizationId: orgId,
      invitedEmail: invitee.email,
      invitedEmailNormalized: invitee.email,
      roleId: ROLE_IDS.member,
      tokenHash: hashInvitationToken(rawToken),
      status: 'pending',
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const accept = () =>
      invitationRepo.acceptInvitation({
        selector: { tokenHash: hashInvitationToken(rawToken) },
        acceptingUserId: invitee.id,
        acceptingUserNormalizedEmail: invitee.email,
        ctx: { actorUserId: invitee.id, actorMembershipId: null, ...ctx },
      });

    // Free is full (3 active members) → the transaction's own snapshot rejects.
    await expect(accept()).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { quota: 'max_members', limit: 3, current: 3 },
    });

    // The SAME invitation accepts once the upgraded plan is committed — the
    // ceiling was never captured outside the acceptance transaction.
    await setPlan(orgId, 'pro'); // max_members = 10
    const result = await accept();
    expect(result.membership.organizationId).toBe(orgId);
    expect(result.invitation.status).toBe('accepted');
  });

  it('fails safe (PLAN_STATE_MISSING) inside the transaction when plan state is absent', async () => {
    const owner = await insertUser('owner');
    const orgId = await insertTeamOrg(owner.id, 'free');
    await db.sql`DELETE FROM organization_plans WHERE organization_id = ${orgId}`;

    await expect(createProject(orgId, owner.id, 'No plan')).rejects.toMatchObject({
      code: 'PLAN_STATE_MISSING',
    });
    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM projects WHERE organization_id = ${orgId}`;
    expect(rows[0].count).toBe('0');
  });
});
