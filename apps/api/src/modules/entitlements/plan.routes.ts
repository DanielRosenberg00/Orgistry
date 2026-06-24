import { demoPlanChangeRequestSchema } from '@orgistry/contracts';
import type { AuthUser } from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import {
  requestContext,
  requireBearerToken,
} from '../../lib/request-context';
import type { OrganizationAuthenticator } from '../organization/organization.routes';
import type { PlanService } from './plan.service';

/**
 * Plan & entitlements HTTP routes — the organization-scoped plan surface.
 *
 * Handlers stay thin: authenticate the Bearer token via the auth boundary,
 * validate input via Zod contracts, delegate the workflow (which performs the
 * membership + permission checks and the entitlement resolution) to the plan
 * service, and shape the response through the standard success envelope. No
 * authorization logic, no entitlement/quota policy, and no raw persistence row
 * ever lives here. The `:organizationId` path segment is the tenant authority
 * boundary — the ONLY source of the organization id (never the request body).
 *
 * Surface:
 *   GET   /v1/organizations/:organizationId/plan          (plan.read)
 *   GET   /v1/organizations/:organizationId/entitlements  (plan.read)
 *   PATCH /v1/organizations/:organizationId/plan/demo     (plan.change_demo)
 *
 * The demo plan change is a DEMO control only: it switches internal plan state
 * and records `plan.changed_demo`. It calls no billing provider and creates no
 * subscription, invoice, or payment.
 */
export interface PlanRoutesOptions {
  service: PlanService;
  authenticator: OrganizationAuthenticator;
}

export function registerPlanRoutes(
  app: FastifyInstance,
  options: PlanRoutesOptions,
): void {
  const { service, authenticator } = options;

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const token = requireBearerToken(request);
    return authenticator.authenticate(token, requestContext(request));
  }

  // Read the organization's current plan (requires plan.read).
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/plan',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const result = await service.getPlan({
        userId: user.id,
        organizationId: request.params.organizationId,
        requestId: ctx.requestId,
      });
      return sendSuccess(reply, result);
    },
  );

  // Read the organization's resolved entitlements + quotas (requires plan.read).
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/entitlements',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const result = await service.getEntitlements({
        userId: user.id,
        organizationId: request.params.organizationId,
        requestId: ctx.requestId,
      });
      return sendSuccess(reply, result);
    },
  );

  // Change the organization's demo plan (requires plan.change_demo).
  app.patch<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/plan/demo',
    async (request, reply) => {
      const user = await authenticate(request);
      const ctx = requestContext(request);
      const input = demoPlanChangeRequestSchema.parse(request.body);
      const result = await service.changeDemoPlan({
        userId: user.id,
        organizationId: request.params.organizationId,
        targetPlanKey: input.planKey,
        ctx,
      });
      return sendSuccess(reply, result);
    },
  );
}
