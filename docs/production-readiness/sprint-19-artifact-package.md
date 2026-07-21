# Sprint 19 Artifact Package — Edge and Application Security Hardening

The authoritative closing record for Sprint 19. Supersedes interim drafts of
this file; every statement below was verified against the repository during
the closing audit on 2026-07-21.

## 1. Sprint Identity

- **Sprint:** 19 — Edge and Application Security Hardening (two refinement
  iterations folded in).
- **Completion date:** 2026-07-21.
- **Baseline:** Sprint 18 complete
  ([sprint-18-artifact-package.md](sprint-18-artifact-package.md)).
- **Binding scope:** harden the Fastify API boundary for production-shaped
  deployment behind a reverse proxy — proxy trust, request-ID hygiene, logger
  redaction, security headers, global and endpoint rate limits, Redis failure
  policy, External API failed-auth write bounding, authenticated mutation
  throttling, readiness disclosure, bounded shutdown — while preserving every
  existing auth, authorization, tenant-isolation, entitlement, quota, and
  audit guarantee. No deployment, monitoring, backup, or secrets work.
- **Final readiness classification:**

  ```text
  C — Ready to continue production implementation
  Not ready for staging
  Not ready for production
  ```

## 2. Implementation Summary

**Proxy trust and client identity** — `TRUST_PROXY` (typed in
`packages/config/src/schema.ts`, parsed by `parseTrustProxy`) is applied to
Fastify at CONSTRUCTION time in `apps/api/src/app.ts`; nothing parses
forwarded headers manually. `false` (default) ignores `X-Forwarded-*`
entirely; a hop count (1–`TRUST_PROXY_MAX_HOPS` = 16, `Number.isSafeInteger`
enforced) or a semantically validated IPv4/IPv6/CIDR list (`node:net` `isIP`;
prefixes 0–32/0–128; hostnames, overflow, scientific notation, decimals, and
empty comma entries fail boot) bounds trust exactly. Invariant: `request.ip`
is the single trusted client-identity source for limiter keys, request logs,
audit IPs, and security-event IPs.

**Request-ID sanitization** — one policy in
`packages/shared/src/request-id.ts` (`resolveRequestId`), applied in
`genReqId` with `requestIdHeader: false`, i.e. before any hook or log line
observes the request. Accepted client format `[A-Za-z0-9._-]{1,128}`;
anything else (missing, empty, overlong, whitespace, CR/LF/NUL, control
characters) is REPLACED with a generated `req_<uuid>` — never partially
cleaned. Invariant: one sanitized ID flows through the response header, log
lines, error envelopes, and audit/security context.

**Structured logger redaction** — every process logger is built by
`apps/api/src/lib/logging.ts` (`buildLoggerOptions`, the `buildApp` default),
which installs pino `redact` paths expanded from a curated sensitive-key list
(authorization, cookie, set-cookie, the configured CSRF header, password
fields, token fields, `tokenHash`/`passwordHash`, API-key fields, secret/
jwtSecret/smtpPassword, `SMTP_PASSWORD`, `JWT_SECRET`) across header
serializer, body, config, error, and one-level-nested shapes. Invariant: a
backstop, not permission — modules still never log bodies or credentials.

**HTTP security headers** — internal plugin
`apps/api/src/plugins/security-headers.ts`, one `onSend` hook on every
response (success, error envelope, 404, readiness 503, CORS preflight).
HSTS requires production mode AND `request.protocol === 'https'` (Fastify's
proxy-aware resolution, inheriting the TRUST_PROXY boundary). Invariant: no
route can opt out; a forged direct-client `X-Forwarded-Proto` can never mint
HSTS.

**Global rate limiting** — `apps/api/src/plugins/global-rate-limit.ts`, one
fixed-window bucket per trusted IP evaluated in `onRequest` before body
parsing and route work; `/health`, `/ready`, and `OPTIONS` exempt; standard
`RATE_LIMITED` envelope. Production `buildApp` THROWS at construction
without a global limiter; the real composition builds one shared
Redis-backed limiter through the unit-tested seam
`apps/api/src/server-rate-limiter.ts` and hands the same instance to every
service and to `buildApp`. Invariant: production cannot boot unlimited.

**Endpoint-specific public controls** — the Sprint 3/16/17/18 buckets
(login, refresh, register + completion, verification request/complete,
recovery request/complete, credential changes) are unchanged and reconciled
into the single matrix in section 8; no duplicate limiters were stacked.

**Invitation inspection** — `invitation.service.ts` throttles public
inspect per trusted IP and per second-order token digest
(`invitationInspectRateLimitKey` = `sha256(sha256(raw))`), before the token
lookup; accept is per-user, create per-user + per-org, both post-permission.
Invariant: the raw token never enters a Redis key, log, or event.

