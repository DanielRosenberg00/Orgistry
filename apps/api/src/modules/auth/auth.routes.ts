import {
  loginRequestSchema,
  registerRequestSchema,
} from '@orgistry/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendSuccess } from '../../lib/envelope';
import { unauthorizedError } from './auth.errors';
import type { AuthService } from './auth.service';
import type { RequestContext } from './auth.types';

/** Build the per-request security context from a Fastify request. */
function requestContext(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    ipAddress: request.ip || null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/** Extract a Bearer token from the Authorization header, or reject. */
function requireBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw unauthorizedError();
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    throw unauthorizedError();
  }
  return token;
}

/**
 * Auth HTTP routes. Handlers stay thin: validate via Zod contracts (ZodError is
 * mapped to VALIDATION_ERROR by the central handler), delegate the workflow to
 * the service, and shape the response through the success envelope. All auth
 * failures are thrown as `AppError` and rendered by the central error handler.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthService,
): void {
  app.post('/v1/auth/register', async (request, reply) => {
    const input = registerRequestSchema.parse(request.body);
    const result = await service.register(input, requestContext(request));
    return sendSuccess(reply, result, 201);
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const input = loginRequestSchema.parse(request.body);
    const result = await service.login(input, requestContext(request));
    return sendSuccess(reply, result);
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const token = requireBearerToken(request);
    const user = await service.authenticate(token, requestContext(request));
    return sendSuccess(reply, { user });
  });
}
