import {
  cursorPageParamsSchema,
  memberRoleChangeRequestSchema,
} from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import {
  requestContext,
  requireBearerToken,
} from '../../lib/request-context';
import type { OrganizationAuthenticator } from './organization.routes';
import type { MemberService } from './member.service';

/**
 * Organization member-management HTTP routes (list / role change / removal).
 *
 * Handlers stay thin: authenticate the Bearer token via the auth boundary,
 * validate input via Zod contracts, delegate the workflow (which performs the
 * membership + permission checks) to the member service, and shape the response
 * through the standard success envelope. No authorization logic and no raw
 * database row ever lives here — the service owns `requireMembership` /
 * `requirePermission`, and the `:organizationId` path segment is the authority
 * boundary (never the slug). The org-scoped RBAC READ surfaces (roles /
 * permissions / matrix / effective) live in `org-rbac.routes.ts`.
 */
export interface MemberRoutesOptions {
  service: MemberService;
  authenticator: OrganizationAuthenticator;
}

export function registerMemberRoutes(
  app: FastifyInstance,
  options: MemberRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  // List the organization's active members (requires members.read).
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/members',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { cursor, limit } = cursorPageParamsSchema.parse(request.query);
      const result = await service.listMembers({
        userId: user.id,
        organizationId: request.params.organizationId,
        requestId: ctx.requestId,
        limit,
        cursor: cursor ?? null,
      });
      return sendSuccess(reply, result);
    },
  );

  // Change a member's role (requires members.change_role; Last Owner protected).
  app.patch<{ Params: { organizationId: string; membershipId: string } }>(
    '/v1/organizations/:organizationId/members/:membershipId/role',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const input = memberRoleChangeRequestSchema.parse(request.body);
      const result = await service.changeMemberRole({
        userId: user.id,
        organizationId: request.params.organizationId,
        membershipId: request.params.membershipId,
        newRole: input.role,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );

  // Remove a member (requires members.remove; Last Owner protected; soft delete).
  app.delete<{ Params: { organizationId: string; membershipId: string } }>(
    '/v1/organizations/:organizationId/members/:membershipId',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const result = await service.removeMember({
        userId: user.id,
        organizationId: request.params.organizationId,
        membershipId: request.params.membershipId,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );
}
