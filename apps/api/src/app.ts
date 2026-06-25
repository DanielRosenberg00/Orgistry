import type { Config } from '@orgistry/config';
import { generateRequestId } from '@orgistry/shared';
import cors from '@fastify/cors';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { registerErrorHandler } from './plugins/error-handler';
import { registerHealthRoute } from './routes/health';
import { registerReadinessRoute } from './routes/readiness';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import type { AuthService } from './modules/auth/auth.service';
import { registerOrganizationRoutes } from './modules/organization/organization.routes';
import type { OrganizationService } from './modules/organization/organization.service';
import { registerMemberRoutes } from './modules/organization/member.routes';
import type { MemberService } from './modules/organization/member.service';
import { registerOrganizationRbacRoutes } from './modules/organization/org-rbac.routes';
import type { OrganizationRbacService } from './modules/organization/org-rbac.service';
import { registerRbacRoutes } from './modules/rbac/rbac.routes';
import type { RbacService } from './modules/rbac/rbac.service';
import { registerProjectRoutes } from './modules/projects/project.routes';
import type { ProjectService } from './modules/projects/project.service';
import { registerPlanRoutes } from './modules/entitlements/plan.routes';
import type { PlanService } from './modules/entitlements/plan.service';
import { registerApiKeyRoutes } from './modules/api-keys/api-key.routes';
import type { ApiKeyService } from './modules/api-keys/api-key.service';
import { registerInvitationRoutes } from './modules/invitations/invitation.routes';
import type { InvitationService } from './modules/invitations/invitation.service';
import { registerExternalProjectRoutes } from './modules/api-keys/external-projects.routes';
import type { ExternalProjectsService } from './modules/api-keys/external-projects.service';
import type { ApiKeyAuthenticator } from './modules/api-keys/api-key.authenticator';
import { registerAuditRoutes } from './modules/audit/audit.routes';
import type { AuditService } from './modules/audit/audit.service';
import type { ReadinessProbe } from './lib/readiness';

