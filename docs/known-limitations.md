# Known Limitations

A consolidated, honest list of what Orgistry does **not** do and where the
current implementation makes deliberate compromises. This is the authoritative
current scope boundary; per-sprint docs carry the detailed history.

Orgistry is an engineering reference for an identity/access foundation. It is
**not production-certified** and should not be deployed as-is to handle real
users or data.

## Not implemented (out of scope)

These are intentional non-goals, not bugs:

- **No billing.** No Stripe, checkout, billing portal, subscription, invoice, or
  payment. Plans (Free/Pro/Business) are fixed internal **demo** plans changed
  only via the demo endpoint.
- **No extended auth.** No OAuth/social login, MFA/passkeys, device-management
  UI, account deletion, data export, or support-admin recovery. Password
  recovery and authenticated password/email change EXIST (Sprint 17; see
  [credential-management.md](credential-management.md)). Email verification
  EXISTS (Sprint 16) but is **advisory only**: nothing gates login,
  organization access, invitations, projects, or API keys on the verified flag.
  Enforcement is a future, deliberate change (the extension point is the
  `emailVerified` field on the current-user contract plus
  `users.email_verified_at`).
- **The registration enumeration oracle is closed (Sprint 18), with a timing
  residual.** Public registration is verification-first:
  `POST /v1/auth/register` returns the identical `200 { accepted: true }` for
  every account state, every private invitation-validation failure (no
  `INVITATION_*` error escapes this endpoint — invitation feedback lives on
  the dedicated inspect surface), and every internal failure; it creates no
  account or session and never returns `EMAIL_ALREADY_REGISTERED`; an account
  exists only after the emailed completion token is redeemed (ORG-PR-030
  closed with this residual documented). The residual: response **timing** on the
  register request is not fully equalized — the Argon2id cost is equalized by
  hashing before the account lookup, but the new-email path still performs
  one insert and one mailer hand-off — bounded by the pre-lookup per-IP and
  per-email-digest rate limits; see
  [auth-foundation.md](auth-foundation.md). The password-recovery request
  endpoint is likewise fully enumeration-safe — including under internal
  account lookup, persistence, mail, and security-event failures — with the
  same class of documented timing residual bounded by rate limits, and its
  request security events are anonymous and not account-linked (the event
  schema has no subject field, and actor attribution is never overloaded) —
  see [credential-management.md](credential-management.md).
- **Production email delivery is unproven.** Sprint 16 added a production
  SMTP adapter (nodemailer transport; fail-closed config; see
  [email-and-verification.md](email-and-verification.md)), and production can
  no longer silently fall back to Mailpit. Stated capabilities: SMTP over
  implicit TLS (SMTPS) with certificate/hostname verification and the
  authentication mechanism negotiated by nodemailer from the server's
  advertised capabilities (AUTH PLAIN has direct automated test evidence;
  other mechanisms rely on nodemailer, untested here) — verified by automated
  tests against an in-process server, plus live delivery to the local Mailpit
  container. **No delivery through a real external provider to a real inbox
  has been performed** (no provider credentials exist in this repository or
  its validation environments), so real-provider compatibility is asserted,
  not evidenced; ORG-PR-002 stays open until it is. The driver offers no
  STARTTLS upgrade — a provider endpoint must accept implicit-TLS
  connections (conventionally port 465). Also intentionally absent: bounce
  processing, complaint processing, suppression lists, marketing/bulk email,
  templates/CMS, and notification preferences.
- **No background processing.** No workers, queues, schedulers, or cron. Anything
  that would need a background job (e.g. expiry sweeps, retention deletion) is
  instead derived on read or simply not performed. In particular there is no
  cleanup scheduler for consumed/expired token rows, including the Sprint 18
  `pending_registrations` table — rows accumulate; the `expires_at` index
  exists to support a future sweep.
- **No PostgreSQL row-level security (RLS).** Tenant isolation is enforced in the
  application layer (every query is scoped by the route organization ID), not by
  database policies.
- **No custom roles.** The four system roles (Owner/Admin/Member/Viewer) are
  fixed and code-defined. There are no role/permission mutation APIs.
- **No resource-level or attribute-based permissions.** Authorization is
  permission-key based at the organization scope; there is no ABAC, policy
  engine, or per-resource ACL.
