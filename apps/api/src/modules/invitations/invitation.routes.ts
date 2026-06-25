import {
  invitationCreateRequestSchema,
  invitationListQuerySchema,
  invitationRouteParamsSchema,
  invitationTokenRequestSchema,
} from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import {
  requestContext,
  requireBearerToken,
} from '../../lib/request-context';
import type { OrganizationAuthenticator } from '../organization/organization.routes';
import type { InvitationService } from './invitation.service';

/**
 * Invitation HTTP routes — the organization invitation lifecycle surface.
 *
 * Two route groups with different authentication models:
 *
 *  1. Organization-scoped MANAGEMENT (`/v1/organizations/:organizationId/
 *     invitations*`): Bearer-USER-authenticated. The `:organizationId` path
 *     segment is the tenant authority boundary — the ONLY source of the
 *     organization id (never the request body). The service performs the
 *     membership + permission + quota checks.
 *
 *  2. Token-bearing ONBOARDING (`/v1/invitations/inspect`, `/v1/invitations/
 *     accept`): the raw token travels in the request BODY, never the URL path,
 *     so it is never written to access logs or `Referer` headers. `inspect` is
 *     unauthenticated (it backs NEW-user registration) and returns only safe
 *     public context; `accept` is Bearer-authenticated (an existing user joins).
 *
 * Handlers stay thin: authenticate (where required), validate input via Zod
 * contracts, delegate to the service, and shape the response through the standard
 * success envelope. The raw token and its hash never appear in any response.
 */
export interface InvitationRoutesOptions {
  service: InvitationService;
  authenticator: OrganizationAuthenticator;
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  options: InvitationRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  // Create an invitation under the route organization (requires
  // invitations.create + the max_members reservation quota). Sends the email
  // (fail-closed) and returns the invitation DTO — never the raw token.
  app.post<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/invitations',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const input = invitationCreateRequestSchema.parse(request.body);
      const result = await service.createInvitation({
        userId: user.id,
        organizationId: request.params.organizationId,
        email: input.email,
        role: input.role,
        ctx,
      });
      return sendSuccess(reply, result, 201);
    },
  );

  // List the organization's invitations (requires invitations.read).
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/invitations',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { cursor, limit } = invitationListQuerySchema.parse(request.query);
      const result = await service.listInvitations({
        userId: user.id,
        organizationId: request.params.organizationId,
        requestId: ctx.requestId,
        limit,
        cursor: cursor ?? null,
      });
      return sendSuccess(reply, result);
    },
  );

  // Revoke a pending invitation, scoped by org + id (requires invitations.revoke).
  app.delete<{ Params: { organizationId: string; invitationId: string } }>(
    '/v1/organizations/:organizationId/invitations/:invitationId',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { organizationId, invitationId } = invitationRouteParamsSchema.parse(
        request.params,
      );
      const result = await service.revokeInvitation({
        userId: user.id,
        organizationId,
        invitationId,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );

  // Inspect a raw token (UNAUTHENTICATED — supports new-user onboarding). Returns
  // only safe public context for an acceptable invitation; rejects otherwise.
  app.post('/v1/invitations/inspect', async (request, reply) => {
    const { token } = invitationTokenRequestSchema.parse(request.body);
    const result = await service.inspectInvitation({ rawToken: token });
    return sendSuccess(reply, result);
  });

  // Accept a raw token as the authenticated EXISTING user. Creates the
  // organization membership transactionally; does NOT create a session.
  app.post('/v1/invitations/accept', async (request, reply) => {
    const user = await authenticate(request);
    const ctx = requestContext(request);
    const { token } = invitationTokenRequestSchema.parse(request.body);
    const result = await service.acceptInvitation({
      userId: user.id,
      userEmail: user.email,
      rawToken: token,
      ctx,
    });
    return sendSuccess(reply, result);
  });
}
