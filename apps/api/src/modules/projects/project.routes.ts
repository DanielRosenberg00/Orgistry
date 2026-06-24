import {
  projectCreateRequestSchema,
  projectListQuerySchema,
  projectRouteParamsSchema,
  projectUpdateRequestSchema,
} from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import {
  requestContext,
  requireBearerToken,
} from '../../lib/request-context';
import type { OrganizationAuthenticator } from '../organization/organization.routes';
import type { ProjectService } from './project.service';

/**
 * Project HTTP routes — the organization-scoped Projects surface.
 *
 * Handlers stay thin: authenticate the Bearer token via the auth boundary,
 * validate input via Zod contracts, delegate the workflow (which performs the
 * membership + permission checks) to the project service, and shape the response
 * through the standard success envelope. No authorization logic and no raw
 * database row ever lives here. The `:organizationId` path segment is the tenant
 * authority boundary — it is the ONLY source of the organization id (never the
 * request body).
 *
 * Route params are parsed through `projectRouteParamsSchema` (presence/shape
 * only — see its contract). Their AUTHORITY is resolved server-side: an unknown,
 * malformed, or cross-tenant id surfaces a uniform safe not-found, never a probe
 * of existence — matching the organization/member route convention.
 */
export interface ProjectRoutesOptions {
  service: ProjectService;
  authenticator: OrganizationAuthenticator;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  // List the organization's active projects (requires projects.read).
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/projects',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { cursor, limit } = projectListQuerySchema.parse(request.query);
      const result = await service.listProjects({
        userId: user.id,
        organizationId: request.params.organizationId,
        requestId: ctx.requestId,
        limit,
        cursor: cursor ?? null,
      });
      return sendSuccess(reply, result);
    },
  );

  // Create a project under the route organization (requires projects.create).
  app.post<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/projects',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const input = projectCreateRequestSchema.parse(request.body);
      const result = await service.createProject({
        userId: user.id,
        organizationId: request.params.organizationId,
        name: input.name,
        ctx,
      });
      return sendSuccess(reply, result, 201);
    },
  );

  // Read a single project, scoped by org + id (requires projects.read).
  app.get<{ Params: { organizationId: string; projectId: string } }>(
    '/v1/organizations/:organizationId/projects/:projectId',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { organizationId, projectId } = projectRouteParamsSchema.parse(
        request.params,
      );
      const result = await service.readProject({
        userId: user.id,
        organizationId,
        projectId,
        requestId: ctx.requestId,
      });
      return sendSuccess(reply, result);
    },
  );

  // Update a project's name, scoped by org + id (requires projects.update).
  app.patch<{ Params: { organizationId: string; projectId: string } }>(
    '/v1/organizations/:organizationId/projects/:projectId',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { organizationId, projectId } = projectRouteParamsSchema.parse(
        request.params,
      );
      const input = projectUpdateRequestSchema.parse(request.body);
      const result = await service.updateProject({
        userId: user.id,
        organizationId,
        projectId,
        name: input.name,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );

  // Soft-delete a project, scoped by org + id (requires projects.delete).
  app.delete<{ Params: { organizationId: string; projectId: string } }>(
    '/v1/organizations/:organizationId/projects/:projectId',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { organizationId, projectId } = projectRouteParamsSchema.parse(
        request.params,
      );
      const result = await service.deleteProject({
        userId: user.id,
        organizationId,
        projectId,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );
}