- **No custom plans or per-organization entitlement overrides**, and no
  feature-flag system.
- **No write-enabled or general external API.** The only external (API-key)
  endpoint is read-only `GET /v1/external/projects`. No API key rotation,
  secret-reveal, or update endpoints; no service accounts, OAuth client
  credentials, or personal access tokens; no published SDK or OpenAPI spec.
- **No audit retention enforcement.** The audit log is **read-only**. The plan's
  `audit_retention_days` is surfaced as a display-only field; there is no
  deletion/cleanup job. There is no audit export, webhook, SIEM, or alerting.
- **No alerting on rate-limiter store failure.** When Redis fails and the
  limiters degrade (fail open) or reject (fail closed, the production
  default for sensitive endpoints — Sprint 19), the state is logged
  (sanitized) but nothing alerts an operator; monitoring/alerting on
  limiter-store failure and fail-closed activation does not exist yet
  (the ORG-PR-009 residual).
- **No frontend CSP.** Sprint 19's security headers are an **API response
  policy** (nosniff, frame denial, referrer/permissions policy, HSTS in
  production, `no-store` on auth/invitation responses). The web demo SPA has
  no Content-Security-Policy hardening; that remains open.
- **No organization lifecycle endpoints** (archive/suspend) and **no project
  hard-delete or restore** — deletes are soft.
- **No object storage** and **no production deployment automation** (no
  Terraform, Helm, Kubernetes manifests, or release pipeline).
- **No production secret management.** There is no secrets manager, no secret
  rotation procedure, and no JWT `kid`/versioned-secret rotation path (rotating
  `JWT_SECRET` invalidates all live access tokens). The Sprint 15 production
  config guard ([production-config-guard.md](production-config-guard.md))
  refuses known-bad and obviously weak secrets under `NODE_ENV=production`,
  but **config validation does not prove real entropy** — a determined operator
  can still supply a weak-but-passing value. External email delivery is
  unvalidated, and no backup/PITR/restore system exists. The project remains
  **not ready for staging or production** (see the
  [production-readiness audit](production-readiness/README.md)).

## Testing and validation limitations

- **No full browser end-to-end tests.** The web demo is covered by jsdom
  component/routing tests, not a real-browser E2E harness (Playwright/Cypress).
- **Live Mailpit is not exercised in CI.** The SMTP conversation (including a
  real implicit-TLS handshake and authentication against an in-process fake
  server) has automated coverage in the mail module suites; delivery to the
  live Mailpit container is verified manually via the
  [demo walkthrough](./demo-walkthrough.md). CI does not run Mailpit.
