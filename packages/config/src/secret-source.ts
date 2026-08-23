import { readFileSync, statSync } from 'node:fs';

/**
 * Runtime secret source resolution (Sprint 24, ORG-PR-006).
 *
 * Orgistry reads every secret from the RUNTIME environment at process start.
 * This module adds one narrow, optional second source for the same values —
 * a mounted secret FILE — so a deployment can hand the process a file path
 * instead of an environment value:
 *
 *     JWT_SECRET=<value>            # direct environment value
 *     JWT_SECRET_FILE=/run/secrets/jwt_secret   # mounted secret file
 *
 * The resolver runs BEFORE `envSchema` parses anything, and it writes the
 * resolved value to the variable's CANONICAL name. Everything downstream —
 * the typed schema, the mailer completeness rules, and the production safety
 * guard — therefore sees exactly one value per variable and cannot tell (or
 * care) which source it came from. A file-backed secret can never bypass a
 * production guard.
 *
 * Deliberately NOT here: secret managers, hot reload, file watching,
 * directory scanning, and any generic secret framework. Replacing a mounted
 * secret requires a process restart, exactly like replacing an environment
 * value.
 */

/** Suffix that names the mounted-file variant of a supported secret. */
export const SECRET_FILE_SUFFIX = '_FILE';

/**
 * The variables that additionally accept a `<NAME>_FILE` mounted-secret path.
 *
 * The list is deliberately closed and small: it covers exactly the values a
 * deployment injects as secret material (signing secrets, provider
 * credentials, and the two connection URLs that embed credentials). Any other
 * `*_FILE` environment variable is none of this module's business and is
 * ignored — unrelated tooling (`SSL_CERT_FILE`, for example) must keep
 * working. Extending this list is the only supported way to add file support.
 */
export const FILE_BACKED_SECRET_NAMES = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_PREVIOUS_SECRET',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
] as const;

export type FileBackedSecretName = (typeof FILE_BACKED_SECRET_NAMES)[number];

/**
 * Reads one secret file and returns its raw contents. Injected so tests can
 * exercise resolution without touching the filesystem; production uses
 * {@link readSecretFileFromDisk}.
 *
 * Implementations MUST throw {@link SecretFileError} with a sanitized,
 * value-free message for anything unreadable.
 */
export type SecretFileReader = (filePath: string) => string;

/**
 * Raised by a {@link SecretFileReader} for an unusable path. The message
 * describes the FAILURE CATEGORY only — it never contains file contents, and
 * callers never append them.
 */
export class SecretFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretFileError';
  }
}

/**
 * Read exactly the configured path — no directory scanning, no globbing, no
 * fallback candidates. Directories and non-regular files are rejected rather
 * than read, and the underlying `fs` error is never propagated: its message
 * is replaced with a fixed category string so nothing about the file's
 * contents can reach a log line.
 */
export function readSecretFileFromDisk(filePath: string): string {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw new SecretFileError(
      'does not exist or is not accessible to this process',
    );
  }
  if (stats.isDirectory()) {
    throw new SecretFileError('is a directory, not a file');
  }
  if (!stats.isFile()) {
    throw new SecretFileError('is not a regular file');
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new SecretFileError('could not be read (permission denied or I/O error)');
  }
}

/**
 * Strip AT MOST the one terminal line ending that secret-file writers (shells,
 * `openssl`, orchestrator secret mounts) conventionally append. Everything
 * else is preserved verbatim: leading whitespace, interior newlines, and
 * trailing spaces are all legitimate parts of a provider-issued credential.
 */
function stripOneTrailingLineEnding(contents: string): string {
  if (contents.endsWith('\r\n')) {
    return contents.slice(0, -2);
  }
  if (contents.endsWith('\n')) {
    return contents.slice(0, -1);
  }
  return contents;
}

/**
 * A variable counts as CONFIGURED only when it is present and not blank.
 * Compose files, shell wrappers, and CI matrices routinely define a variable
 * as the empty string to mean "unset"; treating that as configured would turn
 * an omission into an ambiguity error or an empty secret.
 */
function isConfigured(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export interface SecretResolution {
  /**
   * The environment record with every file-backed secret written to its
   * canonical name. Returned even when `issues` is non-empty (callers must
   * check `issues` first); an ambiguous variable is removed rather than
   * guessed.
   */
  readonly env: Record<string, string | undefined>;
  /**
   * One `FIELD: message` line per misconfiguration, matching the format
   * `ConfigValidationError` already uses for schema issues.
   */
  readonly issues: string[];
}

/**
 * Resolve the file-backed secrets in `source` and return a new environment
 * record. The source record is never mutated.
 *
 * Semantics per supported name — deterministic, and identical for every
 * variable in {@link FILE_BACKED_SECRET_NAMES}:
 *
 * | `NAME`   | `NAME_FILE` | Result |
 * |----------|-------------|--------|
 * | set      | unset       | the direct value is used verbatim |
 * | unset    | set         | the file is read; one terminal line ending is stripped |
 * | set      | set         | **rejected** — the intended source is ambiguous |
 * | unset    | unset       | left absent; the schema decides required vs optional |
 *
 * The both-set case fails CLOSED rather than picking a precedence: a
 * deployment that supplies two sources has a real configuration bug (a stale
 * environment value shadowing a rotated file mount, or the reverse), and
 * silently preferring one would hide it until the wrong secret was already in
 * use.
 */
export function resolveSecretSources(
  source: Record<string, string | undefined>,
  readSecretFile: SecretFileReader = readSecretFileFromDisk,
): SecretResolution {
  const env: Record<string, string | undefined> = { ...source };
  const issues: string[] = [];

  for (const name of FILE_BACKED_SECRET_NAMES) {
    const fileVariable = `${name}${SECRET_FILE_SUFFIX}`;
    const directValue = source[name];
    const filePath = source[fileVariable];

    if (!isConfigured(filePath)) {
      continue;
    }
    if (isConfigured(directValue)) {
      // Fail closed and drop both, so no later stage can read a value whose
      // origin we could not determine.
      delete env[name];
      issues.push(
        `${name}: both ${name} and ${fileVariable} are set; supply exactly one source (unset whichever is stale)`,
      );
      continue;
    }

    let contents: string;
    try {
      contents = readSecretFile(filePath);
    } catch (error) {
      delete env[name];
      const reason =
        error instanceof SecretFileError
          ? error.message
          : 'could not be read';
      // The PATH is non-secret configuration and naming it is what makes the
      // failure fixable; the CONTENTS never appear here.
      issues.push(`${fileVariable}: the secret file "${filePath}" ${reason}`);
      continue;
    }

    const resolved = stripOneTrailingLineEnding(contents);
    if (resolved.length === 0) {
      delete env[name];
      issues.push(
        `${fileVariable}: the secret file "${filePath}" is empty; it must contain the secret value`,
      );
      continue;
    }
    env[name] = resolved;
  }

  return { env, issues };
}
