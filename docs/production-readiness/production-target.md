# Production Target

Readiness is meaningless without a target to measure against. This document
defines the production profile Orgistry is assessed against, separating what the
repository actually implies from explicit assumptions, and states how the result
would change under a different target.

## Verified project characteristics (repository evidence)

- **Open-source reference foundation.** `LICENSE` is Apache-2.0; `README.md`
  frames Orgistry as an "identity and access foundation … engineering reference /
  portfolio project," explicitly "not production-certified."
- **Self-hostable stack.** `infra/docker-compose.yml` defines PostgreSQL, Redis,
  and Mailpit for local use; there is no cloud IaC, Kubernetes, or managed-service
  assumption anywhere (`git ls-files`).
- **Single backend authority.** `apps/api` (Fastify) is the source of truth;
  `apps/web-demo` is a thin React consumer holding no authority (README,
  `docs/architecture.md`).
- **Modest, multi-tenant B2B shape.** The domain is organizations → memberships →
  roles → permissions → entitlements → quotas → org-scoped resources
  (`docs/architecture.md`). Fixed demo plans (Free/Pro/Business); no billing
  (`packages/db/src/schema/plans.ts`).
- **Local-only email + no background processing** (`docs/known-limitations.md`).
- **No deployment, backup, or observability tooling** (`docs/roadmap.md`).
  *(Sprint 25 update: backup, restore, PITR, and retention TOOLING now exist
  and are tested — see [../backup-and-restore.md](../backup-and-restore.md),
  [../pitr.md](../pitr.md), [../retention.md](../retention.md). Nothing
  schedules or stores them.)*
  *(Sprint 26 update: deployment TOOLING now exists too — registry publishing,
  release manifests, a single-host deployment topology, a deployment executor,
  post-deployment smoke, an evidence ledger, and application rollback, all
  rehearsed end to end ([../deployment.md](../deployment.md)). No deployment
  ENVIRONMENT exists — the release pipeline itself has been executed and both
  images are published to GHCR for the merged Sprint 26 commit, but nothing has
  been deployed to any environment — and observability tooling remains
  absent.)*
  *(Sprint 27 update: **the target must be `linux/amd64` (x86-64)**. The release
  workflow builds on a GitHub-hosted amd64 runner and publishes
  single-architecture images, not manifest lists, so an arm64 host — Graviton,
  Ampere, Apple Silicon — cannot run them without emulation. Since Sprint 27
  this is enforced by the deployment rather than merely documented, and
  `pnpm deploy:preflight` refuses a mismatched candidate host before anything is
  deployed to it ([../deployment.md](../deployment.md#the-architecture-constraint-is-real-and-it-is-now-a-gate)).
  Also corrected: the observed state is that both GHCR packages are currently
  publicly pullable, so a target does not presently need a registry pull
  credential — an observation, not an approved visibility policy.)*
  *(Sprint 27 real-target milestone, 2026-08-27: a **durable staging-like deployment
  environment now exists and has been validated** — a DigitalOcean `linux/amd64`
  host serving public HTTPS origins behind Caddy, running gate-authorised
  releases by immutable digest with a real application rollback proven.
  ORG-PR-001 is CLOSED. The amd64 procurement constraint was satisfied and
  verified by the deployment's own platform gate. **No production environment
  exists**, the staging-like target holds synthetic data only, account email
  does not work there, and observability tooling remains absent. **Sprint 27
  itself remains open** pending publication of its repository changes and the
  required remote workflow validation.)*

## Explicit assumptions

These are not resolved by the repository and are stated as assumptions:

- **A1 — Distribution model:** the primary target is a **self-hosted foundation**
  that a single operator/small team can deploy for their own organization(s),
  with a **low-scale single-tenant/managed hosted evaluation** as the secondary
  path. This matches the Apache-2.0 + Compose + "reference" evidence. It is *not*
  a large multi-tenant public SaaS.
- **A2 — Scale:** low tens of thousands of users, low thousands of organizations,
  modest request rates (tens of req/s peak). Nothing in the repo implies more.
- **A3 — Data sensitivity:** account credentials (hashed), email addresses, IP/UA
  in session/security events, org membership — **moderate PII, no special
  categories, no payment data** (no billing exists).
- **A4 — Single region** deployment initially; multi-region is out of scope.
- **A5 — One operator/small team** runs it; no dedicated 24/7 SRE org.

## Selected production profile

**Profile: Self-hosted, single-region, low-scale multi-tenant B2B identity
foundation, operated by a small team.**

The recommended deployment is the **simplest architecture that satisfies this
profile** — explicitly **not Kubernetes**:

```
            ┌─────────────────────────────────────────────┐
   Internet │  Reverse proxy / TLS termination (nginx/Caddy │
  ──────────▶  or a managed load balancer)                  │
            │   • HSTS, security headers, global rate limit │
            └───────────────┬───────────────────────────────┘
                            │  (trusted proxy hop → trustProxy)
                    ┌────────▼─────────┐        ┌──────────────────┐
                    │  API container   │        │  Static web-demo │
                    │  (Fastify, non-  │        │  (built assets   │
                    │   root, N≥2)     │        │   behind proxy)  │
                    └───┬─────────┬────┘        └──────────────────┘
                        │         │
              ┌─────────▼──┐  ┌───▼────────┐   ┌────────────────────┐
              │ Managed    │  │ Managed    │   │ Real SMTP/email    │
              │ PostgreSQL │  │ Redis      │   │ provider (TLS+auth)│
              │ +backups/  │  └────────────┘   └────────────────────┘
              │  PITR      │
              └────────────┘
       + Scheduler/worker for maintenance jobs (retention/expiry)
       + Secrets manager + CI/CD build→migrate→deploy pipeline
```

Two API replicas behind the proxy cover rolling deploys and basic availability;
managed Postgres/Redis remove most operational burden at this scale. A single
scheduler runs maintenance jobs. No queue system, service mesh, or orchestrator
is required at A2 scale.

## Objectives

**These objectives are assumption-derived, not repository-verified facts.** Every
value below follows from assumptions A1–A5 and the decision gates DG-1…DG-5; the
repository does not specify availability, latency, RPO/RTO, operator model, region,
traffic, or compliance regime. Treat each as a proposed target to confirm, not an
established requirement.

| Objective | Target (this profile — assumption) | Rationale / how it changes under a larger target |
| --- | --- | --- |
| **Availability** | ~99.5% (single region, rolling deploys) | A public multi-tenant SaaS would demand ≥99.9% + multi-AZ, changing infra materially. |
| **Latency** | p95 < 300 ms for API reads at A2 scale | Requires the audit-read index (ORG-PR-014) and pool/statement timeouts (ORG-PR-021). |
| **RPO** | ≤ 1 hour (PITR) before production data; daily snapshot acceptable for controlled evaluation | Larger/regulated targets push RPO toward minutes + cross-region replicas. |
| **RTO** | ≤ 4 hours, via rehearsed restore | Restore and PITR procedures are rehearsed against SYNTHETIC data (S25) and pass; not yet rehearsed against a real environment or production-sized data, and no recovery time has been measured (ORG-PR-005). Larger target → automated failover. |
| **Email delivery** | Authenticated TLS SMTP/API provider with verified domain (SPF/DKIM/DMARC published) | Blocking for invitations/recovery (ORG-PR-002). The adapter and credential plumbing exist; no provider send, inbox receipt, or domain authentication has ever been validated. |
| **Billing** | **None** (fixed demo plans) | Out of scope; the entitlement/quota seam is designed to accept billing later without reworking authorization. |
| **Operator model** | Small team, business-hours on-call, runbook-driven | Larger target → dedicated on-call + SLOs/error budgets. |
| **Compliance exposure** | Moderate PII → data-subject rights (export/delete), retention, breach process (**legal review required**) | GDPR/CCPA-like obligations if serving EU/CA users; special categories or payment data would add PCI/other regimes. |
| **Support** | Best-effort, self-service docs + issue tracker | — |

## Self-hosted vs. hosted implications

- **Self-hosted foundation (primary):** the operator owns infrastructure, secrets,
  backups, and compliance. Orgistry must ship a deployable artifact
  (ORG-PR-001), production config guards (ORG-PR-003), secrets/rotation guidance
  (ORG-PR-006), a real mailer adapter (ORG-PR-002), and operations docs
  (ORG-PR-027). Availability/backup/DR become the operator's responsibility, but
  Orgistry must make them *possible and documented*. Sprint 26 shipped the
  deployment path a self-hosting operator actually needs — a single-host
  Compose topology, a promote-by-digest deployment script, post-deployment
  smoke, deployment evidence, and rollback, matching the profile chosen here
  and explicitly not Kubernetes; it is rehearsed, not executed against any
  host. Sprint 23 shipped the
  artifact; Sprint 15 the config guards; Sprint 24 the runtime secret
  injection sources (direct env or mounted `<NAME>_FILE`), graceful
  access-token key rotation, and the rotation/incident guidance
  ([../runtime-secrets.md](../runtime-secrets.md),
  [../rotation-runbook.md](../rotation-runbook.md)) — which is guidance and
  mechanics for a self-hosting operator, **not** a managed secret store, and
  does not close ORG-PR-006. The mailer adapter exists but has never delivered
  through a real provider (ORG-PR-002).
- **Hosted SaaS (secondary):** Orgistry (the operator) additionally owns
  observability (ORG-PR-007), incident response (ORG-PR-008), retention/privacy
  enforcement (ORG-PR-015/025/043), and abuse controls (ORG-PR-009/012/013). The
  multi-tenant abuse/DoS surface raises the priority of edge rate limiting and the
  audit-table findings.

Both paths share the same P1 blockers; the hosted path adds operational P2s.

### Findings whose severity/scope is target-dependent

The register severities assume this target profile. These findings shift with the
decision gates:

| Finding | Impact classification |
| --- | --- |
| ORG-PR-001, 002, 003, 004, 005, 006 | Applies to both deployment models (P1 either way) |
| ORG-PR-009, 012, 013 (abuse/DoS controls) | Higher priority under **hosted** multi-tenant exposure; severity depends on DG-1 |
| ORG-PR-007, 008 (observability/incident) | Operator responsibility when **self-hosted**; a hosted-only launch blocker under DG-1 |
| ORG-PR-029 (quota TOCTOU) | P3 today; **rises to P2 if DG-4** makes quotas billing-enforced |
| ORG-PR-005 backup design | Scope set by **DG-5** RPO/RTO (daily snapshot vs. ≤1h PITR) |
| ORG-PR-017 (Admin→Owner) | Resolution is a **DG-2** product policy decision |
| ORG-PR-025, 043 (privacy) | **Legal review required**; scope set by DG-3 |

## Decision gates

Current status is tracked in [sprint-15-decisions.md](sprint-15-decisions.md).
**DG-1, DG-2, and DG-5 were ratified by the Project Owner on 2026-07-18**;
DG-3 and DG-4 remain open. The profile and objective values in this document
were originally engineering assumptions (as the sections above record); the
distribution model (A1) and the RPO/RTO objectives are now owner-approved
decisions via DG-1/DG-5.

- **DG-1 — Distribution model confirmation.** *RATIFIED (Project Owner,
  2026-07-18):* self-hosted primary / low-scale hosted evaluation secondary;
  explicitly not a large public SaaS.
- **DG-2 — Role-transition policy.** *RATIFIED (Project Owner, 2026-07-18):*
  only an active Owner may grant or remove the Owner role; Admins may not
  confer Owner on themselves or others; last-owner protection remains
  mandatory. Enforcement is Sprint 19 work (ORG-PR-017 stays open until then).
- **DG-3 — Compliance regime.** Which privacy regime(s) apply (drives ORG-PR-025/
  043 scope). **Legal review required.** *Open.*
- **DG-4 — Quota semantics.** Whether quotas will ever gate billing raises
  ORG-PR-029 from P3 to P2. *Open.*
- **DG-5 — Target RPO/RTO.** *RATIFIED (Project Owner, 2026-07-18):* RPO ≤ 1
  hour with PITR available before production data is accepted (daily
  snapshots only for evaluation-only environments with no production data);
  RTO ≤ 4 hours via a documented, rehearsed restore.
  *Status (Sprint 25, 2026-08-24):* the **capability** DG-5 requires now
  exists and is verified — PITR to an arbitrary target time
  ([../pitr.md](../pitr.md)) and a documented, executed restore procedure
  ([../backup-and-restore.md](../backup-and-restore.md)). The **objectives**
  are not met and cannot be until Phase 4: RPO ≤ 1 h needs continuous WAL
  archiving on a long-lived database (none exists), and RTO ≤ 4 h is an
  unmeasured claim — the drills recover fixture-sized databases in seconds,
  which says nothing about production volume. ORG-PR-005 stays open on exactly
  this gap.

## What this target explicitly is not

- Not an enterprise/Kubernetes-scale platform. Recommending Kubernetes here would
  violate the "simplest architecture that satisfies the profile" principle.
- Not a payment-processing system (no billing exists).
- Not a compliance-certified product; no certification is claimed anywhere in this
  package.
