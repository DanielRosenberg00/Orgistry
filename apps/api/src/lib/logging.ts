import type { Config } from '@orgistry/config';
import type { FastifyServerOptions } from 'fastify';

/**
 * Centralized structured-logger configuration (Sprint 19, ORG-PR-033).
 *
 * Every process logger is built here so the pino redaction backstop cannot be
 * forgotten at a call site. Redaction is a BACKSTOP, not a license: modules
 * must still never log request bodies, credentials, or token material — the
 * paths below exist to catch the accidental `log.info({ headers })` or an
 * error context that drags a config object along, not to make sensitive
 * logging acceptable.
 *
 * Pino redaction is path-based (it never scans/serializes log strings after
 * the fact): each sensitive KEY is expanded across the object shapes that
 * realistically reach a log line — top-level, one level nested (`*.key`),
 * request/response header serializers, and explicitly logged body/config
 * containers. Case variants are listed explicitly because pino paths are
 * case-sensitive. The censor replaces values with `[REDACTED]`, preserving
 * the surrounding structure so diagnostic fields stay usable.
 */

/**
 * Sensitive keys, in the exact case variants that occur in this codebase:
 * HTTP header names (lowercased by Node), camelCase DTO/config fields, and
 * UPPER_SNAKE environment names. Extend this list when a new secret-bearing
 * field is introduced — and keep `docs/security-model.md` in sync.
 */
const SENSITIVE_KEYS: readonly string[] = [
  // Credential-bearing headers (Node lowercases inbound header names).
  'authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  // Password fields.
  'password',
  'currentPassword',
  'newPassword',
  // Token fields (raw values and stored hashes alike).
  'token',
  'refreshToken',
  'invitationToken',
  'tokenHash',
  'passwordHash',
  // API keys.
  'apiKey',
  'apiKeySecret',
  // Generic secrets and configuration/environment shapes.
  'secret',
  'jwtSecret',
  'smtpPassword',
  'SMTP_PASSWORD',
  'JWT_SECRET',
];

/** Containers whose nested fields are plausibly logged with sensitive keys. */
const NESTED_CONTAINERS: readonly string[] = [
  'req.headers',
  'res.headers',
  'request.headers',
  'reply.headers',
  'headers',
  '*.headers',
  'body',
  '*.body',
  'config',
  'err',
  'error',
];

/** Quote keys that are not valid identifiers (header names with `-`). */
function pathSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `["${key}"]`;
}

/**
 * Expand every sensitive key across the shapes it can appear in. The
 * configured CSRF header name is included dynamically so a renamed header
 * stays covered without code changes.
 */
export function buildRedactionPaths(csrfHeaderName: string): string[] {
  const keys = new Set<string>(SENSITIVE_KEYS);
  keys.add(csrfHeaderName.toLowerCase());

  const paths = new Set<string>();
  for (const key of keys) {
    const segment = pathSegment(key);
    const dotted = segment.startsWith('[') ? segment : `.${segment}`;
    paths.add(segment);
    paths.add(`*${dotted}`);
    for (const container of NESTED_CONTAINERS) {
      paths.add(`${container}${dotted}`);
    }
  }
  return [...paths];
}

/**
 * Build the Fastify logger options for this process: configured level plus
 * the centralized redaction backstop. `destination` lets tests capture the
 * emitted lines through an in-memory stream.
 */
export function buildLoggerOptions(
  config: Pick<Config, 'logLevel'> & {
    auth: Pick<Config['auth'], 'csrfHeaderName'>;
  },
  destination?: { write: (chunk: string) => void },
): FastifyServerOptions['logger'] {
  const options = {
    level: config.logLevel,
    redact: {
      paths: buildRedactionPaths(config.auth.csrfHeaderName),
      censor: '[REDACTED]',
    },
  };
  return destination
    ? { ...options, stream: destination }
    : options;
}
