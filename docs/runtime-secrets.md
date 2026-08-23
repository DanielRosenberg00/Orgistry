# Runtime Secrets

Sprint 24 design reference: where Orgistry's secrets come from at runtime, how
they are validated, and what is guaranteed about them. Operator procedures
(rotation, incident response, provider setup) live in
[rotation-runbook.md](rotation-runbook.md). Finding status: ORG-PR-006
(secrets management/rotation) and ORG-PR-002 (external email) in the
[findings register](production-readiness/findings-register.md).

**Scope boundary.** This is a runtime *source and validation* boundary, not a
secrets manager. There is no vault integration, no dynamic credential issuance,
no automatic rotation, and no hot reload. Those remain open under ORG-PR-006.

## Sources

Every secret is read once, at process start, from one of exactly two sources:

| Source | Form | Notes |
|---|---|---|
| Direct environment value | `JWT_SECRET=<value>` | The original and default form. Unchanged since Sprint 1. |
| Mounted secret file | `JWT_SECRET_FILE=/run/secrets/jwt_secret` | Sprint 24. The process reads the configured path itself. |

No secret is read at image-build time, copied into an image layer, or embedded
in the frontend bundle — the artifact smoke test asserts all three
([deployment-artifacts.md](deployment-artifacts.md)).

Six variables accept the `_FILE` form. The list is closed and lives in
`packages/config/src/secret-source.ts`:

```
DATABASE_URL   REDIS_URL   JWT_SECRET   JWT_PREVIOUS_SECRET
SMTP_USERNAME  SMTP_PASSWORD
```

Any other `*_FILE` environment variable is ignored by this resolver (unrelated
tooling such as `SSL_CERT_FILE` must keep working). Adding a variable to the
list is the only supported way to give it file support.

### Direct value vs file value

| `NAME` | `NAME_FILE` | Result |
|---|---|---|
| set | unset | the direct value is used verbatim |
| unset | set | the file is read; **one** terminal line ending is stripped |
| set | set | **rejected** — the intended source is ambiguous |
| unset | unset | left absent; the schema decides required vs optional |

A variable counts as *set* only when it is present and non-blank. Compose
files, shell wrappers, and CI matrices routinely define a variable as the empty
string to mean "unset"; treating that as configured would turn an omission into
an ambiguity error.

**Why both-set fails closed rather than picking a precedence.** A deployment
that supplies two sources has a real bug — most often a stale environment value
shadowing a rotated file mount, or the reverse. Silently preferring one hides
that until the wrong secret is already signing tokens. The failure is a boot
refusal naming both variables.

### Secret file handling

- Exactly the configured path is read. No directory scanning, no globbing, no
  fallback candidates.
- A directory, a non-regular file, a missing path, or an unreadable file is
  rejected with a sanitized message.
- An empty file (after the line-ending strip) is rejected for a required
  secret.
- Exactly one terminal `\n` or `\r\n` is removed. Leading whitespace, interior
  newlines, and trailing spaces are preserved — they can be legitimate parts of
  a provider-issued credential.
- File contents never appear in an error, an exception, or a log line.
- The **path** is non-secret configuration and *is* named in the failure
  message and left unredacted in logs: an operator debugging a failed mount
  needs to see which path was attempted.
- There is no file watcher and no hot reload. Replacing a mounted secret
  requires a process restart, exactly like replacing an environment value.

## Validation ordering (security invariant)

```
runtime source (env or file)
  -> resolveSecretSources()      packages/config/src/secret-source.ts
  -> envSchema.safeParse()       packages/config/src/schema.ts
       -> enforceJwtRotationConfig      auth-policy.ts
       -> enforceMailerConfigCompleteness  mail-policy.ts
       -> enforceProductionConfigSafety    production-policy.ts
  -> toConfig() -> typed Config consumed by the application
```

Resolution writes the resolved value to the variable's **canonical name**, so
everything downstream sees exactly one value per variable and cannot tell which
source it came from. **A file-backed secret therefore receives byte-identical
validation to a direct environment value and can never bypass a production
guard.** Test evidence: `packages/config/src/secret-source.test.ts` — a
file-loaded `JWT_SECRET` of `dev-only-jwt-secret-change-me` produces exactly the
same production rejections as the direct value, and a file-loaded placeholder
`SMTP_PASSWORD` is rejected identically.

Both stages report through the same mechanism: `loadConfig` throws
`ConfigValidationError` listing every issue. Resolution issues are reported
first and stop the load — parsing a record whose secret origins are unresolved
would only add misleading "required" issues on top of the real cause.

## Secret inventory

Every runtime-sensitive value the implementation actually reads. Nothing here
is aspirational, and no secret is listed that the code does not use.