**Redis failure policy** — the store contract
(`apps/api/src/lib/rate-limit.ts`) is three-state:
`allowed | limited | unavailable`; `enforceStoreAvailability` maps
`unavailable` per `RATE_LIMIT_FAILURE_MODE` (production derives — and the
guard enforces — `closed`: a generic 503 `SERVICE_UNAVAILABLE` envelope;
dev/test derive `open`). Invariant: store failure is never silently
converted into an allow on a sensitive bucket, and Redis internals never
reach a public response.

**External API failed-auth bounding** — `recordFailedAuthEventBounded`
(`api-key.authenticator.ts`) gates every 401-family durable
`security_events` write behind a per-source-IP allowance
(`RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX`); IP-less requests share
a coarse internal `unknown` bucket; beyond the allowance or on store outage
the write is skipped and visibility is one sanitized warn per window per
process via an in-process, epoch-zero-safe gate. Invariant: a storm cannot
write one durable row per request, and the uniform 401 contract never
changes.

**Authenticated mutation throttling** — post-permission per-actor buckets in
the organization, member, project, API-key, plan, and invitation services
(section 11). Invariant: throttling never masks an authorization result;
permission-first, uniform cross-tenant 404, Last Owner, quota, and audit
behavior are unchanged.

**Readiness disclosure** — `routes/readiness.ts`: production returns coarse
ready/not-ready with no dependency inventory; dev/test keep name/ok/latency
detail; probe error text never surfaces in any mode; per-check outcomes log
server-side on failure. Redis is a required probe, consistent with the
fail-closed limiter policy.

**Shutdown hardening** — `server.ts`: idempotent across repeated
SIGINT/SIGTERM, bounded by a 10s unref'd force-exit timer. Review-proven
(no automated signal-level test; see section 19).

## 3. Architectural Decisions

- **Bounded proxy trust, never universal:** `TRUST_PROXY=true` would let any
  direct client forge its resolved IP and thereby every IP-keyed limiter and
  security event; it is unrepresentable in config.
- **Hop counts capped at 16 (`TRUST_PROXY_MAX_HOPS`):** real chains are a
  handful of hops; every hop beyond the real chain is a spoofing
  opportunity, and unbounded/overflowing counts are misconfigurations, not
  topologies. Recommended ordinary value: 1.
- **Fastify `request.ip` / `request.protocol` are authoritative:** both
  inherit exactly the configured trust boundary; hand-parsing forwarded
  headers would create a second, divergent trust decision.
- **Three-state limiter contract:** a boolean cannot distinguish "over the
  limit" from "the store could not answer", and that distinction is the
  entire fail-open/fail-closed policy.
- **Global bucket fails open; sensitive buckets fail closed:** a Redis blip
  must degrade to "sensitive endpoints 503 + instance leaves rotation", not
  "the entire API 503s at the edge"; readiness already gates rotation.
- **Readiness treats Redis as required:** with production abuse controls
  failing closed without it, an instance without Redis is not serving its
  contract.
- **Second-order token digests in limiter keys:** the raw token is a secret
  and the storage hash is the DB lookup value; `sha256(sha256(raw))` is
  deterministic per token yet useless for a table lookup if Redis leaks.
- **Failed-auth event bounding is separate from auth correctness:** the
  bound governs durable WRITES only; the 401 decision precedes every limiter
  and never depends on Redis.
- **In-process suppression gate:** the "writes are being suppressed" signal
  must keep working exactly when the limiter store is down; one line per
  window per process is deliberate, bounded operator visibility.
- **Mutation limits run after authorization:** a 429 must never leak an
  authorization outcome or weaken the uniform cross-tenant 404.
- **One shared Redis-backed limiter in the composition:** a single instance
  (built by the `server-rate-limiter.ts` seam) backs the global bucket and
  every service bucket — no second store, no drift between buckets.
- **Redaction is a backstop only:** path-based redaction cannot catch novel
  deep keys; the primary control remains "never log bodies or credentials".

## 4. Contracts and Invariants

Future changes must preserve:

- Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are honored
  only through the configured `TRUST_PROXY` boundary.
- Unsafe inbound request IDs are replaced with generated IDs — never
  trimmed, escaped, or partially cleaned.
- HSTS requires production mode AND proxy-aware HTTPS resolution.
- No raw email, token, API key, Authorization value, storage hash, or
  credential-derived digest enters a Redis key, a log line, or event
  metadata.
- Limiter-store unavailability (`unavailable`) is distinct from threshold
  exhaustion (`limited`) everywhere.
- Sensitive production limiters fail closed with the generic
  `SERVICE_UNAVAILABLE` envelope; Redis internals never reach a response.
- Invalid credentials never authenticate because Redis is unavailable, on
  any surface.
- A failed-auth storm cannot create more durable `security_events` rows than
  the configured allowance per source bucket per window.
- A missing client IP does not bypass the durable-write bound (coarse
  `unknown` bucket).
- Suppression logging is bounded (one warn per window per process) and
  credential-free.
- Permission-first authorization, uniform cross-tenant 404, tenant
  isolation, Last Owner protection, entitlement/quota separation, and audit
  behavior remain authoritative and unchanged.
