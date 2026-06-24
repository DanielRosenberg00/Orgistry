import {
  apiKeyCreateRequestSchema,
  apiKeyListQuerySchema,
  apiKeyRouteParamsSchema,
} from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';
import { sendSuccess } from '../../lib/envelope';
import {
  requestContext,
  requireBearerToken,
} from '../../lib/request-context';
import type { OrganizationAuthenticator } from '../organization/organization.routes';
import type { ApiKeyService } from './api-key.service';

/**
 * API key management HTTP routes — the USER-facing, organization-scoped surface
 * (`/v1/organizations/:organizationId/api-keys`).
 *
 * Handlers stay thin: authenticate the Bearer USER token via the auth boundary,
 * validate input via Zod contracts, delegate the workflow (membership +
 * permission + entitlement + quota checks) to the service, and shape the
 * response through the standard success envelope. The `:organizationId` path
 * segment is the tenant authority boundary — it is the ONLY source of the
 * organization id (never the request body). The raw secret appears only in the
 * create response, exactly once.
 */
export interface ApiKeyRoutesOptions {
  service: ApiKeyService;
  authenticator: OrganizationAuthenticator;
}

export function registerApiKeyRoutes(
  app: FastifyInstance,
  options: ApiKeyRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  // Create a key under the route organization (requires api_keys.create +
  // api_keys_access entitlement + max_api_keys quota). Returns the raw secret ONCE.
  app.post<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/api-keys',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const input = apiKeyCreateRequestSchema.parse(request.body);

      // Reject a past/now expiry: a key that is born expired is a client error,
      // not a silently-useless key. (The schema already validated ISO-8601 shape.)
      let expiresAt: Date | null = null;
      if (input.expiresAt) {
        const parsed = new Date(input.expiresAt);
        if (parsed.getTime() <= Date.now()) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            400,
            'expiresAt must be in the future.',
          );
        }
        expiresAt = parsed;
      }

      const result = await service.createApiKey({
        userId: user.id,
        organizationId: request.params.organizationId,
        name: input.name,
        scopes: input.scopes,
        expiresAt,
        ctx,
      });
      return sendSuccess(reply, result, 201);
    },
  );

  // List the organization's keys (requires api_keys.read + api_keys_access).
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/api-keys',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { cursor, limit } = apiKeyListQuerySchema.parse(request.query);
      const result = await service.listApiKeys({
        userId: user.id,
        organizationId: request.params.organizationId,
        requestId: ctx.requestId,
        limit,
        cursor: cursor ?? null,
      });
      return sendSuccess(reply, result);
    },
  );

  // Revoke a key, scoped by org + id (requires api_keys.revoke + api_keys_access).
  app.delete<{ Params: { organizationId: string; apiKeyId: string } }>(
    '/v1/organizations/:organizationId/api-keys/:apiKeyId',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { organizationId, apiKeyId } = apiKeyRouteParamsSchema.parse(
        request.params,
      );
      const result = await service.revokeApiKey({
        userId: user.id,
        organizationId,
        apiKeyId,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );
}
