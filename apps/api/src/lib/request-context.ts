import { ERROR_CODES } from '@orgistry/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';

/**
 * Per-request context shared by Bearer-authenticated modules.
 *
 * Both the auth and organization routes derive the same security context from a
 * Fastify request and extract Bearer tokens identically; centralizing the two
 * helpers keeps that boundary consistent across modules.
 */
export interface RequestContext {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Build the per-request security context from a Fastify request. */
export function requestContext(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    ipAddress: request.ip || null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/**
 * Extract a Bearer token from the Authorization header, or reject with a
 * generic 401. Used by every Bearer-authenticated route.
 */
export function requireBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      401,
      'Authentication is required.',
    );
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      401,
      'Authentication is required.',
    );
  }
  return token;
}
