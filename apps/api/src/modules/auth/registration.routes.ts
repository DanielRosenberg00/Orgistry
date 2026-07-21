import {
  registerRequestSchema,
  registrationCompleteRequestSchema,
} from '@orgistry/contracts';
import type { FastifyInstance } from 'fastify';
import {
  setRefreshCookie,
  type RefreshCookieAttributes,
} from '../../lib/cookies';
import { sendSuccess } from '../../lib/envelope';
import { requestContext } from '../../lib/request-context';
import type { RegistrationService } from './registration.service';

export interface RegistrationRoutesOptions {
  service: RegistrationService;
  /** Centralized refresh-cookie attributes (completion issues a session). */
  refreshCookie: RefreshCookieAttributes;
}

/**
 * Verification-first registration routes (Sprint 18). Both are PUBLIC.
 *
 *  - `POST /v1/auth/register` stages a registration and returns the generic
 *    `{ accepted: true }`. It NEVER sets a cookie, returns tokens, or creates
 *    an account — compare the completion route below.
 *  - `POST /v1/auth/registration/complete` consumes the emailed raw token
 *    (request BODY only — never a URL) and returns the authenticated
 *    registration result. The refresh cookie is set ONLY here, and only after
 *    the service's completion transaction has committed.
 */
export function registerRegistrationRoutes(
  app: FastifyInstance,
  options: RegistrationRoutesOptions,
): void {
  const { service, refreshCookie } = options;

  app.post('/v1/auth/register', async (request, reply) => {
    const input = registerRequestSchema.parse(request.body);
    const response = await service.requestRegistration(
      input,
      requestContext(request),
    );
    return sendSuccess(reply, response);
  });

  app.post('/v1/auth/registration/complete', async (request, reply) => {
    const input = registrationCompleteRequestSchema.parse(request.body);
    const { response, rawRefreshToken } = await service.completeRegistration(
      input,
      requestContext(request),
    );
    // Cookie only after the account-creation transaction has succeeded.
    setRefreshCookie(reply, rawRefreshToken, refreshCookie);
    return sendSuccess(reply, response, 201);
  });
}