### Secret material

**Secret** = must never be logged, committed, or displayed. **Overlap** = must
the previous value stay valid while instances restart? **Invalidates
tokens/sessions?** = does changing it log users out?

| Variable | Purpose | Required | Dev vs production | `_FILE` | Rotation frequency | Overlap required | Invalidates tokens/sessions? | Rotation impact |
|---|---|---|---|---|---|---|---|---|
| `JWT_SECRET` | Current HS256 access-token signing key | Always | Both; production adds the 32-char floor and the known-default/placeholder/degenerate rejections | Yes | Annual, or immediately on suspicion of compromise | Optional — supplied by `JWT_PREVIOUS_SECRET`; this is the dual-**verification** path | Access tokens only, and only without the previous key. **Never** sessions or refresh cookies | With the previous key: none. Without it, every access token issued before the restart fails until the client refreshes — `POST /v1/auth/refresh` reads only the refresh cookie and does not depend on this key, so a client that handles 401-then-refresh recovers on its own; one that does not sees 401s for up to `AUTH_ACCESS_TOKEN_TTL_SECONDS` (default 15 min) |
| `JWT_PREVIOUS_SECRET` | Retiring signing key, accepted at **verification only** — never signs | No; set only during a rotation window | Both; same production strength rules as the current key; must differ from it in every mode | Yes | Set and removed by each rotation | It **is** the overlap mechanism | Removing it invalidates tokens signed with the old key immediately (the emergency path) | None while set; removal ends the window |
| `SMTP_PASSWORD` | Provider SMTP credential | When `MAIL_DRIVER=smtp` (every mode) | Production additionally rejects placeholder/known-development values; **no length floor** — provider credential lengths are not ours to dictate | Yes | Per provider policy; immediately on compromise | Yes — keep the old credential valid at the provider until every process restarts | No | Account email fails while the value is wrong. No user session impact |
| `SMTP_USERNAME` | Provider SMTP identity (credential half) | When `MAIL_DRIVER=smtp` | Same as above | Yes | With the password | Yes | No | As above |
| `DATABASE_URL` | PostgreSQL connection string — embeds credentials | Always | Both | Yes | Per database policy | **Yes** — no dual-credential support; create the new role/password alongside the old and revoke the old only after every process is on it | No | Restart required per instance; `/ready` reports the outcome |
| `REDIS_URL` | Redis connection string — may embed credentials | No (defaults to `redis://localhost:6379`, which is wrong inside a container) | Both | Yes | Per store policy | Yes, same as the database | No | Fixed-window rate-limit counters reset (they are ephemeral by design) and `/ready` fails during the gap; sensitive limiters fail **closed** in production meanwhile |

### Non-secret runtime configuration with a security effect

Not secret, but a wrong value is a security or deliverability incident. None
accepts a `_FILE` form; none has rotation semantics beyond "change it and
restart".

| Variable | Purpose | Required | Production rule | Change impact |
|---|---|---|---|---|
| `MAIL_DRIVER` | Driver selection (`mailpit` \| `smtp` \| `memory`) | Defaulted (`mailpit`) | Must be `smtp`; the default is rejected too, so production can never silently fall back to a dev sink | Switching away from `smtp` in production refuses to boot |
| `SMTP_HOST` / `SMTP_PORT` | Provider endpoint; port 465 = implicit TLS (no STARTTLS upgrade offered) | Host required when `MAIL_DRIVER=smtp`; port defaults to 465 | — | Mail fails closed while wrong |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Sender identity on every account email | Defaulted to a local-only address | The shipped default and every reserved/non-routable domain suffix are rejected | Deliverability depends on the sender domain's SPF/DKIM/DMARC — see [rotation-runbook.md](rotation-runbook.md#sender-domain-spf-dkim-dmarc) |
| `COOKIE_SECURE` | Refresh-cookie `Secure` attribute | Defaulted `false` | Must be `true`, including behind a TLS-terminating proxy | Refresh cookies stop being sent over plain HTTP |
| `AUTH_REFRESH_COOKIE_NAME` / `AUTH_REFRESH_COOKIE_PATH` | Refresh-cookie identity and path scope (always `HttpOnly` + `SameSite=Lax`) | Defaulted | — | Changing either orphans existing refresh cookies: users re-authenticate once |
| `AUTH_CSRF_HEADER_NAME` | Custom header required on cookie-backed mutations (refresh, logout) | Defaulted `x-orgistry-csrf` | — | Clients must send the new name or every refresh/logout returns `403 CSRF_REQUIRED`. Also auto-added to the log-redaction paths |
| `WEB_DEMO_URL` | Public origin embedded in every emailed link | Defaulted to localhost | Must be HTTPS and non-localhost | Previously emailed links keep pointing at the old origin until they expire |
| `TRUST_PROXY` | Proxy hop trust for client-IP resolution | Defaulted `false` | `'true'` is rejected outright | A wrong value corrupts every IP-keyed rate limit and every audit/security-event IP |
| `RATE_LIMIT_FAILURE_MODE` | Sensitive-limiter behavior on a limiter-store outage | Optional; derives to `closed` in production, `open` elsewhere | Explicit `open` is rejected | Determines whether a Redis outage degrades to 503 or to unthrottled sensitive endpoints |
| `HSTS_MAX_AGE_SECONDS` | Strict-Transport-Security lifetime | Defaulted (180 days) | Header emitted only under production **and** a proxy-aware https protocol | An over-long value is hard to walk back in browsers that cached it |

