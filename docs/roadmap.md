# Roadmap

Future work for Orgistry, grouped by category. **Everything in this document is
prospective.** Nothing here is implemented; items describe what *would* be built
next, not current behavior. For what exists today, see the
[architecture overview](./architecture.md) and the
[API surface index](./api-surface.md). For the authoritative list of current
non-goals, see [known limitations](./known-limitations.md).

Items are written to be issue-ready: each has a short rationale and a rough
acceptance signal. They are intentionally scoped as a *reference foundation's*
next steps, not a commercial product backlog.

## How to read this

- **Critical production gaps** — what would have to change before Orgistry could
  responsibly handle real users/data. These are the difference between
  "reference" and "production-capable."
- **Optional enhancements** — valuable but not blockers; they extend or polish.

The two are separated below. Within each category, the most impactful item is
listed first.

---

## Critical production gaps

These are the load-bearing gaps. None should be read as "almost done" — each is a
real body of work with security and correctness implications.

### Production hardening

- **Deployment automation.** No container/release pipeline, infra-as-code, or
  environment provisioning exists. *Would add:* a production Dockerfile per app,
  IaC (Terraform/Helm), and a deploy workflow. *Done when:* a tagged build deploys
  to a target environment reproducibly.
- **Secrets management.** Secrets are local-only `.env` placeholders. *Would add:*
  integration with a secrets manager and a documented rotation procedure for
  `JWT_SECRET` / `COOKIE_SECRET`. *Done when:* no secret is sourced from a
  committed file in any non-local environment.
- **Hardened quota concurrency.** Quota checks read-then-write without a global
  lock, leaving small race windows at the ceiling. *Would add:* transactional
  reservation or row-level locking on the quota path. *Done when:* concurrent
  creates at the limit cannot exceed it.
- **Rate-limit fail-closed option.** Redis-backed limiters fail open by design.
  *Would add:* a configurable fail-closed mode for sensitive surfaces. *Done
  when:* operators can choose availability-vs-protection per surface.
- **Backups and disaster recovery.** No backup/restore story. *Would add:*
  documented backup cadence and a tested restore runbook.

### Observability

- **Metrics and tracing.** Structured JSON logging with request IDs exists;
  metrics and distributed tracing do not. *Would add:* Prometheus-style metrics
  (latency, error rates, rate-limit hits) and OpenTelemetry tracing. *Done when:*
  a dashboard shows per-route latency/error rates and a trace spans a request end
  to end.
- **Health/SLO alerting.** `/health` and `/ready` exist but nothing consumes
  them. *Would add:* alerting on readiness failures and error-budget burn.

### Authorization model extensions

- **PostgreSQL row-level security (RLS).** Tenant isolation is application-layer
  only. *Would add:* RLS policies as defense-in-depth behind the existing
  app-layer scoping. *Done when:* a missing app-layer scope still cannot cross a
  tenant boundary.
- **Audit retention enforcement.** `audit_retention_days` is display-only. *Would
  add:* a retention/cleanup mechanism (needs background processing, below). *Done
  when:* events past retention are actually purged per plan.

---

## Optional enhancements

Valuable extensions that are **not** blockers for a credible reference. Grouped by
the categories a reviewer would expect.

### Authentication extensions

- **Password reset** — email-driven reset flow (needs production email).
- **Email verification enforcement** — gate sensitive actions on a verified
  address; the `email_verification_tokens` table already exists.
- **OAuth / social login** — third-party identity providers.
- **MFA / passkeys** — TOTP and/or WebAuthn second factor.

Each is a deliberate current non-goal ([known limitations](./known-limitations.md))
and a natural extension of the existing auth foundation.

### Authorization / RBAC extensions

- **Custom roles** — per-organization role definitions over the existing
  permission catalog, with role/permission mutation APIs.
- **Resource-level permissions / ABAC** — per-resource ACLs or an attribute/policy
  engine beyond organization-scoped permission keys.
- **API key scope expansion** — additional scopes and key rotation/update
  endpoints (v1 is read-only `projects:read`, no rotation).

### Billing integration

- **Stripe (or equivalent) billing** — checkout, subscriptions, billing portal,
  invoices, and webhook-driven plan changes. The permission/entitlement/quota
  separation was designed so this can be added by changing entitlement/quota
  sources **without** reworking authorization. Plans are currently fixed demo
  plans changed only via the demo endpoint.
- **Custom plans / per-org entitlement overrides** — and a feature-flag system.

### Email provider integration

- **Production email provider** — replace local Mailpit-only SMTP with a real
  provider (deliverability, templates, bounce handling). Invitations, and any
  future password-reset/verification email, depend on this.

### Audit / export features

- **Audit export** — CSV/JSON export of the audit stream.
- **Webhooks / SIEM streaming** — push action events to external systems.
- **Expanded audit coverage** — surface more event types in the public stream.

### Background processing

- **Workers / queues / scheduler** — the enabler for expiry sweeps, audit
  retention deletion, email retries, and other deferred work. Today, expiry is
  derived on read and nothing reclaims storage; several items above depend on this
  capability existing.

### E2E testing

- **Full browser end-to-end suite** — Playwright/Cypress covering the real demo
  flows (login, org switch, quota errors, invitation, API key one-time secret,
  audit). The web demo currently has jsdom component/routing tests only.
- **Live SMTP/Mailpit assertion in CI** — automate the invitation-email path that
  is currently verified manually.

### Frontend / UX improvements

- **Production-quality UI** — the web demo is intentionally thin and
  demo-quality. *Would add:* design polish, loading/empty/error states, and
  accessibility passes — while preserving the thin-consumer, backend-authoritative
  pattern.
- **Richer admin surfaces** — pagination controls, filtering UI for the audit log,
  and inline permission explanations.

### Developer experience

- **OpenAPI spec + generated client** — derive an OpenAPI document from the
  contracts and publish a typed client; today the [API surface index](./api-surface.md)
  is hand-maintained documentation only.
- **Published SDK** — package the external API client.
- **Seed/fixture expansion** — more demo scenarios beyond the single
  `pnpm demo:seed` path.

### Documentation / demo improvements

- **Demo assets** — screenshots of the key web-demo surfaces (overview, members/
  invitations, projects, plan/entitlements, the API key one-time-secret warning,
  audit log) and a short terminal validation excerpt. Currently optional future
  work (no committed screenshots).
- **Architecture diagrams** — rendered diagrams to complement the prose
  architecture overview.
- **Recorded walkthrough** — a short screen capture of the demo flow.

---

## Sequencing note

A pragmatic order, if this were taken further: **background processing** unlocks
audit retention and email reliability; **observability** and **production
hardening** make it operable; **RLS** adds defense-in-depth; **billing** then
slots into the existing entitlement/quota seam; auth extensions and a full **E2E**
suite round it out. UI polish and DX/documentation enhancements can proceed in
parallel at any point.
