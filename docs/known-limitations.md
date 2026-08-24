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
  has been performed** (no provider credentials, no verified sending domain,
  and no test mailbox exist in this repository or its validation environments
  — re-confirmed in Sprint 24), so real-provider compatibility is asserted,
  not evidenced, and **no SPF/DKIM/DMARC posture has been validated**;
  ORG-PR-002 stays open until it is. Provider *acceptance* and real *inbox
  receipt* are tracked as separate evidence and neither is inferred from the
  other. The exact procedure to obtain both is in
  [rotation-runbook.md](rotation-runbook.md#validate-external-email-delivery).
  The driver offers no
  STARTTLS upgrade — a provider endpoint must accept implicit-TLS
  connections (conventionally port 465). Also intentionally absent: bounce
  processing, complaint processing, suppression lists, marketing/bulk email,
  templates/CMS, and notification preferences.
- **No background processing.** No workers, queues, schedulers, or cron.
  Anything that would need a background job runs as an explicit one-shot
  command or is derived on read. Since Sprint 25 the retention cleanup is real,
  runnable, and tested (`pnpm db:retention`, or `node dist/retention.mjs` from
  the deployable artifact — see [retention.md](retention.md)); what is still
  missing is anything that INVOKES it on a schedule, plus metrics and failure
  alerting for such a run. The same applies to backups: `pnpm db:backup` exists,
  nothing schedules it.
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
- **No PER-PLAN audit retention enforcement.** The audit log is **read-only**.
  Since Sprint 25 a GLOBAL retention window for `security_events` exists and is
  enforced by the retention cleanup (`RETENTION_SECURITY_EVENT_DAYS`, default
  180 days — [retention.md](retention.md)), but the plan's
  `audit_retention_days` is still a display-only modeled value: retention is
  not per organization. There is no audit export, webhook, SIEM, or alerting.
- **Retention is not erasure.** The cleanup bounds table growth. It is not
  account deletion, data export, or PII minimization, and it deliberately never
  touches `invitations`, `api_keys`, or account/tenant rows.
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
- **No object storage** and **no deployment automation to a real
  environment.** Sprint 23 added production-shaped container artifacts (API +
  web, non-root, tag+digest-pinned bases), an explicit migration entrypoint, a
  production-like compose validation reference, and a CI build/smoke gate (see
  [deployment-artifacts.md](deployment-artifacts.md)) — but there is still no
  staging or production environment, no Terraform/Helm/Kubernetes, no
  container-registry publishing, no image signing/provenance, and no release
  or deploy pipeline (ORG-PR-001's deployment half remains open).
- **No production secret management.** Sprint 24 delivered the runtime
  *source* and *rotation* halves — secrets come from a direct environment value
  or a mounted `<NAME>_FILE` secret resolved before validation, access-token
  keys rotate gracefully through an optional `JWT_PREVIOUS_SECRET` verification
  window, and manual rotation/incident procedures are written down
  ([runtime-secrets.md](runtime-secrets.md),
  [rotation-runbook.md](rotation-runbook.md)). Still missing: **any secrets
  manager or platform secret-store integration**, automated rotation, rotation
  scheduling or expiry tracking, secret-access auditing, hot reload (every
  rotation is a process restart), a `kid`/versioned-key JWT scheme
  (ORG-PR-049), and dual-credential support for `DATABASE_URL`/`REDIS_URL` (the
  old credential must stay valid until every process restarts). The Sprint 15
  production config guard
  ([production-config-guard.md](production-config-guard.md)) refuses known-bad
  and obviously weak secrets under `NODE_ENV=production`, but **config
  validation does not prove real entropy** — a determined operator can still
  supply a weak-but-passing value. Platform-wide session invalidation has no
  API and is operator SQL only. External email delivery is unvalidated. Backup,
  restore, and PITR tooling now exists and is tested (Sprint 25 —
  [backup-and-restore.md](backup-and-restore.md), [pitr.md](pitr.md)), but
  **nothing schedules or stores backups**: there is no backup schedule, no
  encrypted remote backup storage, no continuous WAL archiving on any
  long-lived database, no provider-managed PITR, and no measured RPO/RTO. The
  project remains **not ready for staging or production** (see the
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
- **CodeQL has no local equivalent.** It runs only on GitHub-hosted CI, so a
  fully offline validation run cannot reproduce its findings. The dependency
  audit and secret scan do have local equivalents (`pnpm scan:deps` /
  `pnpm scan:deps:local`, `pnpm scan:secrets` — the latter being a
  full-history scan, i.e. stricter than the per-range CI runs).
- **Most remaining CodeQL alerts are dismissed, not absent** (Sprint 22). All
  41 baseline High alerts were individually triaged with recorded evidence.
  Two true positives were fixed — the audit-read cost (ORG-PR-055) and the
  demo bootstrap's credential output (ORG-PR-056, remediated by removing the
  output entirely, not accepted) — and the rest are false positives the query
  cannot avoid: Orgistry's rate limiters live in the service layer and in the
  API-key authenticator, which `js/missing-rate-limiting` does not model.
  **No accepted clear-text logging risk remains.** A reader looking at the Code scanning tab will see dismissals rather
  than a clean slate; the reasoning for each is in
  [sprint-22-codeql-alert-inventory.md](production-readiness/sprint-22-codeql-alert-inventory.md).
  The practical consequence: this repository cannot use "zero open alerts" as
  a health signal, and relies on the documented dismissal-evidence rule
  instead.
- **Two dependency advisories are accepted, not fixed** (documented
  reachability analyses in the
  [findings register](production-readiness/findings-register.md), pinned in
  `pnpm.auditConfig.ignoreGhsas` + `osv-scanner.toml`): react-router
  GHSA-qwww-vcr4-c8h2 (CSRF in unstable RSC APIs — the web demo is a
  client-only SPA with no RSC usage; the fix is a major upgrade) and
  brace-expansion GHSA-mh99-v99m-4gvg (DoS in a dev-only eslint transitive
  with no compatible fixed release).
- **The drills prove recoverability, not recovery objectives (Sprint 25).**
  The backup/restore drill and the PITR drill run against fixture-sized
  databases in throwaway containers on a laptop or a CI runner. They prove the
  procedures work; they say nothing about how long a restore takes at
  production data volume, and no RPO/RTO has been measured against real
  infrastructure. PITR runs manually and weekly rather than per pull request
  (rationale: [pitr.md](pitr.md)), so a change to the PITR tooling merged
  without running it would not be caught until the next scheduled run.
- **Retention integration tests use aged fixtures, not short windows.** The
  configured retention floors (30/7/1 days) deliberately prevent sub-floor
  production values, so the suite seeds rows with explicit ages against a fixed
  reference instant rather than shortening a window. Boundaries are exercised
  deterministically; a production window shorter than its floor is not
  exercised because it cannot exist.
- **Infrastructure images are tag+digest-pinned (Sprint 23, ORG-PR-042
  closed).** Every active image reference — Dockerfile bases, both compose
  files, CI service containers — is pinned `tag@sha256-digest`, immune to tag
  re-pushes. Residual: workflow `services:` images are outside Dependabot's
  coverage and are bumped manually (procedure in
  [validation.md](validation.md#image-pinning-policy)).

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
- Data durability boundary and backup security rules:
  [backup & restore](./backup-and-restore.md) and [PITR](./pitr.md).
- Retention policy, cleanup safety invariants, and their residuals:
  [retention](./retention.md).