### Values that do not exist — and were not invented for this inventory

| Candidate | Reality |
|---|---|
| Cookie signing secret | **None.** `COOKIE_SECRET` was removed in Sprint 15: no code path signs any cookie. A leftover value in an old `.env` is ignored |
| Refresh-token / session signing secret | **None.** Refresh tokens are opaque CSPRNG values, unsigned and unencrypted, persisted only as SHA-256 hashes — see [Refresh and session material](#refresh-and-session-material) |
| API-key hashing secret or pepper | **None.** `hashApiKeySecret` is a plain SHA-256 over an already-high-entropy 32-byte secret component (`api-key-secret.ts`); there is no keyed hash and therefore nothing to rotate |
| Encryption-at-rest key | **None.** Orgistry encrypts no column; at-rest encryption is the operator's storage-layer concern |
| Token-signing key for verification/recovery/invitation links | **None.** Those tokens are opaque and hash-only, exactly like refresh tokens |

### Deployment-only and build-time values

Not application runtime secrets, listed so they are not mistaken for any.

| Value | Nature |
|---|---|
| `VITE_API_BASE_URL`, `VITE_CSRF_HEADER_NAME`, `VITE_MAILPIT_URL` | **Public** frontend configuration, compiled into the browser bundle at web **build** time. Never secret; a server secret must never be passed as a `VITE_*` build arg (the artifact smoke test asserts server secrets are absent from the built assets) |
| `TEST_DATABASE_URL` | Test-only; never set in a deployable environment |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Consumed only by the local compose files to provision the dev container, never by the application |
| `NODE_ENV`, `API_HOST`, `API_PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `MAILPIT_*`, `AUTH_*_TTL_SECONDS`, `RATE_LIMIT_*`, `*_TTL_SECONDS`, `MAIL_TIMEOUT_MS`, `API_KEY_LAST_USED_THROTTLE_SECONDS` | Non-secret runtime tuning; defaults documented in `.env.example` |

### Safe placeholder convention

Fake values used in this repository — `.env.example`,
`infra/compose.production-like.yml`, unit-test fixtures, and
`tooling/artifact-smoke.sh` — follow one convention: they are shaped like real
secrets (so guards treat them realistically) and contain an unmistakable
non-secret marker (`dev-only`, `not-a-real-secret`, `not-real`, `smoke`,
`test-suite`). Values with `change-me`/`dev-only`/`placeholder` markers are
rejected outright in production; the others are rejected by the exact-match
known-development-secret list in `production-policy.ts`. Keep that list in sync
when adding a fixture.

## Access-token secret rotation

`JWT_SECRET` is the **current** key: every issued token is signed with it, and
it is always accepted at verification. `JWT_PREVIOUS_SECRET` is an **optional**
second key that verification also accepts.

Contract (`packages/auth-core/src/access-token.ts —
verifyAccessTokenWithRotation`):

- new tokens are signed with the current key **only**;
- verification accepts the current key, then the previous key if configured;
- the previous key is optional and absent by default;
- current and previous must differ — an equal pair is a no-op rotation and is
  refused at config load, in every runtime mode;
- both keys receive the same production strength validation (known-default,
  placeholder, degenerate, and 32-character floor);
- a token signed with any *other* key is rejected;
- expiry, claim shape, the `type` discriminator, session binding, revocation,
  and every authorization decision are **unchanged** — which key verified a
  token grants it no additional trust;
- when no key accepts a token, the error raised is the current key's, so
  diagnostics describe the key tokens are supposed to carry.

Only one verification site exists (`auth.service.ts —
requireAuthenticatedSession`), so the rotation window is impossible to apply
inconsistently. Registration and login **sign** only, and were not touched.

This is deliberately *not* a `kid`/versioned-key scheme (ORG-PR-049 stays open):
a two-key window is what a symmetric, single-issuer, 15-minute-token deployment
needs, and it adds no token-format change or claim surface.

Procedure: [rotation-runbook.md](rotation-runbook.md#rotate-the-access-token-signing-secret).

## Refresh and session material

Verified against the implementation, not assumed:

- Refresh tokens are **opaque** 32-byte CSPRNG values
  (`packages/auth-core/src/opaque-token.ts`). They are **not signed** and **not
  encrypted**, and carry no claims.
- Only the SHA-256 hash is persisted (`refresh_tokens.token_hash`); the raw
  value exists only in the HttpOnly cookie.
- Cookie integrity depends on **no** secret: the cookie carries the opaque
  token itself, and the server validates it by hash lookup
  (`apps/api/src/lib/cookies.ts` — deliberately unsigned, since the value is
  already an unguessable server-side-validated credential).
- There is **no separate refresh/session signing secret**, so there is nothing
  to rotate here. Rotating `JWT_SECRET` does not log anyone out: sessions and
  refresh cookies are independent of it.
- Each refresh rotates the token within a family; presenting a consumed token
  is treated as reuse and revokes the whole family plus the session
  ([session-lifecycle.md](session-lifecycle.md)).

Emergency session invalidation therefore happens in the **database**, not
through a secret change — see
[rotation-runbook.md](rotation-runbook.md#emergency-invalidate-sessions).

## Redaction guarantees

| Path | Guarantee | Evidence |
|---|---|---|
| Structured logs | Pino path-based redaction covers `JWT_SECRET`, `JWT_PREVIOUS_SECRET`, `SMTP_PASSWORD`, their camelCase config forms, and credential-bearing headers/bodies | `apps/api/src/lib/logging.test.ts` |
| Config-validation errors | Messages name the field and the fix, never the value | `packages/config/src/config.test.ts`, `secret-source.test.ts` |
| Secret-file errors | Name the variable and the path; never the contents | `packages/config/src/secret-source.test.ts` |
| SMTP failures (auth rejected, sender/recipient rejected, connection refused, untrusted certificate, timeout) | The password appears in neither the message, the stack, nor any own property of the thrown error | `apps/api/src/modules/mail/smtp-failure-redaction.test.ts` |
| Access-token rejection | Neither signing key reaches the 401 envelope | `apps/api/src/modules/auth/jwt-secret-rotation.routes.test.ts` |
| Artifact runtime | Fake env-injected and file-injected secrets absent from container logs; server secrets absent from the web bundle; no secret-bearing variable in either image config | `tooling/artifact-smoke.sh` |
| Security events | Metadata passes `sanitizeSecurityMetadata`; no raw token, hash, or credential | `apps/api/src/modules/auth/security-events.test.ts` |

`_FILE` variables hold **paths**, which are configuration rather than secrets,
and are deliberately left unredacted.

## Restart behavior

Configuration — including every secret — is read once by `getConfig()` before
any service is constructed or any port is bound (`apps/api/src/server.ts —
main`). Consequences:

- changing an environment value or a mounted file has **no effect** on a running
  process;
- every secret change requires a process restart (or a rolling replacement);
- a rejected value fails the process at boot, before it can serve a request, so
  a bad rotation takes the new instance out of rotation rather than corrupting
  a running one;
- readiness (`/ready`) gates traffic during a rolling restart.

## Known limitations

- No secrets manager or platform secret-store integration; the operator supplies
  environment values or file mounts by whatever means their platform provides.
- No automatic rotation, no rotation scheduling, no expiry tracking, and no
  audit of who read a secret.
- No hot reload — every rotation is a restart.
- No `kid`/versioned-key JWT scheme (ORG-PR-049); the window is exactly two
  symmetric keys.
- No dual-write/dual-read for `DATABASE_URL` or `REDIS_URL`: rotating those
  means the old credential must remain valid until every process has restarted.
- Config validation refuses known-bad and obviously weak values; it does **not**
  measure entropy, so a weak-but-passing value is still possible.
- External email delivery through a real provider remains unvalidated
  (ORG-PR-002).

## Extending this safely

1. Add the variable to `rawEnvSchema` in `packages/config/src/schema.ts`.
2. If it is secret material, add it to `FILE_BACKED_SECRET_NAMES` in
   `secret-source.ts` — that is all the file support requires.
3. If it must be strong in production, call the existing helpers in
   `production-policy.ts`; do not write a second validation path.
4. Add its camelCase and UPPER_SNAKE names to `SENSITIVE_KEYS` in
   `apps/api/src/lib/logging.ts`.
5. Add a row to the [secret inventory](#secret-inventory) and, if it is
   rotatable, a procedure to [rotation-runbook.md](rotation-runbook.md).
6. Add a fixture following the [placeholder convention](#safe-placeholder-convention).
