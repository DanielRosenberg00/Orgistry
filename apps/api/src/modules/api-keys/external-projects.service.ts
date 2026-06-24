import type { ProjectRow } from '@orgistry/db';
import {
  ERROR_CODES,
  type ExternalProject,
  type ExternalProjectListResponse,
} from '@orgistry/contracts';
import { decodeCursor, encodeCursor } from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import type { ProjectRepository } from '../projects/project.types';

/**
 * External read-only Projects workflow — the data behind `GET /v1/external/projects`.
 *
 * It REUSES the tenant-scoped `ProjectRepository` (the same persistence the
 * internal Projects slice uses), so tenant isolation and active-only filtering
 * are inherited, not re-implemented. The crucial difference from the internal
 * slice: there is NO `requireMembership` and NO permission check here. The
 * organization id is supplied by the caller from the authenticated API KEY actor
 * (derived from the key row), never from the request — the external route is the
 * only caller and it passes `actor.organizationId`.
 *
 * Rows are mapped to the EXTERNAL project DTO (a distinct shape from the internal
 * `Project`), so no internal/persistence field can leak through this surface.
 */

export interface ExternalProjectsServiceOptions {
  projects: ProjectRepository;
}

export interface ListExternalProjectsInput {
  /** The key's organization, derived from the API key actor (never the request). */
  organizationId: string;
  limit: number;
  cursor: string | null;
}

export interface ExternalProjectsService {
  listProjects(
    input: ListExternalProjectsInput,
  ): Promise<ExternalProjectListResponse>;
}

/** Internal external-project-list cursor shape. Opaque to clients. */
interface ExternalProjectCursor {
  c: number; // createdAt epoch millis
  i: string; // project id (tiebreak)
}

/** Map a project row to the external project DTO. */
function toExternalProject(row: ProjectRow): ExternalProject {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Decode a cursor, rejecting a malformed value with BAD_REQUEST. */
function decodeExternalCursor(
  cursor: string | null,
): { createdAtMs: number; id: string } | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeCursor<ExternalProjectCursor>(cursor);
  if (!decoded || typeof decoded.c !== 'number' || typeof decoded.i !== 'string') {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
  }
  return { createdAtMs: decoded.c, id: decoded.i };
}

export function createExternalProjectsService(
  options: ExternalProjectsServiceOptions,
): ExternalProjectsService {
  const { projects } = options;

  return {
    async listProjects(input) {
      const rows = await projects.listActiveProjects({
        organizationId: input.organizationId,
        limit: input.limit,
        cursor: decodeExternalCursor(input.cursor),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.createdAt.getTime(),
              i: last.id,
            } satisfies ExternalProjectCursor)
          : null;

      return { items: page.map(toExternalProject), nextCursor, hasMore };
    },
  };
}
