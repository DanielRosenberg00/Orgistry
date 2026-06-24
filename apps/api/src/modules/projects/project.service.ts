import type { ProjectRow } from '@orgistry/db';
import {
  ERROR_CODES,
  PERMISSION_KEYS,
  type Project,
  type ProjectCreateResponse,
  type ProjectDeleteResponse,
  type ProjectListResponse,
  type ProjectReadResponse,
  type ProjectUpdateResponse,
} from '@orgistry/contracts';
import { decodeCursor, encodeCursor } from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import type { EntitlementService } from '../entitlements/entitlement.service';
import {
  type OrganizationActor,
  requireMembership,
  requirePermission,
} from '../organization/access-control';
import type { AccessControlRepository } from '../organization/organization.types';
import { projectNotFoundError } from './project.errors';
import type {
  ProjectActionContext,
  ProjectRepository,
} from './project.types';

/**
 * Project workflows (list / create / read / update / soft delete) — the
 * Projects vertical slice.
 *
 * Every method composes the standard organization-scoped pipeline, identical to
 * member management:
 *
 *   requireMembership  (active member of this org? -> OrganizationActor)
 *     -> requirePermission (does the actor hold the projects.* permission key?)
 *       -> tenant-scoped project repository call (always scoped by org id)
 *         -> map the persistence row to the public Project DTO (never a raw row)
 *           -> repository records the action event for meaningful mutations
 *
 * Authorization is ALWAYS by permission key, never by role name. The
 * organization id is taken from the route (`OrganizationActor.organizationId`),
 * never from a request body. The service never returns a raw database row and
 * never exposes soft-delete internals.
 */

export interface ProjectServiceOptions {
  /** Resolves active membership + effective permissions (the org repo satisfies this). */
  accessControl: AccessControlRepository;
  /** Tenant-aware project persistence. */
  projects: ProjectRepository;
  /**
   * Organization-level entitlement/quota service. Project CREATE enforces the
   * `max_projects` quota through it, AFTER the permission check. This is the
   * Sprint 7 separation made concrete: permission says the user may create a
   * project; the quota says the organization's plan still has room.
   */
  entitlements: EntitlementService;
}

/** Per-request security metadata threaded from the route into action events. */
export interface ProjectRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ListProjectsInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
  limit: number;
  cursor: string | null;
}

export interface CreateProjectInput {
  userId: string;
  organizationId: string;
  name: string;
  ctx: ProjectRequestContext;
}

export interface ReadProjectInput {
  userId: string;
  organizationId: string;
  projectId: string;
  requestId: string | null;
}

export interface UpdateProjectInput {
  userId: string;
  organizationId: string;
  projectId: string;
  name: string;
  ctx: ProjectRequestContext;
}

export interface DeleteProjectInput {
  userId: string;
  organizationId: string;
  projectId: string;
  ctx: ProjectRequestContext;
}

export interface ProjectService {
  listProjects(input: ListProjectsInput): Promise<ProjectListResponse>;
  createProject(input: CreateProjectInput): Promise<ProjectCreateResponse>;
  readProject(input: ReadProjectInput): Promise<ProjectReadResponse>;
  updateProject(input: UpdateProjectInput): Promise<ProjectUpdateResponse>;
  deleteProject(input: DeleteProjectInput): Promise<ProjectDeleteResponse>;
}

/** Internal project-list cursor shape. Opaque to clients. */
interface ProjectCursor {
  c: number; // project createdAt epoch millis
  i: string; // project id (tiebreak)
}

/** Map a project row to the public Project DTO (never exposes delete markers). */
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Decode a project-list cursor, rejecting a malformed value with BAD_REQUEST. */
function decodeProjectCursor(
  cursor: string | null,
): { createdAtMs: number; id: string } | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeCursor<ProjectCursor>(cursor);
  if (!decoded || typeof decoded.c !== 'number' || typeof decoded.i !== 'string') {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
  }
  return { createdAtMs: decoded.c, id: decoded.i };
}

/** Build the repository action context from an actor + request metadata. */
function actionContext(
  actor: OrganizationActor,
  ctx: ProjectRequestContext,
): ProjectActionContext {
  return {
    actorUserId: actor.userId,
    actorMembershipId: actor.membershipId,
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  };
}

export function createProjectService(
  options: ProjectServiceOptions,
): ProjectService {
  const { accessControl, projects, entitlements } = options;

  /** Resolve the actor (active membership + effective permissions) for a request. */
  async function actorFor(input: {
    userId: string;
    organizationId: string;
    requestId: string | null;
  }): Promise<OrganizationActor> {
    return requireMembership(accessControl, {
      userId: input.userId,
      organizationId: input.organizationId,
      requestId: input.requestId,
    });
  }

  return {
    async listProjects(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.projectsRead);

      const rows = await projects.listActiveProjects({
        organizationId: actor.organizationId,
        limit: input.limit,
        cursor: decodeProjectCursor(input.cursor),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.createdAt.getTime(),
              i: last.id,
            } satisfies ProjectCursor)
          : null;

      return { items: page.map(toProject), nextCursor, hasMore };
    },

    async createProject(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.projectsCreate);

      // Enforcement order: permission (above) THEN quota. A user without
      // projects.create is already blocked; an authorized user is still blocked
      // when the organization's plan is at its max_projects ceiling. The quota
      // check throws QUOTA_EXCEEDED and runs BEFORE any write, so a quota failure
      // creates no project and records no project.created event.
      await entitlements.requireProjectCreationQuota(actor.organizationId);

      const project = await projects.createProject({
        organizationId: actor.organizationId,
        name: input.name,
        createdByUserId: actor.userId,
        ctx: actionContext(actor, input.ctx),
      });

      return { project: toProject(project) };
    },

    async readProject(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.projectsRead);

      // Looked up by BOTH organization id and project id; a cross-tenant or
      // soft-deleted project is indistinguishable from a missing one.
      const project = await projects.findActiveProject(
        actor.organizationId,
        input.projectId,
      );
      if (!project) {
        throw projectNotFoundError();
      }

      return { project: toProject(project) };
    },

    async updateProject(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.projectsUpdate);

      const project = await projects.updateProject({
        organizationId: actor.organizationId,
        projectId: input.projectId,
        name: input.name,
        ctx: actionContext(actor, input.ctx),
      });

      return { project: toProject(project) };
    },

    async deleteProject(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.projectsDelete);

      await projects.softDeleteProject({
        organizationId: actor.organizationId,
        projectId: input.projectId,
        ctx: actionContext(actor, input.ctx),
      });

      return { id: input.projectId, deleted: true };
    },
  };
}
