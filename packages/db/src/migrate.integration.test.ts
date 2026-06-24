import { loadWorkspaceEnv } from '@orgistry/shared/node';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrator';
import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from './schema/permissions';

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
    ];
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const present = new Set(rows.map((row) => row.indexname));
    for (const index of indexes) {
      expect(present.has(index), `${index} should exist`).toBe(true);
    }
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