export interface BuildAppOptions {
  config: Config;
  /** Dependency probes backing the readiness endpoint (e.g. PostgreSQL, Redis). */
  readinessProbes: ReadinessProbe[];
  /**
   * Auth service backing the `/v1/auth/*` routes. Optional so infrastructure-
   * only contexts (and some unit tests) can build the app without a database.
   */
  authService?: AuthService;
  /**
   * Organization service backing the `/v1/organizations` routes. Requires
   * `authService` (the routes are Bearer-authenticated through it); registered
   * only when both are provided.
   */
  organizationService?: OrganizationService;
  /**
   * Member-management service backing the organization member routes
   * (`/v1/organizations/:id/members*`). Requires `authService`.
   */
  memberService?: MemberService;
  /**
   * Organization-scoped RBAC read service backing the permission-enforced
   * `/v1/organizations/:id/roles`, `…/permissions`, `…/permissions/matrix`, and
   * `…/permissions/effective` routes. Requires `authService`.
   */
  organizationRbacService?: OrganizationRbacService;
  /**
   * Global RBAC reference service backing the authenticated static catalog at
   * `/v1/roles`, `/v1/permissions`, and `/v1/permissions/matrix`. Requires
   * `authService`. These are NOT permission-enforced — see the org-scoped
   * equivalents above.
   */
  rbacService?: RbacService;
  /**
   * Project service backing the organization-scoped Projects routes
   * (`/v1/organizations/:id/projects*`). Requires `authService` (the routes are
   * Bearer-authenticated through it); registered only when both are provided.
   */
  projectService?: ProjectService;
  /**
   * Plan & entitlements service backing the organization-scoped plan routes
   * (`/v1/organizations/:id/plan`, `…/entitlements`, `…/plan/demo`). Requires
   * `authService` (the routes are Bearer-authenticated through it); registered
   * only when both are provided.
   */
  planService?: PlanService;
  /**
   * API key management service backing the organization-scoped key routes
   * (`/v1/organizations/:id/api-keys*`). Requires `authService` (the routes are
   * Bearer-USER-authenticated through it); registered only when both are provided.
   */
  apiKeyService?: ApiKeyService;
  /**
   * Invitation lifecycle service backing the organization-scoped invitation
   * management routes (`/v1/organizations/:id/invitations*`) and the
   * token-bearing onboarding routes (`/v1/invitations/inspect`,
   * `/v1/invitations/accept`). Requires `authService` (the management + accept
   * routes are Bearer-authenticated through it); registered only when both are
   * provided. The same service instance is also wired into the auth service as
   * the registration-with-invitation collaborator.
   */
  invitationService?: InvitationService;
  /**
   * Audit log read service backing the organization-scoped audit route
   * (`GET /v1/organizations/:id/audit-events`). Requires `authService` (the
   * route is Bearer-USER-authenticated through it); registered only when both
   * are provided. The route additionally enforces the `audit_events.read`
   * permission and the `audit_log_access` entitlement inside the service.
   */
  auditService?: AuditService;
  /**
   * External read-only Projects service backing `GET /v1/external/projects`.
   * Registered only together with `apiKeyAuthenticator` — the external route is
   * authenticated by API key, NOT by the user auth service.
   */
  externalProjectsService?: ExternalProjectsService;
  /**
   * Authenticator for external API-key routes. Independent of `authService` —
   * API keys are not user sessions. Required to register the external routes.
   */
  apiKeyAuthenticator?: ApiKeyAuthenticator;
  /** Logger override. Defaults to a JSON logger at the configured level. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Construct a fully wired Fastify instance WITHOUT starting it.
 *
 * Keeping construction separate from `listen` (see `server.ts`) lets tests
 * exercise the app via `app.inject(...)` with no open ports or real network,
 * and lets startup own process concerns (signals, real clients, shutdown).
 *
 * Request-id handling: Fastify reuses an inbound `x-request-id` header when
 * present and otherwise generates one. The id is echoed on every response and
 * included in error envelopes and log lines (`reqId`).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, readinessProbes } = options;

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => generateRequestId(),
  });

  // Echo the resolved request id on every response for client-side correlation.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.register(cors, {
    origin: config.cors.origins.length > 0 ? [...config.cors.origins] : false,
    credentials: true,
  });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerReadinessRoute(app, readinessProbes);
  if (options.authService) {
    registerAuthRoutes(app, {
      service: options.authService,
      refreshCookie: config.auth.refreshCookie,
      csrfHeaderName: config.auth.csrfHeaderName,
    });

    // Organization routes authenticate via the auth service, so they are only
    // wired when both services are present.
    if (options.organizationService) {
      registerOrganizationRoutes(app, {
        service: options.organizationService,
        authenticator: options.authService,
      });
    }

    // Member-management routes (organization-scoped).
    if (options.memberService) {
      registerMemberRoutes(app, {
        service: options.memberService,
        authenticator: options.authService,
      });
    }

    // Organization-scoped, permission-enforced RBAC read routes.
    if (options.organizationRbacService) {
      registerOrganizationRbacRoutes(app, {
        service: options.organizationRbacService,
        authenticator: options.authService,
      });
    }

    // Global static RBAC reference routes (authenticated; not permission-enforced).
    if (options.rbacService) {
      registerRbacRoutes(app, {
        service: options.rbacService,
        authenticator: options.authService,
      });
    }

    // Organization-scoped, permission-enforced Projects routes.
    if (options.projectService) {
      registerProjectRoutes(app, {
        service: options.projectService,
        authenticator: options.authService,
      });
    }

    // Organization-scoped, permission-enforced plan & entitlements routes.
    if (options.planService) {
      registerPlanRoutes(app, {
        service: options.planService,
        authenticator: options.authService,
      });
    }

    // Organization-scoped, permission-enforced API key MANAGEMENT routes. These
    // are Bearer-USER-authenticated (key management is a user action), so they
    // are wired alongside the other user routes.
    if (options.apiKeyService) {
      registerApiKeyRoutes(app, {
        service: options.apiKeyService,
        authenticator: options.authService,
      });
    }

    // Organization-scoped invitation management + token-bearing onboarding
    // routes. The management routes and the accept route are Bearer-USER
    // authenticated; the inspect route is intentionally public (it backs
    // new-user onboarding) and is registered by `registerInvitationRoutes`.
    if (options.invitationService) {
      registerInvitationRoutes(app, {
        service: options.invitationService,
        authenticator: options.authService,
      });
    }

    // Organization-scoped audit log read route. Bearer-USER authenticated; the
    // service enforces audit_events.read AND audit_log_access independently.
    if (options.auditService) {
      registerAuditRoutes(app, {
        service: options.auditService,
        authenticator: options.authService,
      });
    }
  }

  // External read-only Projects route. Deliberately OUTSIDE the user-auth block:
  // it is authenticated by API key, never by the user auth service, so it is
  // registered whenever its own dependencies are present.
  if (options.externalProjectsService && options.apiKeyAuthenticator) {
    registerExternalProjectRoutes(app, {
      service: options.externalProjectsService,
      authenticator: options.apiKeyAuthenticator,
    });
  }

  return app;
}