- Production `/ready` never exposes the dependency inventory or any
  dependency internals.
- All public errors keep the standard envelope (`RATE_LIMITED` and
  `SERVICE_UNAVAILABLE` are existing codes; no new codes, no shape change).

## 5. Configuration Reference

Full variable listing with local defaults: [.env.example](../../.env.example)
(kept in sync with `packages/config/src/schema.ts`, the single validation
point). Security-sensitive behavior:

- `TRUST_PROXY` — default `false`. Accepts `false`, a hop count 1–16, or a
  semantically validated IP/CIDR list; `true`, hostnames, overflow, and
  malformed lists fail boot. `TRUST_PROXY_MAX_HOPS = 16` is a code-level
  exported constant, not configuration.
- `HSTS_MAX_AGE_SECONDS` — default 15552000 (180 days); consumed only when
  the HSTS condition (production + trusted HTTPS) holds.
- `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX` — global bucket, defaults
  60 s / 300 per trusted IP.
- `RATE_LIMIT_FAILURE_MODE` — `open | closed`; unset derives
  production→`closed`, dev/test→`open`; the production guard
  (`production-policy.ts`) REFUSES an explicit `open`.
- Invitation buckets — `RATE_LIMIT_INVITATION_INSPECT_PER_IP_MAX` (30),
  `…_INSPECT_PER_TOKEN_MAX` (10), `…_ACCEPT_PER_USER_MAX` (10),
  `…_CREATE_PER_USER_MAX` (20), `…_CREATE_PER_ORG_MAX` (60); auth window.
- Mutation buckets — `RATE_LIMIT_MUTATION_WINDOW_SECONDS` (60),
  `RATE_LIMIT_ORG_CREATE_PER_USER_MAX` (10),
  `RATE_LIMIT_PROJECT_CREATE_PER_USER_MAX` (30),
  `RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX` (60, update+delete shared),
  `RATE_LIMIT_API_KEY_CREATE_PER_USER_MAX` (10),
  `RATE_LIMIT_PLAN_CHANGE_PER_ORG_MAX` (10),
  `RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX` (30, role change+removal
  shared).
- External failed-auth allowance —
  `RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX` (10 per external
  window).
- Pre-existing auth/registration/recovery/verification/external buckets are
  unchanged (see the matrix).

## 6. Security Header Summary

Every response (success, error, 404, readiness 503, preflight) carries:
`X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`;
`Referrer-Policy: no-referrer`; `Cross-Origin-Opener-Policy: same-origin`;
`Cross-Origin-Resource-Policy: same-origin`;
`Permissions-Policy: camera=(), microphone=(), geolocation=()`.

- **HSTS condition:** `Strict-Transport-Security:
  max-age=<HSTS_MAX_AGE_SECONDS>; includeSubDomains` only when
  `NODE_ENV=production` AND `request.protocol === 'https'` via the trusted
  proxy boundary. Never on local HTTP; never mintable by a forged header.
- **no-store:** `Cache-Control: no-store` on `/v1/auth/*` and
  `/v1/invitations/*` (credential/token-bearing surfaces).
- **CORS compatibility:** explicit typed origin allow-list with credentials;
  allowed-origin credentialed requests receive the origin echo (never `*`)
  plus the header set above; foreign origins receive no grant; preflight is
  functional and exempt from the global limiter. CSRF-header enforcement is
  unchanged.
- **CORP/COOP rationale:** `same-origin` CORP constrains only cross-origin
  no-cors embedding; the SPA's CORS-mode credentialed fetches are governed
  by the allow-list, so this is the least-permissive compatible value. COOP
  `same-origin` isolates any browsing context the API might open (none).
- **No frontend CSP claim:** this is an API response policy; SPA CSP
  hardening remains open (ORG-PR-035).

## 7. Proxy Trust Summary

- **Direct mode (`false`, default):** forwarded headers ignored;
  `request.ip` = socket peer; spoofing impossible; correct for local
  development and direct exposure.
- **Hop mode (`1`–`16`):** exactly N hops trusted; the client IP comes from
  the corresponding `X-Forwarded-For` position. `1` is the documented
  production-shaped topology (one TLS-terminating reverse proxy).
- **Explicit IP/CIDR mode:** a semantically validated trusted-proxy address
  list, for when the deployment (ORG-PR-001) fixes a stable proxy range.
- **Trusted-header behavior:** with trust configured, `X-Forwarded-For`
  resolves the client identity and `X-Forwarded-Proto` the protocol (HSTS);
  with trust disabled, both are ignored.
- **Misconfiguration risks:** a hop count above the real chain lets clients
  spoof IPs (defeating every IP-keyed control); below it collapses all
  clients into the proxy IP (shared buckets, useless audit IPs); a wrong
  value also silently disables HSTS.
- **Deployment responsibility:** set the real hop count or proxy CIDR, and
  terminate TLS, before production traffic. The application cannot infer
  the topology.

