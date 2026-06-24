import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { requestContext, requireBearerToken } from '../../lib/request-context';
import type { OrganizationAuthenticator } from '../organization/organization.routes';
import type { RbacService } from './rbac.service';

/**
 * RBAC reference HTTP routes — the fixed roles, the fixed permission catalog,
 * and the role→permission matrix.
 *
 * All three are READ-ONLY reference data: there is no create/update/delete
 * surface for roles or permissions in v1. They require a valid Bearer access
 * token (any authenticated user) but are NOT organization-scoped — they describe
 * the platform's fixed RBAC model, not a tenant's state.
 */
export interface RbacRoutesOptions {
  service: RbacService;
  authenticator: OrganizationAuthenticator;
}

export function registerRbacRoutes(
  app: FastifyInstance,
  options: RbacRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  app.get('/v1/roles', async (request, reply) => {
    await authenticate(request);
    return sendSuccess(reply, await service.listRoles());
  });

  app.get('/v1/permissions', async (request, reply) => {
    await authenticate(request);
    return sendSuccess(reply, await service.listPermissions());
  });

  app.get('/v1/permissions/matrix', async (request, reply) => {
    await authenticate(request);
    return sendSuccess(reply, await service.getMatrix());
  });
}
