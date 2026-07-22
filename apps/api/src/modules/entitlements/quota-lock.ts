import type { DbExecutor } from '@orgistry/db';
import { sql } from 'drizzle-orm';

/**
 * Organization-scoped quota serialization (Sprint 20, ORG-PR-029).
 *
 * A service-level count followed by a separate insert is TOCTOU-racy: two
 * concurrent creates at `limit - 1` both pass the check and both write. Every
 * quota-protected creation therefore acquires a TRANSACTION-SCOPED PostgreSQL
 * advisory lock keyed by (organization, quota kind) before counting, so the
 * count and the insert of concurrent writers serialize inside PostgreSQL.
 *
 * Properties:
 *  - keyed per organization AND per quota kind — unrelated organizations and
 *    unrelated quotas never contend;
 *  - transaction-scoped (`pg_advisory_xact_lock`): released automatically at
 *    commit/rollback, nothing persists, nothing to clean up;
 *  - the key is derived INSIDE PostgreSQL via `hashtextextended` from a bind
 *    parameter (never interpolated) — the same construction the Sprint 18
 *    pending-registration issuance lock uses.
 *
 * LOCK ORDER (must hold across every quota-protected path): at most ONE quota
 * lock per transaction, acquired BEFORE the plan-row snapshot
 * (`lockOrganizationEntitlements`, FOR SHARE) and BEFORE any flow-specific
 * row lock (invitation rows, lazily-expired invitation updates) and the
 * protected insert. The registration-completion path holds its
 * pending-registration row lock first (the token single-use seam), then this
 * lock — no other path locks pending registrations, so no cycle is possible.
 * See docs/production-readiness/sprint-20-quota-race-audit.md.
 */

/** The quota kinds with a serialized count-then-insert path. */
export type OrganizationQuotaKind = 'projects' | 'api_keys' | 'members';

/**
 * Acquire the (organization, quota kind) advisory lock for the CURRENT
 * transaction. MUST be called on an open transaction executor — outside a
 * transaction the lock would be session-scoped and never released.
 */
export async function acquireOrganizationQuotaLock(
  tx: DbExecutor,
  organizationId: string,
  kind: OrganizationQuotaKind,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${kind}:${organizationId}`}, 0))`,
  );
}
