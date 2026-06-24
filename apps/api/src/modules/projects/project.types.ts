import type { ProjectRow } from '@orgistry/db';

/**
 * Internal project-module types.
 *
 * `ProjectRow` is the persistence shape; it is used INSIDE the module only and
 * is never returned from a route — the service maps it to the public
 * `@orgistry/contracts` `Project` DTO first.
 */

/**
 * Per-request action context attached to a project action event. Carries the
 * server-derived actor identity (user + membership) plus non-secret request
 * metadata. Secrets are never placed here; metadata is sanitized before
 * persistence regardless.
 */
export interface ProjectActionContext {
  /** The acting user (recorded as the event's actor and on create/delete columns). */
  actorUserId: string;
  /** The actor's active membership in the organization (recorded in event metadata). */
  actorMembershipId: string;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Cursor-pagination inputs for listing an organization's active projects. */
export interface ListProjectsParams {
  organizationId: string;
  limit: number;
  /** Exclusive lower bound from a prior page's cursor (project createdAt, id). */
  cursor: { createdAtMs: number; id: string } | null;
}

/** Inputs for creating a project under an organization. */
export interface CreateProjectParams {
  organizationId: string;
  name: string;
  createdByUserId: string;
  ctx: ProjectActionContext;
}

/** Inputs for a narrow project update (Sprint 6: name only). */
export interface UpdateProjectParams {
  organizationId: string;
  projectId: string;
  name: string;
  ctx: ProjectActionContext;
}

/** Inputs for a soft delete. */
export interface SoftDeleteProjectParams {
  organizationId: string;
  projectId: string;
  ctx: ProjectActionContext;
}

/**
 * Tenant-aware persistence boundary for project workflows.
 *
 * Every method is organization-scoped: it takes an `organizationId` and a
 * project is NEVER looked up by project id alone. The repository owns project
 * SQL and the action-event writes that commit with each mutation; it does NOT
 * own permission checks and does NOT shape HTTP responses. It is deliberately
 * NOT a generic CRUD abstraction — the method set is exactly what Projects need.
 */
export interface ProjectRepository {
  /**
   * List an organization's ACTIVE (non-deleted) projects, newest first, one
   * page at a time. Returns up to `limit + 1` rows so the caller can detect a
   * further page without a second query. Soft-deleted projects are excluded.
   */
  listActiveProjects(params: ListProjectsParams): Promise<ProjectRow[]>;

  /** Create a project under `organizationId` and record `project.created`. */
  createProject(params: CreateProjectParams): Promise<ProjectRow>;

  /**
   * The single ACTIVE project matching BOTH `organizationId` and `projectId`,
   * or null. A project in another organization, an unknown id, and a
   * soft-deleted project all return null (the caller maps that to a uniform
   * not-found).
   */
  findActiveProject(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectRow | null>;

  /**
   * Update an active project's name (scoped by org + id) and record
   * `project.updated`. Throws `PROJECT_NOT_FOUND` when the project is unknown,
   * belongs to another organization, or is soft-deleted.
   */
  updateProject(params: UpdateProjectParams): Promise<ProjectRow>;

  /**
   * Soft-delete an active project (scoped by org + id): set `deleted_at` +
   * `deleted_by_user_id`, and record `project.deleted`. Rows are never hard
   * deleted. Throws `PROJECT_NOT_FOUND` when the project is unknown, belongs to
   * another organization, or is ALREADY soft-deleted — a repeated delete fails
   * safely without leaking existence.
   */
  softDeleteProject(params: SoftDeleteProjectParams): Promise<void>;
}
