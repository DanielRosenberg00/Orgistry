/**
 * Demo-seed target guard (Sprint 22, ORG-PR-056).
 *
 * `demo-seed.mjs` seeds an account whose password is published in the repo and
 * prints a one-time API key secret to the terminal. That print is the delivery
 * channel for the credential — the demo is useless without it — so it cannot be
 * removed. What can be removed is the ability to point the tool somewhere it
 * does not belong: this guard refuses any target that is not a loopback host,
 * before the first request is made, so a misdirected run creates no account and
 * emits no secret.
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
        'It seeds a published demo password and prints a one-time API key secret, ' +
        'so it is safe only against a throwaway local stack.',
    );
  }
}
