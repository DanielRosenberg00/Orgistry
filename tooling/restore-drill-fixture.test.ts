import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  hashApiKeySecret,
  parseApiKey,
} from '../apps/api/src/modules/api-keys/api-key-secret';

/**
 * Drift guard for the restore drill's fixture identity (Sprint 25, ORG-PR-005).
 *
 * The drill seeds an API key into a throwaway database and then reads restored
 * data back through the REAL API-key-authenticated endpoint. That works only
 * while two things hold, and a bash script can prove neither:
 *
 *  1. the product hashes an API-key secret as plain SHA-256 hex — which is what
 *     the drill's `sha256_hex` shell helper computes when it derives the
 *     fixture's `api_keys.secret_hash`;
 *  2. the fixture's raw key is well-formed for the product's parser.
 *
 * If either changes, the drill would fail inside a container with an
 * unreadable error. It fails here instead, with the actual cause.
 */

const FIXTURE_PATH = fileURLToPath(
  new URL('./lib/restore-drill-fixture.sh', import.meta.url),
);
const SEED_SQL_PATH = fileURLToPath(
  new URL('./fixtures/restore-drill-seed.sql', import.meta.url),
);

const fixtureSource = readFileSync(FIXTURE_PATH, 'utf8');
const seedSql = readFileSync(SEED_SQL_PATH, 'utf8');

/** Read a single-quoted shell assignment (`NAME='value'`) from the fixture. */
function shellValue(name: string): string {
  const match = fixtureSource.match(new RegExp(`^${name}='([^']*)'$`, 'm'));
  expect(match, `${name} is not defined in restore-drill-fixture.sh`).not.toBeNull();
  return match![1] as string;
}

describe('restore drill API-key fixture', () => {
  const displayPrefix = shellValue('DRILL_API_KEY_DISPLAY_PREFIX');
  const secret = shellValue('DRILL_API_KEY_SECRET');

  it('is hashed by the product as plain SHA-256 hex, matching the drill shell helper', () => {
    // `sha256_hex` in tooling/lib/pg-tools.sh computes exactly this. If the
    // product ever salts, peppers, or changes algorithm, the drill's derived
    // hash would stop matching any key the API can authenticate.
    const shellEquivalent = createHash('sha256').update(secret).digest('hex');

    expect(hashApiKeySecret(secret)).toBe(shellEquivalent);
    expect(shellEquivalent).toMatch(/^[0-9a-f]{64}$/);
  });

  it('composes a raw key the product can parse back', () => {
    const parsed = parseApiKey(`${displayPrefix}_${secret}`);

    expect(parsed).not.toBeNull();
    expect(parsed?.displayPrefix).toBe(displayPrefix);
    expect(parsed?.secretComponent).toBe(secret);
  });

  it('is an obviously fake, non-production credential', () => {
    expect(secret).toContain('not-a-real-credential');
  });

  it('commits no hash literal', () => {
    // A committed 64-hex constant is indistinguishable from a real credential
    // to a secret scanner, and can drift from the secret it belongs to. The
    // drill derives it at run time instead.
    expect(fixtureSource).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('restore drill seed SQL', () => {
  it('takes its identity values as parameters, never as literals', () => {
    // The fixture shell file is the single source of truth; a literal here
    // would let the two drift apart silently.
    for (const literal of [
      shellValue('DRILL_ORG_ID'),
      shellValue('DRILL_OWNER_USER_ID'),
      shellValue('DRILL_API_KEY_DISPLAY_PREFIX'),
    ]) {
      expect(seedSql).not.toContain(literal);
    }
    for (const variable of [
      ":'api_key_secret_hash'",
      ":'api_key_display_prefix'",
      ":'org_id'",
      ":'owner_user_id'",
    ]) {
      expect(seedSql).toContain(variable);
    }
  });

  it('seeds every entity class the restore assertions check', () => {
    for (const table of [
      'users',
      'organizations',
      'memberships',
      'organization_plans',
      'projects',
      'api_keys',
      'invitations',
      'security_events',
      'app_meta',
    ]) {
      expect(seedSql).toContain(`INSERT INTO ${table}`);
    }
  });

  it('never seeds a raw secret — only hashes', () => {
    expect(seedSql).not.toContain(shellValue('DRILL_API_KEY_SECRET'));
  });
});