## 8. Rate-Limit Matrix

Trusted IP = `request.ip` under §7. Email/token dimensions use SHA-256
digests (tokens: second-order digests) — never raw values. Window =
`RATE_LIMIT_AUTH_WINDOW_SECONDS` (60 s) for auth/invitation rows,
`RATE_LIMIT_MUTATION_WINDOW_SECONDS` (60 s) for mutation rows,
`RATE_LIMIT_EXTERNAL_WINDOW_SECONDS` (60 s) for external rows. "Closed" =
generic 503 on store outage in production (`open` in dev/test). "Event" =
durable `rate_limit_exceeded`-family row on limit exceed.

| Surface | Dimensions (default max) | Store outage | Durable event | Rationale |
| --- | --- | --- | --- | --- |
| Global (all routes; not `/health`, `/ready`, OPTIONS) | trusted IP (300) | **fails open by design** | no | baseline edge boundary; readiness gates rotation |
| POST /v1/auth/register | IP (5); email digest (3) | closed | yes | enumeration-safe public entry; bounds mailbox flooding |
| POST /v1/auth/registration/complete | IP (10); token digest (5) | closed | yes | completion-token brute force |
| POST /v1/auth/login | IP (10); email digest (5) | closed | yes | credential stuffing |
| POST /v1/auth/refresh | session (60); IP (120) | closed | yes | rotation abuse |
| POST /v1/auth/email-verification/request (resend) | user (3); IP (10) | closed | yes | email spam bound |
| POST /v1/auth/email-verification/complete | IP (10) | closed | yes | verification-token brute force |
| POST /v1/auth/password-recovery/request | IP (5); email digest (3) | closed | yes | victim mailbox flooding |
| POST /v1/auth/password-recovery/complete | IP (10); token digest (5) | closed | yes | reset-token brute force |
| Password change (authenticated) | user (5) | closed | yes | credential mutation |
| Email change (authenticated) | user (3) | closed | yes | credential mutation |
| POST /v1/invitations/inspect (public) | IP (30); token digest (10) | closed | **no** — a per-attempt durable row would recreate the amplification this control closes; 429s stay in request logs | token-probing oracle |
| POST /v1/invitations/accept | user (10) | closed | no | authenticated token guessing |
| Invitation create | user (20); org (60) | closed | no | sends real email per call |
| Organization create | user (10) | closed | no | provisions org + membership + plan state |
| Project create | user (30) | closed | no | durable row + audit event (quota still authoritative) |
| Project update / delete (shared bucket) | acting user (60) | closed | no | audit event per call; repeatable |
| Member role change / removal (shared bucket) | acting user (30) | closed | no | audit event per call; role-flip loops |
| API-key create | user (10) | closed | no | mints a live credential + audit event |
| Demo plan change | org (10) | closed | no | entitlement rewrite + audit event |
| External API valid-key throughput | key (120); org (600) | closed | yes (`api_key.rate_limit_exceeded`) | machine-surface throughput cap |
| External API failed-auth EVENT allowance | source IP or internal `unknown` bucket (10) — bounds durable writes, not the response | write skipped (never amplifies) | this row IS the durable-write policy | ORG-PR-013; response stays uniform 401 |
| Internal: existing-account notice email | email digest (1) | email skipped | no | courtesy-mail flood bound |

## 9. Redis Outage Behavior

- **Global limiter:** fails open (explicit design; logged, sanitized).
- **Sensitive public endpoints** (all auth-family rows above, invitation
  inspect/accept/create): production fails closed — generic 503, request ID
  included, no store internals; dev/test fail open.
- **Authenticated mutations:** same fail-closed production posture.
- **External API, invalid credentials:** remain uniform 401 in every mode —
  authentication correctness precedes all limiters.
- **External API, valid keys:** 503 in production when the per-key/per-org
  buckets cannot be evaluated; open in dev/test.
- **Failed-auth event allowance:** store outage skips the durable write
  (never re-opens amplification) and keeps the bounded log signal.
- **Readiness:** Redis is a required probe; production `/ready` goes 503
  (coarse), taking the instance out of rotation — consistent with the
  fail-closed handlers.
- **Remaining limitation:** nothing alerts an operator on limiter-store
  failure or fail-closed activation; that observability belongs to
  ORG-PR-007 (open). Fail-closed behavior does not replace monitoring.

## 10. External API Failed-Auth Bounding

- **Durable row bound:** at most
  `RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX` (default 10)
  `security_events` rows per source bucket per external window, across the
  entire 401 family (missing/malformed/unknown/revoked/expired/inactive
  org), enforced by `recordFailedAuthEventBounded` BEFORE the insert.
- **Source bucket:** trusted client IP; **unknown-source fallback:** a
  request with no resolved IP consumes one coarse internal `unknown` bucket
  — a missing IP never bypasses the bound. Bucket names are internal and
  credential-free.
