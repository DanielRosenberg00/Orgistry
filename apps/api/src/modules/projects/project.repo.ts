import type { Database, DbExecutor, ProjectRow } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { sanitizeSecurityMetadata } from '../../lib/security-metadata';
import { projectNotFoundError } from './project.errors';
import {
  PROJECT_EVENT_TYPES,
  type ProjectEventType,
} from './project.events';
import type {
  CreateProjectParams,
  ListProjectsParams,
  ProjectActionContext,
  ProjectRepository,
  SoftDeleteProjectParams,
  UpdateProjectParams,
} from './project.types';

/** Stable target type recorded on every project action event. */
const PROJECT_TARGET_TYPE = 'project';

/**
 * Drizzle-backed implementation of the tenant-aware project persistence
 * boundary. All project SQL lives here; the service depends only on
 * `ProjectRepository`.
 *
 * Two rules hold for every method:
 *  1. Reads and mutations are scoped by `organization_id` — a project is never
 *     addressed by id alone, so cross-tenant access cannot occur.
 *  2. Active flows filter `deleted_at IS NULL`, so soft-deleted projects are
 *     invisible to list/read/update/delete.
 */
export function createDbProjectRepository(db: Database): ProjectRepository {
  /**
   * Record a project action event in the SAME transaction as the mutation, on
   * the existing organization-scoped `security_events` seam. Actor membership,
   * target type, and target id live in the sanitized metadata (the table has no
   * dedicated columns for them); secrets never appear here.
   */
  async function recordProjectEvent(
    executor: DbExecutor,
    input: {
      organizationId: string;
      eventType: ProjectEventType;
      projectId: string;
      metadata: Record<string, unknown>;
      ctx: ProjectActionContext;
    },
  ): Promise<void> {
    await executor.insert(schema.securityEvents).values({
      id: createId('sevt'),
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
      ipAddress: input.ctx.ipAddress,
      userAgent: input.ctx.userAgent,
      requestId: input.ctx.requestId,
    });
  }

  return {
    async listActiveProjects(params: ListProjectsParams): Promise<ProjectRow[]> {
      // Keyset pagination on (created_at desc, id desc) within the organization,
      // matching the active partial index. Soft-deleted rows are excluded.
      const cursorClause = params.cursor
        ? or(
            lt(schema.projects.createdAt, new Date(params.cursor.createdAtMs)),
            and(
              eq(
                schema.projects.createdAt,
                new Date(params.cursor.createdAtMs),
              ),
              lt(schema.projects.id, params.cursor.id),
            ),
          )
        : undefined;

      return db
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, params.organizationId),
            isNull(schema.projects.deletedAt),
            ...(cursorClause ? [cursorClause] : []),
          ),
        )
        .orderBy(desc(schema.projects.createdAt), desc(schema.projects.id))
        .limit(params.limit + 1);
    },

    async createProject(params: CreateProjectParams): Promise<ProjectRow> {
      return db.transaction(async (tx) => {
        const [project] = await tx
          .insert(schema.projects)
          .values({
            id: createId('prj'),
            organizationId: params.organizationId,
            name: params.name,
            createdByUserId: params.createdByUserId,
          })
          .returning();

        await recordProjectEvent(tx, {
          organizationId: params.organizationId,
          eventType: PROJECT_EVENT_TYPES.created,
          projectId: project.id,
          metadata: { name: project.name },
          ctx: params.ctx,
        });

        return project;
      });
    },

    async findActiveProject(
      organizationId: string,
      projectId: string,
    ): Promise<ProjectRow | null> {
      const [project] = await db
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, organizationId),
            eq(schema.projects.id, projectId),
            isNull(schema.projects.deletedAt),
          ),
        )
        .limit(1);
      return project ?? null;
    },

    async updateProject(params: UpdateProjectParams): Promise<ProjectRow> {
      return db.transaction(async (tx) => {
        // Lock the row, scoped by org + id, and require it active. A missing,
        // cross-tenant, or already-deleted project is a uniform not-found.
        const [target] = await tx
          .select()
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.organizationId, params.organizationId),
              eq(schema.projects.id, params.projectId),
              isNull(schema.projects.deletedAt),
            ),
          )
          .for('update')
          .limit(1);
        if (!target) {
          throw projectNotFoundError();
        }

        const [updated] = await tx
          .update(schema.projects)
          .set({ name: params.name, updatedAt: new Date() })
          .where(eq(schema.projects.id, target.id))
          .returning();

        await recordProjectEvent(tx, {
          organizationId: params.organizationId,
          eventType: PROJECT_EVENT_TYPES.updated,
          projectId: updated.id,
          metadata: { name: updated.name },
          ctx: params.ctx,
        });

        return updated;
      });
    },

    async softDeleteProject(params: SoftDeleteProjectParams): Promise<void> {
      await db.transaction(async (tx) => {
        // Lock the row, scoped by org + id, and require it still active. A
        // repeated delete (already soft-deleted), a cross-tenant target, or an
        // unknown id all surface the same not-found — existence never leaks.
        const [target] = await tx
          .select()
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.organizationId, params.organizationId),
              eq(schema.projects.id, params.projectId),
              isNull(schema.projects.deletedAt),
            ),
          )
          .for('update')
          .limit(1);
        if (!target) {
          throw projectNotFoundError();
        }

        const now = new Date();
        await tx
          .update(schema.projects)
          .set({
            deletedAt: now,
            deletedByUserId: params.ctx.actorUserId,
            updatedAt: now,
          })
          .where(eq(schema.projects.id, target.id));

        await recordProjectEvent(tx, {
          organizationId: params.organizationId,
          eventType: PROJECT_EVENT_TYPES.deleted,
          projectId: target.id,
          metadata: {},
          ctx: params.ctx,
        });
      });
    },
  };
}
