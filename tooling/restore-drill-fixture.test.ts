import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseApiKey } from '../apps/api/src/modules/api-keys/api-key-secret';

/**
 * Static guards for the restore drill's fixture identity (Sprint 25,
 * ORG-PR-005).
 *
 * WHERE THE HASH CONTRACT IS ACTUALLY PROVEN — and why it is not proven here.
 *
 * The drill seeds an API key whose `api_keys.secret_hash` is DERIVED at run
 * time by a shell helper (`sha256_hex` in `tooling/lib/pg-tools.sh`), and then
 * reads restored data back through the real API-key-authenticated endpoint.
 * The invariant that matters is therefore:
 *
 *   shell-derived hash  ==  the hash the packaged API computes when it
 *                           authenticates the same raw key
 *
 * That is proven END TO END by `tooling/db-restore-drill.sh --with-artifact`,
 * which runs in the `artifacts` CI job on every push and pull request: the
 * seeded hash must let `GET /v1/external/projects` return the restored
 * projects, and an unknown key must still return 401. If the product ever
 * salted, peppered, or changed algorithm, that request would 401 and the drill
 * would fail.
 *
 * This file deliberately does NOT re-derive the hash in TypeScript. Doing so
 * compared Node's `createHash` against the product's `hashApiKeySecret` —
 * neither of which is the shell helper the drill actually uses — so it proved
 * a weaker property than the drill already proves, while duplicating a
 * cryptographic operation in test code. (CodeQL also read that duplicated
 * fast-hash of a value named `secret` as `js/insufficient-password-hash`; the
 * fix was to delete the redundant operation, not to change the API-key hashing
 * contract, which is deliberately SHA-256 over 256 bits of CSPRNG output —
 * see `apps/api/src/modules/api-keys/api-key-secret.ts` and
 * `packages/auth-core/src/hashing-invariants.test.ts`.)
 *
 * What remains here are the properties a running drill cannot check: that the
 * fixture is well-formed for the product's parser, that it is obviously fake,
 * and that no 64-hex hash literal is ever committed back into the tooling.
 */

const FIXTURE_PATH = fileURLToPath(
  new URL('./lib/restore-drill-fixture.sh', import.meta.url),
);
const DRILL_PATH = fileURLToPath(
  new URL('./db-restore-drill.sh', import.meta.url),
);
const SEED_SQL_PATH = fileURLToPath(
  new URL('./fixtures/restore-drill-seed.sql', import.meta.url),
);

const fixtureSource = readFileSync(FIXTURE_PATH, 'utf8');
const drillSource = readFileSync(DRILL_PATH, 'utf8');
const seedSql = readFileSync(SEED_SQL_PATH, 'utf8');

/**
 * Strip pinned container-image digests before scanning for hash literals.
 * `@sha256:<64 hex>` is a required, non-secret construct under the image
 * pinning policy (ORG-PR-042) and is the only legitimate 64-hex string in this
 * tooling.
 */
function withoutImageDigests(source: string): string {
  return source.replace(/@sha256:[0-9a-f]{64}/g, '@sha256:<digest>');
}

/** Read a single-quoted shell assignment (`NAME='value'`) from the fixture. */
function shellValue(name: string): string {
  const match = fixtureSource.match(new RegExp(`^${name}='([^']*)'$`, 'm'));
  expect(match, `${name} is not defined in restore-drill-fixture.sh`).not.toBeNull();
  return match![1] as string;
}

describe('restore drill API-key fixture', () => {
  const displayPrefix = shellValue('DRILL_API_KEY_DISPLAY_PREFIX');
  const secretComponent = shellValue('DRILL_API_KEY_SECRET');

  it('composes a raw key the product can parse back', () => {
    // The one product-side property a drill failure could not explain: if the
    // key format changed, the drill would 401 with no indication why.
    const parsed = parseApiKey(`${displayPrefix}_${secretComponent}`);

    expect(parsed).not.toBeNull();
    expect(parsed?.displayPrefix).toBe(displayPrefix);
    expect(parsed?.secretComponent).toBe(secretComponent);
  });

  it('is an obviously fake, non-production credential', () => {
    expect(secretComponent).toContain('not-a-real-credential');
  });

  it('commits no hash literal, in the fixture or in the drill', () => {
    // A committed 64-hex constant is indistinguishable from a real credential
    // to a secret scanner, and can drift from the secret it belongs to. Both
    // files are checked: the fixture holds the identity, and the drill is
    // where the hash is derived — a literal could regress into either.
    // Pinned image digests are excluded; they are the one legitimate 64-hex
    // string here.
    expect(withoutImageDigests(fixtureSource)).not.toMatch(/[0-9a-f]{64}/);
    expect(withoutImageDigests(drillSource)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('derives the seeded hash at run time rather than carrying one', () => {
    expect(drillSource).toContain('DRILL_API_KEY_SECRET_HASH="$(sha256_hex ');
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
