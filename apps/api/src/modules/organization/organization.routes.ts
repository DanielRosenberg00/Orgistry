import {
  cursorPageParamsSchema,
  organizationCreateRequestSchema,
} from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import {
  type RequestContext,
  requestContext,
  requireBearerToken,
} from '../../lib/request-context';
import type { OrganizationService } from './organization.service';

/**
 * The authentication boundary the organization routes depend on. The auth
 * service satisfies this structurally; the organization module never imports the
 * auth service concretely, so the dependency points one way (organization ->
 * auth) and stays loose.
 */
export interface OrganizationAuthenticator {
  authenticate(accessToken: string, ctx: RequestContext): Promise<AuthUser>;
}

export interface OrganizationRoutesOptions {
  service: OrganizationService;
  authenticator: OrganizationAuthenticator;
}

/**
 * Organization HTTP routes. Handlers stay thin: authenticate the Bearer token
 * via the auth boundary, validate input via Zod contracts (ZodError -> central
 * VALIDATION_ERROR), delegate the workflow to the service, and shape the
 * response through the standard success envelope. No domain logic lives here and
 * no raw database row is ever returned.
 */
export function registerOrganizationRoutes(
  app: FastifyInstance,
  options: OrganizationRoutesOptions,
): void {
  const { service, authenticator } = options;

  /** Resolve the authenticated user for a request, or reject (401). */
  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  app.post('/v1/organizations', async (request, reply) => {
    const user = await authenticate(request);
    const input = organizationCreateRequestSchema.parse(request.body);
    const result = await service.createOrganization(user.id, input);
    return sendSuccess(reply, result, 201);
  });

  app.get('/v1/organizations', async (request, reply) => {
    const user = await authenticate(request);
    const { cursor, limit } = cursorPageParamsSchema.parse(request.query);
    const result = await service.listOrganizations(user.id, {
      limit,
      cursor: cursor ?? null,
    });
    return sendSuccess(reply, result);
  });

  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId',
    async (request, reply) => {
      const user = await authenticate(request);
      const result = await service.readOrganization(
        user.id,
        request.params.organizationId,
      );
      return sendSuccess(reply, result);
    },
  );
}
