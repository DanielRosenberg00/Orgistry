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
- **No extended auth.** No OAuth/social login, MFA/passkeys, email verification
  enforcement, or password reset.
- **No production email.** Email is delivered only to the local Mailpit container
  over SMTP. There is no production email provider, and no bulk invites,
  reminders, or invitation UI beyond the web demo flows.
- **No background processing.** No workers, queues, schedulers, or cron. Anything
  that would need a background job (e.g. expiry sweeps, retention deletion) is
  instead derived on read or simply not performed.
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
- **No organization lifecycle endpoints** (archive/suspend) and **no project
  hard-delete or restore** — deletes are soft.
- **No object storage** and **no production deployment automation** (no
  Terraform, Helm, Kubernetes manifests, or release pipeline).

## Testing and validation limitations

- **No full browser end-to-end tests.** The web demo is covered by jsdom
  component/routing tests, not a real-browser E2E harness (Playwright/Cypress).
- **Mailpit/SMTP is not exercised by automated tests.** The invitation mailer has
  unit coverage; the live SMTP delivery path is verified manually via the local
  Mailpit container and the [demo walkthrough](./demo-walkthrough.md). CI does not
  run Mailpit.
- **Integration tests require live PostgreSQL + Redis.** Without them the
  integration suites skip (with a warning), so a fully offline run validates
  types, lint, unit tests, the web build, and schema drift — but not the live DB
  paths. See the [validation matrix](./validation.md).

## Accepted runtime compromises

- **Quota race windows.** Quota checks (e.g. `max_projects`, `max_members`,
  `max_api_keys`) read-then-write without a global lock, so two highly concurrent
  requests could in principle both pass a check at the ceiling. This is an
  accepted demo-scale trade-off; the invariant is enforced per request, not under
  adversarial concurrency.
- **Rate limits fail open.** The Redis-backed fixed-window limiters allow requests
  when Redis is unavailable rather than blocking them, so a Redis outage never
  breaks authentication. The cost is that rate limiting is unavailable during such
  an outage.
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
