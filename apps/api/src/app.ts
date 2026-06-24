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
  }

  return app;
}
