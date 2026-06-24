import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { requestContext, requireBearerToken } from '../../lib/request-context';
import type { OrganizationAuthenticator } from './organization.routes';
import type { OrganizationRbacService } from './org-rbac.service';

/**
 * Organization-scoped RBAC read HTTP routes — the permission-enforced reference
 * surfaces.
 *
 *   GET /v1/organizations/:organizationId/roles                  -> roles.read
 *   GET /v1/organizations/:organizationId/permissions            -> permissions.read
 *   GET /v1/organizations/:organizationId/permissions/matrix     -> permissions.read
 *   GET /v1/organizations/:organizationId/permissions/effective  -> active membership
 *
 * Handlers stay thin: authenticate the Bearer token, delegate to the service
 * (which performs requireMembership + requirePermission), and shape the response
 * through the standard success envelope. `:organizationId` is the authority
 * boundary — never the slug. These are the org-scoped, permission-gated
 * counterparts to the global static catalog at `/v1/roles`, `/v1/permissions`,
 * and `/v1/permissions/matrix`.
 */
export interface OrganizationRbacRoutesOptions {
  service: OrganizationRbacService;
  authenticator: OrganizationAuthenticator;
}

export function registerOrganizationRbacRoutes(
  app: FastifyInstance,
  options: OrganizationRbacRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  function readInput(
    user: AuthUser,
    request: FastifyRequest<{ Params: { organizationId: string } }>,
  ) {
    return {
      userId: user.id,
      organizationId: request.params.organizationId,
      requestId: requestContext(request).requestId,
    };
  }

  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/roles',
    async (request, reply) => {
      const user = await authenticate(request);
      return sendSuccess(reply, await service.listRoles(readInput(user, request)));
    },
  );

  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/permissions',
    async (request, reply) => {
      const user = await authenticate(request);
      return sendSuccess(
        reply,
        await service.listPermissions(readInput(user, request)),
      );
    },
  );

  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/permissions/matrix',
    async (request, reply) => {
      const user = await authenticate(request);
      return sendSuccess(reply, await service.getMatrix(readInput(user, request)));
    },
  );

  // The current user's OWN effective permissions in the organization.
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/permissions/effective',
    async (request, reply) => {
      const user = await authenticate(request);
      return sendSuccess(
        reply,
        await service.getEffectivePermissions(readInput(user, request)),
      );
    },
  );
}