- **Suppression condition:** allowance exceeded OR limiter store
  unavailable → the durable write is skipped.
- **Suppression-log bound:** one sanitized warn per limiter window per
  process (in-process gate; `null` initial state so the first suppression
  logs even at clock epoch 0; survives store outages). Payload: component,
  coarse event type, `reason: allowance_exceeded | store_unavailable` only.
- **Uniform invalid-credential behavior:** 401 `API_KEY_UNAUTHORIZED` in
  every mode, including total store outage under `closed`.
- **Valid-key fail-closed:** production 503 when the throughput buckets
  cannot be evaluated; scope checks and last-used throttling unchanged.
- **Credential hygiene:** no credential or credential-derived digest in
  keys, rows, or logs — asserted by tests against stored metadata, captured
  redaction-enabled process logs, and log payloads.
- **Tests:** `api-key.failed-auth.integration.test.ts` (live PostgreSQL:
  25-request storm → row growth ≤ allowance of 3; valid key functional
  mid-storm), `api-key.failed-auth-bounding.test.ts` (null-IP burst;
  epoch-0 log gate; outage log bound), `external-projects.routes.test.ts`
  (unit bound; outage semantics).

## 11. Authenticated Mutation Throttling

Protected (all enforced in services AFTER `requireMembership`/
`requirePermission`; all return the standard `RATE_LIMITED` envelope; all
fail closed in production; thresholds in section 5): organization create
(per user), project create (per user), project update + delete (shared
per-acting-user bucket `rl:project:mutate:user:`), API-key create (per
user), demo plan change (per org), invitation create (per user + per org),
invitation accept (per user), member role change + removal (shared
per-acting-user bucket `rl:member:mutate:user:`). Password change, email
change, and verification resend keep their Sprint 16–17 per-user limits.

Deliberately unthrottled — revocations only (invitation revoke, API-key
revoke, session revoke): a revoked resource cannot be revoked twice (the
second attempt errors without an audit write), so their durable writes are
bounded by resource state and by creation, and creation is itself throttled.

Tests: `organization/mutation-throttle.test.ts` (org create + member
buckets; user isolation; unauthenticated 401 precedes limiter; fail-closed),
`projects/project-throttle.test.ts` (create + update/delete buckets;
cross-tenant 404 with exhausted bucket),
`api-keys/api-key-create-throttle.test.ts` (threshold; entitlement 403
intact under the limiter), `entitlements/plan-throttle.test.ts` (org
isolation; non-member 404, never 429), `invitation.throttle.test.ts`
(create/accept buckets; permission-first regression).

## 12. Logger Redaction

- **Implementation:** `apps/api/src/lib/logging.ts` (`buildLoggerOptions`),
  the `buildApp` default — no process logger is built without it. Pino
  `redact` paths (censor `[REDACTED]`) are generated from a curated key list
  including the CONFIGURED CSRF header name.
- **Representative protected paths:** `req.headers.authorization`,
  `*.headers["set-cookie"]`, `body.password` / `*.currentPassword` /
  `*.newPassword`, `*.token` / `*.refreshToken` / `*.invitationToken`,
  `*.tokenHash` / `*.passwordHash`, `*.apiKey` / `*.apiKeySecret`,
  `config.jwtSecret` / `*.smtpPassword` / `SMTP_PASSWORD` / `JWT_SECRET`,
  and the `err`/`error` container equivalents.
- **Limitations:** path-based — a secret under a novel key at depth ≥ 3 is
  not caught; the list must grow with new secret-bearing fields.
- **Module responsibility:** unchanged — never log request bodies or
  credentials; redaction is defense in depth, not permission.
- **Tests:** `lib/logging.test.ts` (capture-stream proofs across header/
  body/config/nested-error shapes; safe fields survive; real-request
  Authorization absent) plus the storm integration test's captured-log
  assertions.

## 13. Request-ID Policy

- **Accepted format:** `[A-Za-z0-9._-]{1,128}` (max length 128, exported as
  `REQUEST_ID_MAX_LENGTH`).
- **Replacement:** any other inbound value — missing, empty, overlong,
  whitespace, malformed, CR/LF/NUL, control characters — yields a generated
  `req_<uuid>`; never partial cleanup.
- **Injection prevention:** hostile CR/LF values cannot split response
  headers or forge log lines (tested: no `X-Injected`/`Set-Cookie`
  reflection).
- **Propagation:** the one resolved ID appears in the `x-request-id`
  response header, log lines (`requestId`), error envelopes
  (`error.requestId`), and audit/security context.
- **Tests:** `packages/shared/src/request-id.test.ts` (policy unit matrix),
  `apps/api/src/plugins/request-id.test.ts` (end-to-end propagation +
  header–envelope consistency of the replacement).

## 14. Readiness Disclosure

- **Production:** `200 { status: 'ready' }` or a generic 503 — no
  dependency names, hosts, ports, latencies, or error text.
