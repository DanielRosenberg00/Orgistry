import {
  auditListQuerySchema,
  auditRouteParamsSchema,
} from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { requestContext, requireBearerToken } from '../../lib/request-context';
import type { OrganizationAuthenticator } from '../organization/organization.routes';
import type { AuditService } from './audit.service';

/**
 * Audit Log read HTTP route — the organization-scoped audit surface.
 *
 * The handler stays thin: authenticate the Bearer token via the auth boundary,
 * validate query + params through Zod contracts, delegate to the audit service
 * (which performs the membership + permission + entitlement checks, the query,
 * the metadata sanitization, and the DTO shaping), and wrap the result in the
 * standard success envelope. No authorization logic and no raw row ever lives
 * here. The `:organizationId` path segment is the ONLY source of the
 * organization id — never the request body.
 */
export interface AuditRoutesOptions {
  service: AuditService;
  authenticator: OrganizationAuthenticator;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  options: AuditRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  // List the organization's audit/action events (requires audit_events.read +
  // audit_log_access). Cursor-paginated, filterable, retention metadata included.
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/audit-events',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const { organizationId } = auditRouteParamsSchema.parse(request.params);
      const query = auditListQuerySchema.parse(request.query);

      const result = await service.listAuditEvents({
        userId: user.id,
        organizationId,
        requestId: ctx.requestId,
        limit: query.limit,
        cursor: query.cursor ?? null,
        eventType: query.eventType ?? null,
        actorType: query.actorType ?? null,
        targetType: query.targetType ?? null,
        actorId: query.actorId ?? null,
        targetId: query.targetId ?? null,
        createdAfter: query.createdAfter ?? null,
        createdBefore: query.createdBefore ?? null,
      });

      return sendSuccess(reply, result);
    },
  );
}
