/**
 * Demo-seed target guard (Sprint 22, ORG-PR-056).
 *
 * `demo-seed.mjs` registers an account whose password is published in this
 * repository and then MUTATES state through it — creating an organization,
 * changing its plan, creating projects, and sending a real invitation email.
 * None of that belongs anywhere but a throwaway local stack, so this guard
 * refuses any target that is not a loopback host, before the first request is
 * made. A misdirected run creates nothing.
 *
 * Note what this guard is NOT doing any more: the bootstrap no longer creates
 * an API key and prints no credential on any stream, so the guard is no longer
 * standing between a secret and a terminal. It protects against seeding
 * published demo credentials into a shared environment and against writing
 * demo data somewhere real — which is why it survives the removal of the
 * secret print rather than becoming redundant.
 *
 * Extracted from the CLI so the rule is testable on its own (mirroring
 * `lib/migrations-snapshot.mjs`).
 */

/** Hostnames that unambiguously resolve to this machine. */
export const LOOPBACK_HOSTNAMES = Object.freeze([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

const LOOPBACK_SET = new Set(LOOPBACK_HOSTNAMES);

/**
 * Throw unless `rawUrl` points at a loopback host. `URL.hostname` strips the
 * port and normalizes IPv6 brackets, so `http://127.0.0.1:3000` and
 * `http://[::1]:3000` both pass while `http://127.0.0.1.example.com` — which a
 * naive prefix check would accept — does not.
 */
export function assertLocalTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Demo seed target is not a valid URL: ${rawUrl}`);
  }
  if (!LOOPBACK_SET.has(parsed.hostname)) {
    throw new Error(
      `Demo seed refuses to run against a non-loopback API (${parsed.hostname}). ` +
        'It registers a published demo password and mutates organization, plan, ' +
        'project, and invitation state, so it is safe only against a throwaway ' +
        'local stack.',
    );
  }
}
