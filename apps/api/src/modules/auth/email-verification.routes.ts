import { emailVerificationCompleteRequestSchema } from '@orgistry/contracts';
import type { FastifyInstance } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { requestContext, requireBearerToken } from '../../lib/request-context';
import type { AuthService } from './auth.service';
import type { EmailVerificationService } from './email-verification.service';

export interface EmailVerificationRoutesOptions {
  service: EmailVerificationService;
  /** Authenticates the Bearer token on the request/resend endpoint. */
  authenticator: AuthService;
}

/**
 * Email-verification HTTP routes (Sprint 16). Handlers stay thin: validate via
 * Zod contracts, delegate the workflow to the service, shape the response
 * through the success envelope.
 *
 *  - `POST /v1/auth/email-verification/request` — Bearer-authenticated; also
 *    the resend endpoint. NO request body: it operates only on the current
 *    user's stored email, so no arbitrary address can be probed.
 *  - `POST /v1/auth/email-verification/complete` — PUBLIC; possession of the
 *    emailed raw token is the proof. The token arrives in the request BODY,
 *    never a URL path, so it cannot reach access logs.
 */
export function registerEmailVerificationRoutes(
  app: FastifyInstance,
  options: EmailVerificationRoutesOptions,
): void {
  const { service, authenticator } = options;

  app.post('/v1/auth/email-verification/request', async (request, reply) => {
    const token = requireBearerToken(request);
    const ctx = requestContext(request);
    const user = await authenticator.authenticate(token, ctx);
    const response = await service.requestVerificationEmail(user, ctx);
    return sendSuccess(reply, response);
  });

  app.post('/v1/auth/email-verification/complete', async (request, reply) => {
    const input = emailVerificationCompleteRequestSchema.parse(request.body);
    const response = await service.completeVerification(
      input.token,
      requestContext(request),
    );
    return sendSuccess(reply, response);
  });
}