- **Development/test:** per-dependency `name/ok/latencyMs`; probe error
  text, hosts, and ports never surface in ANY mode (probes reduce to
  booleans).
- **Redis requirement:** a required probe, aligned with fail-closed
  limiters — Redis down ⇒ production not-ready AND sensitive endpoints 503.
- **Server-side visibility:** per-check name/ok outcomes are logged
  (sanitized) on failure.
- **Prohibited disclosures:** connection strings, dependency inventory (in
  production), exception text, stack traces, driver details.

## 15. Findings Status

| Finding | Final status | Implementation evidence | Test evidence | Remaining limitation |
| --- | --- | --- | --- | --- |
| ORG-PR-009 — limiter fails open on Redis outage | **Materially advanced** | Three-state store contract; production-default `closed` + guard refusing `open`; sanitized store-failure logs; readiness requires Redis | Failure-mode unit suites; REAL-Redis healthy/fail-closed/fail-open (`rate-limit.redis.integration.test.ts`) | No metric/alert on store failure or fail-closed activation — the finding's alerting half is ORG-PR-007 (open) |
| ORG-PR-010 — `trustProxy` unset | **Closed** | Semantic `TRUST_PROXY` incl. bounded hops, construction-time application | Config validation matrix; spoof/hop/limiter-key/boot-level tests (`app.proxy-trust.test.ts`) | Deployment must set the value matching its topology |
| ORG-PR-011 — no HTTP security headers | **Closed** | `plugins/security-headers.ts`; HSTS = production + trusted HTTPS | Header suites incl. HSTS matrix, forged-XFP rejection, credentialed-CORS compatibility | Frontend CSP remains ORG-PR-035 |
| ORG-PR-012 — no global limit; inspect unthrottled | **Closed** | Global plugin + production construction invariant + shared-limiter composition seam; inspect IP + token-digest buckets | Unit suites; LIVE-Redis threshold/TTL/isolation; invariant + seam tests; `invitation.throttle.test.ts` | Network-edge (WAF/CDN) controls remain future infrastructure (ORG-PR-001) |
| ORG-PR-013 — unbounded failed-auth event writes | **Closed** | Bounded writer + `unknown` bucket + bounded epoch-safe suppression logging | DB-backed storm; null-IP burst; log-bound suites | Per-source bound, not distributed aggregate; retention/index remain ORG-PR-015/014 |
| ORG-PR-032 — spammable mutations unthrottled | **Closed** | Every surface named by the finding throttled post-permission, incl. member role/removal and project update/delete; revokes excluded with bounded-write proof | Five mutation suites incl. member/project-mutation cases | Static thresholds; no per-plan tuning |
| ORG-PR-033 — no logger redaction backstop | **Closed** | `lib/logging.ts` centralized default | Log-capture suites; storm log assertions | Path-based; deep/novel keys uncaught |
| ORG-PR-052 — minor API disclosures | **Closed** | Request-ID sanitization; coarse production `/ready`; bounded idempotent shutdown | Request-ID + readiness suites | Shutdown behavior review-proven (no automated signal test) |

Statuses are identical in [findings-register.md](findings-register.md) (the
authoritative register), the readiness [README](README.md), the
[scorecard](production-scorecard.md), [roadmap](production-roadmap.md),
[launch checklist](launch-checklist.md), and
[security assessment](security-assessment.md).

## 16. Tests Added and Updated

- **Configuration and proxy** — `packages/config/src/config.test.ts`:
  TRUST_PROXY semantic matrix (real IPv4/IPv6/CIDR acceptance; rejection of
  `true`, 0, negatives, hostnames, bad octets, out-of-range/zero-padded
  prefixes, `::::`, empty/leading/trailing comma entries, decimals,
  scientific notation, unsafe integers, overlong digit strings; ceiling 16
  accepted, 17 rejected); failure-mode derivation; production guard on
  `open`. `app.proxy-trust.test.ts`: spoofed XFF ignored when untrusted;
  correct hop resolution incl. attacker-prepended chains; limiter keys use
  the resolved IP; an explicit IP/CIDR list boots and is honored;
  production `buildApp` refuses construction without the global limiter.
- **Request IDs** — safe values preserved; every hostile class replaced; no
  header splitting; one consistent replacement across header and envelope.
- **Logger redaction** — captured output never contains representative
  header/password/token/API-key/SMTP/JWT values across realistic logged
  shapes, while diagnostic fields survive.
- **Security headers and CORS** — full header set on success/error/503/
  preflight; the four-way HSTS condition matrix incl. forged-XFP rejection;
  allowed-origin credentialed requests get explicit (never wildcard) grants
  alongside COOP/CORP; foreign origins denied; no-store scoping.
- **Global limiter** — threshold + standard envelope with no limiter
  internals; per-IP isolation; probe/OPTIONS exemptions; documented
  fail-open on store outage.