- **No external-provider delivery test.** The production SMTP adapter has
  never sent through a real provider to a real inbox (no credentials
  available). The safe validation procedure is documented in
  [email-and-verification.md](email-and-verification.md#external-provider-validation).
- **Integration tests require live PostgreSQL + Redis.** Without them the
  integration suites skip (with a warning), so a fully offline run validates
  types, lint, unit tests, the web build, and schema drift — but not the live DB
  paths. See the [validation matrix](./validation.md).
- **The Sprint 21 security workflows have not yet run remotely.** The
  dependency-audit, secret-scan (Gitleaks), and CodeQL workflows are
  configured, SHA-pinned, actionlint-clean, and locally validated where a
  local equivalent exists (`pnpm scan:deps:local`, `pnpm scan:secrets`) — but
  their first execution on GitHub-hosted CI is outstanding evidence, and
  CodeQL has **no** local equivalent at all (it runs only on GitHub CI; on a
  private repository it additionally requires code scanning to be available).
  ORG-PR-020 therefore remains open until the first green remote run plus a
  verified failure on a seeded finding.
- **Two dependency advisories are accepted, not fixed** (documented
  reachability analyses in the
  [findings register](production-readiness/findings-register.md), pinned in
  `pnpm.auditConfig.ignoreGhsas` + `osv-scanner.toml`): react-router
  GHSA-qwww-vcr4-c8h2 (CSRF in unstable RSC APIs — the web demo is a
  client-only SPA with no RSC usage; the fix is a major upgrade) and
  brace-expansion GHSA-mh99-v99m-4gvg (DoS in a dev-only eslint transitive
  with no compatible fixed release).
- **Infrastructure images are patch-tag-pinned, not digest-pinned.** Local/CI
  images (`postgres:16.14-alpine`, `redis:7.4.10-alpine`,
  `axllent/mailpit:v1.30.5`) are exact tags, but a registry tag can in
  principle be re-pushed. Digest pinning is deferred to the production
  artifact track (ORG-PR-001/042).

## Accepted runtime compromises

- **Quota race windows — closed (Sprint 20).** Quota checks (`max_projects`,
  `max_members`, `max_api_keys`) now serialize their ENTIRE decision — the
  current plan ceiling (resolved inside the transaction, plan row
  `FOR SHARE`), the count, and the write — under a per-(organization, quota
  kind) PostgreSQL advisory lock, proven by real-DB concurrency and
  plan-coherence suites that fail if the serialization is removed. A plan
  downgrade never revokes existing rows (creation-time enforcement only, by
  design). The
  one accepted residual is on invitation CREATE: the fail-closed invitation
  email is sent before the transaction, so a request that loses the serialized
  re-check has sent a courtesy email whose link resolves to
  `INVITATION_INVALID` (no state, no seat consumed).
- **Rate-limit failure mode is environment-derived (revised in Sprint 19).**
  The Redis-backed limiters no longer unconditionally fail open. Under
  `RATE_LIMIT_FAILURE_MODE=closed` — derived automatically in production,
  which also refuses an explicit `open` — a Redis outage makes **sensitive**
  endpoints (auth flows, invitation inspect/accept/create, the external API,
  the mutation buckets) reject with `503 SERVICE_UNAVAILABLE`; in
  development/test the limiters fail open and requests proceed unthrottled.
  The **global** per-IP limiter fails open by design (readiness takes the
  instance out of rotation). Residual: there is no alerting on either state
  (see above).
- **Fixed-window limiter bursts.** All limiters are fixed-window: a client can
  see up to 2x the configured rate across a window boundary (e.g. the tail of
  one window plus the head of the next). Accepted; sliding windows are not
  implemented.
- **Failed-auth event bounding is per-IP only.** The Sprint 19 bound on
  durable failed-API-key-auth `security_events` writes
  (`RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX`) is keyed per source IP
  (requests with no resolved IP share one coarse internal `unknown` bucket) —
  a distributed storm is bounded per IP, not in aggregate. Beyond the bound,
  visibility is one sanitized warn per window per process (an in-process
  gate, so it survives a Redis outage); a fleet of N instances can emit up to
  N lines per window.
- **Logger redaction is a path-based backstop.** The pino redact paths
  (Sprint 19; `apps/api/src/lib/logging.ts`) cover known credential-shaped
  keys across header/body/config/error and one-level nested shapes, but deeply
  nested or novel keys are not caught. The primary control remains the policy
  of never logging request bodies or credentials; redaction is
  defense-in-depth, not a guarantee.
- **HSTS requires production AND trusted HTTPS context.** The
  `Strict-Transport-Security` header is emitted only when
  `NODE_ENV=production` and the request's proxy-aware protocol resolves to
  `https` (real TLS, or a trusted forwarded hop under `TRUST_PROXY`).
  Non-production deployments get no transport pinning, and a production
  deployment with a wrong `TRUST_PROXY` value or HTTP-only termination
  silently gets none either — deployment must configure both.
- **UI is demo-quality.** The web demo is a deliberately thin, official API
  consumer for reviewing backend behavior — not a polished, production product
  surface. Permission-aware UI is a usability *hint*; the backend remains the sole
  authority for authorization, entitlements, and quotas.
- **Local infrastructure assumptions.** Defaults assume PostgreSQL on 5432, Redis
  on 6379, Mailpit on 1025/8025, API on 3000, and web demo on 5173, all on
  localhost. Port conflicts (especially Postgres on 5432) are the most common
  setup failure — see the [runbook](./runbook.md#handling-port-conflicts) and
  [troubleshooting](./troubleshooting.md).
- **Secrets are local-only placeholders.** Values in `.env.example` and the demo
  seed are non-secret development defaults and must never be reused outside a
  throwaway local environment.

## Where this is enforced / documented

- Scope boundary per sprint: the `docs/sprint-*-artifact-package.md` artifacts.
- Security posture and its non-production caveats: [security model](./security-model.md).
- Architecture rationale: [architecture overview](./architecture.md).
