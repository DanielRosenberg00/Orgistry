import { readFileSync } from 'node:fs';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrator';
import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from './schema/permissions';
import { PLAN_SEED } from './schema/plans';

// Integration entry point: load the root `.env` so this runs locally with only
// `cp .env.example .env`. CI sets these variables directly (no `.env` present).
loadWorkspaceEnv();

/**
 * Migration-from-scratch integration test.
 *
 * Requires a reachable, disposable PostgreSQL database. It is EXCLUDED from the
 * default `pnpm test` run (filename suffix `*.integration.test.ts`) and is run
 * by `pnpm test:integration` / CI with infrastructure up.
 *
 * Set `TEST_DATABASE_URL` (preferred) or `DATABASE_URL`. When neither is set
 * the suite is skipped with a clear warning rather than silently passing.
 */
const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[db] Skipping migrate.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('migration from scratch', () => {
  const sql = postgres(connectionString as string, {
    max: 1,
    onnotice: () => {},
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('applies the baseline to an empty schema and creates app_meta', async () => {
    // Drop both the app schema and Drizzle's migration-history schema so the
    // baseline is genuinely applied from scratch.
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );

    await runMigrations(connectionString as string);

    const rows = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.app_meta') IS NOT NULL AS exists
    `;
    expect(rows[0]?.exists).toBe(true);
  });

  it('is idempotent when run a second time', async () => {
    await expect(
      runMigrations(connectionString as string),
    ).resolves.not.toThrow();
  });

  it('creates every auth + organization table from scratch', async () => {
    const tables = [
      'users',
      'sessions',
      'refresh_tokens',
      'email_verification_tokens',
      'security_events',
      'roles',
      'organizations',
      'memberships',
      'permissions',
      'role_permissions',
      'projects',
      'plans',
      'organization_plans',
      'api_keys',
    ];
    for (const table of tables) {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
      `;
      expect(rows[0]?.exists, `${table} should exist`).toBe(true);
    }
  });

  it('seeds the baseline roles idempotently', async () => {
    const rows = await sql<{ id: string; key: string }[]>`
      SELECT id, key FROM roles ORDER BY key
    `;
    expect(rows.map((r) => r.key)).toEqual([
      'admin',
      'member',
      'owner',
      'viewer',
    ]);
    expect(rows.find((r) => r.key === 'owner')?.id).toBe('role_owner');
  });

  it('seeds the fixed permission catalog idempotently and matches the contracts catalog', async () => {
    const rows = await sql<{ id: string; key: string }[]>`
      SELECT id, key FROM permissions ORDER BY key
    `;
    expect(rows).toHaveLength(PERMISSION_SEED.length);
    expect(rows.map((r) => r.key).sort()).toEqual(
      PERMISSION_SEED.map((p) => p.key).sort(),
    );
    // Stable derived ids are part of the migration contract.
    expect(rows.find((r) => r.key === 'members.read')?.id).toBe('perm_members_read');
  });

  it('seeds the role→permission mapping to match the canonical seed', async () => {
    const rows = await sql<{ role_id: string; permission_id: string }[]>`
      SELECT role_id, permission_id FROM role_permissions
    `;
    expect(rows).toHaveLength(ROLE_PERMISSION_SEED.length);
    const seeded = new Set(rows.map((r) => `${r.role_id}:${r.permission_id}`));
    for (const grant of ROLE_PERMISSION_SEED) {
      expect(seeded.has(`${grant.roleId}:${grant.permissionId}`)).toBe(true);
    }
    // Owner has every permission; Owner is strictly more capable than Admin.
    const ownerCount = rows.filter((r) => r.role_id === 'role_owner').length;
    const adminCount = rows.filter((r) => r.role_id === 'role_admin').length;
    expect(ownerCount).toBe(PERMISSION_SEED.length);
    expect(adminCount).toBeLessThan(ownerCount);
  });

  it('seeds the fixed plan catalog idempotently and matches the contracts catalog', async () => {
    const rows = await sql<
      {
        id: string;
        key: string;
        max_members: number;
        max_projects: number;
        api_keys_access: boolean;
        max_api_keys: number;
        audit_log_access: boolean;
        audit_retention_days: number;
      }[]
    >`SELECT * FROM plans ORDER BY key`;
    expect(rows).toHaveLength(PLAN_SEED.length);
    // Exactly Free, Pro, Business with stable derived ids.
    expect(rows.map((r) => r.key).sort()).toEqual(['business', 'free', 'pro']);
    expect(rows.find((r) => r.key === 'pro')?.id).toBe('plan_pro');
    // Values match the canonical catalog seed exactly (no drift).
    for (const seed of PLAN_SEED) {
      const row = rows.find((r) => r.key === seed.key);
      expect(row).toBeDefined();
      expect(row?.max_members).toBe(seed.maxMembers);
      expect(row?.max_projects).toBe(seed.maxProjects);
      expect(row?.api_keys_access).toBe(seed.apiKeysAccess);
      expect(row?.max_api_keys).toBe(seed.maxApiKeys);
      expect(row?.audit_log_access).toBe(seed.auditLogAccess);
      expect(row?.audit_retention_days).toBe(seed.auditRetentionDays);
    }
  });

  it('backfills organization plan state deterministically and idempotently', async () => {
    // Simulate a pre-Sprint-7 organization that has no plan-state row, then run
    // the SAME backfill statement the 0005 migration uses. Proves the backfill is
    // deterministic (derived id, Free plan) and idempotent (NOT EXISTS guard).
    await sql`DELETE FROM organization_plans`;
    await sql`DELETE FROM memberships`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_plan_backfill'`;
    await sql`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES ('user_plan_backfill', 'p@x.com', 'p@x.com', 'hash', 'P')`;
    await sql`
      INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
      VALUES ('org_plan_backfill', 'Org', 'org-plan-backfill', 'team', 'active', 'user_plan_backfill')`;

    const backfill = sql`
      INSERT INTO organization_plans (id, organization_id, plan_key, changed_by_user_id)
      SELECT 'oplan_' || o.id, o.id, 'free', o.created_by_user_id
      FROM organizations o
      WHERE NOT EXISTS (
        SELECT 1 FROM organization_plans op WHERE op.organization_id = o.id
      )`;
    await backfill;
    // Idempotent: re-running inserts nothing more.
    await sql.unsafe(`
      INSERT INTO organization_plans (id, organization_id, plan_key, changed_by_user_id)
      SELECT 'oplan_' || o.id, o.id, 'free', o.created_by_user_id
      FROM organizations o
      WHERE NOT EXISTS (
        SELECT 1 FROM organization_plans op WHERE op.organization_id = o.id
      )`);

    const rows = await sql<{ id: string; plan_key: string }[]>`
      SELECT id, plan_key FROM organization_plans WHERE organization_id = 'org_plan_backfill'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('oplan_org_plan_backfill');
    expect(rows[0]?.plan_key).toBe('free');

    await sql`DELETE FROM organization_plans`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_plan_backfill'`;
  });

  it('enforces one active membership per (user, organization)', async () => {
    // Set up a user + organization to attach memberships to.
    await sql`DELETE FROM memberships`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_mem_test'`;
    await sql`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES ('user_mem_test', 'm@x.com', 'm@x.com', 'hash', 'M')
    `;
    await sql`
      INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
      VALUES ('org_mem_test', 'Org', 'org-mem-test', 'team', 'active', 'user_mem_test')
    `;
    await sql`
      INSERT INTO memberships (id, user_id, organization_id, role_id, status)
      VALUES ('mem_active_1', 'user_mem_test', 'org_mem_test', 'role_owner', 'active')
    `;
    // A second ACTIVE membership for the same pair is rejected by the partial
    // unique index; a removed one is allowed.
    await expect(
      sql`
        INSERT INTO memberships (id, user_id, organization_id, role_id, status)
        VALUES ('mem_active_2', 'user_mem_test', 'org_mem_test', 'role_member', 'active')
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        INSERT INTO memberships (id, user_id, organization_id, role_id, status)
        VALUES ('mem_removed_1', 'user_mem_test', 'org_mem_test', 'role_member', 'removed')
      `,
    ).resolves.toBeDefined();

    await sql`DELETE FROM memberships`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_mem_test'`;
  });

  it('creates the lookup/cleanup indexes the auth model relies on', async () => {
    const indexes = [
      'uq_users_normalized_email',
      'uq_refresh_tokens_token_hash',
      'uq_email_verification_tokens_token_hash',
      'ix_sessions_user_id',
      'ix_sessions_expires_at',
      'ix_security_events_event_type',
      'ix_security_events_created_at',
      'uq_roles_key',
      'uq_organizations_slug',
      'ix_organizations_created_by',
      'ix_organizations_status',
      'uq_memberships_active_user_org',
      'ix_memberships_user_id',
      'ix_memberships_organization_id',
      'uq_permissions_key',
      'uq_role_permissions_role_permission',
      'ix_projects_org_created_active',
      'ix_projects_org_id',
      'uq_plans_key',
      'uq_organization_plans_organization',
      'uq_api_keys_secret_hash',
      'ix_api_keys_org_created',
      'ix_api_keys_org_active',
      'uq_organizations_active_personal_owner',
      'ix_security_events_org_created_id',
    ];
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const present = new Set(rows.map((row) => row.indexname));
    for (const index of indexes) {
      expect(present.has(index), `${index} should exist`).toBe(true);
    }
  });

  it('supports tenant-scoped project lookup and active-list intent (not just names)', async () => {
    // Assert the index DEFINITIONS, so a future refactor cannot silently drop the
    // Sprint 6 tenant-isolation invariant ("lookup is by organization_id + id")
    // by renaming or recolumning an index while keeping the name list happy.
    const defs = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'projects'
    `;
    const byName = new Map(defs.map((d) => [d.indexname, d.indexdef]));

    // Tenant-scoped point lookup: organization_id + id.
    const lookup = byName.get('ix_projects_org_id') ?? '';
    expect(lookup).toMatch(/\(organization_id, id\)/);

    // Active list / keyset pagination: organization_id + created_at + id, and a
    // PARTIAL predicate so only active (non-deleted) rows are indexed.
    const list = byName.get('ix_projects_org_created_active') ?? '';
    expect(list).toMatch(/\(organization_id, created_at, id\)/);
    expect(list.toLowerCase()).toContain('where (deleted_at is null)');
  });

  it('enforces api key secret-hash uniqueness and active-key index intent', async () => {
    // Set up an organization + user to own the keys.
    await sql`DELETE FROM api_keys`;
    await sql`DELETE FROM memberships`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_key_test'`;
    await sql`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES ('user_key_test', 'k@x.com', 'k@x.com', 'hash', 'K')`;
    await sql`
      INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
      VALUES ('org_key_test', 'Org', 'org-key-test', 'team', 'active', 'user_key_test')`;

    await sql`
      INSERT INTO api_keys (id, organization_id, name, display_prefix, secret_hash, scopes, created_by_user_id)
      VALUES ('key_one', 'org_key_test', 'A', 'orgistry_AAAA1111', 'hash_dup', '["projects:read"]'::jsonb, 'user_key_test')`;
    // A second key with the SAME secret hash is rejected by the unique index.
    await expect(
      sql`
        INSERT INTO api_keys (id, organization_id, name, display_prefix, secret_hash, scopes, created_by_user_id)
        VALUES ('key_two', 'org_key_test', 'B', 'orgistry_BBBB2222', 'hash_dup', '["projects:read"]'::jsonb, 'user_key_test')`,
    ).rejects.toThrow();

    // NOTE: the `id` column has NO database default — id generation is
    // REPOSITORY-owned (`createId('key')` in `createDbApiKeyRepository`), the same
    // convention as projects/organizations. A column with no default rejects an
    // id-less insert, which proves the point: the prefix is enforced in code, not
    // by the DB. The real generated-`key_`-id assertion therefore lives on the
    // service path (api-key.routes.test.ts), not here.
    await expect(
      sql`
        INSERT INTO api_keys (organization_id, name, display_prefix, secret_hash, scopes, created_by_user_id)
        VALUES ('org_key_test', 'C', 'orgistry_CCCC3333', 'hash_c', '["projects:read"]'::jsonb, 'user_key_test')`,
    ).rejects.toThrow();

    // The active-key index is PARTIAL on revoked_at IS NULL (quota/active scans).
    const defs = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'api_keys'`;
    const active = defs.find((d) => d.indexname === 'ix_api_keys_org_active');
    expect(active?.indexdef.toLowerCase()).toContain('where (revoked_at is null)');

    await sql`DELETE FROM api_keys`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_key_test'`;
  });

  it('enforces at most one ACTIVE personal workspace per user (ORG-PR-038)', async () => {
    await sql`DELETE FROM memberships`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_pw_test'`;
    await sql`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES ('user_pw_test', 'pw@x.com', 'pw@x.com', 'hash', 'PW')
    `;
    await sql`
      INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
      VALUES ('org_pw_1', 'PW', 'pw-1', 'personal', 'active', 'user_pw_test')
    `;

    // A second ACTIVE personal workspace for the same user is rejected by the
    // partial unique index — the invariant is DATABASE-enforced, not a
    // service-level convention.
    await expect(
      sql`
        INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
        VALUES ('org_pw_2', 'PW2', 'pw-2', 'personal', 'active', 'user_pw_test')
      `,
    ).rejects.toThrow();

    // Team organizations are NOT constrained: the same user may create many.
    await expect(
      sql`
        INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
        VALUES ('org_pw_t1', 'T1', 'pw-t1', 'team', 'active', 'user_pw_test'),
               ('org_pw_t2', 'T2', 'pw-t2', 'team', 'active', 'user_pw_test')
      `,
    ).resolves.toBeDefined();

    // An archived personal workspace frees the slot (lifecycle-compatible):
    // the index is partial on status = 'active'.
    await sql`UPDATE organizations SET status = 'archived', archived_at = now() WHERE id = 'org_pw_1'`;
    await expect(
      sql`
        INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
        VALUES ('org_pw_3', 'PW3', 'pw-3', 'personal', 'active', 'user_pw_test')
      `,
    ).resolves.toBeDefined();

    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id = 'user_pw_test'`;
  });

  it('applies the 0011 DDL forward over a populated pre-Sprint-20 state', async () => {
    // Forward-migration evidence for 0011_calm_gressill.sql: the two Sprint 20
    // indexes must build over a POPULATED valid pre-Sprint-20 dataset (users
    // each owning one active personal workspace, team organizations, existing
    // org-scoped security events) — not only over an empty schema. The exact
    // committed migration SQL is executed statement-by-statement.
    await sql`DELETE FROM security_events`;
    await sql`DELETE FROM memberships`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id LIKE 'user_fwd_%'`;
    await sql`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES ('user_fwd_1', 'f1@x.com', 'f1@x.com', 'hash', 'F1'),
             ('user_fwd_2', 'f2@x.com', 'f2@x.com', 'hash', 'F2')
    `;
    await sql`
      INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
      VALUES ('org_fwd_p1', 'P1', 'fwd-p1', 'personal', 'active', 'user_fwd_1'),
             ('org_fwd_p2', 'P2', 'fwd-p2', 'personal', 'active', 'user_fwd_2'),
             ('org_fwd_t1', 'T1', 'fwd-t1', 'team', 'active', 'user_fwd_1'),
             ('org_fwd_t2', 'T2', 'fwd-t2', 'team', 'active', 'user_fwd_1')
    `;
    await sql`
      INSERT INTO security_events (id, organization_id, actor_type, event_type, metadata)
      VALUES ('sevt_fwd_1', 'org_fwd_t1', 'user', 'project.created', '{}'),
             ('sevt_fwd_2', 'org_fwd_t1', 'user', 'project.created', '{}'),
             ('sevt_fwd_3', NULL, 'anonymous', 'auth.login_failed', '{}')
    `;

    // Reviewer PREFLIGHT (documented in the Sprint 20 artifact): before
    // applying the unique index over legacy data, detect duplicate active
    // personal workspaces. Zero rows means the index will build; any row
    // is an explicit operational precondition to resolve FIRST — the
    // migration never deletes or merges data.
    const duplicates = await sql<{ created_by_user_id: string }[]>`
      SELECT created_by_user_id, count(*) AS n FROM organizations
      WHERE type = 'personal' AND status = 'active'
      GROUP BY created_by_user_id HAVING count(*) > 1
    `;
    expect(duplicates).toHaveLength(0);

    // Re-apply the EXACT committed 0011 statements over the populated state.
    await sql`DROP INDEX IF EXISTS uq_organizations_active_personal_owner`;
    await sql`DROP INDEX IF EXISTS ix_security_events_org_created_id`;
    const migrationSql = readFileSync(
      new URL('../migrations/0011_calm_gressill.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migrationSql.split('--> statement-breakpoint')) {
      await sql.unsafe(statement);
    }

    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const present = new Set(rows.map((row) => row.indexname));
    expect(present.has('uq_organizations_active_personal_owner')).toBe(true);
    expect(present.has('ix_security_events_org_created_id')).toBe(true);

    // The seeded rows are untouched (the migration mutates no data).
    const counts = await sql<{ orgs: string; events: string }[]>`
      SELECT (SELECT count(*)::text FROM organizations) AS orgs,
             (SELECT count(*)::text FROM security_events) AS events
    `;
    expect(counts[0]).toEqual({ orgs: '4', events: '3' });

    await sql`DELETE FROM security_events`;
    await sql`DELETE FROM organizations`;
    await sql`DELETE FROM users WHERE id LIKE 'user_fwd_%'`;
  });

  it('backs the org-scoped audit read with a matching composite index (ORG-PR-014)', async () => {
    // The index definition must match the read path exactly:
    // WHERE organization_id = ? … ORDER BY created_at DESC, id DESC.
    const [index] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'ix_security_events_org_created_id'
    `;
    expect(index?.indexdef).toContain(
      'ON public.security_events USING btree (organization_id, created_at, id)',
    );

    // Planner evidence, kept non-brittle for tiny fixtures: with sequential
    // scans disabled inside this transaction, the audit-shaped query must be
    // answerable through the composite index (plan choice on a large table is
    // captured in the Sprint 20 docs, not asserted here).
    await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const plan = await tx<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT id FROM security_events
        WHERE organization_id = 'org_plan_probe'
        ORDER BY created_at DESC, id DESC LIMIT 50
      `;
      const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
      expect(planText).toContain('ix_security_events_org_created_id');
    });
  });

  it('enforces normalized-email uniqueness', async () => {
    await sql`DELETE FROM users`;
    await sql`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES ('user_dup1', 'A@x.com', 'a@x.com', 'hash', 'A')
    `;
    await expect(
      sql`
        INSERT INTO users (id, email, normalized_email, password_hash, display_name)
        VALUES ('user_dup2', 'A2@x.com', 'a@x.com', 'hash', 'A2')
      `,
    ).rejects.toThrow();
    await sql`DELETE FROM users`;
  });
});
