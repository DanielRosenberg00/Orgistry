import { signAccessToken } from '@orgistry/auth-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from './auth.service';
import {
  createInMemoryAuthRepository,
  type InMemoryAuthRepository,
} from './testing/in-memory-auth-repo';

/**
 * End-to-end auth route behavior exercised through `app.inject`, backed by an
 * in-memory repository. This validates the full HTTP path — validation,
 * service workflow, envelopes, error mapping, and security-event writing —
 * without requiring PostgreSQL. DB-backed persistence is covered separately in
 * the integration suite.
 */
const config = testConfig();

const VALID_REGISTER = {
  email: 'New.User@Example.com',
  password: 'a-strong-password-123',
  displayName: 'New User',
};

let repo: InMemoryAuthRepository;
let app: FastifyInstance;

beforeEach(async () => {
  repo = createInMemoryAuthRepository();
  const authService = createAuthService({
    repo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
  });
  app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    logger: false,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function register(
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
}
function login(
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/v1/auth/login', payload: body });
}

describe('POST /v1/auth/register', () => {
  it('creates a user and returns tokens without exposing secrets', async () => {
    const response = await register(VALID_REGISTER);
    const body = response.json();

    expect(response.statusCode).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.data.user.email).toBe('New.User@Example.com');
    expect(body.data.user.displayName).toBe('New User');
    expect(body.data.user.emailVerified).toBe(false);
    expect(body.data.user.id).toMatch(/^user_/);
    expect(body.data.tokens.tokenType).toBe('Bearer');
    expect(body.data.tokens.accessToken).toBeTypeOf('string');

    // No secret or persistence-only field leaks into the response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain(VALID_REGISTER.password);
    expect(raw).not.toContain('normalizedEmail');
  });

  it('stores an Argon2id hash, never the raw password', async () => {
    await register(VALID_REGISTER);
    const stored = repo.users[0];
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored.passwordHash).not.toContain(VALID_REGISTER.password);
  });

  it('writes a registration security event', async () => {
    await register(VALID_REGISTER);
    const event = repo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_succeeded',
    );
    expect(event).toBeDefined();
    expect(event?.userId).toBe(repo.users[0].id);
    expect(event?.sessionId).toBe(repo.sessions[0].id);
    expect(event?.requestId).toMatch(/^req_/);
  });

  it('rejects a duplicate normalized email with a conflict', async () => {
    await register(VALID_REGISTER);
    // Different casing/whitespace normalizes to the same account.
    const response = await register({
      ...VALID_REGISTER,
      email: '  New.User@example.COM ',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(repo.users).toHaveLength(1);
  });

  it('rejects a password shorter than 12 characters with VALIDATION_ERROR', async () => {
    const response = await register({ ...VALID_REGISTER, password: 'short' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(repo.users).toHaveLength(0);
  });
});

describe('POST /v1/auth/login', () => {
  beforeEach(async () => {
    await register(VALID_REGISTER);
  });

  it('logs in with correct credentials (case-insensitive email)', async () => {
    const response = await login({
      email: 'new.user@example.com',
      password: VALID_REGISTER.password,
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.user.email).toBe('New.User@Example.com');
    expect(body.data.tokens.accessToken).toBeTypeOf('string');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(
      repo.securityEvents.some((e) => e.eventType === 'auth.login_succeeded'),
    ).toBe(true);
  });

  it('returns an identical generic error for wrong password and unknown email', async () => {
    const wrongPassword = await login({
      email: 'new.user@example.com',
      password: 'definitely-wrong-password',
    });
    const unknownEmail = await login({
      email: 'nobody@example.com',
      password: 'definitely-wrong-password',
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);

    const a = wrongPassword.json().error;
    const b = unknownEmail.json().error;
    expect(a.code).toBe('INVALID_CREDENTIALS');
    // Identical public behavior: same code and message (ignore the per-request id).
    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('writes a login_failed security event for a failed attempt', async () => {
    await login({ email: 'newuser@example.com', password: 'wrong-password!' });
    expect(
      repo.securityEvents.some((e) => e.eventType === 'auth.login_failed'),
    ).toBe(true);
  });
});

describe('GET /v1/auth/me', () => {
  async function authedToken(): Promise<string> {
    const response = await register(VALID_REGISTER);
    return response.json().data.tokens.accessToken;
  }

  it('resolves the authenticated user for a valid token', async () => {
    const token = await authedToken();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.user.email).toBe('New.User@Example.com');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a missing token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired token with a standard envelope and no leaked state', async () => {
    const expired = await signAccessToken({
      userId: 'user_whatever',
      sessionId: 'sess_whatever',
      secret: config.auth.jwtSecret,
      ttlSeconds: -10,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: `Bearer ${expired}`,
        'x-request-id': 'req_expired_case',
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.requestId).toBe('req_expired_case');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain(expired); // raw token is never echoed back
    expect(body).not.toHaveProperty('data');
  });

  it('rejects a token whose session is missing', async () => {
    await register(VALID_REGISTER);
    const token = await signAccessToken({
      userId: repo.users[0].id,
      sessionId: 'sess_does_not_exist',
      secret: config.auth.jwtSecret,
      ttlSeconds: 900,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token whose session was revoked', async () => {
    const token = await authedToken();
    repo.sessions[0].revokedAt = new Date();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a token whose session has expired', async () => {
    const token = await authedToken();
    repo.sessions[0].expiresAt = new Date(Date.now() - 1000);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a token whose sessionId belongs to a different user", async () => {
    await register(VALID_REGISTER); // user A -> users[0], sessions[0]
    await register({
      ...VALID_REGISTER,
      email: 'other.person@example.com',
    }); // user B -> users[1], sessions[1]

    // Token for user A but pointing at user B's session.
    const crossToken = await signAccessToken({
      userId: repo.users[0].id,
      sessionId: repo.sessions[1].id,
      secret: config.auth.jwtSecret,
      ttlSeconds: 900,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${crossToken}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('writes a sanitized access_token_rejected event for an invalid token', async () => {
    await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: 'Bearer not.a.valid.jwt',
        'x-request-id': 'req_reject_case',
      },
    });

    const event = repo.securityEvents.find(
      (e) => e.eventType === 'auth.access_token_rejected',
    );
    expect(event).toBeDefined();
    // Nothing about the caller can be trusted from an unverifiable token.
    expect(event?.userId).toBeNull();
    expect(event?.sessionId).toBeNull();
    expect(event?.requestId).toBe('req_reject_case');
    // Metadata is sanitized and carries no token/credential material.
    const metadata = JSON.stringify(event?.metadata ?? {});
    expect(metadata).not.toContain('not.a.valid.jwt');
    expect(metadata).not.toContain('Bearer');
    expect(metadata).not.toMatch(/password|cookie|authorization/i);
  });

  it('does not write a security event for a missing token (intentional)', async () => {
    await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(
      repo.securityEvents.some(
        (e) => e.eventType === 'auth.access_token_rejected',
      ),
    ).toBe(false);
  });
});
