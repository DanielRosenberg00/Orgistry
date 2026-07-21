import { describe, expect, it } from 'vitest';
import { buildLoggerOptions, buildRedactionPaths } from './logging';
import { buildTestApp, testConfig } from '../testing/build-test-app';

/**
 * Centralized logger redaction backstop (Sprint 19, ORG-PR-033).
 *
 * These tests build a REAL app with the production logger options routed to an
 * in-memory stream, emit structured log lines shaped like the accidents the
 * backstop exists for (logged headers, bodies, config objects, nested error
 * context), and assert the sensitive VALUES never reach the captured output
 * while safe diagnostic fields survive.
 */

function captureSetup() {
  const lines: string[] = [];
  const stream = { write: (chunk: string) => lines.push(chunk) };
  const config = testConfig();
  const app = buildTestApp(undefined, {
    config,
    logger: buildLoggerOptions(config, stream),
  });
  return { app, lines, all: () => lines.join('') };
}

describe('buildRedactionPaths', () => {
  it('covers the configured CSRF header dynamically', () => {
    const paths = buildRedactionPaths('x-custom-csrf');
    expect(paths).toContain('req.headers["x-custom-csrf"]');
    expect(paths.some((p) => p.includes('x-csrf-token'))).toBe(true);
  });
});

describe('logger redaction backstop', () => {
  it('redacts credential-bearing headers logged as structured fields', async () => {
    const { app, all } = captureSetup();
    app.log.info(
      {
        headers: {
          authorization: 'Bearer super-secret-access-token-9f1',
          cookie: 'orgistry_rt=raw-refresh-token-abc123',
          'x-orgistry-csrf': 'csrf-token-value-777',
        },
      },
      'incoming headers',
    );
    const output = all();
    expect(output).not.toContain('super-secret-access-token-9f1');
    expect(output).not.toContain('raw-refresh-token-abc123');
    expect(output).not.toContain('csrf-token-value-777');
    expect(output).toContain('[REDACTED]');
    await app.close();
  });

  it('redacts req/res serializer header paths and set-cookie', async () => {
    const { app, all } = captureSetup();
    app.log.info(
      {
        req: { headers: { authorization: 'Bearer leaked-req-token' } },
        res: { headers: { 'set-cookie': 'orgistry_rt=leaked-cookie-value' } },
      },
      'serializer shapes',
    );
    const output = all();
    expect(output).not.toContain('leaked-req-token');
    expect(output).not.toContain('leaked-cookie-value');
    await app.close();
  });

  it('redacts password, token, and API-key fields in logged bodies', async () => {
    const { app, all } = captureSetup();
    app.log.info(
      {
        body: {
          password: 'hunter2-plaintext',
          currentPassword: 'old-plaintext-pw',
          newPassword: 'new-plaintext-pw',
          token: 'raw-completion-token-xyz',
          refreshToken: 'raw-refresh-rotation-token',
          invitationToken: 'raw-invitation-token-qqq',
          apiKey: 'okey_live_rawapikeysecret',
        },
      },
      'body accident',
    );
    const output = all();
    for (const secret of [
      'hunter2-plaintext',
      'old-plaintext-pw',
      'new-plaintext-pw',
      'raw-completion-token-xyz',
      'raw-refresh-rotation-token',
      'raw-invitation-token-qqq',
      'okey_live_rawapikeysecret',
    ]) {
      expect(output).not.toContain(secret);
    }
    await app.close();
  });

  it('redacts SMTP/JWT secrets when a config-like object is logged', async () => {
    const { app, all } = captureSetup();
    app.log.info(
      {
        config: {
          jwtSecret: 'config-jwt-secret-value',
          smtpPassword: 'config-smtp-password-value',
          JWT_SECRET: 'env-style-jwt-secret',
          SMTP_PASSWORD: 'env-style-smtp-password',
        },
      },
      'config accident',
    );
    const output = all();
    for (const secret of [
      'config-jwt-secret-value',
      'config-smtp-password-value',
      'env-style-jwt-secret',
      'env-style-smtp-password',
    ]) {
      expect(output).not.toContain(secret);
    }
    await app.close();
  });

  it('redacts hash fields and nested sensitive objects in error context', async () => {
    const { app, all } = captureSetup();
    app.log.error(
      {
        err: {
          tokenHash: 'sha256-token-hash-value',
          passwordHash: 'argon2-password-hash-value',
        },
        session: { refreshToken: 'nested-raw-refresh-token' },
      },
      'error context accident',
    );
    const output = all();
    expect(output).not.toContain('sha256-token-hash-value');
    expect(output).not.toContain('argon2-password-hash-value');
    expect(output).not.toContain('nested-raw-refresh-token');
    await app.close();
  });

  it('preserves safe diagnostic fields alongside redacted ones', async () => {
    const { app, all } = captureSetup();
    app.log.info(
      {
        userId: 'usr_123',
        organizationId: 'org_456',
        bucket: 'login_per_ip',
        authorization: 'Bearer should-vanish',
      },
      'diagnostics stay useful',
    );
    const output = all();
    expect(output).toContain('usr_123');
    expect(output).toContain('org_456');
    expect(output).toContain('login_per_ip');
    expect(output).toContain('diagnostics stay useful');
    expect(output).not.toContain('should-vanish');
    await app.close();
  });

  it('never logs the Authorization value for a real Bearer-authenticated 404 request', async () => {
    const { app, all } = captureSetup();
    await app.ready();
    await app.inject({
      method: 'GET',
      url: '/v1/does-not-exist',
      headers: { authorization: 'Bearer real-request-access-token' },
    });
    expect(all()).not.toContain('real-request-access-token');
    await app.close();
  });
});
