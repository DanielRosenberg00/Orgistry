import type { ProjectRow } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { sanitizeSecurityMetadata } from '../../../lib/security-metadata';
import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';
import { projectNotFoundError } from '../project.errors';
import {
  PROJECT_EVENT_TYPES,
  type ProjectEventType,
} from '../project.events';
import type {
  CreateProjectParams,
  ListProjectsParams,
  ProjectActionContext,
  ProjectRepository,
  SoftDeleteProjectParams,
  UpdateProjectParams,
} from '../project.types';

/** Stable target type recorded on every project action event. */
const PROJECT_TARGET_TYPE = 'project';

/**
 * In-memory `ProjectRepository` for unit/route tests.
 *
 * Mirrors the database repository's observable behavior — prefixed ids,
 * timestamps, organization-scoped lookups, active (non-deleted) filtering,
 * keyset ordering, and the action-event writes — over the shared
 * `InMemoryOrgStore`, so project workflows can be exercised end-to-end through
 * the HTTP layer with no PostgreSQL.
 */
export function createInMemoryProjectRepository(
  store: InMemoryOrgStore,
): ProjectRepository {
  function recordProjectEvent(input: {
    organizationId: string;
    eventType: ProjectEventType;
    projectId: string;
    metadata: Record<string, unknown>;
    ctx: ProjectActionContext;
  }): void {
    store.securityEvents.push({
      userId: input.ctx.actorUserId,
      organizationId: input.organizationId,
      actorType: 'user',
      eventType: input.eventType,
      metadata: sanitizeSecurityMetadata({
        actorMembershipId: input.ctx.actorMembershipId,
        targetType: PROJECT_TARGET_TYPE,
        targetProjectId: input.projectId,
        ...input.metadata,
      }),
      requestId: input.ctx.requestId,
    });
  }

  /** The active project matching org + id, or undefined. */
  function findActive(
    organizationId: string,
    projectId: string,
  ): ProjectRow | undefined {
    return store.projects.find(
      (p) =>
        p.id === projectId &&
        p.organizationId === organizationId &&
        p.deletedAt === null,
    );
  }

  return {
    async listActiveProjects(params: ListProjectsParams): Promise<ProjectRow[]> {
      const ordered = store.projects
        .filter(
          (p) =>
            p.organizationId === params.organizationId && p.deletedAt === null,
        )
        .sort((a, b) => {
          const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
          return byCreated !== 0 ? byCreated : a.id < b.id ? 1 : -1;
        });

      const afterCursor = params.cursor
        ? ordered.filter((p) => {
            const created = p.createdAt.getTime();
            if (created < params.cursor!.createdAtMs) {
              return true;
            }
            return (
              created === params.cursor!.createdAtMs &&
              p.id < params.cursor!.id
            );
          })
        : ordered;

      return afterCursor.slice(0, params.limit + 1);
    },

    async createProject(params: CreateProjectParams): Promise<ProjectRow> {
      const now = new Date();
      const project: ProjectRow = {
        id: createId('prj'),
        organizationId: params.organizationId,
        name: params.name,
        createdByUserId: params.createdByUserId,
        deletedAt: null,
        deletedByUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      store.projects.push(project);

      recordProjectEvent({
        organizationId: params.organizationId,
        eventType: PROJECT_EVENT_TYPES.created,
        projectId: project.id,
        metadata: { name: project.name },
        ctx: params.ctx,
      });

      return project;
    },

    async findActiveProject(
      organizationId: string,
      projectId: string,
    ): Promise<ProjectRow | null> {
      return findActive(organizationId, projectId) ?? null;
    },

    // Synchronous read-classify-write (no await before the mutation) -> atomic
    // under Node's single-threaded loop, mirroring the DB transaction + row lock.
    async updateProject(params: UpdateProjectParams): Promise<ProjectRow> {
      const target = findActive(params.organizationId, params.projectId);
      if (!target) {
        throw projectNotFoundError();
      }

      target.name = params.name;
      target.updatedAt = new Date();

      recordProjectEvent({
        organizationId: params.organizationId,
        eventType: PROJECT_EVENT_TYPES.updated,
        projectId: target.id,
        metadata: { name: target.name },
        ctx: params.ctx,
      });

      return target;
    },

    async softDeleteProject(params: SoftDeleteProjectParams): Promise<void> {
      const target = findActive(params.organizationId, params.projectId);
      // A repeated delete, cross-tenant target, or unknown id all surface the
      // same not-found — existence never leaks.
      if (!target) {
        throw projectNotFoundError();
      }

      const now = new Date();
      target.deletedAt = now;
      target.deletedByUserId = params.ctx.actorUserId;
      target.updatedAt = now;

      recordProjectEvent({
        organizationId: params.organizationId,
        eventType: PROJECT_EVENT_TYPES.deleted,
        projectId: target.id,
        metadata: {},
        ctx: params.ctx,
      });
    },
  };
}
