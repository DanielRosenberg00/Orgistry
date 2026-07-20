import {
  passwordRecoveryCompleteRequestSchema,
  passwordRecoveryRequestSchema,
} from '@orgistry/contracts';
import type { FastifyInstance } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { requestContext } from '../../lib/request-context';
import type { PasswordRecoveryService } from './password-recovery.service';

export interface PasswordRecoveryRoutesOptions {
  service: PasswordRecoveryService;
}

/**
 * Password-recovery HTTP routes (Sprint 17). Handlers stay thin: validate via
 * Zod contracts, delegate the workflow to the service, shape the response
 * through the success envelope. Both routes are PUBLIC by design.
 *
 *  - `POST /v1/auth/password-recovery/request` — accepts an email; responds
 *    identically whether or not an account exists (enumeration-safe contract).
 *  - `POST /v1/auth/password-recovery/complete` — possession of the emailed
 *    raw token is the proof. Token AND new password arrive in the request
 *    BODY, never a URL, so neither can reach access logs. A success signs
 *    nobody in — the client directs the user to login.
 */
export function registerPasswordRecoveryRoutes(
  app: FastifyInstance,
  options: PasswordRecoveryRoutesOptions,
): void {
  const { service } = options;

  app.post('/v1/auth/password-recovery/request', async (request, reply) => {
    const input = passwordRecoveryRequestSchema.parse(request.body);
    const response = await service.requestReset(input, requestContext(request));
    return sendSuccess(reply, response);
  });

  app.post('/v1/auth/password-recovery/complete', async (request, reply) => {
    const input = passwordRecoveryCompleteRequestSchema.parse(request.body);
    const response = await service.completeReset(
      input,
      requestContext(request),
    );
    return sendSuccess(reply, response);
  });
}
