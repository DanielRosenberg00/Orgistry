import { z } from 'zod';

/**
 * Project API contracts (Sprint 6) — the first organization-scoped business
 * resource.
 *
 * Projects are intentionally small: they exist to prove the tenant-scoped
 * resource pattern (organization-scoped persistence, permission-first
 * authorization, cursor pagination, soft delete, safe cross-tenant failure)
 * end to end — they are not a product domain.
 *
 * These DTOs are the stable boundary between the API and any client. Hard rules
 * carried over from the organization/member contracts:
 *  - no response field ever carries a persistence-only column. The public
 *    Project DTO deliberately omits the soft-delete markers (`deletedAt`,
 *    `deletedByUserId`) — deleted projects are simply absent from active
 *    responses, so a client never needs to read deleted metadata;
 *  - authorization is by permission key (`projects.read` / `.create` / `.update`
 *    / `.delete`), enforced server-side — no permission field appears here;
 *  - the organization id is the authority boundary and comes from the route,
 *    never from a request body, so no create/update body carries it.
 */

/** Maximum name length guards against denial-of-service via oversized inputs. */
export const MAX_PROJECT_NAME_LENGTH = 120;

/**
 * Public representation of a project. This is the ONLY project shape that
 * crosses the API boundary. `id` is the opaque, prefixed authority identifier
 * (`prj_…`); `organizationId` is the tenant it belongs to; `createdByUserId`
 * is the actor that created it. Soft-delete internals are never exposed.
 */
export const projectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * POST …/projects request body. Only `name` is accepted — the organization is
 * taken from the route path, never the body, and the creator is the
 * authenticated actor. `name` is trimmed and length-bounded.
 */
export const projectCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(MAX_PROJECT_NAME_LENGTH),
});
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;

/**
 * PATCH …/projects/:projectId request body. Deliberately narrow: only `name`
 * may change in Sprint 6. The schema is its own type (not reused from create)
 * so the two surfaces can evolve independently under review.
 */
export const projectUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(MAX_PROJECT_NAME_LENGTH),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;

/**
 * GET …/projects query params. Projects standardize on the platform cursor
 * pagination baseline (opaque cursor + bounded limit); this is a named alias of
 * that baseline so the project list surface has its own stable contract.
 */
export { cursorPageParamsSchema as projectListQuerySchema } from './pagination';
export type { CursorPageParams as ProjectListQuery } from './pagination';

/**
 * Route parameters for the single-project surfaces
 * (`…/projects/:projectId`). The organization id is the tenant authority
 * boundary; the project id is only ever addressable WITHIN it.
 *
 * Both are validated for presence/shape only (non-empty strings) — NOT for the
 * opaque-id prefix. This matches the established organization/member route
 * convention: an id's authority is resolved SERVER-SIDE, and an unknown,
 * malformed, or cross-tenant id surfaces the same safe not-found
 * (`ORGANIZATION_NOT_FOUND` for the org, `PROJECT_NOT_FOUND` for the project)
 * rather than a structural 400. Prefix-validating here would create a one-off
 * behavior that diverges from those routes and leaks nothing extra, so it is
 * deliberately omitted.
 */
export const projectRouteParamsSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
});
export type ProjectRouteParams = z.infer<typeof projectRouteParamsSchema>;

/** POST …/projects response body (the created project). */
export const projectCreateResponseSchema = z.object({
  project: projectSchema,
});
export type ProjectCreateResponse = z.infer<typeof projectCreateResponseSchema>;

/** GET …/projects/:projectId response body. */
export const projectReadResponseSchema = z.object({
  project: projectSchema,
});
export type ProjectReadResponse = z.infer<typeof projectReadResponseSchema>;

/** PATCH …/projects/:projectId response body (the updated project). */
export const projectUpdateResponseSchema = z.object({
  project: projectSchema,
});
export type ProjectUpdateResponse = z.infer<typeof projectUpdateResponseSchema>;

/** GET …/projects response body — cursor-paginated active projects. */
export const projectListResponseSchema = z.object({
  items: z.array(projectSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

/**
 * DELETE …/projects/:projectId response body. A soft delete returns a minimal
 * acknowledgement (the now-deleted project's id) rather than the row, since the
 * project is no longer an active resource.
 */
export const projectDeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type ProjectDeleteResponse = z.infer<typeof projectDeleteResponseSchema>;
