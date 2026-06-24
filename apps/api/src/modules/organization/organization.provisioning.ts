import {
  type DbExecutor,
  DEFAULT_PLAN_KEY,
  ROLE_IDS,
  type MembershipRow,
  type OrganizationRow,
  type OrganizationStatus,
  type OrganizationType,
  schema,
} from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { eq } from 'drizzle-orm';

/**
 * Organization provisioning primitives.
 *
 * These are the single source of truth for how an organization row and its
 * owner membership are created. They are deliberately persistence-only and
 * accept a `DbExecutor` so the SAME rules apply whether they run:
 *  - standalone, inside the organization repo's team-creation transaction, OR
 *  - inside the auth module's registration transaction (personal workspace).
 *
 * Keeping slug derivation and the org+owner-membership insert here (rather than
 * duplicated in each caller) is what lets registration provision a workspace
 * atomically without the auth module re-implementing organization rules.
 */

const MAX_SLUG_BASE_LENGTH = 40;
/** Bounded numeric-suffix search before falling back to a random token. */
const MAX_SLUG_SUFFIX_ATTEMPTS = 50;

/**
 * Convert arbitrary text into a slug base: lowercase, non-alphanumeric runs
 * collapsed to single hyphens, trimmed, length-capped. Falls back to `fallback`
 * when the input has no usable characters (e.g. a display name of only emoji).
 */
export function slugify(input: string, fallback = 'workspace'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_BASE_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/** A short, slug-safe random token used to guarantee uniqueness as a fallback. */
function shortSlugToken(): string {
  // `createId` yields `<prefix>_<base32>`; the random tail lowercased is a
  // valid slug segment ([a-z0-9]).
  return createId('org').split('_')[1].slice(0, 6).toLowerCase();
}

/** True when an organization already uses `slug`. */
export async function isSlugTaken(
  executor: DbExecutor,
  slug: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug))
    .limit(1);
  return row !== undefined;
}

/**
 * Resolve a globally-unique slug from `base` by appending `-2`, `-3`, … until a
 * free value is found, falling back to a random suffix in the (vanishingly
 * unlikely) event the numeric search is exhausted. The unique index on
 * `organizations.slug` remains the authoritative guard against the small
 * check-then-insert race; this just keeps the common case collision-free and
 * produces tidy URLs.
 */
export async function resolveUniqueSlug(
  executor: DbExecutor,
  base: string,
): Promise<string> {
  let candidate = base;
  for (let suffix = 2; ; suffix += 1) {
    if (!(await isSlugTaken(executor, candidate))) {
      return candidate;
    }
    if (suffix > MAX_SLUG_SUFFIX_ATTEMPTS) {
      return `${base}-${shortSlugToken()}`;
    }
    candidate = `${base}-${suffix}`;
  }
}

/**
 * Build a personal-workspace slug base: the display name slugified plus a short
 * random token. The random token makes a collision (and therefore a registration
 * failure on the slug unique index) astronomically unlikely on the hot path.
 */
export function personalWorkspaceSlugBase(displayName: string): string {
  return `${slugify(displayName)}-${shortSlugToken()}`;
}

export interface InsertOrganizationParams {
  type: OrganizationType;
  name: string;
  /** A finalized, unique slug (resolve via `resolveUniqueSlug` beforehand). */
  slug: string;
  createdByUserId: string;
  /** The user to attach as the active Owner member. */
  ownerUserId: string;
  status?: OrganizationStatus;
}

/**
 * Insert an organization, its creator's ACTIVE Owner membership, AND its default
 * plan state, using the given executor. All three inserts share the executor, so
 * when it is a transaction they are atomic — a new organization can never exist
 * without an Owner or without plan state.
 *
 * The Owner role is the seeded baseline role (`ROLE_IDS`); this is a role
 * assignment, NOT a permission grant. The plan state is the default plan
 * (`DEFAULT_PLAN_KEY`, Free); plan state belongs to the organization and is
 * independent of the membership role. This is the single provisioning seam used
 * by BOTH registration (personal workspace) and team-organization creation, so
 * every organization — personal or team — receives default plan state the same
 * way.
 */
export async function insertOrganizationWithOwnerMembership(
  executor: DbExecutor,
  params: InsertOrganizationParams,
): Promise<{ organization: OrganizationRow; membership: MembershipRow }> {
  const [organization] = await executor
    .insert(schema.organizations)
    .values({
      name: params.name,
      slug: params.slug,
      type: params.type,
      status: params.status ?? 'active',
      createdByUserId: params.createdByUserId,
    })
    .returning();

  const [membership] = await executor
    .insert(schema.memberships)
    .values({
      userId: params.ownerUserId,
      organizationId: organization.id,
      roleId: ROLE_IDS.owner,
      status: 'active',
    })
    .returning();

  // Default plan state. The creator is recorded as having set it; a later demo
  // plan change overwrites the plan key and the actor.
  await executor.insert(schema.organizationPlans).values({
    id: createId('oplan'),
    organizationId: organization.id,
    planKey: DEFAULT_PLAN_KEY,
    changedByUserId: params.createdByUserId,
  });

  return { organization, membership };
}
