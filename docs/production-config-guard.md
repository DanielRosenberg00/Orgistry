# Production Configuration Guard

Sprint 15 implementation reference for the production configuration safety
guard (closes [ORG-PR-003](production-readiness/findings-register.md#org-pr-003))
and the removal of the dead `COOKIE_SECRET` variable (closes
[ORG-PR-047](production-readiness/findings-register.md#org-pr-047)). Audience:
engineers who did not write the implementation.

> **Scope honesty:** this guard rejects *known-bad and obviously weak* values.
> It does not prove real entropy, it is not secrets management, and it does not
> implement rotation (those remain open as
> [ORG-PR-006](production-readiness/findings-register.md#org-pr-006)). The
> project remains **not ready for staging or production** — see
> [known-limitations.md](known-limitations.md) and the
> [production-readiness audit](production-readiness/README.md).

## What was implemented

Under `NODE_ENV=production`, configuration loading now **fails closed** (throws
`ConfigValidationError`, so the process never boots) when any of the following
holds:

- `JWT_SECRET` is one of the known development-only secrets shipped in this
  repository (`.env.example`, test fixtures, CI values);
- `JWT_SECRET` is shorter than 32 UTF-8 characters;
- `JWT_SECRET` contains an obvious placeholder marker (`change-me`,
  `changeme`, `dev-only`, `replace-me`, `placeholder`, `example-secret`,
  `default-secret` — matched case-insensitively);
- `JWT_SECRET` is a single repeated character (e.g. `aaaa…`);
- `JWT_PREVIOUS_SECRET` (Sprint 24, optional) fails any of the same four rules
  — a retiring key still verifies live tokens, so a weak one is exactly as
  forgeable as a weak current key;
- `COOKIE_SECURE` is `false` (explicitly or by default).

Sprint 24 also added one rule that applies in **every** mode
(`packages/config/src/auth-policy.ts`): `JWT_PREVIOUS_SECRET` must not equal
`JWT_SECRET`. An equal pair is a rotation that never happened, and accepting it
would let an operator believe a cutover window is open when it is not.

Sprint 16 extended the same guard with the account-mailer rules (see
[email-and-verification.md](email-and-verification.md)); in production it
additionally refuses:

- `MAIL_DRIVER` other than `smtp` (the `mailpit` and `memory` drivers are
  local/test sinks; rejecting the *default* too means production can never
  silently fall back to Mailpit);
- `SMTP_PASSWORD` values that are known repository defaults, placeholder-like,
  or degenerate (**no length floor** here — provider-issued credential lengths
  are not ours to dictate; the placeholder/known-default checks still apply);
- `MAIL_FROM_EMAIL` set to a shipped local-only default or any reserved,
  non-routable domain (`.local`, `.test`, `.invalid`, `.example`,
  `example.com/org/net`);
- `WEB_DEMO_URL` that is not HTTPS or points at localhost (emailed
  verification/invitation links embed this origin).

Missing SMTP credentials are refused in **every** mode once `MAIL_DRIVER=smtp`
is selected (`packages/config/src/mail-policy.ts`) — choosing the production
driver without credentials is a configuration error in development too.

Development and test modes are otherwise unaffected: the pre-existing baseline
(`min(16)` secrets, `COOKIE_SECURE=false` allowed, Mailpit driver with no
credentials) still applies, so `cp .env.example .env` keeps working locally.

## Where the guard lives and when it executes

| Piece | Location |
| --- | --- |
| Policy (constants + helpers) | `packages/config/src/production-policy.ts` |
| Driver-conditional mailer completeness | `packages/config/src/mail-policy.ts` |
| Access-token key rotation rules (all modes) | `packages/config/src/auth-policy.ts` |
| Runtime secret source resolution (Sprint 24) | `packages/config/src/secret-source.ts` |
| Schema wiring (`superRefine`) | `packages/config/src/schema.ts` — `envSchema` |
| Loading boundary | `packages/config/src/index.ts` — `loadConfig` / `getConfig` |
| Tests | `packages/config/src/config.test.ts` — `production configuration guard`, `mailer configuration`, `production mailer guard`, and `access-token secret rotation config` suites; `packages/config/src/secret-source.test.ts` |

The guard is a Zod `superRefine` on `envSchema` itself, not a separate
validation pass. `loadConfig` has exactly one parse call
(`envSchema.safeParse`), so **every** consumer gets the guard with no opt-out
and there is no second config authority to drift.

**Sprint 24 ordering invariant.** `loadConfig` now runs one stage *before* the
parse: `resolveSecretSources` reads any `<NAME>_FILE` mounted secret and writes
the value to its **canonical** variable name. The parse — and therefore this
guard — then sees exactly one value per variable and cannot tell which source
it came from, so **a file-backed secret can never bypass a production guard**.
Ambiguous (`NAME` and `NAME_FILE` both set), empty, and unreadable secret files
fail at that stage through the same `ConfigValidationError`. Full contract:
[runtime-secrets.md](runtime-secrets.md#validation-ordering-security-invariant).

## Why unsafe config prevents API boot

`apps/api/src/server.ts` (`main`) calls `getConfig()` as its first act after
loading `.env` — before creating the database client, Redis client, any
service, and before `app.listen`. `getConfig` → `loadConfig` → `envSchema`
(including the guard) → throws `ConfigValidationError` on violation → `main`
rejects → the process exits non-zero having never bound a port. This is
structural: no listener or runtime service can exist without a validated
`Config`, because `buildApp` takes the validated `Config` object as a required
input. No separate bootstrap assertion is needed; the test suite exercises the
same `loadConfig` boundary the server uses.

## Design rationale

- **Centralized in `packages/config`:** the config package is the single
  source of truth for every environment variable (its schema doc says so, and
  `apps/api` consumes only the validated `Config`). Putting production policy
  anywhere else (e.g. an API-side check) would create a second authority that
  future entry points (workers, schedulers) could miss.
- **Fail closed, no warnings, no coercion:** a logged warning is invisible in
  a non-interactive deploy; silently coercing `COOKIE_SECURE` to `true` would
  hide an operator error and could mask a deeper misconfiguration (e.g. no TLS
  in front at all). Refusing to boot forces the environment to be corrected.
- **Intentionally simple policy:** exact known-value rejection + a length
  floor + placeholder/degenerate detection is deterministic, auditable, and
  reproducible. An **entropy estimator was rejected** because probabilistic
  strength scoring produces unexplainable, environment-dependent failures and
  false confidence — a 32+ byte random secret passes trivially; anything an
  estimator would catch beyond this policy is speculative.
- **Known defaults are rejected exactly, not just by length**, so a future
  edit that lengthens a placeholder cannot sneak it past the floor.

## Contracts and invariants (stable guarantees)

Future infrastructure work (Sprint 21+, ORG-PR-006 secrets management) builds
**on top of** these and must not weaken them:

1. `NODE_ENV=production` requires `COOKIE_SECURE=true`.
2. Known local-development secrets are invalid in production.
3. Production secrets must satisfy the documented quality floor (≥ 32 chars,
   no placeholder markers, not degenerate).
4. Unsafe config fails at load time — before the API can boot.
5. Development/test defaults are never production credentials.
6. Every required config field corresponds to real runtime behavior (this is
   why `COOKIE_SECRET` was removed rather than kept "just in case").

## Extending the policy safely

- **New known dev default?** Add the exact string to
  `KNOWN_DEVELOPMENT_SECRETS` in `production-policy.ts` and keep it in sync
  with `.env.example` / fixtures / CI (the list documents its sync points).
- **New production secret field?** Call
  `collectProductionSecretIssues('FIELD_NAME', value)` for it inside
  `enforceProductionConfigSafety` — do not write a parallel rule set.
- **Error-message rule:** messages must name the field and say how to fix it
  (generate ≥ 32 random bytes, hex-encoded: `openssl rand -hex 32`) but must
  **never echo the secret value**.
- Add a test per new rule in the `production configuration guard` suite.

## How tests isolate environment state

Config tests never read or mutate `process.env`: each case builds an explicit
env record and passes it to `loadConfig(source)` (which is pure with respect
to its input). There is no module-cache juggling and no cleanup hooks, so
cases cannot leak state and the suite is order-independent. The API's
injection tests use the same mechanism via
`apps/api/src/testing/build-test-app.ts` (`testConfig()` passes an explicit
record).

## `COOKIE_SECRET` removal (ORG-PR-047)

A repository-wide search (all source, tests, config, CI, docs) proved
`COOKIE_SECRET` had **no runtime consumer**: it was validated and copied into
`Config.auth.cookieSecret`, but the refresh cookie is written **unsigned** by
`apps/api/src/lib/cookies.ts` (`serializeCookie`, plain `name=value`), and
nothing signs or verifies any cookie. Requiring the secret implied
tamper-evidence that did not exist. Resolution: the variable, its schema
field, its `Config` property, its fixtures, and its documentation references
were removed. Signed-cookie behavior was deliberately **not** introduced just
to justify keeping the variable — the refresh cookie's integrity model relies
on the token itself being a hashed, rotated, high-entropy credential (see
[session-lifecycle.md](session-lifecycle.md)). A stale `COOKIE_SECRET` in an
operator's `.env` is now silently ignored (unknown keys are stripped).

## Integration notes

- **How the API consumes config:** `apps/api/src/server.ts` calls
  `getConfig()` once and passes the frozen `Config` into `buildApp` and every
  service factory. Refresh-cookie flags (`Secure`, name, path, Max-Age) derive
  from `config.auth.refreshCookie`, which is built from the validated env —
  so in production the cookie is provably `Secure`.
- **Sprint 21 (infrastructure)** must provision real values that pass this
  guard: a generated `JWT_SECRET` (≥ 32 random bytes) and
  `COOKIE_SECURE=true`. The guard is the contract that deployment tooling
  must satisfy; it is not replaced by it.
- **ORG-PR-006 (secrets manager + rotation)** remains open. Sprint 24 delivered
  the runtime *source* half (direct env or mounted `_FILE`, resolved before
  validation) and graceful access-token key rotation
  ([runtime-secrets.md](runtime-secrets.md),
  [rotation-runbook.md](rotation-runbook.md)); there is still no secrets
  manager, no automated rotation, and no hot reload. Whatever supplies the
  values must still pass this guard. Rejecting weak secrets here is not secrets
  management.
