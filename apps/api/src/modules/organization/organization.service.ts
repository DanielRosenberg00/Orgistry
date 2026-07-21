import type {
  MembershipRow,
  OrganizationRow,
  RoleRow,
} from '@orgistry/db';
import type {
  MembershipSummary,
  Organization,
  OrganizationCreateRequest,
  OrganizationCreateResponse,
  OrganizationListResponse,
  OrganizationReadResponse,
  RoleSummary,
} from '@orgistry/contracts';
import { ERROR_CODES } from '@orgistry/contracts';
import { decodeCursor, encodeCursor } from '@orgistry/shared';
import { AppError, rateLimitedError } from '../../lib/errors';
import {
  createNoopRateLimiter,
  enforceStoreAvailability,
  type RateLimiter,
  type RateLimitFailureMode,
} from '../../lib/rate-limit';
import { resolveOrganizationContext } from './organization.context';
import type {
  OrganizationMembershipView,
  OrganizationRepository,
} from './organization.types';

export interface OrganizationServiceOptions {
  repo: OrganizationRepository;
  /** Redis-backed in production; a no-op limiter when omitted. */
  rateLimiter?: RateLimiter;
  /** Org-creation bucket (Sprint 19, ORG-PR-032; from `config.rateLimit.mutations`). */
  rateLimits?: OrganizationRateLimits;
  /**
   * Limiter-store outage behavior (Sprint 19, ORG-PR-009): `open` allows,
   * `closed` rejects with a generic 503. Wired from
   * `config.rateLimit.failureMode`; defaults open for test usability.
   */
  rateLimitFailureMode?: RateLimitFailureMode;
}

/** Organization mutation buckets: creation provisions rows + plan state. */
export interface OrganizationRateLimits {
  windowSeconds: number;
  createPerUserMax: number;
}

export interface ListOrganizationsInput {
  limit: number;
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor: string | null;
}

/**
 * Organization domain workflows. All inputs are already authenticated — the
 * caller's `userId` is resolved by the route via the auth boundary and passed
 * in. The service never touches HTTP, tokens, or raw database rows: it maps
 * persistence rows to public contracts and enforces the membership-scoped
 * read/list visibility rules.
 */
export interface OrganizationService {
  createOrganization(
    userId: string,
    input: OrganizationCreateRequest,
  ): Promise<OrganizationCreateResponse>;
  listOrganizations(
    userId: string,
    input: ListOrganizationsInput,
  ): Promise<OrganizationListResponse>;
  readOrganization(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationReadResponse>;
}

/** Internal organization-list cursor shape. Opaque to clients. */
interface OrganizationCursor {
  c: number; // membership createdAt epoch millis
  i: string; // membership id (tiebreak)
}

/** Map a persistence row to the public, secret-free organization DTO. */
function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a role row to the identity-only role summary (never permissions). */
function toRoleSummary(role: RoleRow): RoleSummary {
  return { id: role.id, key: role.key, name: role.name };
}

/** Map a membership row + its role to the caller's membership summary. */
function toMembershipSummary(
  membership: MembershipRow,
  role: RoleRow,
): MembershipSummary {
  return {
    id: membership.id,
    status: membership.status,
    role: toRoleSummary(role),
    joinedAt: membership.joinedAt.toISOString(),
    createdAt: membership.createdAt.toISOString(),
  };
}

function toView(view: OrganizationMembershipView) {
  return {
    organization: toOrganization(view.organization),
    membership: toMembershipSummary(view.membership, view.role),
  };
}

export function createOrganizationService(
  options: OrganizationServiceOptions,
): OrganizationService {
  const {
    repo,
    rateLimiter = createNoopRateLimiter(),
    rateLimitFailureMode = 'open',
  } = options;

  const limits: OrganizationRateLimits = options.rateLimits ?? {
    windowSeconds: 60,
    createPerUserMax: Number.MAX_SAFE_INTEGER,
  };

  /**
   * Consume one mutation rate-limit hit (Sprint 19, ORG-PR-032); throw the
   * standard RATE_LIMITED envelope on exceed. Runs AFTER authentication and
   * permission checks so throttling never masks an authorization result. No
   * durable event per blocked attempt (bounded writes are the point); the 429
   * stays visible in request logs. A limiter-store outage follows the
   * configured failure mode (production: fail closed with a generic 503).
   */
  async function enforceMutationRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const decision = await rateLimiter.consume(key, limit, windowSeconds);
    if (!enforceStoreAvailability(decision, rateLimitFailureMode)) {
      throw rateLimitedError();
    }
  }

  return {
    async createOrganization(userId, input) {
      // Authenticated caller; creation provisions an organization, Owner
      // membership, and plan state, so it is throttled per user.
      await enforceMutationRateLimit(
        `rl:org:create:user:${userId}`,
        limits.createPerUserMax,
        limits.windowSeconds,
      );

      const view = await repo.createTeamOrganization({
        userId,
        name: input.name,
        requestedSlug: input.slug,
      });
      return toView(view);
    },

    async listOrganizations(userId, input) {
      let cursor: { createdAtMs: number; id: string } | null = null;
      if (input.cursor) {
        const decoded = decodeCursor<OrganizationCursor>(input.cursor);
        if (
          !decoded ||
          typeof decoded.c !== 'number' ||
          typeof decoded.i !== 'string'
        ) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
        }
        cursor = { createdAtMs: decoded.c, id: decoded.i };
      }

      const rows = await repo.listActiveOrganizationsForUser({
        userId,
        limit: input.limit,
        cursor,
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.membership.createdAt.getTime(),
              i: last.membership.id,
            })
          : null;

      return {
        items: page.map(toView),
        nextCursor,
        hasMore,
      };
    },

    async readOrganization(userId, organizationId) {
      // The resolver enforces existence + active status + active membership,
      // keyed on organization ID. Non-members get an indistinguishable 404.
      const context = await resolveOrganizationContext(repo, {
        userId,
        organizationId,
      });
      return {
        organization: toOrganization(context.organization),
        membership: toMembershipSummary(context.membership, context.role),
      };
    },
  };
}