- **Real Redis integration** —
  `apps/api/src/lib/rate-limit.redis.integration.test.ts`: the actual
  `createRedisRateLimiter` + `ioredis` enforce the global threshold, isolate
  per-identity buckets, set positive TTLs, and keep secrets out of observed
  keys; a representative sensitive endpoint behaves normally with a healthy
  store, fails closed (generic 503) after a deterministic real-client
  failure (`redis.quit()`), and fails open in dev mode. The suite FAILS
  HARD at load when Redis is unreachable — verified exit 1 against a dead
  port. (Client-side outage simulation, stated as such; the shared server
  is not stopped.) `server-rate-limiter.test.ts`: the production
  composition's limiter seam is the Redis-backed implementation
  (INCR/EXPIRE protocol, `unavailable` decision, deferred logger binding).
- **Auth-family failure modes** — register, registration completion, login,
  and recovery request/completion each fail closed (503, request ID, no
  internals) under `closed`, proceed under `open`, unaffected when healthy.
- **Invitations** — inspect per-IP and per-token thresholds; raw token
  absent from keys/events/logs; fail-closed/open; inspect→accept flow
  intact; create/accept buckets post-permission.
- **External API bounding and outage** — DB-backed storm bound; null-IP
  bound; epoch-0 suppression gate; one-warn-per-window incl. during outage;
  invalid credentials stay 401 in every mode; valid keys 503-closed / open
  per mode.
- **Mutation throttling** — thresholds, shared buckets, user/org isolation,
  standard envelope, permission-first and entitlement regressions for all
  eight protected surfaces.
- **Readiness** — coarse production vs. detailed dev; no internals in any
  mode.
- **Regression suites** — the pre-existing registration equality matrix,
  completion, invitation registration, verification, recovery, credential
  change, session lifecycle, invitations, tenant isolation, entitlement/
  quota, API-key/External API, and web-demo suites run unchanged; no
  security test was weakened and no production threshold was lowered for
  tests.

## 17. Validation Evidence

Closing-pass run, 2026-07-21 (exact final output):

```text
pnpm validate              → exit 0
  unit: 72 test files / 794 tests
  web-demo: 10 test files / 78 tests
  (typecheck, eslint, web build, schema-drift, git diff --check all green)

pnpm validate:integration  → exit 0
  packages/db: 1 file / 13 tests
  apps/api:   13 files / 69 tests

git diff --check           → clean
```

- The real Redis integration suite EXECUTED in the final run
  (`✓ src/lib/rate-limit.redis.integration.test.ts (3 tests)`), did not
  skip, and cannot skip: Redis unavailability throws at module load and
  fails `pnpm validate:integration` (verified exit 1 against an unreachable
  port).
- Environment note: PostgreSQL for integration validation ran on host port
  55432 (a throwaway container working around a foreign Postgres occupying
  5432 on the validation machine — the documented runbook workaround). This
  is an environment condition, not a code limitation.

## 18. Documentation Index

Updated in Sprint 19 (each verified during the closing audit):

- **Root `README.md`** — project-level security summary and readiness
  statement; entry point to everything below.
- **`.env.example`** — the operator-facing configuration contract, kept in
  lock-step with the schema.
- **`docs/api-surface.md`** — authoritative route/permission/limit table,
  incl. per-endpoint 429/503 behavior.
- **`docs/api-conventions.md`** — envelope, error-code, request-ID,
  security-header, and health/readiness conventions.
- **`docs/security-model.md`** — the security architecture reference; owns
  the edge-hardening section (trust boundary, limiter architecture, failure
  policy, redaction, sanitization).
- **`docs/auth-foundation.md`** — authoritative auth design; records the
  fail-closed note for the auth-family limiters.
- **`docs/invitations.md`** — invitation lifecycle design incl. the
  throttle policy and token hygiene.
- **`docs/api-keys-external-api.md`** — External API design incl.
  failed-auth bounding, suppression policy, outage semantics.
- **`docs/local-development.md`** — local defaults (no proxy, HSTS never,
  fail-open limiters).
- **`docs/validation.md`** — the validation matrix; states Redis is
  mandatory for a valid integration pass (fail-hard suite).
- **`docs/troubleshooting.md`** — symptom-driven entries for 429s, 503
  fail-closed, wrong client IPs, request-ID replacement.
- **`docs/known-limitations.md`** — honest limitation register (burst
  windows, per-source bounding, redaction limits, HSTS dependencies,
  missing alerting).
- **`docs/production-readiness/README.md`** — readiness navigation + status
  chain.
- **`findings-register.md`** — the authoritative findings record with
  Sprint 19 resolutions.
- **`security-assessment.md`** — audit narrative with the dated Sprint 19
  addendum.
- **`threat-model.md`** — per-threat Sprint 19 mitigation updates with
  preserved residuals.
- **`standards-matrix.md`** — ASVS control-status updates (V11.1, V14.4,
  V7.x).
- **`production-roadmap.md`** — Phase 3 edge-hardening completion record.
- **`launch-checklist.md`** — item-level status updates (LC-1.7, LC-3.3,
  LC-3.4, LC-5.3).
