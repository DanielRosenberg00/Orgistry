import {
  cursorPageParamsSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import {
  clearRefreshCookie,
  readCookie,
  setRefreshCookie,
  type RefreshCookieAttributes,
} from '../../lib/cookies';
import { requestContext, requireBearerToken } from '../../lib/request-context';
import {
  csrfRequiredError,
  invalidRefreshTokenError,
  tokenReuseDetectedError,
} from './auth.errors';
import type { AuthService } from './auth.service';

export interface AuthRoutesOptions {
  service: AuthService;
  /** Centralized refresh-cookie attributes (set + clear share these). */
  refreshCookie: RefreshCookieAttributes;
  /** Lowercased custom header required on cookie-backed mutations. */
  csrfHeaderName: string;
}

/**
 * CSRF guard for cookie-backed mutations. The Sprint 3 model is intentionally
 * minimal: SameSite=Lax cookie + strict CORS allow-list + a REQUIRED custom
 * header. A cross-site form/`fetch` cannot attach a custom header without a
 * CORS preflight that the allow-list denies, so requiring the header's presence
 * is sufficient — no double-submit token value is needed at this stage.
 */
function requireCsrfHeader(
  request: FastifyRequest,
  headerName: string,
): void {
  const value = request.headers[headerName];
  const present =
    typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
  if (!present) {
    throw csrfRequiredError();
  }
}

/**
 * Auth HTTP routes. Handlers stay thin: validate via Zod contracts (ZodError is
 * mapped to VALIDATION_ERROR by the central handler), delegate the workflow to
 * the service, and shape the response through the success envelope. The refresh
 * credential moves ONLY through the centralized HttpOnly cookie helper.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): void {
  const { service, refreshCookie, csrfHeaderName } = options;

  app.post('/v1/auth/register', async (request, reply) => {
    const input = registerRequestSchema.parse(request.body);
    const { response, rawRefreshToken } = await service.register(
      input,
      requestContext(request),
    );
    setRefreshCookie(reply, rawRefreshToken, refreshCookie);
    return sendSuccess(reply, response, 201);
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const input = loginRequestSchema.parse(request.body);
    const { response, rawRefreshToken } = await service.login(
      input,
      requestContext(request),
    );
    setRefreshCookie(reply, rawRefreshToken, refreshCookie);
    return sendSuccess(reply, response);
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const token = requireBearerToken(request);
    const user = await service.authenticate(token, requestContext(request));
    return sendSuccess(reply, { user });
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    requireCsrfHeader(request, csrfHeaderName);

    const rawToken = readCookie(request, refreshCookie.name);
    if (!rawToken) {
      // No cookie -> nothing to rotate. Clear defensively and fail generically.
      clearRefreshCookie(reply, refreshCookie);
      throw invalidRefreshTokenError();
    }

    const result = await service.refresh(rawToken, requestContext(request));
    if (result.status === 'rotated') {
      setRefreshCookie(reply, result.rawRefreshToken, refreshCookie);
      return sendSuccess(reply, result.response);
    }

    // Invalid or reuse: always clear the cookie before surfacing the error.
    clearRefreshCookie(reply, refreshCookie);
    throw result.status === 'reuse_detected'
      ? tokenReuseDetectedError()
      : invalidRefreshTokenError();
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    requireCsrfHeader(request, csrfHeaderName);

    const rawToken = readCookie(request, refreshCookie.name);
    await service.logout(rawToken, requestContext(request));

    // Always clear, even on a repeat logout with no cookie (idempotent).
    clearRefreshCookie(reply, refreshCookie);
    return sendSuccess(reply, { success: true });
  });

  app.get('/v1/auth/sessions', async (request, reply) => {
    const token = requireBearerToken(request);
    const { cursor, limit } = cursorPageParamsSchema.parse(request.query);
    const result = await service.listSessions(
      token,
      { limit, cursor: cursor ?? null },
      requestContext(request),
    );
    return sendSuccess(reply, result);
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/auth/sessions/:sessionId',
    async (request, reply) => {
      const token = requireBearerToken(request);
      const { revokedCurrent } = await service.revokeSession(
        token,
        request.params.sessionId,
        requestContext(request),
      );
      // Revoking the current session invalidates this browser's refresh cookie;
      // clear it so the client does not hold a now-dead credential.
      if (revokedCurrent) {
        clearRefreshCookie(reply, refreshCookie);
      }
      return sendSuccess(reply, { success: true });
    },
  );
}
