import {
  API_KEY_SCOPES,
  externalProjectListQuerySchema,
} from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { requestContext } from '../../lib/request-context';
import type { ApiKeyAuthenticator } from './api-key.authenticator';
import type { ExternalProjectsService } from './external-projects.service';

/**
 * External read-only Projects route (`GET /v1/external/projects`).
 *
 * This is the machine-facing surface. It is authenticated ONLY by an API key
 * (Bearer), never by a browser session/JWT. It does NOT take an organization id
 * in the path — the tenant is derived entirely from the authenticated key actor,
 * which is the whole point of the external API: a key can only ever read its own
 * organization's data, and a client cannot ask for another tenant's.
 *
 * It requires the `projects:read` scope, reuses the tenant-scoped Projects
 * persistence (active projects only, soft-deleted omitted), paginates with an
 * opaque cursor, and returns explicit external DTOs in the standard envelope.
 * There is no create/update/delete surface here by design.
 */
export interface ExternalProjectRoutesOptions {
  service: ExternalProjectsService;
  authenticator: ApiKeyAuthenticator;
}

/** Extract a raw Bearer credential, or null when absent/non-Bearer. */
function bearerCredential(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function registerExternalProjectRoutes(
  app: FastifyInstance,
  options: ExternalProjectRoutesOptions,
): void {
  const { service, authenticator } = options;

  app.get('/v1/external/projects', async (request, reply) => {
    // The per-request logger rides along so the authenticator can keep
    // suppressed failed-auth event writes observable (sanitized payloads only).
    const ctx = {
      ...requestContext(request),
      log: (data: Record<string, unknown>, message: string) =>
        request.log.warn(data, message),
    };
    // Authenticate the API key and require the read scope. The actor carries the
    // organization id (from the key row) — the ONLY source of tenant context.
    const actor = await authenticator.authenticate(
      bearerCredential(request),
      ctx,
      API_KEY_SCOPES.projectsRead,
    );

    const { cursor, limit } = externalProjectListQuerySchema.parse(
      request.query,
    );
    const result = await service.listProjects({
      organizationId: actor.organizationId,
      limit,
      cursor: cursor ?? null,
    });
    return sendSuccess(reply, result);
  });
}