- **`production-scorecard.md`** — dated status block; classification C
  unchanged.
- **This artifact** — the authoritative Sprint 19 closing record.

## 19. Known Limitations and Remaining Risks

- **Fixed-window burst:** up to 2× the configured rate across a window
  boundary (store semantics, accepted).
- **Per-source failed-auth bounding:** a distributed storm is bounded per
  source IP, not in aggregate (allowance × distinct IPs rows per window).
- **Unknown-source aggregation:** all IP-less failed auth shares one coarse
  bucket — heterogeneous unattributable sources contend for one allowance.
- **Path-based redaction:** novel or deeply nested secret keys are not
  caught; the no-sensitive-logging module policy remains primary.
- **TRUST_PROXY deployment dependency:** every IP-keyed control and HSTS
  are only as correct as the deployed value; the application cannot verify
  the topology.
- **HSTS dependency:** requires production mode, TLS termination, AND
  correct proxy trust; misdeployment silently yields no HSTS.
- **No monitoring/alerting:** limiter-store failure, fail-closed
  activation, and readiness flapping are log-visible only (ORG-PR-007;
  suppression warns are additionally per-process, so a fleet emits up to N
  lines per window).
- **Shutdown:** bounded/idempotent behavior is review-proven; there is no
  automated signal-level test.
- **Remaining P1 blockers:** ORG-PR-001 (deployment automation), ORG-PR-002
  (external production email validation), ORG-PR-005 (backup/PITR/tested
  restore), ORG-PR-006 (secrets management and rotation).
- **Deferred to Sprint 20:** permission-gate consistency (ORG-PR-053),
  quota TOCTOU races, Owner role-transition enforcement (ratified DG-2),
  `security_events` org index + retention (ORG-PR-014/015).

## 20. Scope-Control Confirmation

Excluded and untouched: Sprint 20 authorization/concurrency work, Owner
role-transition changes, quota TOCTOU fixes, Sprint 20 index work,
deployment automation, Dockerfiles, IaC, staging configuration,
reverse-proxy deployment, TLS provisioning, WAF/CDN, monitoring
infrastructure, dashboards, alerts, backup/restore, secrets management, key
rotation, SMTP-provider validation, workers/queues, dependency scanning,
browser E2E, MFA/OAuth/SAML/SCIM/passkeys. No unrelated refactors; no
stable API behavior changed for artifact polish. No redesign of
registration, recovery, verification, refresh rotation, invitations,
API-key auth, authorization, tenant isolation, the error envelope, or CSRF.

## 21. Confidence Assessment

**High confidence at the application layer; moderate overall pending the
production envelope.** Grounds: every Sprint 19 control is enforced in code
and pinned by behavioral tests; the limiter path has LIVE-Redis evidence
(threshold, TTL, isolation, fail-closed via a real client failure) that
cannot silently skip; the failed-auth bound is proven against live
PostgreSQL with credential-hygiene assertions on real rows and captured
logs; the full pre-existing regression surface (auth lifecycle, tenant
isolation, entitlements, external API, web demo) passes unmodified; and the
twenty-one documents above were audited for mutual consistency in this
closing pass. Confidence is capped below "high overall" by what tests
cannot reach: the Redis outage evidence is a client-side simulation,
shutdown is review-proven, the proxy/TLS topology is a deployment
assumption, and none of the fail-closed states page a human. Those are
operational and infrastructure gaps (the open P1s + ORG-PR-007), not
application defects.

## 22. Remaining Risks

- **Application-level residuals:** fixed-window bursts; per-source (not
  aggregate) failed-auth bounding; path-based redaction limits.
- **Deployment assumptions:** correct `TRUST_PROXY`, TLS termination, and
  HTTPS-only exposure; `RATE_LIMIT_*` thresholds tuned to real traffic.
- **Operational gaps:** no alerting on limiter-store failure / fail-closed
  activation / readiness flapping; suppression visibility is per-process.
- **Infrastructure blockers (P1):** ORG-PR-001, ORG-PR-002, ORG-PR-005,
  ORG-PR-006 — unchanged and prerequisite to any staging claim.
- **Sprint 20 concerns:** authorization-gate consistency, quota TOCTOU
  under concurrency, Owner role-transition enforcement, `security_events`
  index/retention growth (now the dominant growth concern on that table
  after this sprint's write bounding).

## 23. Readiness for Next Sprint

**Ready to begin Sprint 20 — Authorization and Concurrency Correctness.**
Final validation is green, the closing audit found no Sprint 19 regression,
and the edge boundary is frozen with its invariants documented in section 4.
Expected Sprint 20 concerns (not implemented here): permission-gate
consistency on the membership-only read paths (ORG-PR-053); quota
check-then-insert races under adversarial concurrency; Owner
role-transition enforcement per the ratified DG-2 decision;
`security_events` organization index (ORG-PR-014) and retention
(ORG-PR-015).
