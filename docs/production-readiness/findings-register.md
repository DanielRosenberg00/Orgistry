# Findings Register

Authoritative source for all Sprint 14 production-readiness findings. Every other
document references these IDs and must not restate a different severity or title.
Severity, classification, and confidence conventions are defined in
[README.md](README.md#finding-severity-conventions).

**No P0 findings.** P0 denotes an immediate critical risk requiring emergency
remediation before any further work. The audit found no such condition: no
evidence of an active compromise, no exposed production secret in the repository
or its history, no data-loss event, and no immediately exploitable critical flaw
in the implemented code. The highest-severity confirmed gaps are the *absence* of
a production envelope (deployment, email, config guards, recovery, backup, secrets
management); these are production-launch blockers and are therefore classified P1.
A P1 finding is held at P1 — not lowered — even though it would only become
critical once the system is deployed as-is; severity is not reduced because the
system is pre-production.

Counts: **6 P1**, **22 P2**, **17 P3**, **9 P4** — 54 total (at Sprint 14 audit
time; original entries below are preserved as recorded).

**Status update (Sprint 15, 2026-07-18):** [ORG-PR-003](#org-pr-003) (P1) and
[ORG-PR-047](#org-pr-047) (P4) are **Closed** with implementation and test
evidence — see the *Resolution* line appended to each entry. **Open P1
production blockers: ORG-PR-001, ORG-PR-002, ORG-PR-004, ORG-PR-005,
ORG-PR-006.** In particular, ORG-PR-006 (secrets management/rotation) is *not*
closed by the Sprint 15 config guard — rejecting weak secrets is not secrets
management. The repository remains not ready for staging or production.

**Status update (Sprint 16, 2026-07-18):** [ORG-PR-024](#org-pr-024) (P2) and
[ORG-PR-048](#org-pr-048) (P4) are **Closed** — the full email-verification
lifecycle is implemented, active product behavior, and lifecycle-tested (unit +
DB-backed integration, including concurrent-completion race coverage).
[ORG-PR-002](#org-pr-002) (P1) **remains Open, materially advanced**: a
production SMTP adapter (nodemailer transport: implicit TLS with verification,
negotiated SASL auth), deterministic driver selection, and fail-closed
production mail config now exist, but **no delivery through a real external
provider to a real inbox has been performed** (no provider credentials in any
validation environment) — adapter existence is not delivery evidence. **Open P1 production blockers: ORG-PR-001, ORG-PR-002,
ORG-PR-004, ORG-PR-005, ORG-PR-006.** The repository remains not ready for
staging or production. See
[email-and-verification.md](../email-and-verification.md).

**Status update (Sprint 17, 2026-07-20):** [ORG-PR-004](#org-pr-004) (P1) and
[ORG-PR-039](#org-pr-039) (P3) are **Closed** — the full credential lifecycle
(enumeration-safe password recovery over a dedicated hash-only
`password_reset_tokens` table with `FOR UPDATE` race-safe completion and full
session/refresh revocation; current-password-gated password change and email
change) is implemented, lifecycle-tested (unit + DB-backed integration,
including the concurrent-completion race), and documented — see the
*Resolution* line on each entry and
[credential-management.md](../credential-management.md).
[ORG-PR-030](#org-pr-030) (P3) **remains Open, materially advanced**: the
registration duplicate-email 409 is now bounded by a per-email-digest rate
limit and recorded as a durable probe event, but the conflict itself is still
distinguishable; full response uniformity requires a verification-first
registration redesign. **Open P1 production blockers: ORG-PR-001, ORG-PR-002,
ORG-PR-005, ORG-PR-006.** The repository remains not ready for staging or
production.

**Status update (Sprint 18, 2026-07-20):** [ORG-PR-030](#org-pr-030) (P3) is
**Closed** — public registration is now verification-first: the request
endpoint answers one contract-identical `200 { accepted: true }` for every
post-validation account state (eligible new email, existing active account,
unverified account, disabled account, soft-deleted account, and every
internal failure), creates no user/session/token/cookie, and the account is
created only by the emailed single-use completion token. `409
EMAIL_ALREADY_REGISTERED` no longer exists on any public surface (it remains
only on the authenticated, password-re-proved email-change flow). Closure is
proven by a direct response-equality test matrix plus DB-backed issuance- and
completion-concurrency tests — see the *Resolution* line on the entry and
[auth-foundation.md](../auth-foundation.md). A residual (documented, accepted)
side channel remains: response *timing* is not fully equalized (Argon2id is
now spent identically on all paths, but the eligible-new-email path still
performs one insert + one email hand-off), and the rate limits bound how fast
that signal can be sampled. **Open P1 production blockers: ORG-PR-001,
ORG-PR-002, ORG-PR-005, ORG-PR-006.** The repository remains not ready for
staging or production.

**Status update (Sprint 19, 2026-07-21):** the edge and application security
hardening sprint closes [ORG-PR-010](#org-pr-010) (typed `TRUST_PROXY` applied
at Fastify construction; forwarded-header spoofing rejected when untrusted),
[ORG-PR-011](#org-pr-011) (centralized security-header policy on every
response with production-only HSTS; no API-level CSP claim — the frontend CSP
remains ORG-PR-035), [ORG-PR-012](#org-pr-012) (global per-trusted-IP limiter
plus a reconciled public abuse-control matrix including `invitations/inspect`
per-IP + per-token-digest throttling), [ORG-PR-013](#org-pr-013) (durable
failed-auth `security_events` writes bounded per source IP per window, proven
by a DB-backed storm test), [ORG-PR-032](#org-pr-032) (per-user/per-org
buckets on organization/project/API-key/invitation creation and demo plan
change, enforced after permission checks), [ORG-PR-033](#org-pr-033)
(centralized pino redaction with log-capture tests), and
[ORG-PR-052](#org-pr-052) (request-id sanitization/replacement, coarse
production `/ready`, bounded idempotent shutdown).
[ORG-PR-009](#org-pr-009) (P2) is **Materially advanced, not closed**: the
limiter store now reports outages explicitly, every sensitive bucket fails
closed under the production-default `RATE_LIMIT_FAILURE_MODE=closed` (the
guard refuses `open` in production), and the behavior is tested — but the
finding's alerting half (a metric/alert when the limiter store is down)
depends on ORG-PR-007 observability, which remains open. Fail-closed behavior
does not replace monitoring. **Open P1 production blockers: ORG-PR-001,
ORG-PR-002, ORG-PR-005, ORG-PR-006 — unchanged.** The repository remains not
ready for staging or production. See
[sprint-19-artifact-package.md](sprint-19-artifact-package.md).

**Status update (Sprint 21, 2026-07-26):** supply-chain and CI hardening.
Sprint 21 repository implementation is complete; ORG-PR-020 remains open
pending first remote CI execution and negative-path enforcement evidence.
[ORG-PR-018](#org-pr-018) (P2) **Closed** — `drizzle-orm` upgraded to
0.45.2 (the GHSA-gpj5-g38j-94v9 fix release) via pnpm; the advisory no longer
appears in any scan, and the drizzle ≥0.44 `DrizzleQueryError` wrapping is
handled by a shared, unit-tested cause-chain SQLSTATE helper so every
unique-violation guard still classifies correctly (live-PostgreSQL integration
suite green). [ORG-PR-054](#org-pr-054) (P4) **Closed** — every vulnerable
`esbuild` copy is gone (`drizzle-kit` 0.31.10 plus a scoped override for its
deprecated `@esbuild-kit` chain). [ORG-PR-019](#org-pr-019) (P2) **Closed** —
every workflow action is pinned to a verified full commit SHA with explicit
least-privilege `permissions:` and `concurrency` groups; Dependabot proposes
pin updates. [ORG-PR-040](#org-pr-040) (P3) **Closed** —
`noUncheckedIndexedAccess` is enabled in the shared tsconfig for every project;
all 297 resulting errors fixed with no suppressions.
[ORG-PR-020](#org-pr-020) (P2) **remains Open, materially advanced**:
dependency audit (pnpm `--audit-level high` gates), secret scanning (Gitleaks
with a narrow documented allowlist), SAST (CodeQL), and Dependabot are fully
configured and validated locally where locally runnable — but none of the new
workflows has yet executed on GitHub-hosted CI, and configuration is not
execution evidence. [ORG-PR-042](#org-pr-042) (P3) **remains Open, materially
advanced**: every development/CI image is pinned to an exact patch tag
(`postgres:16.14-alpine`, `redis:7.4.10-alpine`, `axllent/mailpit:v1.30.5`);
digest pinning is deferred to the production-artifact track (ORG-PR-001). Two
accepted dependency-advisory exceptions are recorded with reachability
analyses (react-router GHSA-qwww-vcr4-c8h2 — RSC-only CSRF, no RSC usage in
the client-only SPA; brace-expansion GHSA-mh99-v99m-4gvg — dev-only eslint
chain with no compatible fixed release), each pinned in
`pnpm.auditConfig.ignoreGhsas` and `osv-scanner.toml`. **Open P1 production
blockers: ORG-PR-001, ORG-PR-002, ORG-PR-005, ORG-PR-006 — unchanged**
(ORG-PR-015 also remains open). The repository remains not ready for staging
or production. See
[sprint-21-artifact-package.md](sprint-21-artifact-package.md).

**Status update (Sprint 22, 2026-07-26):** CodeQL alert triage and CI gate
closure. All 41 High alerts from CodeQL's first operational run were
individually triaged with source/sink evidence, grouped into ten root causes,
and given individual GitHub dispositions — see
[sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md).
[ORG-PR-020](#org-pr-020) (P2) **Closed**: all three workflows ran green
remotely on `c33a150f`; a temporary branch proved the Gitleaks job actually
FAILS on a seeded synthetic secret (run 30207672121, `generic-api-key`,
redacted output, branch deleted and never merged); CodeQL findings are fully
triaged; and a `main` ruleset now makes the CI, Security, and CodeQL checks
required, so a scanner failure blocks the merge rather than merely being
visible. Two findings were opened by the triage itself.
[ORG-PR-055](#org-pr-055) (P3) **Mitigated** — the audit-log read was the one
true positive in the 34 `js/missing-rate-limiting` alerts: its `targetId`
filter compares against five un-indexed JSONB metadata keys over a table with
no retention policy, so a filter matching nothing scanned the organization's
entire event slice, bounded only by a coarse per-IP ceiling. Per-user and
per-organization buckets now bound it; the underlying scan cost remains open.
[ORG-PR-056](#org-pr-056) (P4) **Closed** — the demo bootstrap emitted a
one-time API key secret to stdout. The completion iteration removed the sink
outright rather than accepting it: the bootstrap no longer creates an API key
at all, prints no credential of any kind, and points at the web demo's API
Keys page, where the backend hands the raw secret straight to the browser
once. **No accepted clear-text logging risk remains.** Everything else was proved a
false positive with recorded evidence: the password/token hashing boundary is
Argon2id-only for all seven password paths, and both flagged modulo operations
are exactly uniform (256 = 32 x 8). **Open P1 production blockers: ORG-PR-001,
ORG-PR-002, ORG-PR-005, ORG-PR-006 — unchanged.** The repository remains not
ready for staging or production. See
[sprint-22-artifact-package.md](sprint-22-artifact-package.md).

**Status update (Sprint 23, 2026-08-23):** deployable artifact — **Sprint 23
DoD MET**: local implementation/validation complete, merged as PR #28 (7/7
checks successful, implementation commit `37a586c`), post-merge `main`
(`6019db8`) workflows all green (CI 32650121796 incl. the
`Artifacts (build + smoke)` job / Security 32650121899 / CodeQL
32650121792), and the artifact check is registered as a required check in
ruleset 19769611 (API-verified — the gate is branch-enforced).
[ORG-PR-042](#org-pr-042) (P3) **Closed**: every
active image reference —
both new production Dockerfiles, both `infra/` compose files, and the CI
service containers — is pinned exact patch tag PLUS manifest-list digest; no
floating references remain, and the one Dependabot coverage gap (workflow
`services:` images) has a documented manual bump procedure.
[ORG-PR-001](#org-pr-001) (P1) **remains Open, materially advanced**: the
repository now has non-root production container artifacts for the API
(esbuild bundle of the existing entrypoints + lockfile-exact production
node_modules) and web (static nginx), an explicit one-shot migration
entrypoint, a production-like compose validation reference, and a
branch-required CI build + smoke gate (green locally, on PR #28, and on
`main` @ `6019db8`) proving `NODE_ENV=production` boot, health/readiness,
secret hygiene, and clean shutdown from the packaged artifacts — but the
finding's deployment half (a pipeline that promotes artifacts to a target
environment, with migration orchestration and rollback) still does not exist.
[ORG-PR-006](#org-pr-006) (P1) **remains Open, advanced only at the
boundary**: the artifacts define and enforce the runtime secret-injection
seam (no secrets at build time, no `.env` in images, environment-only at
process start) that a future secrets manager plugs into; there is still no
manager, no rotation procedure, and no rehearsed `JWT_SECRET` rotation —
documentation of an injection boundary is not secrets management. **Open P1
production blockers: ORG-PR-001, ORG-PR-002, ORG-PR-005, ORG-PR-006 —
unchanged.** The repository remains not ready for staging or production. See
[sprint-23-artifact-package.md](sprint-23-artifact-package.md) (final) and
[../deployment-artifacts.md](../deployment-artifacts.md).

**Status update (Sprint 24, 2026-08-23):** **Sprint 24 is COMPLETE and its DoD
is MET** (all required remote checks green for implementation commit `de6780f`
on PR #33: CI `32663739832`, CodeQL `32663739811`, Security scans
`32663739952`) — and **no finding was closed.** That combination is the
specification-permitted outcome, not a contradiction: sprint completion and
finding closure are separate, and the sprint's external-email condition was
explicitly allowed to be met by a precisely documented blocker.
[ORG-PR-006](#org-pr-006) (P1) **remains Open, materially advanced**: a runtime
secret-source boundary now resolves `<NAME>_FILE` mounted secrets for
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_PREVIOUS_SECRET`,
`SMTP_USERNAME`, and `SMTP_PASSWORD` **before** schema validation and onto the
canonical variable name — so file-backed secrets get byte-identical production
validation and cannot bypass a guard — and graceful access-token key rotation
exists (optional `JWT_PREVIOUS_SECRET`, verification-only, test-proven at the
primitive and route level), together with redaction proofs and written manual
rotation/emergency runbooks. It stays open because there is still no
secrets-manager or platform-store integration, no least-privilege secret
access control, no automated rotation or expiry tracking, no hot reload, and —
decisively — no *rehearsed* rotation, which needs a deployment environment
(ORG-PR-001). [ORG-PR-002](#org-pr-002) (P1) **remains Open, materially
advanced**: SMTP credentials now flow through the same runtime secret boundary
with identical validation, every representative provider failure mode is proven
not to leak the credential, the six account-email families are enumerated with
explicit evidence classes, and a precise operator validation procedure exists —
but **no send through a real external provider to a real inbox was performed**
and **no SPF/DKIM/DMARC posture was validated**, because this environment has
no provider credentials, no verified sending domain, and no readable test
mailbox (repository secrets empty; zero GitHub Actions environments).
[ORG-PR-049](#org-pr-049) (P4) is **materially advanced** — graceful rotation
now works, though no `kid`/versioned-key scheme was introduced. **Open P1
production blockers: ORG-PR-001, ORG-PR-002, ORG-PR-005, ORG-PR-006 —
unchanged** (ORG-PR-015 also remains open). The repository remains not ready
for staging or production. See
[sprint-24-artifact-package.md](sprint-24-artifact-package.md),
[../runtime-secrets.md](../runtime-secrets.md), and
[../rotation-runbook.md](../rotation-runbook.md).

**Status update (Sprint 25, 2026-08-24 — COMPLETE, merged and remotely
validated):** merged to `main` as PR #34 (merge commit `b267f70`;
implementation `e7d5710` + `e55c5a8`) with all seven PR checks green — CI
Validate/Integration/Artifacts (run 32702593281), Security scans dependency
audit + Gitleaks (32702593268), CodeQL analyze (32702593273), and the CodeQL PR
**security gate** (97357238278) — and the merged state of `main` independently
re-validated green. The `Data durability` workflow was then dispatched against
`main` and **passed** (run 32702918307, job 97357955641, 42 s), so the PITR
drill is verified locally **and** on GitHub Actions.

[ORG-PR-015](#org-pr-015) (P2) is **Closed** — a retention policy, a runnable
one-shot cleanup command (source mode and deployable artifact), the indexes its
predicates need, and PostgreSQL-backed safety tests all exist; scheduling
remains deployment-dependent and is tracked under ORG-PR-016.

[ORG-PR-005](#org-pr-005) (P1) **remains Open, materially advanced**: a
repeatable logical backup, a tested restore into a fresh database that reaches
the packaged API artifact, and a **VERIFIED** PostgreSQL PITR drill (base
backup + archived WAL + recovery target time, with post-target damage proven
undone) now exist with command-level runbooks and remote evidence — but
**nothing schedules a backup, no backup is stored remotely or encrypted, no
long-lived database archives WAL, no managed-provider PITR is configured, no
archive health is monitored, and no RPO/RTO has been measured**, all of which
depend on ORG-PR-001. A verified drill is a capability; it is not a backup
posture.

**Open P1 production blockers: ORG-PR-001, ORG-PR-002, ORG-PR-005,
ORG-PR-006 — unchanged.** The repository remains not ready for staging or
production. See
[sprint-25-artifact-package.md](sprint-25-artifact-package.md),
[../backup-and-restore.md](../backup-and-restore.md), [../pitr.md](../pitr.md),
and [../retention.md](../retention.md).

**Status update (Sprint 26, 2026-08-24):** no finding is closed. This is the
specification-permitted outcome for a sprint whose closure criteria depend on
infrastructure that does not exist.

[ORG-PR-001](#org-pr-001) (P1) **remains Open, materially advanced — second
time**. Sprint 23 delivered the artifact half; Sprint 26 delivers the promotion
and deployment MECHANISM: GHCR publishing under immutable commit-SHA tags with
digest capture, a schema-validated release manifest, a build-once/promote-by-
digest contract enforced at four independent points, a single-host deployment
topology that structurally cannot rebuild source, an operator-run deployment
script with a migrate-exactly-once contract and a verified applied migration
head, a reusable post-deployment smoke command, an append-only deployment
evidence ledger that answers "what is running?" and "what would a rollback
restore?", application rollback to the previous known-good digests, and an
end-to-end rehearsal that executes all of it locally and passes. **Why it stays
open:** the finding's required validation is "a tagged build deploys to a
target environment reproducibly". No target environment exists — no host, no
provider account, no deployment credential — and nothing has been deployed to
one. *(The pipeline itself was subsequently executed remotely: see the
Remote validation entry on [ORG-PR-001](#org-pr-001).)* Rollback is validated
only in the rehearsal. Deployment mechanics implemented is not deployment
target validated, and neither is staging readiness.

[ORG-PR-005](#org-pr-005) (P1) **remains Open**, unchanged in substance. Sprint
26 integrated the Sprint 25 backup tooling at the one point where a deployment
creates a new recovery-point requirement — a labelled pre-migration backup whose
artifact and recovery point are recorded in deployment evidence, with an
unexplained skip refused outright. That is integration, not a backup posture:
nothing schedules backups, nothing stores them off-host or encrypted, no
long-lived database archives WAL, no archive-health check exists (there is no
archiving database to check), and no RPO/RTO has been measured. Repository
integration documentation is explicitly insufficient for closure.

[ORG-PR-006](#org-pr-006) (P1) **remains Open**, unchanged in substance. Sprint
26 added deployment-side secret HANDLING — a 0600-enforced runtime configuration
file, `<NAME>_FILE` compatibility preserved, exactly one secret read by the
deployment itself and never logged or passed as an argument, credential-shape
guards on the release manifest and every evidence record, and a publishing
workflow that consumes no long-lived credential. None of that is secrets
management: there is still no secret store, no least-privilege access control,
no read auditing, no automated rotation or expiry tracking, and no rotation
rehearsed against a real runtime. GitHub Environment secrets are documented as
the intended home for a future deployment credential and are **not configured**.

[ORG-PR-002](#org-pr-002) (P1) was explicitly out of scope and is untouched.

**Open P1 production blockers: ORG-PR-001, ORG-PR-002, ORG-PR-005,
ORG-PR-006 — unchanged.** The repository remains not ready for staging or
production. See [sprint-26-artifact-package.md](sprint-26-artifact-package.md)
and [../deployment.md](../deployment.md).

**Status update (Sprint 27, 2026-08-27 — REAL TARGET VALIDATED):**
[ORG-PR-001](#org-pr-001) is **CLOSED** on real durable-target evidence. It is
the first P1 production blocker closed since Sprint 17.

```
Real staging-like target validated   YES
ORG-PR-001                           CLOSED
Sprint 27 DoD met                    NO   (remote validation of the Sprint 27
                                           repository changes is outstanding)
Staging ready                        NO
Production ready                     NO
```

**What was executed.** On 2026-08-27 the Sprint 26 deployment mechanism ran end
to end against a durable DigitalOcean staging-like host (`orgistry-staging-01`,
FRA1, `linux/amd64`, Ubuntu 24.04.4) serving real public HTTPS origins
(`https://staging.drsvp.com`, `https://api-staging.drsvp.com`) behind Caddy with
valid Let's Encrypt certificates:

- **Target preflight PASS** — 0 failed, 0 warned, on the host itself.
- **Target-side digest pulls** — the host pulled both images for both releases
  with **no registry credential of any kind** (`~/.docker/config.json` absent).
- **Release `91664d0` deployed** — backup preflight `taken`, migration applied
  once from the release's own image, applied head `0012_shocking_warbound` (13)
  verified against the manifest, API healthy, web up, **running container
  digests asserted equal to the manifest digests**, smoke 9/9, evidence written.
- **Public HTTPS smoke 9/9** from outside the host — the first public-origin
  smoke evidence in the project's history. The pre-deployment `502` responses on
  both origins became `200`.
- **Durability** — application containers restarted cleanly, `/ready` returned
  200 again after 3s, and the migration ledger held 13 rows before and after.
- **Release `d51c76b` deployed** — same lifecycle, public HTTPS smoke 9/9.
- **Real application rollback** — `91664d0`'s exact digests redeployed with
  `--no-migrate`, public HTTPS rollback smoke 9/9, running images cross-checked
  as Release 1's, and the migration ledger unchanged at 13.
- **Deploy workflow run `33061763360`** bound to the `staging-like` environment
  validated the manifest, confirmed gate authorisation, and resolved both
  digests in the registry.
- **Network boundary** — externally probed: only 22/80/443 reachable; API, web,
  PostgreSQL, Redis, Mailpit, and the Caddy admin endpoint all unreachable from
  the internet.
- **Evidence hygiene** — every evidence file scanned; no credential-bearing URL,
  credential-named key, or secret value anywhere.

The two releases are a genuinely compatible pair — identical migration head,
count, and journal timestamp — and both already existed on `main`. **No release
was manufactured**, and **no source was built on the target**: only the
deployment tooling dependency closure was transferred.

[ORG-PR-002](#org-pr-002) (P1) **remains Open.** No provider was contacted and
no mail reached a real recipient. The target's isolated Mailpit sink has no
external relay. Account-email delivery was not exercised and would currently
fail closed, because `MAIL_DRIVER=smtp` points at a plaintext sink while the
driver requires implicit TLS — correct fail-closed behaviour, and a staging
limitation rather than a deployment defect.

[ORG-PR-005](#org-pr-005) (P1) **remains Open.** The pre-migration backup
preflight executed for real twice on the target, producing dumps with checksums
and provenance sidecars. That is the deployment boundary working. Nothing
schedules backups, stores them off-host, encrypts them, archives WAL, or
monitors archive health; no RPO/RTO is measured; the target has no PITR window;
and **no real-target restore or PITR drill was performed**.

[ORG-PR-006](#org-pr-006) (P1) **remains Open.** Runtime secrets are a 0600 file
on a host. The `staging-like` GitHub Environment now carries an active
deployment-branch policy — a deployment boundary, not secrets management. No
secret store, access control, read auditing, or automated rotation exists.

**Open P1 production blockers: ORG-PR-002, ORG-PR-005, ORG-PR-006.**
The repository is **not** staging ready (account email does not work on the
target and there is no observability there) and **not** production ready. See
[sprint-27-artifact-package.md](sprint-27-artifact-package.md) and
[../deployment.md](../deployment.md).

## Summary table

| ID | Title | Domain | Class | Sev | Conf |
| --- | --- | --- | --- | --- | --- |
| [ORG-PR-001](#org-pr-001) | No production deployment automation (Dockerfiles/IaC/pipeline) — **Closed (Sprint 27, 2026-08-27)**: a durable staging-like target pulled immutable digests itself, deployed two gate-authorised releases with a backup preflight, one-shot migration and verified head, served real public HTTPS origins, passed public smoke 9/9 three times, and completed a real application rollback with verified running digests — all recorded in machine-generated deployment and rollback evidence | Infrastructure | Production blocker | P1 | High |
| [ORG-PR-002](#org-pr-002) | No production email provider (Mailpit-only) — **Open; materially advanced (Sprint 16 adapter + guard; Sprint 24 runtime credential source, failure-mode redaction proofs, family matrix, operator validation procedure): external delivery, inbox receipt, and sender-domain authentication all still unvalidated** | Email/Infra | Production blocker | P1 | High |
| [ORG-PR-003](#org-pr-003) | Dev-default secrets accepted & `COOKIE_SECURE` unenforced under `NODE_ENV=production` — **Closed (Sprint 15)** | Secrets/Config | Production blocker | P1 | High |
| [ORG-PR-004](#org-pr-004) | No password recovery flow — **Closed (Sprint 17)** | Account lifecycle | Product completeness gap | P1 | High |
| [ORG-PR-005](#org-pr-005) | No database backup / PITR / tested restore — **Open; materially advanced (Sprint 25): repeatable logical backup, tested restore into a fresh database reaching the packaged artifact, and a VERIFIED PITR drill; no backup schedule, no encrypted remote storage, no continuous WAL archiving, no provider-managed PITR, no measured RPO/RTO** | Backup & DR | Production blocker | P1 | High |
| [ORG-PR-006](#org-pr-006) | No secrets management or rotation procedure — **Open; materially advanced (Sprint 24): runtime env/file secret sources validated before production guards, graceful JWT key rotation, redaction proofs, manual rotation runbooks; no secrets manager, no automated rotation, no rehearsed rotation** | Secrets/Ops | Production blocker | P1 | High |
| [ORG-PR-007](#org-pr-007) | No observability (metrics/tracing/dashboards/alerts) | Observability | Operational gap | P2 | High |
| [ORG-PR-008](#org-pr-008) | No incident response / production runbook / on-call | Operations | Operational gap | P2 | High |
| [ORG-PR-009](#org-pr-009) | Rate limiting fails open on Redis outage — **Materially advanced (Sprint 19): sensitive buckets fail closed in production; alerting residual → ORG-PR-007** | Auth/App security | Security risk | P2 | High |
| [ORG-PR-010](#org-pr-010) | `trustProxy` unset → per-IP limits and audit IPs invalid behind a proxy — **Closed (Sprint 19)** | Auth/App security | Security risk | P2 | High |
| [ORG-PR-011](#org-pr-011) | No HTTP security headers (helmet) — **Closed (Sprint 19)** | App security | Security risk | P2 | High |
| [ORG-PR-012](#org-pr-012) | No global/edge rate limiting; unauthenticated `invitations/inspect` oracle unthrottled — **Closed (Sprint 19)** | App security | Security risk | P2 | High |
| [ORG-PR-013](#org-pr-013) | External API writes an un-throttled `security_events` row per unauthenticated request — **Closed (Sprint 19)** | App security/Reliability | Reliability risk | P2 | High |
| [ORG-PR-014](#org-pr-014) | `security_events` lacks an `organization_id` index backing the audit read path — **Closed (Sprint 20)** | Database/Perf | Reliability risk | P2 | High |
| [ORG-PR-015](#org-pr-015) | No retention/cleanup for unbounded tables — **Closed (Sprint 25)** | Data governance | Operational gap | P2 | High |
| [ORG-PR-016](#org-pr-016) | No background-processing runtime (workers/scheduler) | Reliability | Operational gap | P2 | High |
| [ORG-PR-017](#org-pr-017) | Admin can escalate self/others to Owner (no role-transition guard) — **Closed (Sprint 20)** | Authorization | Security risk | P2 | Medium |
| [ORG-PR-018](#org-pr-018) | `drizzle-orm` high-severity advisory (installed `<0.45.2`) — **Closed (Sprint 21)** | Supply chain | Security risk | P2 | Medium |
| [ORG-PR-019](#org-pr-019) | CI actions pinned to mutable tags; no workflow `permissions` block — **Closed (Sprint 21)** | CI/CD | Security risk | P2 | High |
| [ORG-PR-020](#org-pr-020) | No dependency/vuln/secret/SAST scanning in CI — **Closed (Sprint 22): scanners run remotely, the secret gate demonstrably fails on a seeded finding, CodeQL findings are fully triaged, and a `main` ruleset makes the checks required** | Supply chain | Operational gap | P2 | High |
| [ORG-PR-021](#org-pr-021) | No DB pool / statement / lock timeouts | Reliability | Reliability risk | P2 | Medium |
| [ORG-PR-022](#org-pr-022) | App and migrations share a single Postgres superuser | Infra/Security | Security risk | P2 | High |
| [ORG-PR-023](#org-pr-023) | No React error boundary; a render throw blanks the SPA | Frontend | Reliability risk | P2 | High |
| [ORG-PR-024](#org-pr-024) | No email verification (unused `email_verification_tokens` scaffolding) — **Closed (Sprint 16)** | Account lifecycle | Product completeness gap | P2 | High |
| [ORG-PR-025](#org-pr-025) | No account deletion / data export (data-subject rights) | Privacy | Compliance dependency | P2 | High |
| [ORG-PR-026](#org-pr-026) | No failure-injection / degraded-dependency integration tests | Testing | Reliability risk | P2 | Medium |
| [ORG-PR-027](#org-pr-027) | No production operations documentation | Documentation | Operational gap | P2 | High |
| [ORG-PR-028](#org-pr-028) | No migration rollback / recovery strategy | Database | Operational gap | P2 | High |
| [ORG-PR-029](#org-pr-029) | Quota ceilings are TOCTOU-racy under concurrency — **Closed (Sprint 20)** | Concurrency | Data-integrity risk | P3 | High |
| [ORG-PR-030](#org-pr-030) | User enumeration on registration — **Closed (Sprint 18): verification-first registration; public register is contract-identical for all account states** | Auth | Security risk | P3 | High |
| [ORG-PR-031](#org-pr-031) | No idempotency keys on create operations | API | Reliability risk | P3 | Medium |
| [ORG-PR-032](#org-pr-032) | Spammable authenticated mutations lack rate limits — **Closed (Sprint 19)** | App security | Security risk | P3 | High |
| [ORG-PR-033](#org-pr-033) | No structured-logger redaction backstop — **Closed (Sprint 19)** | Observability/Security | Maintainability issue | P3 | Medium |
| [ORG-PR-034](#org-pr-034) | "Best-effort" last-used / auth-event writes not isolated | Reliability | Reliability risk | P3 | Medium |
| [ORG-PR-035](#org-pr-035) | No CSP / security meta in the web demo | Frontend | Security risk | P3 | Medium |
| [ORG-PR-036](#org-pr-036) | Frontend UX/robustness gaps (revoke confirm, deep-link, expiry UX, a11y) | Frontend | Developer-experience issue | P3 | High |
| [ORG-PR-037](#org-pr-037) | `reset-test` destructive guard weaker than documented | Database/DX | Maintainability issue | P3 | High |
| [ORG-PR-038](#org-pr-038) | "One personal workspace per user" invariant unenforced — **Closed (Sprint 20)** | Database | Data-integrity risk | P3 | Medium |
| [ORG-PR-039](#org-pr-039) | No password-change / email-change flows — **Closed (Sprint 17)** | Account lifecycle | Product completeness gap | P3 | High |
| [ORG-PR-040](#org-pr-040) | `noUncheckedIndexedAccess` disabled — **Closed (Sprint 21)** | Type safety/DX | Maintainability issue | P3 | High |
| [ORG-PR-041](#org-pr-041) | Mailpit / live SMTP path never exercised in CI | Testing | Operational gap | P3 | High |
| [ORG-PR-042](#org-pr-042) | Docker infra images pinned by floating tags — **CLOSED (Sprint 23): exact patch tag + manifest-list digest on every active reference (Dockerfiles, compose files, CI services)** | Supply chain | Maintainability issue | P3 | High |
| [ORG-PR-043](#org-pr-043) | PII in audit/security metadata with no retention | Privacy | Compliance dependency | P3 | Medium |
| [ORG-PR-044](#org-pr-044) | Narrow concurrency test coverage — **Closed (Sprint 20)** | Testing | Reliability risk | P3 | High |
| [ORG-PR-045](#org-pr-045) | No MFA/passkeys and no security notifications | Account lifecycle | Product completeness gap | P3 | High |
| [ORG-PR-046](#org-pr-046) | Stale/contradictory subsystem documentation | Documentation | Developer-experience issue | P4 | High |
| [ORG-PR-047](#org-pr-047) | `COOKIE_SECRET` required but never used (unsigned cookies) — **Closed (Sprint 15)** | Config | Maintainability issue | P4 | High |
| [ORG-PR-048](#org-pr-048) | `email_verification_tokens` dead schema shipped — **Closed (Sprint 16)** | Database | Maintainability issue | P4 | High |
| [ORG-PR-049](#org-pr-049) | HS256 symmetric JWT with no `kid`/rotation path — **Open; materially advanced (Sprint 24): graceful two-key rotation window implemented and test-proven; no `kid`/versioned-key scheme** | Cryptography | Optional enhancement | P4 | High |
| [ORG-PR-050](#org-pr-050) | Concurrent legitimate refresh revokes family + session (multi-tab logout) | Auth | Reliability risk | P4 | High |
| [ORG-PR-051](#org-pr-051) | Redundant unique index duplicates PK on `role_permissions` | Database | Optional enhancement | P4 | High |
| [ORG-PR-052](#org-pr-052) | Minor API disclosures (`/ready` deps, inbound `x-request-id`, no shutdown timeout) — **Closed (Sprint 19)** | API | Maintainability issue | P4 | Medium |
| [ORG-PR-053](#org-pr-053) | Two read paths skip the permission gate (divergence, no current gap) — **Closed (Sprint 20)** | Authorization | Maintainability issue | P4 | High |
| [ORG-PR-054](#org-pr-054) | `esbuild` moderate dev-only advisory (via `drizzle-kit`) — **Closed (Sprint 21)** | Supply chain | Optional enhancement | P4 | High |
| [ORG-PR-055](#org-pr-055) | Audit-log read has unbounded query cost and no per-actor ceiling — **Found and mitigated (Sprint 22); underlying scan cost open** | API | Security risk | P3 | High |
| [ORG-PR-056](#org-pr-056) | Demo bootstrap printed a one-time API key secret to stdout — **Closed (Sprint 22): secret output removed entirely; key creation moved to the interactive UI** | Tooling | Security risk | P4 | High |

---

## Detailed findings

Fields: Classification · Severity · Confidence · Status (fact/inference/assumption)
· Evidence · Current behavior · Expected production behavior · Risk · Remediation
· Dependencies · Effort (S/M/L/XL) · Required validation · Roadmap phase ·
Standards · Threats.

> **Note on the `Standards:` tags.** Any standard reference in a finding (e.g.
> "ASVS", "SSDF", "SLSA") is an **informal practice-level pointer** into
> [standards-matrix.md](standards-matrix.md), not a verified control identifier.
> Exact standard identifiers were not verifiable in this environment; see the
> matrix's verification-basis note. The `Threats:` tags reference
> [threat-model.md](threat-model.md).

<a id="org-pr-001"></a>
### ORG-PR-001 — No production deployment automation
- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact.
- **Evidence:** `git ls-files | grep -i dockerfile` → none; only `infra/docker-compose.yml` (local Postgres/Redis/Mailpit). `.github/workflows/` contains only `ci.yml` (no release/deploy job). `git tag` → empty. All `package.json` are `version: 0.0.0`, `private: true`. `docs/known-limitations.md` confirms "no production deployment automation."
- **Current behavior:** The API and web demo have no container image, no infrastructure-as-code, no environment provisioning, and no deploy pipeline. The apps run only via `pnpm dev:*` locally.
- **Expected production behavior:** A reproducible, immutable artifact per app (multi-stage Dockerfile, non-root runtime) built and promoted by a pipeline to a target environment, with migration orchestration and rollback.
- **Risk:** The system cannot be deployed to production at all; nothing downstream (staging, restore drill, launch) can proceed.
- **Remediation:** Add a production Dockerfile per app, minimal IaC for the selected profile (see [production-target.md](production-target.md)), and a build→migrate→deploy pipeline. **Not implemented during the Sprint 14 audit.**
- **Dependencies:** Requires the production target decision. Blocks ORG-PR-005, ORG-PR-007, ORG-PR-008.
- **Effort:** L. **Validation:** a tagged build deploys to a target environment reproducibly; container runs as non-root.
- **Roadmap:** Phase 4 (Production infrastructure). **Standards:** SLSA build/provenance; SSDF PW.6/PO.3. **Threats:** T-DEP, T-OPS.
- **Progress (Sprint 23, 2026-08-23): Open — materially advanced.** The
  artifact half of this finding is implemented, validated locally and
  remotely (PR #28; `main` @ `6019db8` — CI run 32650121796), and
  branch-enforced (`Artifacts (build + smoke)` is a required check in
  ruleset 19769611):
  `apps/api/Dockerfile` (multi-stage; esbuild bundles of the EXISTING
  `src/server.ts` and `packages/db/scripts/migrate.ts` entrypoints +
  lockfile-exact hoisted production node_modules; non-root `node` user;
  read-only `/app`; no `.env`/source/git in the image) and
  `apps/web-demo/Dockerfile` (Vite production build served by non-root
  nginx-unprivileged with SPA fallback). `infra/compose.production-like.yml`
  is the production-like validation reference (postgres healthy → one-shot
  `node dist/migrate.mjs` → API under `NODE_ENV=production` with fake
  guard-passing config), and `tooling/artifact-smoke.sh` (CI: the
  `artifacts` job in `ci.yml`, local: `pnpm artifact:smoke`) proves build,
  migrate, boot, health/readiness (incl. fail-closed on a Redis stop),
  non-root UIDs, artifact hygiene, secret absence from logs/web assets,
  config-guard rejection of dev secrets, and exit-0 SIGTERM shutdown from the
  PACKAGED artifacts. **Why still open:** the expected production behavior —
  artifacts "built and promoted by a pipeline to a target environment, with
  migration orchestration and rollback" — still has no environment, no
  registry publishing, no promotion/deploy pipeline, and no rollback beyond
  forward-only migrations. Docs: [../deployment-artifacts.md](../deployment-artifacts.md).
- **Progress (Sprint 26, 2026-08-24): Open — materially advanced (second
  time).** The promotion and deployment MECHANISM now exists, is readable, and
  is exercised end to end locally. Implemented:
  `.github/workflows/release.yml` (runs the artifact gate itself, then publishes
  the images that gate produced to `ghcr.io/<owner>/orgistry-{api,web}` under an
  immutable commit-SHA tag, captures registry digests, generates and validates
  the release manifest, uploads it as a workflow artifact; never runs on pull
  requests; `packages: write` on the publish job only; credential is the job's
  own short-lived `GITHUB_TOKEN` on stdin; no secret enters any image build);
  `.github/workflows/deploy.yml` (manual dispatch, bound to a GitHub
  Environment, read-only everywhere — validates a release manifest, refuses a
  release whose artifact gate did not pass, proves both digests still resolve in
  the registry, emits the deployment plan and operator commands);
  `.github/workflows/deployment-rehearsal.yml` (manual + weekly);
  `tooling/release-manifest.mjs` + `tooling/lib/release-manifest.mjs` (the
  release identity: digest-only image references, image tag == source commit,
  migration head/count/journal-timestamp DERIVED from the repository rather than
  supplied, the web image's build-time API origin recorded as part of its
  identity, and a credential-shape guard that refuses anything secret-looking);
  `tooling/deploy-evidence.mjs` + `tooling/lib/deploy-evidence.mjs` (an
  append-only per-environment ledger recording the deployed release, the
  migration outcome and verified head, the backup preflight and its recovery
  point, the smoke result, the digests OBSERVED running on the target, and the
  rollback target — with failed deployments recorded too, and a record unable to
  claim a validated deployment without observed digests);
  `infra/compose.deploy.yml` (deploys only Orgistry's own artifacts, by digest,
  with **no `build:` section anywhere**); `infra/deploy.env.example` (the
  deployment configuration contract, secrets deliberately in a separate
  0600 runtime file); `tooling/deploy.sh` (thirteen named stages: manifest
  validation → no-build assertion → web-origin match → runtime-config
  permission and presence checks → digest pull → backup preflight → migrate
  exactly once from the release's own image → verify the applied head against
  the manifest via Drizzle's ledger → API → web → readiness → verify the RUNNING
  container image IDs are the manifest's digests → smoke → evidence);
  `tooling/deploy-smoke.sh` (eight URL-only checks incl. coarse-readiness
  disclosure, six security headers, request-ID propagation, and reading the API
  origin back out of the SERVED web bundle); `tooling/deploy-rollback.sh`
  (resolves the previous known-good release — smoke passed, not current, not
  already rolled away from — and redeploys those exact digests from that
  release's own manifest, stored on the host, with migrations off); and
  `tooling/deploy-rehearsal.sh` (`pnpm deploy:rehearsal`), which executed the
  whole lifecycle locally and PASSED: build once → publish → digest capture →
  manifest → deploy → migrate once → verified head → readiness → 8/8 smoke →
  evidence → second release → rollback to the previous known-good digests →
  running-container digest verification, plus three proven refusals (a
  tag-pinned manifest, a web image built for another API origin, and a
  group-readable runtime configuration file). 29 new unit tests pin the manifest
  and evidence contracts inside the required `Validate (offline)` check.
  **Why still open — the closure criterion is not met.** The finding requires
  "a tagged build deploys to a target environment reproducibly". **No target
  environment exists**: no host, no provider account, no deployment credential,
  no GitHub Environment. *At the time of this entry* the release workflow had
  not yet run, so no Orgistry image had been published to any registry, and
  `Release`, `Deploy`, and `Deployment rehearsal` had never executed on GitHub
  Actions — all three superseded by the Remote validation entry below (they were
  `actionlint`-clean and their scripts run locally); and rollback is validated
  only in the local rehearsal, between two releases that differ by an image
  label, on a throwaway database. Deployment mechanics implemented is not
  deployment target validated, and neither is staging or production readiness.
  Docs: [../deployment.md](../deployment.md),
  [sprint-26-artifact-package.md](sprint-26-artifact-package.md).
- **Refinement (Sprint 26, 2026-08-24): still Open — three release-integrity
  defects found in review and fixed.** (1) *The web artifact was not actually
  promotable.* `VITE_API_BASE_URL` was compiled into the bundle, so the manifest
  had to record the baked origin and the deployment had to refuse a mismatch —
  safe, but it meant one validated web digest could not move between
  environments, contradicting build-once/promote-by-digest. The browser's public
  configuration now arrives at RUNTIME (`/public-config.js`, rendered by nginx
  from `ORGISTRY_PUBLIC_*` container variables at container start); the web
  Dockerfile takes **no build arguments at all**; `images.web.apiBaseUrl` is gone
  and the schema now refuses ANY non-identity field on an image. Proven at three
  levels: unit tests over the resolver, the artifact smoke test running one image
  as two origins, and the rehearsal promoting one release between two
  configurations with the running digests asserted unchanged. (2) *Rehearsal
  provenance was ambiguous.* A dirty working tree produced images described by a
  clean HEAD SHA with only a printed warning. Manifests now declare
  `release.type` and `source.provenance`; a dirty tree yields `working-tree`
  provenance plus a content fingerprint and can never be `deployable`; a
  rehearsal never carries gate evidence; the release workflow asserts a clean
  checkout; and `deploy.sh` refuses a non-deployable manifest unless the
  environment explicitly declares itself a rehearsal. (3) *Publication was not
  tied to the required checks for the release SHA.* A dedicated `gates` job now
  resolves the actual workflow runs for the exact commit and requires all six
  required checks to have concluded `success` at JOB granularity, recording their
  run IDs in the manifest — which the validator binds to `source.commit`. The
  race is handled explicitly with a bounded wait: a failure fails immediately, a
  missing run is `pending` and never a silent pass, and a timeout publishes
  nothing. `actions: read` is scoped to the gate job and `packages: write` to the
  publish job. **None of this changes the finding's status**: there is still no
  deployment target. *(At the time of this entry nothing had been published and
  no workflow had executed remotely; both were done in the closure pass below.)*
- **Remote validation (Sprint 26 closure, 2026-08-24): Open — materially
  advanced; the pipeline is now EXECUTED, not merely implemented.** Merged as PR
  [#38](https://github.com/DanielRosenberg00/Orgistry/pull/38) (merge commit
  `91664d0fd639ca6ca8b5681317757bbcf0f0209b`) after all six required checks
  passed on the PR head. Against that exact merged SHA: **CI** `32776576684`,
  **Security scans** `32776576586`, **CodeQL** `32776576905` — every required
  JOB `success`; **Release** `32776576782` — its gate job proved those six runs
  for that exact commit (logging `[pending]` and re-polling for ~3 minutes until
  CodeQL concluded, never treating an unreported run as satisfied), then
  published `ghcr.io/danielrosenberg00/orgistry-api@sha256:9b79d72c045f…` and
  `ghcr.io/danielrosenberg00/orgistry-web@sha256:20dc434b7b62…` by re-tagging the
  images its own artifact gate built — the publish job contains no `docker
  build` step. The release manifest was downloaded and independently validated:
  `published`/`deployable`/`commit` provenance, `source.commit` = the merge SHA,
  both image tags = the merge SHA, both references digest-form and matching the
  live registry, the complete six-gate set all bound to that SHA with real run
  IDs, migration head `0012_shocking_warbound` matching the merged journal, and
  no credential-shaped value anywhere. **Deploy** `32777270537` (environment
  `staging-like`) validated the manifest, confirmed deployability and gate
  evidence, resolved both digests in the registry, and emitted the operator
  plan. **Deployment rehearsal** `32777259951` passed with 65 assertions.
  **Data durability** `32777249673` passed, re-verifying PITR after Sprint 26
  modified the Sprint 25 durability tooling. Promotion was proven against the
  PUBLISHED artifact: one web digest started twice with two different public API
  origins serves each correctly, with neither origin present in the bundle.
  Ruleset `19769611` is unchanged — active, zero bypass actors, the same six
  required checks — and no new workflow gates pull requests. **Why still open:**
  the finding requires "a tagged build deploys to a target environment
  reproducibly". **No deployment target exists and nothing has been deployed to
  one.** Publishing and authorising an artifact is not deploying it; rollback
  remains rehearsal-only; the `staging-like` environment has zero protection
  rules; and the published images are single-architecture `linux/amd64`.
- **Progress (Sprint 27, 2026-08-25 — IN PROGRESS): Open — materially
  advanced.** Sprint 27's task is to validate Sprint 26's mechanism against a
  durable staging-like target. That has not happened, so **the Sprint 27
  definition of done is not met and the sprint remains open**. **No
  such target is reachable from this execution environment** — no provider CLI
  is installed (`flyctl`, `doctl`, `hcloud`, `aws`, `gcloud`, `az`, `terraform`:
  all absent), no SSH key material exists (`~/.ssh` holds only a `known_hosts`
  with a single `github.com` entry), no target hostname, DNS name, or TLS
  certificate is configured anywhere, and no deployment credential exists. That
  is the exact, unmet external prerequisite; everything below is what was done
  instead, and none of it substitutes for it.

  **Two findings that a locally built rehearsal cannot produce.** (1) *Observed
  state: the GHCR packages are currently publicly pullable, not private as
  Sprint 26 recorded.* Proven by pulling both published digests with
  `DOCKER_CONFIG` set to an empty directory — no stored credential could have
  been used — and by an anonymously issued registry token listing tags with
  `200`. *Operational implication:* a deployment host does not currently need a
  registry credential, so the staging blocker "a pull credential for the host"
  is not currently blocking, and the images are already proven to contain
  nothing secret by `tooling/artifact-smoke.sh`. *Policy implication:* this is
  an observation of the current state, **not an approved visibility policy** —
  visibility remains an operator decision, nothing here changed it, and no
  approval is recorded anywhere in this repository. It is also not a
  secrets-management capability and closes nothing in ORG-PR-006. (2) *The
  deployment had no image/host architecture check.* The published images are
  single-architecture `linux/amd64` — a single manifest, not a manifest list —
  and a pull is architecture-agnostic, so an arm64 host pulls them successfully
  and fails only when a container starts. Before Sprint 27 that surfaced four
  stages later as "the API container did not become healthy", **after the backup
  preflight and the migration had already run against the target's database**.
  `pnpm deploy:rehearsal` builds its images locally, so they are always native
  and can never mismatch: this class of defect is invisible to it by
  construction.

  **Implemented:** `deploy_normalize_architecture`, `deploy_image_platform`,
  `deploy_host_platform`, and `deploy_assert_image_runs_on_host` in
  `tooling/lib/deploy-common.sh`; a new stage 5 in `tooling/deploy.sh` that runs
  immediately after the digest pull and before the backup preflight, so a
  platform mismatch aborts while the target is still untouched. Both spellings
  of each architecture are normalised (`docker info` reports `aarch64`/`x86_64`,
  an image reports `arm64`/`amd64`) because a gate that fails closed on correct
  input gets disabled. Emulation is accepted only on the exact opt-in
  `ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH=yes` (`true` and `1` are refused)
  and is then written onto the deployment record as a limitation stating that
  runtime behaviour and performance are unproven. Ten unit tests in
  `tooling/deploy-platform-guard.test.ts` drive the real shell functions through
  bash rather than re-implementing the rule, and run inside the required
  `Validate (offline)` check. Also new:
  `tooling/deploy-target-preflight.sh` (`pnpm deploy:preflight`), a read-only
  host-qualification tool covering the deployment toolchain, the host baseline
  including whether Docker starts at boot, release pullability and platform from
  that host, and the configuration boundary (environment class, runtime-file
  permissions, loopback binds, HTTPS public origin, evidence/backup directory
  permissions). It collects every problem rather than stopping at the first, and
  stats the runtime configuration file without reading it.

  **Evidence upgraded from stand-ins to the real artifacts.** The entire
  lifecycle ran against the images GHCR actually serves: unauthenticated digest
  pull of both images for both releases → deploy `91664d0` (backup preflight
  taken, migrations applied exactly once, applied head `0012_shocking_warbound`
  verified against the manifest, API healthy, web up, running container digests
  verified, 9/9 smoke, evidence recorded) → deploy the second compatible release
  `d51c76b` (9/9 smoke; rollback target resolved to `91664d0`) → roll back to
  `91664d0` by digest with `--no-migrate` (9/9 smoke; running digests confirmed
  to be `91664d0`'s). Both releases already existed on `main` from Sprint 26 and
  declare the same migration head with the same migration count, so the pair is
  genuinely schema-compatible and **no release was manufactured for the test**.
  The refusal path was exercised too: on the arm64 host, both the preflight and
  `tooling/deploy.sh` correctly refused the release before any database
  operation.

  **Why it stays open — the closure criterion is unchanged and unmet.** The
  finding requires "a tagged build deploys to a target environment
  reproducibly", and ORG-PR-001's closure list requires that evidence on a
  *durable* target. Sprint 27's run was a local rehearsal on a workstation: it
  had no durability (every container, volume, and network was destroyed on
  completion), **no TLS, no DNS, no public origin** — smoke reached
  `127.0.0.1`, not a configured public origin — no reverse proxy, no reboot
  survival, and it ran under CPU emulation, which no Orgistry validation
  exercises — and because emulation lets a mismatched image run, such a
  deployment is distinguishable from a native one only by the limitation written
  onto its evidence record. That evidence tier is **published-artifact local
  rehearsal**. It is not a target, it is not staging readiness, and it is not
  production readiness. Docs:
  [../deployment.md](../deployment.md),
  [sprint-27-artifact-package.md](sprint-27-artifact-package.md).
- **Resolution (Sprint 27, 2026-08-27): CLOSED — real durable-target
  deployment and rollback evidence exists.** The finding's validation criterion
  was "a tagged build deploys to a target environment reproducibly; container
  runs as non-root". Both halves are now satisfied by evidence from a durable
  external target rather than a rehearsal.

  **Target:** `orgistry-staging-01`, a DigitalOcean droplet in FRA1 —
  `linux/amd64`, Ubuntu 24.04.4, kernel 6.8.0-138, 2 vCPU / 4 GiB / ~74 GiB
  free, Docker Engine 29.7.2 and Compose v5.5.0, Docker enabled at boot, all
  containers `restart=unless-stopped`, PostgreSQL 16.14-alpine on a named volume
  and Redis 7.4.10-alpine on the `orgistry-deploy` network with **no host port
  bindings**. Public origins `https://staging.drsvp.com` and
  `https://api-staging.drsvp.com` behind Caddy v2.11.4 with Let's Encrypt
  certificates valid to 2026-11-25. Inbound exposure externally probed:
  **22/80/443 only**. Synthetic data only; no real user data.

  **Closure evidence, element by element.**
  *Durable target exists* — survives container restart with data intact
  (migration ledger 13 before and after) and is enabled at boot.
  *Target-side immutable pulls* — the host pulled
  `orgistry-api@sha256:9b79d72c045f…` and `orgistry-web@sha256:20dc434b7b62…`
  (and the Release 2 pair) **with no registry credential present on it at all**.
  *Real digest deployment* — `tooling/deploy.sh` ran its full stage sequence
  twice, refusing anything not digest-pinned and asserting the compose topology
  has no `build:` section.
  *Backup/PITR preflight* — `taken` before each migration, producing
  `orgistry-20260827T100354Z-pre-deploy.dump` and
  `orgistry-20260827T100654Z-pre-deploy.dump` with checksums and provenance
  sidecars, recovery points `10:03:59Z` and `10:06:59Z`.
  *Migration* — applied exactly once per deployment from the release's own API
  image; the API never migrates at boot.
  *Verified head* — `0012_shocking_warbound`, 13 applied migrations, checked
  against the manifest through Drizzle's ledger on the target's own database.
  *Real public operation* — both public HTTPS origins returned `200` where they
  had returned `502` before deployment.
  *HTTPS post-deployment smoke* — `tooling/deploy-smoke.sh` from outside the
  host, **9/9 after Release 1, 9/9 after Release 2, 9/9 after the rollback**,
  including coarse readiness disclosure, six security headers, request-ID
  propagation through the proxy, and reading the API origin back out of the
  served bundle.
  *Second compatible release* — `d51c76b5ee6b0d6183b76ac4b8efacdee94ae704`
  (Release run `32779601026`), identical migration head, count, and journal
  timestamp to `91664d0fd639ca6ca8b5681317757bbcf0f0209b` (run `32776576782`);
  both pre-existing on `main`, neither manufactured.
  *Real application rollback* — `tooling/deploy-rollback.sh` resolved Release 1
  from the host's own ledger and redeployed its exact digests with
  `--no-migrate`; `docker inspect` confirmed the running images are Release 1's,
  and the migration ledger stayed at 13, proving application rollback does not
  reverse migrations.
  *Evidence* — three machine-generated records under
  `/opt/orgistry/evidence/staging-like/`, each carrying the release identity,
  full gate authorisation, public-config fingerprint, migration and backup
  results, smoke result, and the digests **observed running**. Both deployed
  manifests are stored alongside them, so the host can resolve a rollback
  without the registry or an expired artifact. Scanned: no credential material.
  *Environment boundary reconciled* — Deploy workflow run `33061763360`
  (`workflow_dispatch`, `main`, success) bound to the `staging-like` GitHub
  Environment validated the manifest, confirmed gate authorisation, and resolved
  both digests; the environment now carries an active deployment-branch policy
  (`protected_branches: true`). Reviewer separation is unavailable on a
  single-maintainer repository and is a documented limitation, which the Sprint
  Specification permits.
  *Non-root* — unchanged since Sprint 23 and re-proven by the artifact gate that
  authorised both releases.

  **The operator-assisted boundary was preserved.** GitHub Actions does not
  reach into the target and **no inbound exposure was created** to let it. Only
  the deployment tooling dependency closure was transferred to the host — no
  Dockerfile, no application source, no `packages/` — so the target is
  structurally incapable of building the application.

  **What this closure does NOT mean.** It is not staging readiness: account
  email does not work on that target (`MAIL_DRIVER=smtp` against a plaintext
  Mailpit sink, while the driver requires implicit TLS — correct fail-closed
  behaviour), and there is no observability there. It is not production
  readiness: ORG-PR-002, ORG-PR-005, and ORG-PR-006 remain open, and the target
  holds synthetic data only. No real-target restore or PITR drill was performed.
  Docs: [../deployment.md](../deployment.md),
  [sprint-27-artifact-package.md](sprint-27-artifact-package.md).

<a id="org-pr-002"></a>
### ORG-PR-002 — No production email provider (Mailpit-only)

> **Status: OPEN — materially advanced (Sprint 16, 2026-07-18).** The
> Evidence/Current behavior lines below describe the **Sprint 14 audit
> baseline**, preserved as recorded. Sprint 16 delivered the adapter half of
> the remediation: a shared account-mailer boundary
> (`apps/api/src/modules/mail/`) with a production SMTP adapter
> (`smtp-account-mailer.ts`, nodemailer transport per the refinement
> iteration — implicit TLS with certificate/hostname verification, auth
> negotiated by nodemailer from server capabilities (AUTH PLAIN directly
> test-evidenced), bounded
> timeouts, construction-time config validation, central header-injection
> guard, no credential logging), explicit deterministic driver selection
> (`MAIL_DRIVER`), and a fail-closed production config guard (production
> refuses the Mailpit/memory drivers, missing or placeholder SMTP credentials,
> non-routable senders, and localhost/non-HTTPS public web URLs). The TLS +
> auth conversation is covered by automated tests against an in-process fake
> server, and live local delivery to the Mailpit container was re-verified.
> **What keeps this open:** the required validation is a *live send through a
> real external provider to a real inbox*, and that has NOT been performed —
> no provider credentials or sandbox inbox exist in the validation
> environment. Adapter existence is not delivery evidence. The exact safe
> validation procedure is documented in
> [email-and-verification.md](../email-and-verification.md#external-provider-validation).
> Bounce/complaint handling and suppression lists remain out of scope
> (deliberately, per the Sprint 16 boundary) and are tracked by this finding's
> original expected-behavior text.

- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact.
- **Evidence:** `apps/api/src/modules/invitations/invitation.mailpit-mailer.ts — createMailpitInvitationMailer` (raw `net` SMTP, no auth/TLS) is the only non-test `InvitationMailer` implementation. `infra/docker-compose.yml` service `mailpit`. `docs/known-limitations.md`: "Email is delivered only to the local Mailpit container."
- **Current behavior:** Invitations (and any future verification/reset email) can be delivered only to a local dev sink. There is no deliverability, templating, DKIM/SPF, or bounce handling. **Confirm which mailer `server.ts` instantiates in production** (unknown noted below).
- **Expected production behavior:** A real provider behind the existing `InvitationMailer` interface with authenticated TLS SMTP/API, verified sending domain, and bounce/complaint handling.
- **Risk:** Invitations undeliverable to real recipients; blocks any email-dependent lifecycle feature (ORG-PR-004, ORG-PR-024). Because invitation create is **fail-closed** (`invitation.service.ts — createInvitation` sends before persisting), a broken provider makes invitation creation fail entirely.
- **Remediation:** Implement a production mailer adapter; wire via config; verify delivery. The clean interface abstraction (`InvitationMailer`) makes this swap-in only.
- **Dependencies:** Blocks ORG-PR-004, ORG-PR-024, ORG-PR-045. **Effort:** M. **Validation:** live send to an external inbox in staging; CI SMTP assertion (ORG-PR-041).
- **Roadmap:** Phase 2 (Account lifecycle) / Phase 4. **Standards:** ASVS V2 recovery prerequisites. **Threats:** T-INV.
- **Progress (Sprint 24, 2026-08-23): Open — materially advanced; every
  repository-side prerequisite within scope is now done.** Delivered:
  `SMTP_USERNAME`/`SMTP_PASSWORD` resolve through the runtime secret boundary
  (direct env or `<NAME>_FILE`), and a file-backed credential receives
  byte-identical production validation — placeholder and known-development
  values are refused either way (`packages/config/src/secret-source.test.ts`).
  `apps/api/src/modules/mail/smtp-failure-redaction.test.ts` proves the SMTP
  password appears in neither the message, the stack, nor any own property of
  the error thrown by rejected authentication, a rejected sender, a rejected
  recipient, a refused connection, an untrusted certificate, or a real
  connection timeout — so a caller logging `{ err }` cannot print it. The six
  account-email families that actually exist (registration completion,
  existing-account guidance, password recovery, email verification,
  email-change verification, organization invitation) are enumerated with
  per-family evidence classes in
  [../email-and-verification.md](../email-and-verification.md), and a precise
  operator validation procedure — configuration, per-family triggers, header
  and link checks, DNS validation, and what to record — is in
  [../rotation-runbook.md](../rotation-runbook.md#validate-external-email-delivery).
  The mailer remains provider-agnostic (no SDK, no provider branch).
  **Exact closure blocker:** no email-provider credentials, no verified sending
  domain, and no readable test mailbox exist in this repository or any of its
  validation environments — re-confirmed in Sprint 24 (`gh secret list` empty;
  `environments` `total_count: 0`). Consequently there is **no provider
  acceptance evidence, no inbox-receipt evidence, no received sender-identity
  evidence, and no SPF/DKIM/DMARC evidence**, and none is claimed; provider
  acceptance and inbox receipt are tracked as separate facts and neither is
  inferred from the local fake-server or Mailpit evidence. Closure requires all
  of: a real external send, provider acceptance, real inbox receipt for the
  relevant families, verified sender identity, documented provider/domain
  verification state, and SPF/DKIM/DMARC verdicts from a received
  `Authentication-Results` header.
- **Progress (Sprint 27, 2026-08-25 — IN PROGRESS): Open — untouched, and
  confirmed NOT to be a prerequisite for ORG-PR-001.** Sprint 27 sent no mail,
  contacted no provider, resolved no MX record, and validated no sender domain.
  External provider credentials, real inbox receipt, and SPF/DKIM/DMARC
  alignment all remain unvalidated, and closure still requires all three.

  **The staging boundary was established precisely**, by loading real
  configurations against `packages/config/src/production-policy.ts` and
  `mail-policy.ts` rather than reading prose. Under `NODE_ENV=production` the
  guard constrains the mail *driver* (`smtp` only — a local sink would silently
  swallow account email), the *credential* (no placeholder or development
  default), and the *sender domain* (no reserved, non-routable suffix). It does
  **not** constrain the endpoint's identity. Combined with the SMTP transport
  being created lazily — nothing connects at boot — and `/ready` probing only
  PostgreSQL and Redis, a staging-like target boots, becomes ready, and passes
  all nine post-deployment smoke checks with `MAIL_DRIVER=smtp` pointed at an
  operator-run isolated sink. Directly observed during the lifecycle run: the
  packaged API did exactly that with an unreachable `SMTP_HOST`.

  **Consequence:** a real production email provider is **not** required to
  deploy to, or validate, a staging-like target, and therefore not required for
  ORG-PR-001 closure. The staging blocker previously recorded as "a real SMTP
  provider" was never accurate. **None of this is progress toward ORG-PR-002**:
  nothing proves an endpoint exists, accepts a credential, or delivers anything
  to a recipient, and no production email validation was weakened — the
  driver/credential/sender rules are unchanged and are now pinned by an
  additional regression test. Model:
  [../deployment.md](../deployment.md#staging-mail-model).
- **Progress (Sprint 27, 2026-08-27 — real target): Open, untouched.** No
  provider was contacted and no mail reached a real recipient. The staging
  target's Mailpit sink is isolated with no external relay. Account-email
  delivery was **not exercised** and would currently fail closed there:
  `MAIL_DRIVER=smtp` points at a plaintext sink on port 1025 while Orgistry's
  smtp driver uses implicit TLS with verification always on. That is correct
  fail-closed behaviour and a staging limitation, not a deployment defect — and
  it is not delivery evidence in any direction. Closure still requires an
  external provider, real inbox receipt, and SPF/DKIM/DMARC alignment.

<a id="org-pr-003"></a>
### ORG-PR-003 — Dev-default secrets accepted & `COOKIE_SECURE` unenforced in production

> **Status: CLOSED (Sprint 15, 2026-07-18).** The Evidence/Current behavior
> lines below describe the **Sprint 14 audit baseline**, preserved as recorded;
> they no longer describe the repository. See the **Resolution** line at the
> end of this entry for the current state.

- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact (independently re-checked).
- **Evidence:** `packages/config/src/schema.ts` — `JWT_SECRET: z.string().min(16)` (L74), `COOKIE_SECRET … .min(16)` (L75-77), `COOKIE_SECURE: booleanFromEnv.default('false')` (L81). No `refine`/`superRefine`/`NODE_ENV` cross-check (grep confirmed). `packages/config/src/index.ts:100` computes `isProduction` but nothing consumes it for enforcement. `.env.example:60-61` ships `JWT_SECRET=dev-only-jwt-secret-change-me` / `COOKIE_SECRET=dev-only-cookie-secret-change-me` — both ≥16 chars, so they **pass** validation under `NODE_ENV=production`.
- **Current behavior:** A production process boots successfully with the shipped guessable HS256 secret and with the refresh cookie lacking `Secure`.
- **Expected production behavior:** Startup refuses known dev-default secret values and low-entropy secrets in production, and forces `COOKIE_SECURE=true` (or refuses to boot without it) when `NODE_ENV=production`.
- **Risk:** With a public/guessable JWT secret an attacker can forge access tokens (full account/tenant takeover). Without `Secure`, the refresh cookie can leak over plaintext. This is the single highest-impact misconfiguration the config layer fails to prevent.
- **Remediation:** Add a production `superRefine`: reject the known dev defaults and require `COOKIE_SECURE=true`; consider a minimum entropy/length floor for production. **Config-only change; not implemented during the Sprint 14 audit (later implemented in Sprint 15 — see Resolution below).**
- **Dependencies:** Related to ORG-PR-006. **Effort:** S. **Validation:** unit test asserts production config rejects dev defaults and `COOKIE_SECURE=false`.
- **Roadmap:** Phase 3 (Security hardening). **Standards:** ASVS V6/V3, V14 config; SSDF PW.9. **Threats:** T-TOKEN-FORGE, T-CONF.
- **Resolution (Sprint 15, 2026-07-18): CLOSED.** `envSchema` now applies `enforceProductionConfigSafety` (`packages/config/src/production-policy.ts`, wired via `superRefine` in `packages/config/src/schema.ts`). Under `NODE_ENV=production`, `loadConfig` throws `ConfigValidationError` for: known dev-default/fixture/CI secrets (exact match), `JWT_SECRET` < 32 chars, placeholder-marker values, single-repeated-character values, and `COOKIE_SECURE=false` (explicit or defaulted). The guard runs inside the only parse path, and `apps/api/src/server.ts — main` calls `getConfig()` before any service or `listen`, so unsafe production config cannot boot the API. Evidence: `packages/config/src/config.test.ts` — `production configuration guard (NODE_ENV=production)` suite (positive + all negative cases; messages name the field and never echo the secret). Docs: [docs/production-config-guard.md](../production-config-guard.md). Note: this does **not** close ORG-PR-006 (no secrets manager, no rotation, no entropy proof).

<a id="org-pr-004"></a>
### ORG-PR-004 — No password recovery flow
- **Class / Sev / Conf:** Product completeness gap · P1 · High · Verified fact (absence).
- **Evidence:** `grep -rniE "password.?reset|forgot|reset-password" apps/api/src packages --include=*.ts` (excl. tests) → zero non-test matches. No reset-token table (only the unused `email_verification_tokens`). No route, service, or web surface. Login/registration exist (`auth.routes.ts`), establishing password auth is implemented while recovery is absent.
- **Current behavior:** A user who forgets their password is permanently locked out; no self-service recovery.
- **Expected production behavior:** Email-driven reset with a single-use, expiring, hash-only token (mirroring the invitation token design), rate-limited request endpoint, enumeration-safe response, and session invalidation on reset.
- **Risk:** Permanent lockout for any forgetful user; unsustainable support burden; effective account/data loss for that user. Standard expectation for any real multi-user product.
- **Remediation:** Build the reset flow on the existing opaque-token + mailer primitives. **Depends on ORG-PR-002.**
- **Dependencies:** ORG-PR-002 (email), ORG-PR-016 (token expiry cleanup). **Effort:** M. **Validation:** integration tests for request/redeem/expiry/reuse/enumeration.
- **Roadmap:** Phase 2. **Standards:** ASVS V2.5 (credential recovery). **Threats:** T-ENUM, T-CRED.
- **Resolution (Sprint 17, 2026-07-20): CLOSED.** Full recovery flow implemented on the existing opaque-token + mailer primitives, exactly as the remediation specified: public `POST /v1/auth/password-recovery/request` (enumeration-safe — identical `{ accepted: true }` for existing/unknown/disabled/soft-deleted accounts and on ANY internal failure incl. account lookup, persistence, mail delivery, and the best-effort security-event write; request events are always anonymous and never account-linked; rate-limited per IP + per normalized-email digest) and public `POST /v1/auth/password-recovery/complete` (raw token + new password in the body only). Dedicated `password_reset_tokens` table (migration `0009`): hash-only 32-byte CSPRNG tokens, short expiry (`PASSWORD_RESET_TTL_SECONDS`, default 1 h), single-use `used_at` + retired-unused `invalidated_at` lifecycle, sibling invalidation on every new generation under a per-user issuance lock (persist-and-commit before send — every emailed token was persisted first, though a later request may supersede a sent link; exactly one generation survives issuance). Completion is ONE transaction under `SELECT … FOR UPDATE` (`password-recovery.repo.ts — completeReset`): password swap + token consumption + sibling invalidation + revocation of EVERY session and refresh token; no session is issued (fresh login required). Reset link uses fragment-only transport (`/auth/reset-password#token=…`) with the Sprint 16 frontend token-hygiene pattern. Evidence: `password-recovery.routes.test.ts` (28 route tests incl. concurrent completion, an eight-scenario enumeration-uniformity matrix under injected lookup/persistence/mail/event-store failures and disabled/soft-deleted states, attribution, and secret-hygiene sweeps), `password-recovery.integration.test.ts` (live PostgreSQL, independently runnable concurrent-generation and concurrent-completion races, durable revocation), web-demo `password-recovery.test.tsx` (15 tests incl. storage/DOM/query-string hygiene). Docs: [credential-management.md](../credential-management.md). Residual (documented, accepted): request-path timing is not fully equalized (existing accounts trigger a synchronous send), bounded by the rate limits.

<a id="org-pr-005"></a>
### ORG-PR-005 — No database backup / PITR / tested restore
- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact (absence).
- **Evidence:** No backup config anywhere; `infra/docker-compose.yml` uses a local named volume only. `docs/roadmap.md` lists "No backup/restore story" as a critical gap. `docs/known-limitations.md` confirms no operational tooling.
- **Current behavior:** No automated backups, no point-in-time recovery, no restore procedure, no restore test.
- **Expected production behavior:** Automated encrypted backups + PITR meeting the target RPO/RTO ([production-target.md](production-target.md)), with a **restore drill executed before production data** and re-verified periodically.
- **Risk:** Any data-loss event (operator error, corruption, host loss) is unrecoverable. This is the classic "we had backups but never tested a restore" trap.
- **Remediation:** Use managed-Postgres backups/PITR or documented `pg_dump`/WAL archiving; document and rehearse restore. **Not implemented during the Sprint 14 audit.**
- **Dependencies:** ORG-PR-001 (infra). **Effort:** M. **Validation:** a restore drill reconstructs the DB to a target timestamp and passes readiness/integration checks — mandatory launch gate.
- **Roadmap:** Phase 5 (Reliability & operations). **Standards:** SSDF PO.3; ASVS V14. **Threats:** T-DBLOSS, T-OPS.
- **Progress (Sprint 25, 2026-08-24): OPEN — materially advanced. The
  repository-controlled half is complete and evidenced; the
  deployment-dependent half is untouched, and that half is what makes this a
  production blocker.**

  **Delivered and verified (repository-controlled):**
  - *Persistent-data inventory.* PostgreSQL is the only durable store. Redis
    holds nothing but TTL-bounded `INCR`/`EXPIRE` rate-limit counters
    (`apps/api/src/lib/rate-limit.ts`), images/bundles are rebuildable from
    source, logs are stdout-only with no writable application path in the
    artifact, and there is no object storage or upload path anywhere in the
    repository. Backup scope is therefore PostgreSQL and nothing else
    ([../backup-and-restore.md](../backup-and-restore.md)).
  - *Repeatable logical backup.* `tooling/db-backup.sh` (`pnpm db:backup`) —
    `pg_dump -Fc` run from the pinned `postgres:16.14-alpine` image so the
    client can never drift from the server, plus a SHA-256 sidecar and a
    provenance `meta.json` (server version, client version, image digest,
    applied-migration count, byte count, `"encrypted": false`). Credentials
    are passed by environment variable and never reach an argument, a
    filename, a log line, or the sidecar. A dump failure or an empty output
    deletes the partial file and exits non-zero.
  - *Tested restore.* `tooling/db-restore-drill.sh` (`pnpm drill:restore`)
    exercises the REAL backup script, verifies the checksum, proves a
    truncated artifact is rejected by `pg_restore`, asserts the target has
    zero public tables BEFORE restoring, restores with `--exit-on-error`,
    then asserts every table, the Drizzle migration ledger, each seeded
    entity, an owner→organization→plan→project join, and byte-identical
    API-key hash metadata — and finally re-runs migrations against the
    restored database requiring a no-op.
  - *Deployable-artifact recovery contract.* `--with-artifact` completes
    restored PostgreSQL → `node dist/migrate.mjs` → the packaged API →
    `/health` 200 → `/ready` 200 → an API-key-authenticated
    `GET /v1/external/projects` returning the restored projects (the key's
    SHA-256 hash comes out of the restored database) → an unknown key still
    401 → no drill secret in the artifact logs → the packaged retention
    command in both modes.
  - ***PITR VERIFIED.*** `tooling/db-pitr-drill.sh` (`pnpm drill:pitr`) proves
    real point-in-time recovery, not a logical restore: WAL archival is
    verified WORKING (`pg_stat_archiver.archived_count > 0`, no
    `last_failed_wal`, files present on the archive volume); the base backup
    is taken with `pg_basebackup` BEFORE the pre-target writes, so those rows
    exist only in archived WAL; a recovery target is recorded, destructive
    post-target writes follow (`DELETE FROM users`, `DROP TABLE projects`); an
    independent server recovers from the base backup + archive with
    `recovery_target_time`; the target's log is asserted to contain
    `restored log file` AND a recovery-stopping line; and the recovered state
    is checked in BOTH directions — pre-target rows present, post-target-only
    row absent, `DELETE` and `DROP TABLE` undone, schema and migration ledger
    intact. Recorded evidence: [../pitr.md](../pitr.md).
  - *CI.* The data-layer restore drill runs in the `integration` job and the
    `--with-artifact` drill in the `artifacts` job on every push and pull
    request; the PITR drill runs manually and weekly in
    `.github/workflows/data-durability.yml` (cost rationale documented).
  - *Remote evidence.* All of the above passed on GitHub Actions for the merged
    change set (CI run 32702593281 on the PR, re-validated on `main` by run
    32702856226), and the PITR drill was dispatched against `main` and passed
    (`Data durability` run 32702918307, 42 s) with archived-WAL consumption and
    the target boundary asserted from the run log. The capability is therefore
    not machine-specific.
  - *Backup security.* `backups/`, `*.dump`, and `*.dump.sha256` are
    git-ignored; the tool refuses to write inside `.git`; artifacts are
    created under `umask 077` and `chmod 600`; drills delete their artifacts
    on exit; the checksum is documented as integrity only, never represented
    as encryption or access control.
  - *Operational process.* Command-level runbooks for taking, verifying,
    restoring, and protecting a backup; for choosing, performing, validating,
    and diagnosing a PITR recovery; and for handling a failed migration —
    the last explicitly labelled unrehearsed guidance.

  **Why this stays OPEN.** The finding's expected production behavior is
  *automated encrypted backups + PITR meeting a target RPO/RTO, with a restore
  drill executed before production data*. None of the following exists, and
  every one depends on ORG-PR-001:
  - no scheduler invokes `db:backup` anywhere — the command has no producer;
  - backups are written to a local directory: no remote storage, no lifecycle
    policy, no encryption at rest, no cross-region copy;
  - no long-lived Orgistry database archives WAL. The PITR drill enables
    archiving for its own lifetime and deletes the archive volume afterwards;
  - no managed-provider continuous backup/PITR window is configured;
  - no RPO or RTO has been measured. The drills recover fixture-sized
    databases in seconds, which says nothing about production volume;
  - no monitoring of archive health — a silently failing `archive_command` is
    the classic way PITR stops existing unnoticed;
  - no least-privilege backup/restore identity (ORG-PR-006, open).

  Closing this finding on repository-controlled capability alone would assert
  that the backup/DR launch gate is satisfied while no backup runs anywhere.
  The capability is proven; the production posture is not.
- **Progress (Sprint 26, 2026-08-24): Open — integration boundary advanced,
  substance unchanged.** The deployment lifecycle now has exactly one
  backup/PITR integration point, at the only moment a deployment creates a new
  recovery-point requirement: before migrations, `tooling/deploy.sh` runs the
  REAL `tooling/db-backup.sh` with the label `pre-deploy`, records the artifact
  name and the resulting recovery point in the deployment evidence record, and
  **aborts the deployment before migrations if the backup fails** — leaving the
  target unchanged. A skip is permitted for an operator relying on
  provider-managed backups but **requires a recorded reason**: an unexplained
  skip is refused, because during an incident it is indistinguishable from an
  oversight. A rollback skips the preflight automatically, with that reason
  recorded. Two latent defects on this path were found and fixed by the
  rehearsal: `tooling/db-backup.sh` could not back up a database with no
  migration ledger (PostgreSQL resolves relation names at parse time, so the
  `coalesce(...)` guard never ran) — which is exactly the first-deployment case
  — and `pg_start_server` failed under `set -u` on bash 3.2 when called with no
  extra Docker arguments. The restore drill, the `--with-artifact` drill, and
  the PITR drill were all re-run locally after those fixes and pass. **Nothing
  about closure changes.** Verifying WAL-archival health before a migration is
  NOT implemented, because no long-lived archiving database exists to verify;
  and every bullet in the "why this stays OPEN" list above is still true —
  nothing schedules a backup, nothing stores one off-host or encrypted, no
  provider PITR window is configured, no archive health is monitored, and no
  RPO/RTO has been measured. Deployment-time integration is not a backup
  programme.
- **Progress (Sprint 27, 2026-08-25 — IN PROGRESS): Open — unchanged in
  substance.** The pre-migration backup preflight executed for real, against the lifecycle
  deployment's own PostgreSQL, in the middle of a real deployment of a published
  release: `tooling/db-backup.sh` produced a labelled `pre-deploy` dump and the
  deployment recorded its artifact name and recovery point in the evidence
  ledger, before migrations ran. That proves the *deployment boundary* Sprint 26
  built is wired correctly to Sprint 25's durability tooling and works against
  real published artifacts. **It is not backup operations.** Nothing schedules a
  backup, nothing stores one off-host, nothing encrypts one at rest, no
  long-lived database archives WAL, no archive-health check exists, and no
  RPO/RTO has been measured. The rollback performed in the same run deliberately
  took no backup and recorded that absence as a limitation, which is the
  intended behaviour and is also not evidence of a recovery capability.
  Closure continues to require the independent production requirements listed
  above, none of which Sprint 27 addressed.
- **Progress (Sprint 27, 2026-08-27 — real target): Open, unchanged in
  substance.** The pre-migration backup preflight executed for real **twice on
  the durable target**, before each migration, producing
  `orgistry-20260827T100354Z-pre-deploy.dump` and
  `orgistry-20260827T100654Z-pre-deploy.dump` with SHA-256 checksums and
  provenance sidecars, and recording artifact and recovery point in the
  deployment evidence. The rollback correctly took none and recorded why. That
  is the deployment boundary working against real infrastructure. **It is not
  backup operations.** Nothing schedules a backup, stores one off-host, encrypts
  one at rest, archives WAL, or monitors archive health; no RPO/RTO is measured;
  the staging PostgreSQL has **no PITR window**; and **no real-target restore or
  PITR drill was performed** — none is claimed. ORG-PR-001 closing removes the
  dependency that previously blocked this finding's environment-dependent half,
  which makes it the strongest candidate for the next sprint.

<a id="org-pr-006"></a>
### ORG-PR-006 — No secrets management or rotation procedure
- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact.
- **Evidence:** Secrets sourced from `.env` only (`packages/shared/src/node/load-env.ts`, `.env.example`). No secrets-manager integration; `docs/roadmap.md` lists rotation of `JWT_SECRET`/`COOKIE_SECRET` as future work. `access-token.ts` has no `kid`/versioned-secret support (see ORG-PR-049), so rotation is disruptive.
- **Current behavior:** Production secrets would live in environment/committed-file form with no rotation path and no emergency-compromise procedure.
- **Expected production behavior:** Secrets sourced from a manager (or the platform's secret store), documented routine + emergency rotation, and least-privilege access. No secret in a committed file in any non-local environment.
- **Risk:** Secret sprawl and no response plan for a leaked `JWT_SECRET`/DB credential; compounds ORG-PR-003.
- **Remediation:** Integrate a secrets store; document rotation runbooks; pair with ORG-PR-049 for graceful JWT rotation.
- **Dependencies:** ORG-PR-001, ORG-PR-003. **Effort:** M. **Validation:** a rehearsed rotation of `JWT_SECRET` with no unexpected mass logout beyond the accepted window.
- **Roadmap:** Phase 3 / Phase 4. **Standards:** ASVS V6.4 (secret management); SSDF PS.1. **Threats:** T-SECRET, T-CONF.
- **Progress (Sprint 23, 2026-08-23): Open — boundary advanced only.** The
  deployable artifacts now enforce the runtime secret-injection seam a future
  manager plugs into: secrets are read exclusively from the runtime
  environment at process start; no secret enters Docker build args or image
  layers; `.env` files are excluded from build contexts and proven absent
  from images; the smoke test asserts the (fake) runtime secrets never appear
  in logs or in the static web assets. This is the injection *boundary*, not
  secrets management: there is still no secrets-manager/platform-store
  integration, no routine or emergency rotation procedure, no rehearsed
  `JWT_SECRET` rotation, and no `kid`/versioned-secret path (ORG-PR-049).
  The finding's validation criterion is untouched.
- **Progress (Sprint 24, 2026-08-23): Open — materially advanced.**
  *Runtime sources.* `packages/config/src/secret-source.ts` adds one narrow
  resolution boundary giving `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
  `JWT_PREVIOUS_SECRET`, `SMTP_USERNAME`, and `SMTP_PASSWORD` an optional
  mounted-file source (`<NAME>_FILE`) alongside the direct environment value.
  Semantics are deterministic and test-proven: both forms set → refused
  (ambiguous); only one → that source; neither → the schema decides; blank
  counts as unset; exactly one terminal line ending is stripped and interior
  whitespace preserved; empty, missing, directory, and unreadable files are
  refused with the path but never the contents; unrelated `*_FILE` variables
  are ignored. *Ordering invariant.* Resolution runs before
  `envSchema.safeParse` and writes onto the CANONICAL variable name, so a
  file-backed secret receives byte-identical production validation — a
  file-loaded `dev-only-jwt-secret-change-me`, a sub-32-character secret, and a
  placeholder `SMTP_PASSWORD` are rejected exactly as direct values are
  (`packages/config/src/secret-source.test.ts`), and the packaged artifact
  re-proves it (`tooling/artifact-smoke.sh`). *Graceful JWT rotation.*
  `verifyAccessTokenWithRotation` accepts an optional `JWT_PREVIOUS_SECRET` at
  verification only; signing stays current-key-only; the two keys must differ
  (refused in every mode); both are held to the same production strength rules;
  an unrelated older key is rejected; expiry, claims, session binding, and
  authorization are unchanged; removing the previous key completes the cutover
  — proven at the primitive level (`access-token.test.ts`) and through the HTTP
  boundary (`jwt-secret-rotation.routes.test.ts`). *Redaction.* Startup,
  config-validation, secret-file, SMTP-failure, 401-envelope, container-log,
  and web-asset paths all have explicit secret-absence evidence. *Runbooks.*
  [../rotation-runbook.md](../rotation-runbook.md) documents routine rotation
  (open window → verify → wait one access-token lifetime → remove previous →
  restart), emergency rotation (previous key deliberately omitted so the leaked
  key dies at restart), session invalidation, SMTP rotation, and database/Redis
  rotation; [../runtime-secrets.md](../runtime-secrets.md) carries the
  inventory and contracts. *Verified, not assumed:* there is **no
  refresh/session signing secret** — refresh tokens are opaque, unsigned,
  hash-only, and the cookie is deliberately unsigned — so none was invented for
  the inventory, rotating `JWT_SECRET` logs nobody out, and session
  invalidation is a database operation with no platform-wide API.
  **Why still open:** the expected behavior is "secrets sourced from a manager
  (or the platform's secret store) … and least-privilege access", and the
  validation criterion is a *rehearsed* rotation. Missing: any
  secrets-manager/platform-store integration, least-privilege secret access
  control, automated rotation or expiry tracking, secret-access auditing, hot
  reload (every rotation is a restart), a `kid`/versioned-key scheme
  (ORG-PR-049), dual-credential support for `DATABASE_URL`/`REDIS_URL`, and a
  rehearsal against a real deployment — which cannot happen until ORG-PR-001
  provides one. File-based injection plus runbooks is not secrets management.
- **Progress (Sprint 26, 2026-08-24): Open — deployment-side HANDLING added,
  substance unchanged.** The deployment now enforces several secret-handling
  rules the Sprint 24 boundary could only describe: the runtime configuration
  file holding every runtime secret must be mode **0600** or the deployment
  refuses to run (proven by a rehearsal negative check); the deployment reads
  exactly one secret for itself (`DATABASE_URL`, honouring `DATABASE_URL_FILE`)
  and passes it only through a container environment variable, never as a
  command argument, a filename, or a log line; `docker compose config` is
  deliberately never invoked anywhere, because it expands `env_file` entries
  into plaintext; the release manifest and every deployment evidence record are
  validated against a credential-shape guard that refuses a URL with inline
  credentials or an inline credential assignment; the publishing workflow
  consumes no long-lived registry credential (the job's own `GITHUB_TOKEN`,
  passed on stdin) and no image build takes a secret argument. `<NAME>_FILE`
  compatibility is preserved end to end. **None of this is secrets
  management.** The finding's expected behavior — a manager or platform secret
  store, least-privilege access, and a *rehearsed* rotation — is untouched:
  secrets are still plaintext files on a host, with no store, no access control,
  no read auditing, no automated rotation or expiry tracking, no hot reload, and
  no rotation rehearsed against a real runtime (still blocked on ORG-PR-001).
  The deployment workflow declares a GitHub `environment:` as the intended home
  for a future deployment credential; **no GitHub Environment is configured**,
  so that is a documented intention, not a control. GitHub Environment secrets
  would in any case satisfy only the injection half of this finding.
- **Progress (Sprint 27, 2026-08-25 — IN PROGRESS): Open — unchanged.** Sprint
  27 observed that the GHCR packages are *currently* publicly pullable, which
  means a deployment host does not presently need a registry pull credential.
  One fewer secret to hold is a good thing and it is **not** secrets management;
  it closes nothing here, and it is an observed state rather than an approved
  policy, so it could change. Everything
  the finding requires is still absent: runtime secrets remain a 0600 file on a
  host, with no secret store, no least-privilege access control, no read
  auditing, no expiry tracking, and no automated rotation. The `staging-like`
  GitHub Environment — documented as the intended home of a future deployment
  credential — was re-observed on 2026-08-25 with `protection_rules: []` and
  `deployment_branch_policy: null`, i.e. still **zero protection**. Sprint 27
  did not configure it: required reviewers on a single-maintainer repository
  would be the sole maintainer approving their own deployment, which is a log
  entry rather than a control, and nothing in this repository mutates remote
  configuration. Restricting that environment's deployment branches to `main`
  *is* a real control and is recorded as a one-command operator action in
  [../deployment.md](../deployment.md).
- **Progress (Sprint 27, 2026-08-27 — real target): Open, unchanged.**
  Runtime secrets on the durable target are a single 0600 file
  (`/opt/orgistry/config/runtime.env`, owner-only), which the deployment's
  permission gate verified and which was never read or printed by this
  execution. The `staging-like` GitHub Environment now carries an active
  deployment-branch policy (`protected_branches: true`) — a **deployment
  boundary**, not secrets management. Public package visibility means the host
  needs no registry credential, which removes a secret rather than managing one.
  Still absent, and still required for closure: a secret store, least-privilege
  access control, read auditing, expiry tracking, and automated rotation.
  Reviewer separation on the environment is unavailable for a single maintainer
  and is documented rather than simulated.

<a id="org-pr-007"></a>
### ORG-PR-007 — No observability (metrics/tracing/dashboards/alerts)
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact (absence).
- **Evidence:** No prometheus/prom-client/OpenTelemetry anywhere (grep → 0). Logger is Fastify pino configured only with `{ level }` (`app.ts:136`). `/ready` probe latency is measured (`lib/readiness.ts`) but never exported. `/health` and `/ready` exist but nothing consumes them.
- **Current behavior:** Structured JSON logs with request IDs exist; there are no metrics, traces, dashboards, SLOs, or alerts.
- **Expected production behavior:** Per-route latency/error-rate metrics, request tracing, dashboards, and alerts on readiness failure, error-budget burn, rate-limit spikes, audit-writer failures, and certificate/email/backup health.
- **Risk:** Operators are blind to failures and abuse (compounds ORG-PR-009, ORG-PR-013); no way to detect or diagnose production incidents.
- **Remediation:** Add metrics + tracing exporters and an alerting layer.
- **Dependencies:** ORG-PR-001. **Effort:** L. **Validation:** a dashboard shows per-route latency/error rate; a synthetic readiness failure pages.
- **Roadmap:** Phase 5. **Standards:** ASVS V7 (logging/monitoring); SSDF RV.1. **Threats:** T-OPS, T-DOS.

<a id="org-pr-008"></a>
### ORG-PR-008 — No incident response / production runbook / on-call
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** `docs/runbook.md` is explicitly a *local infrastructure* runbook (Docker services + port conflicts). `docs/troubleshooting.md` covers local/CI symptoms only. No on-call, escalation, postmortem, or status-communication docs (doc census).
- **Current behavior:** No production incident-response process, ownership, or runbooks.
- **Expected production behavior:** Runbooks for the top failure modes (DB down, Redis down, deploy rollback, migration recovery, secret compromise, email outage), defined ownership, and a postmortem process.
- **Risk:** Unstructured, slow, error-prone incident handling.
- **Remediation:** Author production runbooks and an incident process (see ORG-PR-027).
- **Dependencies:** ORG-PR-007. **Effort:** M. **Validation:** a tabletop exercise against one runbook. **Roadmap:** Phase 5. **Standards:** SSDF RV.2/RV.3. **Threats:** T-OPS.

<a id="org-pr-009"></a>
### ORG-PR-009 — Rate limiting fails open on Redis outage
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** `apps/api/src/lib/rate-limit.ts — createRedisRateLimiter.consume` (L40-51): `try { redis.incr… } catch { return true }` with comment "Fail open: rate limiting must never break auth on a Redis outage." All auth buckets (`auth.service.ts` login/register/refresh) and external-API buckets (`api-key.authenticator.ts`) use it.
- **Current behavior:** During any Redis outage, all login/register/refresh and external-API throttling is silently disabled while auth continues serving.
- **Expected production behavior:** A configurable fail-closed (or degraded) mode for sensitive surfaces (at minimum login), plus alerting when the limiter is bypassed. Documented and intentional today, but a production posture must make the tradeoff explicit and observable.
- **Risk:** A Redis outage opens an unthrottled brute-force / credential-stuffing window with no signal.
- **Remediation:** Add a per-surface fail-closed option and emit a metric/alert when Redis is unavailable.
- **Dependencies:** ORG-PR-007 (alerting). **Effort:** M. **Validation:** test that login fails closed (or degrades) when the limiter throws in the configured mode.
- **Roadmap:** Phase 3. **Standards:** ASVS V11.1 (anti-automation). **Threats:** T-CRED, T-DOS.
- **Resolution (Sprint 19 — Materially advanced, not closed):** the limiter
  store contract now reports `allowed | limited | unavailable`
  (`lib/rate-limit.ts`); every sensitive bucket (auth, registration, recovery,
  verification, invitations, mutations, external API) applies the typed
  `RATE_LIMIT_FAILURE_MODE` — production defaults to `closed` (generic 503,
  `enforceStoreAvailability`), the production guard refuses an explicit
  `open`, dev/test default `open` — and each store failure emits a sanitized
  structured warn (`server.ts` `onStoreError`). Readiness requires Redis, so a
  production instance also leaves rotation. Tested:
  `lib/rate-limit.test.ts`, `modules/auth/rate-limit.failure-mode.test.ts`,
  `invitation.throttle.test.ts`, `mutation-throttle.test.ts`, and — with the
  REAL Redis client (`lib/rate-limit.redis.integration.test.ts`) — the
  healthy-store path, the fail-closed 503 after a deterministic real-client
  failure (`redis.quit()`), and the dev fail-open path. The GLOBAL
  bucket fails open by design (documented in the Sprint 19 artifact).
  **Residual:** no metric/alert on limiter-store failure — that half of the
  expected behavior depends on ORG-PR-007 (observability), still open.

<a id="org-pr-010"></a>
### ORG-PR-010 — `trustProxy` unset → per-IP limits and audit IPs invalid behind a proxy
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact (independently re-checked).
- **Evidence:** No `trustProxy` in `Fastify({...})` (`app.ts:135`); `apps/api/src/lib/request-context.ts:22` uses `request.ip` (socket peer). Per-IP buckets `rl:login:ip`/`rl:register:ip`/`rl:refresh:ip` (`auth.service.ts`) and `security_events.ip_address` derive from it.
- **Current behavior:** Behind a reverse proxy/LB (the standard production topology) `request.ip` is the proxy address: all clients collapse into one per-IP bucket, and every recorded IP is the proxy. The safe side: `X-Forwarded-For` is *not* trusted, so IP spoofing to evade limits is not possible today.
- **Expected production behavior:** A trusted-proxy allow-list so `request.ip` reflects the real client, restoring per-IP throttling and accurate audit IPs — without blindly trusting `X-Forwarded-For`.
- **Risk:** Per-IP login/register limits become a single global bucket (one attacker exhausts it for everyone; per-attacker throttling is impossible); audit/security IPs are useless for investigation.
- **Remediation:** Set `trustProxy` to the known proxy hop(s) once the deployment topology is fixed.
- **Dependencies:** ORG-PR-001 (topology known). **Effort:** S. **Validation:** integration test asserting client IP resolves correctly with a trusted `X-Forwarded-For` and is ignored otherwise.
- **Roadmap:** Phase 3 / Phase 4. **Standards:** ASVS V11, V7.3 (log integrity). **Threats:** T-CRED, T-DOS, T-AUDIT.
- **Resolution (Sprint 19 — Closed):** typed `TRUST_PROXY` config
  (`packages/config/src/schema.ts — parseTrustProxy`: `false` | hop count |
  IP/CIDR list; `"true"` rejected at boot) applied at Fastify CONSTRUCTION
  time (`app.ts`). With trust disabled (default), a directly presented
  `X-Forwarded-For` is ignored — `request.ip` is the socket peer; with
  `TRUST_PROXY=1`, the client IP resolves behind exactly one documented hop.
  All IP consumers (limiter keys, request logs, audit/security-event IPs) read
  `request.ip`. Tested end to end in `app.proxy-trust.test.ts` (spoof
  rejection, hop resolution, multi-value XFF, limiter-key IP). The deployment
  must still set the value matching its topology (documented, with
  misconfiguration risk, in `docs/security-model.md` and the artifact).

<a id="org-pr-011"></a>
### ORG-PR-011 — No HTTP security headers (helmet)
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact (independently re-checked).
- **Evidence:** No `helmet`/`@fastify/helmet` anywhere (grep → 0). `app.ts:135` registers only CORS + error handler. No HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- **Current behavior:** Responses carry no security headers.
- **Expected production behavior:** HSTS, `nosniff`, frame-deny, referrer policy, and a response CSP appropriate to an API, applied globally.
- **Risk:** A browser-facing, cookie-authenticating API (`credentials: true`) without header hardening is exposed to clickjacking, MIME sniffing, and downgrade; pairs with the missing frontend CSP (ORG-PR-035).
- **Remediation:** Register a security-headers plugin; align CSP with the SPA.
- **Dependencies:** none. **Effort:** S. **Validation:** response-header assertion test. **Roadmap:** Phase 3. **Standards:** ASVS V14.4 (HTTP security headers). **Threats:** T-XSS, T-CSRF.
- **Resolution (Sprint 19 — Closed):** centralized internal plugin
  (`plugins/security-headers.ts`) applies `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP
  `same-origin`, and a minimal `Permissions-Policy` to EVERY response (success,
  error envelope, 404, preflight); production-only HSTS
  (`HSTS_MAX_AGE_SECONDS`, never emitted locally); `Cache-Control: no-store`
  on `/v1/auth/*` and `/v1/invitations/*`. Tested (normal/error/preflight/
  HSTS-by-environment/CORS compatibility) in `plugins/security-headers.test.ts`.
  Deliberately NO API-level document CSP — the API serves JSON only, and the
  frontend CSP remains ORG-PR-035 (open); this policy makes no frontend-CSP
  claim.

<a id="org-pr-012"></a>
### ORG-PR-012 — No global/edge rate limiting; unauthenticated `invitations/inspect` oracle unthrottled
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** Rate limiting exists only in `auth.service.ts` and `api-key.authenticator.ts` (grep `.consume(`); there is no `@fastify/rate-limit` / global `onRequest` throttle. `POST /v1/invitations/inspect` is public and unauthenticated (`invitation.routes.ts:113`) with no limiter.
- **Current behavior:** An unauthenticated attacker can hammer `invitations/inspect` (token-probing + invitation-content disclosure for any valid token) bounded only by 256-bit token entropy, and hit every other unthrottled route freely.
- **Expected production behavior:** A global/edge rate limit (proxy/WAF or a Fastify global limiter) covering unauthenticated and mutation surfaces, in addition to the per-surface auth limits.
- **Risk:** Token-guessing and generic request flooding; combines with ORG-PR-013 for a cheap DoS.
- **Remediation:** Add a global limiter and/or edge rate limiting; throttle `invitations/inspect` specifically.
- **Dependencies:** ORG-PR-010 (accurate client IP). **Effort:** M. **Validation:** limiter test on `invitations/inspect` and a default global bucket. **Roadmap:** Phase 3. **Standards:** ASVS V11.1. **Threats:** T-INV, T-DOS.
- **Resolution (Sprint 19 — Closed):** global per-trusted-IP fixed-window
  limiter (`plugins/global-rate-limit.ts`; `RATE_LIMIT_MAX`/`_WINDOW_SECONDS`)
  runs in `onRequest` ahead of route work, exempting `/health`, `/ready`, and
  OPTIONS preflight, returning the standard `RATE_LIMITED` envelope, keying on
  the ORG-PR-010-resolved IP, failing open on store outage by design
  (readiness gates rotation; sensitive buckets fail closed individually).
  `POST /v1/invitations/inspect` is throttled per trusted IP AND per
  token-derived second-order digest (`invitationInspectRateLimitKey` — never
  the raw token), with accept per-user and create per-user + per-org buckets
  (`invitation.service.ts`). The full public abuse-control matrix is in the
  Sprint 19 artifact. Tested: `plugins/global-rate-limit.test.ts`,
  `invitation.throttle.test.ts`, and against LIVE Redis
  (`lib/rate-limit.redis.integration.test.ts`: threshold, per-identity key
  isolation, positive TTLs, secret-free keys, standard envelope). A
  production `buildApp` refuses to construct without the global limiter
  (refinement iteration). Edge-of-network (WAF/CDN) controls remain
  future infrastructure work under ORG-PR-001.

<a id="org-pr-013"></a>
### ORG-PR-013 — External API writes an un-throttled `security_events` row per unauthenticated request
- **Class / Sev / Conf:** Reliability risk · P2 · High · Verified fact (independently re-checked).
- **Evidence:** `api-key.authenticator.ts` — the malformed-credential (L118→125) and unknown-key (L134→141) branches call `apiKeys.recordAuthEvent` (a DB INSERT) **before** throwing 401; the rate-limit `consume` calls are only reached at L217/222 *after* key resolution. No global limiter (ORG-PR-012). `security_events` has no `organization_id` index (ORG-PR-014) and no retention (ORG-PR-015).
- **Current behavior:** Every unauthenticated request to `GET /v1/external/projects` with a missing/garbage bearer drives one uncapped INSERT into `security_events`.
- **Expected production behavior:** Pre-authentication abuse is bounded by an edge/global limit; unattributable failed attempts are counted/sampled, not one unbounded row each.
- **Risk:** Unauthenticated table-flooding → unbounded growth, index bloat, degraded audit reads (amplifies ORG-PR-014), and disk-exhaustion DoS.
- **Remediation:** Add edge/global rate limiting ahead of the authenticator (ORG-PR-012); consider sampling/aggregating pre-auth failure events; add the org index (ORG-PR-014) and retention (ORG-PR-015).
- **Dependencies:** ORG-PR-012, ORG-PR-014, ORG-PR-015. **Effort:** M. **Validation:** load test confirming pre-auth writes are bounded. **Roadmap:** Phase 3. **Standards:** ASVS V11.1, V7. **Threats:** T-DOS, T-AUDIT.
- **Resolution (Sprint 19 — Closed):** every 401-family failed-auth event
  (missing/malformed/unknown/revoked/expired/inactive-org) now funnels through
  `recordFailedAuthEventBounded` (`api-key.authenticator.ts`), which consumes
  a per-source-IP allowance (`RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX`,
  default 10/window) BEFORE the durable INSERT; beyond the allowance — or on a
  limiter-store outage, which must never re-open the amplification hole — the
  write is skipped. Refinement iteration: requests with NO resolved client IP
  share one coarse internal `unknown` bucket (a missing IP never means "write
  every event"), and the suppression warn itself is bounded to one sanitized
  line per window per process through an in-process gate that survives a
  store outage (coarse event type + reason only; never the credential or any
  digest of it). The uniform 401 contract is unchanged. Proven by
  `api-key.failed-auth.integration.test.ts` (DB-backed 25-request storm →
  bounded row growth, no credential in rows or captured logs, valid key
  unaffected), `api-key.failed-auth-bounding.test.ts` (null-IP burst and
  log-bound cases), and `external-projects.routes.test.ts` (outage
  semantics). Retention (ORG-PR-015) and the org index (ORG-PR-014) remain
  separate open findings.

<a id="org-pr-014"></a>
### ORG-PR-014 — `security_events` lacks an `organization_id` index backing the audit read path
- **Class / Sev / Conf:** Reliability risk · P2 · High · Verified fact.
- **Evidence:** `packages/db/src/schema/auth.ts — securityEvents` (L151-177) indexes only `user_id`, `event_type`, `created_at`; `organization_id` carries no FK and no index (comment "reserved for future compatibility" is now stale). The audit read query filters `organization_id = ? AND event_type IN (...) ORDER BY created_at DESC, id DESC` plus an unindexed jsonb `metadata->>` filter (`audit.repo.ts`).
- **Current behavior:** Tenant-scoped audit reads scan/bitmap over an append-only, never-pruned table.
- **Expected production behavior:** A composite `(organization_id, created_at, id)` index (and consideration for the jsonb target filter) so audit reads stay bounded as the table grows.
- **Risk:** Audit list latency degrades over time, amplified by ORG-PR-013/ORG-PR-015.
- **Remediation:** Add the composite index in a new forward migration. **Not implemented during the Sprint 14 audit** (schema/migration change).
- **Dependencies:** informs ORG-PR-013/015. **Effort:** S. **Validation:** `EXPLAIN` shows index usage; schema-drift check passes; migrate-from-scratch test updated. **Roadmap:** Phase 3. **Standards:** ASVS V7 (log availability). **Threats:** T-AUDIT, T-DOS.
- **Resolution (Sprint 20 — Closed):** migration `0011_calm_gressill.sql` adds
  `ix_security_events_org_created_id` on `security_events (organization_id,
  created_at, id)` — exactly the audit read shape (`WHERE organization_id = ?
  … ORDER BY created_at DESC, id DESC` with the keyset tie-breaker;
  `audit.repo.ts`). Proven by `migrate.integration.test.ts`: index existence +
  `indexdef` column/order assertion, plus an `enable_seqscan = off` EXPLAIN
  showing the audit-shaped query is answerable through the index (plan choice
  on tiny fixtures is deliberately not asserted). The jsonb `metadata->>`
  target filter remains unindexed by design — it is applied on top of the
  narrow org/time scan. Retention is still ORG-PR-015.

<a id="org-pr-015"></a>
### ORG-PR-015 — No retention/cleanup for unbounded tables
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact (absence).
- **Evidence:** Grep for `DELETE FROM|.delete(|cron|setInterval|sweep|cleanup|purge|prune|retention` (non-test) → only a stale comment (`auth.ts:94` "Expiry sweep") and the display-only `plans.audit_retention_days` (`entitlement.service.ts:53` "not enforced"). No cleanup exists for `sessions`, `refresh_tokens`, `security_events`, `invitations`, `email_verification_tokens`, or expired `api_keys`.
- **Current behavior:** These tables grow forever; `audit_retention_days` is surfaced but never enforced.
- **Expected production behavior:** Scheduled, idempotent, locked cleanup jobs for each state class ([see maintenance-jobs in security-assessment](security-assessment.md)), with metrics and failure alerts.
- **Risk:** Storage/index bloat, slow scans (compounds ORG-PR-014), and unmet retention promises (privacy — ORG-PR-043).
- **Remediation:** Introduce scheduled cleanup once a background runtime exists (ORG-PR-016). **Not implemented during the Sprint 14 audit.**
- **Dependencies:** ORG-PR-016. **Effort:** M. **Validation:** job tests (idempotency, lock, metrics) + retention enforcement test. **Roadmap:** Phase 5. **Standards:** ASVS V7.3; privacy retention. **Threats:** T-AUDIT, T-PRIV.
- **Status (Sprint 20 — OPEN, retention-readiness documented only):** no
  cleanup runtime exists and none was added (a scheduler is out of scope —
  ORG-PR-016). Sprint 20 documents the retention-readiness map — unbounded
  tables, their lifecycle timestamps, and the indexes future batched cleanup
  can use — in [sprint-20-artifact-package.md](sprint-20-artifact-package.md).
  Documentation and indexes do NOT constitute retention enforcement; this
  finding stays open until an actual cleanup runtime lands.
- **Resolution (Sprint 25, 2026-08-24): CLOSED.** A retention policy, a
  runnable cleanup that enforces it, and PostgreSQL-backed safety tests all
  exist. Documentation alone was explicitly insufficient; this is enforcement.

  **Policy.** Six categories, each defined once in
  `apps/api/src/maintenance/retention-policy.ts` with its table, growth driver,
  retention column, window, supporting index, and predicate:
  `security_events` (`created_at`, 180 d default / 30 d floor),
  `expired_refresh_tokens` and `expired_sessions` (`expires_at`, 90 d / 7 d),
  and `expired_email_verification_tokens`,
  `expired_password_reset_tokens`, `expired_pending_registrations`
  (`expires_at`, 30 d / 1 d). `invitations` and `api_keys` are DELIBERATELY
  excluded — both schema files declare their rows durable lifecycle records —
  as are `users`/`organizations`/`memberships`/`projects` (account and tenant
  state; deletion is ORG-PR-043, not a maintenance sweep). Categories from the
  generic retention checklist that this repository does not have (a separate
  audit table, a persistent idempotency store, an email-event/outbox table,
  job tables) are documented as non-existent rather than invented. Full
  matrix: [../retention.md](../retention.md).

  **Enforcement.** `apps/api/src/maintenance/retention-command.ts`, runnable as
  `pnpm db:retention` in source mode and as `node dist/retention.mjs` from the
  deployable artifact (`apps/api/scripts/build.mjs` bundles it into the same
  image, so a maintenance job cannot drift from the deployment it maintains).
  It loads configuration through the same `loadWorkspaceEnv()` + `getConfig()`
  path as the API, so `<NAME>_FILE` mounted secrets and every production guard
  apply unchanged. Deletion requires `--apply`; the default mode is `dry-run`
  and no other flag combination reaches apply mode. Deletion is bounded — one
  `LIMIT`-ed id-subselect batch per transaction, oldest rows first, stopping on
  a short batch or the `--max-batches` cap — so a sweep never holds a long
  destructive lock. A failing category is isolated, reported, and the process
  still exits non-zero. Output is counts and table metadata only; PostgreSQL
  `detail`/`hint` and Drizzle's bound-parameter block are stripped from failure
  messages.

  **Configuration.** Four typed values with HARD FLOORS
  (`RETENTION_SECURITY_EVENT_DAYS` ≥ 30, `RETENTION_EXPIRED_AUTH_TOKEN_DAYS`
  ≥ 1, `RETENTION_ENDED_SESSION_DAYS` ≥ 7, `RETENTION_CLEANUP_BATCH_SIZE`
  1–50000). A zero window would put live rows in scope and a negative one would
  make every row eligible; both fail process start. The default
  `security_events` window is pinned above the largest plan
  `audit_retention_days` (90) by a config test.

  **Referential integrity.** `sessions` is the only retention target with
  inbound foreign keys (`refresh_tokens.session_id`,
  `security_events.session_id`), neither cascading. A session is deleted only
  when EVERY row referencing it is itself past its own cutoff, each clause
  using that referrer's own window. This makes the active-token guarantee
  structural (a refresh token is only ever deleted by its own predicate, which
  matters because refresh lifetimes are not capped by the session) and means
  audit history is never mutated to make a delete succeed. Documented
  consequence: because security events are retained longer than sessions
  (180 d vs 90 d by default), sessions are effectively retained until their
  events age out. See [../retention.md](../retention.md) §3.1.

  **Schema.** Migration `0012` is additive and index-only —
  `ix_refresh_tokens_expires_at`,
  `ix_email_verification_tokens_expires_at`,
  `ix_password_reset_tokens_expires_at`, and `ix_security_events_session_id` —
  one index per cleanup predicate that lacked one. No speculative index was
  added.

  **Evidence.** `retention.integration.test.ts` (21 cases against live
  PostgreSQL, deterministic ages against a fixed instant, no sleeps): dry-run
  counts and mutates nothing; apply removes the expired half of paired
  expired/active fixtures and preserves the active half including the account
  itself; the `<` boundary (a row AT the cutoff survives, one millisecond older
  does not); a second apply deletes nothing; batch size and batch cap are
  honoured exactly and a truncated category resumes on rerun; batches take the
  oldest rows first; `--category` touches only its own table; the session sweep
  clears its refresh tokens even when run alone; a refresh token still inside
  its window survives; **an eligible session whose refresh token is not
  independently eligible is held back, and released once it ages out**; **an
  eligible session still referenced by a retained security event is held back
  with no failed category, and released once that event ages out**; **a
  held-back session does not consume a batch slot or block other eligible
  sessions**; an unreachable database fails every category and yields exit 1; a
  serialized summary contains no email, token hash, user id, or password-hash
  marker; every declared supporting index exists in `pg_indexes` **including
  both session referrer indexes**; **the complete inbound-foreign-key set on
  retention targets matches the reviewed list**; and a full run's result set
  never names `invitations` or `api_keys`. Plus `retention-cli.test.ts` (17),
  `retention-policy.test.ts` (9), and 7 config cases — **54 retention tests**.
  The `--with-artifact` restore drill runs the PACKAGED command against a
  freshly restored database and asserts it deletes nothing and leaves every
  seeded entity in place.

  **`audit_retention_days` reconciliation.** Verified from source rather than
  inferred: it is **modeled metadata explicitly documented as non-enforced**,
  in three independent places that all predate Sprint 25 —
  `packages/contracts/src/plans.ts` (entitlement-key catalog: *"Modeled policy
  value … returned, not enforced by a deletion job"*; and
  `entitlementValuesSchema`: *"a modeled policy value only — Sprint 7 returns
  it but does not run a retention/deletion job"*) and
  `apps/api/src/modules/entitlements/entitlement.service.ts`
  (`AuditEntitlements.retentionDays`: *"not enforced by a deletion job in
  v1"*), with the same statement on the read surface in `docs/audit-log.md`. No
  code path reads it to gate or remove data. Sprint 25 therefore adds
  repository-level lifecycle cleanup with a GLOBAL window and leaves the
  pre-existing non-enforced entitlement semantics unchanged — it neither
  honours nor breaks a behavioral contract, because none existed. This does not
  invalidate closure: this finding asked for retention/cleanup on unbounded
  tables, which now exists and is tested. Per-plan enforcement is a separate,
  unclaimed capability and stays in
  [../known-limitations.md](../known-limitations.md).

  **Documented residual (does NOT reopen this finding):** nothing SCHEDULES the
  cleanup. There is no background runtime (**ORG-PR-016**, open), no metrics,
  and no failure alerting. Per-plan `audit_retention_days` is still not
  enforced — retention is global, not per organization. And retention bounds
  growth; it is not erasure (**ORG-PR-043**, **ORG-PR-052**, open).

<a id="org-pr-016"></a>
### ORG-PR-016 — No background-processing runtime (workers/scheduler)
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** `docs/known-limitations.md`: "No workers, queues, schedulers, or cron." No scheduler code (grep). `infra/docker-compose.yml` header: "No worker/queue runtime."
- **Current behavior:** Anything requiring a background job (expiry sweeps, retention deletion, email retries) is derived-on-read or not performed.
- **Expected production behavior:** A scheduler/worker (cron container, platform scheduler, or in-process scheduled task) to run maintenance jobs reliably.
- **Risk:** Enabler gap — ORG-PR-015 retention, ORG-PR-004 reset-token expiry cleanup, and email-retry reliability all depend on it.
- **Remediation:** Add the simplest scheduler that fits the target (does not require a queue system at this scale).
- **Dependencies:** ORG-PR-001. **Effort:** M. **Validation:** a scheduled job runs, is observable, and is idempotent. **Roadmap:** Phase 5. **Standards:** SSDF PO.3. **Threats:** T-AUDIT, T-PRIV.
- **Status (Sprint 25, 2026-08-24): Open — the WORK a scheduler would run now
  exists.** Retention cleanup (ORG-PR-015, closed) and logical backup
  (ORG-PR-005) are real, tested, idempotent one-shot commands, runnable from
  source and from the deployable artifact. What is still missing is exactly the
  scheduler half of this finding: nothing invokes them periodically, nothing
  emits metrics for a run, nothing alerts on a failed one, and there is no
  concurrency control between two simultaneous invocations (the commands are
  safe to run concurrently — batches are transactional and the predicates are
  idempotent — but nothing prevents it). No worker or queue runtime was added;
  see [../deployment-artifacts.md](../deployment-artifacts.md) ("Worker
  decision").

<a id="org-pr-017"></a>
### ORG-PR-017 — Admin can escalate self/others to Owner
- **Class / Sev / Conf:** Security risk · P2 · Medium · Evidence-backed inference (policy-dependent).
- **Evidence:** `members.change_role` is held by both Owner and Admin (`packages/contracts/src/access.ts` ROLE_PERMISSIONS, L176-177). `member.service.ts — changeMemberRole` (L163-183) → `organization.repo.ts — changeMemberRole` (L307-363) validates only the Last-Owner *demotion* invariant; no guard restricts *promoting* a membership to `owner` or prevents an Admin from creating an Owner. No test asserts the intended behavior either way.
- **Current behavior:** An Admin can set any membership (including their own) to `owner`, then use Owner-only capabilities (e.g. `plan.change_demo`).
- **Expected production behavior:** A documented, enforced role-transition policy — most likely: only an Owner may create/confer Owner. Whichever policy is chosen, it must be enforced in code and tested.
- **Risk:** Vertical privilege escalation to the top role by any Admin.
- **Remediation:** Add a role-transition guard and negative tests. **Policy decision required** (see [production-target.md](production-target.md) decision gates).
- **Dependencies:** none. **Effort:** S. **Validation:** tests for allowed/blocked promotions. **Roadmap:** Phase 3. **Standards:** ASVS V4.1 (access control), V1.2. **Threats:** T-PRIV.
- **Policy update (Sprint 15, 2026-07-18):** the required policy decision now exists — **DG-2 was ratified by the Project Owner** ([sprint-15-decisions.md](sprint-15-decisions.md)): only an active Owner may grant or remove the Owner role; Admins may not confer Owner on themselves or others; last-owner protection remains mandatory. **This finding remains OPEN**: the code still permits Admin→Owner promotion; enforcement and negative tests are Sprint 19 work.
- **Resolution (Sprint 20 — Closed):** DG-2 is enforced server-side, inside the
  member-mutation transaction. `owner-transition.ts` is the single policy
  definition; `organization.repo.ts` applies it in `changeMemberRole` AND
  `removeMember` — any change that grants or removes the Owner role (including
  removing an Owner member, and the Owner→Owner no-op) requires the ACTOR's
  membership to be in the transaction's LOCKED active-owner set, so a
  concurrently demoted actor cannot still confer Owner. Rejection is the
  standard safe 403 `FORBIDDEN`, checked AFTER target resolution (cross-tenant
  probes keep the uniform 404) and BEFORE Last-Owner (which is unchanged and
  still 409 `LAST_OWNER_REQUIRED`). Frontend unchanged and non-authoritative.
  Evidence: `member.routes.test.ts` (15-case allowed/forbidden matrix incl.
  Admin self/other promotion, Admin demote/remove Owner, Member/Viewer,
  removed membership, disabled user, cross-tenant), `member.integration.test.ts`
  (live-PostgreSQL DG-2 + ownership hand-off), `owner-transition.test.ts`.

<a id="org-pr-018"></a>
### ORG-PR-018 — `drizzle-orm` high-severity advisory (installed `<0.45.2`)

> **Status: CLOSED (Sprint 21, 2026-07-26).** The lines below describe the
> pre-close state; see the *Resolution* line.

- **Class / Sev / Conf:** Security risk · P2 · Medium · Verified fact (advisory) / inference (exploitability).
- **Evidence:** `pnpm audit --prod` → 1 high: `drizzle-orm` "SQL injection via improperly escaped SQL identifiers", vulnerable `<0.45.2`, path `apps__api>drizzle-orm`; installed `^0.38.3` (`apps/api/package.json`), advisory GHSA-gpj5-g38j-94v9.
- **Current behavior:** The API depends on a drizzle-orm version in the advisory range.
- **Expected production behavior:** Dependency not in a known-vulnerable range, or a documented risk acceptance with exploitability analysis. Exploitation requires attacker-controlled *SQL identifiers* (table/column names); Orgistry's queries use static identifiers with parameterized values, so a direct path is not evident — but this must be triaged, not assumed.
- **Risk:** Potential SQL injection if any identifier is ever derived from user input; unpatched high advisory in the dependency tree.
- **Remediation:** Triage exploitability, then remediate on the dependency track. **Per Sprint 14 scope, dependencies are NOT upgraded solely for remediation here** — routed to the roadmap.
- **Dependencies:** ORG-PR-020 (scanning). **Effort:** S. **Validation:** `pnpm audit` clean or documented acceptance; grep confirms no dynamic identifiers. **Roadmap:** Phase 3. **Standards:** ASVS V5.3 (injection); SLSA/SSDF PW.4. **Threats:** T-DEP, T-SQLI.
- **Resolution (Sprint 21, 2026-07-26): CLOSED.** `drizzle-orm` upgraded 0.38.4 → **0.45.2** (exactly the GHSA-gpj5-g38j-94v9 / CVE-2026-39356 fix release) in `packages/db` and `apps/api` via pnpm (lockfile updated by pnpm only); `drizzle-kit` 0.30.6 → 0.31.10 for toolchain compatibility. The advisory is absent from current scans (`osv-scanner` against `pnpm-lock.yaml` reports no `drizzle-orm` finding; the CI `pnpm audit` gate covers it going forward). Exploitability context: Orgistry's queries use static identifiers throughout (the Sprint 14 triage grep stands), so no reachable injection path was evident — the dependency was remediated anyway rather than risk-accepted. The upgrade's one behavioral break — drizzle ≥ 0.44 wraps driver errors in `DrizzleQueryError` with the postgres-js error as `cause` — was identified and fixed: the five duplicated `code === '23505'` guards were replaced by one shared cause-chain helper (`apps/api/src/lib/pg-errors.ts`, unit-tested incl. bare/wrapped/nested/cyclic cases), preserving unique-violation classification for registration conflicts, duplicate pending invitations, email changes, and the active-membership backstop. Evidence: `pnpm validate` exit 0; `pnpm validate:integration` (live PostgreSQL + Redis; 82 tests incl. the quota/uniqueness races) exit 0; schema-drift check clean under drizzle-kit 0.31.10 (no migration churn).

<a id="org-pr-019"></a>
### ORG-PR-019 — CI actions pinned to mutable tags; no workflow `permissions` block

> **Status: CLOSED (Sprint 21, 2026-07-26).** The lines below describe the
> pre-close state; see the *Resolution* line.

- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** `.github/workflows/ci.yml` uses `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` (major-version tags, not SHAs). No `permissions:` block → default `GITHUB_TOKEN` scope applies. No `concurrency:` group.
- **Current behavior:** CI trusts mutable third-party action references and runs with default token permissions.
- **Expected production behavior:** Actions pinned to full commit SHAs; an explicit least-privilege `permissions:` block; `concurrency` to cancel superseded runs.
- **Risk:** A hijacked/retagged action executes in CI with broader-than-needed token scope (supply-chain/CI compromise).
- **Remediation:** Pin to SHAs, add `permissions: { contents: read }` (widen per job as needed).
- **Dependencies:** none. **Effort:** S. **Validation:** workflow lints; pins are SHAs. **Roadmap:** Phase 3 / Phase 6. **Standards:** SLSA source/build; SSDF PO.5. **Threats:** T-CI.
- **Resolution (Sprint 21, 2026-07-26): CLOSED.** Every `uses:` in `.github/workflows/{ci,security,codeql}.yml` is a full commit SHA resolved from the upstream repository via `git ls-remote` (annotated tags dereferenced to their commit) with the version retained as a trailing comment: `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.0.9, `github/codeql-action` v4.37.3, `gitleaks/gitleaks-action` v3.0.0. All three workflows declare workflow-level `permissions: contents: read`; the only wider scope anywhere is `security-events: write` (plus the CodeQL-required `actions: read`) on the single CodeQL analyze job. `concurrency` groups cancel superseded runs (the finding's expected-behavior item). Dependabot's `github-actions` ecosystem proposes SHA-pin bumps weekly; the pin-update review procedure (re-verify the SHA against the upstream release before merging) is documented in docs/validation.md. Validation evidence: `actionlint` exit 0 across all workflows; repo-wide search finds zero mutable action references. Residual (documented; tracked under ORG-PR-020, does not reopen this finding): the hardened workflows have not yet executed on GitHub-hosted CI.

<a id="org-pr-020"></a>
### ORG-PR-020 — No dependency/vuln/secret/SAST scanning in CI
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact (absence).
- **Evidence:** `.github/` contains only `workflows/ci.yml`; no `dependabot.yml`/`renovate.json`; CI runs no `pnpm audit`, CodeQL, secret scanning, or SAST (workflow read).
- **Current behavior:** Vulnerable/abandoned deps (e.g. ORG-PR-018) and leaked secrets are detected only by manual runs; `^` ranges mean drift is invisible.
- **Expected production behavior:** Automated dependency updates + `audit` gate + secret scanning + SAST/CodeQL in CI.
- **Risk:** Known-vulnerable dependencies and committed secrets ship undetected.
- **Remediation:** Add Dependabot/Renovate, an `audit`/OSV gate, secret scanning, and CodeQL.
- **Dependencies:** none. **Effort:** M. **Validation:** CI runs the scanners and fails on a seeded finding. **Roadmap:** Phase 3 / Phase 6. **Standards:** SSDF PW.4/RV.1; SLSA. **Threats:** T-DEP, T-SECRET, T-CI.
- **Progress (Sprint 21, 2026-07-26): Open — materially advanced.** Implemented and configured: **(1) dependency vulnerability gate** — `security.yml` runs `pnpm audit --prod --audit-level high` and `pnpm audit --dev --audit-level high` (high/critical fail; production and development risk separated; no `|| true` or `continue-on-error` anywhere) on push/PR/weekly schedule/manual dispatch; exceptions live ONLY in `pnpm.auditConfig.ignoreGhsas` (currently two, each with a reachability analysis — react-router GHSA-qwww-vcr4-c8h2: CSRF in unstable RSC APIs, fix is a major upgrade, the web demo is a client-only SPA with zero RSC usage; brace-expansion GHSA-mh99-v99m-4gvg: DoS in a dev-only eslint transitive with no compatible fixed release). In-range vulnerable transitives were remediated outright instead of accepted (find-my-way 9.7.0, fast-uri 3.1.4, postcss 8.5.18, shell-quote 1.9.0, brace-expansion 1.1.16). Local equivalents: `pnpm scan:deps` (audit) and `pnpm scan:deps:local` (osv-scanner with the mirrored `osv-scanner.toml` ignore file). The exact CI audit commands were executed locally in the closing pass: prod and dev gates exit 0 with exactly the two documented ignores reported, and a negative test (ignore entry temporarily removed, `package.json` restored byte-identical afterwards) made the prod gate exit 1 — the gate demonstrably fails on an unaccepted high. **(2) Secret scanning** — Gitleaks (SHA-pinned action) fails on suspected live secrets; realistic-looking committed fixtures were REWRITTEN to unmistakable fakes; `.gitleaks.toml` allowlists only the committed fake SMTP TLS fixture (one path) and five exact historical fake values / one prose false-positive (regexes), each annotated in-file; local `pnpm scan:secrets` (full git-history scan) exits clean, the pre-rewrite run detected all 8 fixture hits, and a disposable-repository negative test proved the final config fails (exit 1) on a synthetic secret with redacted output while accepting the allowlisted historical value ONLY verbatim (a one-character mutation fails) — see artifact §17. CI scan semantics verified against the pinned action source: push/PR scan the event's commit range, schedule/dispatch scan full history (checkout `fetch-depth: 0`), PR comments disabled so the job needs no write permission and is fork-PR-safe. **(3) SAST** — CodeQL v4, `javascript-typescript`, build-mode `none` (no install/build, no secrets), push/PR/weekly, `security-events: write` scoped to the one analyze job. **(4) Dependency-update automation** — `dependabot.yml` covering npm (workspace root), github-actions (SHA pins), and docker-compose (`infra/` — the ecosystem that actually discovers `docker-compose.yml`), weekly, minor/patch grouped, majors individual; no auto-merge exists. Local validation: osv-scanner exit 0, gitleaks history scan exit 0, actionlint exit 0. **Why still open:** none of the new workflows has executed on GitHub-hosted CI. Closure requires the first green remote run of `security.yml` and `codeql.yml` plus a verified failure on a seeded finding (and, for CodeQL on a private repository, code-scanning availability). Configuration is not enforcement until it has run.
- **Resolution (Sprint 22, 2026-07-26): CLOSED.** The three conditions Sprint 21 named as outstanding are now met with remote evidence.
  **(1) First green remote runs.** All three workflows executed on GitHub-hosted CI on the Sprint 21 commit `c33a150f` (event `push`, branch `main`): CI run [30205303375](https://github.com/DanielRosenberg00/Orgistry/actions/runs/30205303375) success; Security scans run [30205303370](https://github.com/DanielRosenberg00/Orgistry/actions/runs/30205303370) success; CodeQL run [30205303373](https://github.com/DanielRosenberg00/Orgistry/actions/runs/30205303373) success.
  **(2) Verified failure on a seeded finding — remote, not local.** A temporary branch `chore/sprint-22-scanner-negative-path` (commit `75daffcdfd7e52969a1e97a52e15af751ccbb662`, based on `origin/main`) carried one synthetic, non-provider-format, never-valid high-entropy assignment in `SPRINT-22-SCANNER-NEGATIVE-PATH.txt`. `security.yml` was dispatched against that ref: run [30207672121](https://github.com/DanielRosenberg00/Orgistry/actions/runs/30207672121) concluded **failure**. Job-level detail proves the failure was specific rather than a broken workflow: *Dependency audit (pnpm)* → success; *Secret scan (Gitleaks)* → **failure** at the gitleaks step, reporting `RuleID: generic-api-key`, `File: SPRINT-22-SCANNER-NEGATIVE-PATH.txt`, `Line: 13`, `Commit: 75daffcd`, `leaks found: 1`, with `Secret: REDACTED` — confirming the redaction guarantee holds on a real failure. The branch was deleted from the remote and locally immediately afterwards; `gh api /repos/DanielRosenberg00/Orgistry/branches` lists only `main` and Dependabot branches. Nothing from that branch was merged or cherry-picked into `main`. The GitHub run record persists as durable evidence.
  **(3) SAST is operational AND triaged.** CodeQL is not merely running: its first analysis produced 41 High alerts, every one of which was individually triaged in Sprint 22 with source/sink evidence, root-cause grouping, and an individual GitHub disposition — see [sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md) and [sprint-22-artifact-package.md](sprint-22-artifact-package.md). The triage found and fixed two true positives: ORG-PR-055 (audit-read cost) and ORG-PR-056 (credential output from the demo bootstrap, initially mitigated and then fully remediated in the completion iteration). Code scanning is available (public repository); the analysis uploads SARIF under the single `security-events: write` job.
  **(4) Enforcement, which is what "gate" required.** Sprint 21 correctly noted that configuration is not enforcement. Sprint 22 added the missing half: a repository ruleset targeting `main` requires a pull request and makes the CI, Security, and CodeQL checks required status checks, so a scanner failure now blocks the merge instead of merely being visible. Direct pushes to `main` are refused. The gate policy that governs dispositions is documented in [validation.md](../validation.md#codeql-alert-policy).
  **Residual (does NOT reopen this finding, tracked elsewhere):** code-scanning merge protection blocks on alert *severity* and cannot express a per-query allow-list, so the "no new High alerts" rule is enforced at that granularity only; the remainder of the alert policy (evidence-bearing individual dismissals, no bulk dismissal) is a documented manual control, stated as such rather than claimed as enforced. Container image digest pinning remains under ORG-PR-042; artifact signing and SLSA provenance remain out of scope under ORG-PR-001.

<a id="org-pr-021"></a>
### ORG-PR-021 — No DB pool / statement / lock timeouts
- **Class / Sev / Conf:** Reliability risk · P2 · Medium · Verified fact.
- **Evidence:** `packages/db/src/client.ts — createDbClient` sets pool `max: 10` with no `connect_timeout`/`idle_timeout`/`max_lifetime`/`statement_timeout` (grep → none); API calls it with no `max` (`server.ts:44`). `FOR UPDATE` paths (owner/rotation/accept) have no lock/statement timeout.
- **Current behavior:** A slow/stuck query or lock can occupy a pool slot indefinitely; under load the 10-slot pool can exhaust with no queue timeout.
- **Expected production behavior:** Explicit `statement_timeout`, `idle_in_transaction_session_timeout`, lock timeouts, and pool sizing/timeouts tuned to the deployment.
- **Risk:** A single pathological query stalls the API; cascading pool exhaustion under load.
- **Remediation:** Set statement/lock/pool timeouts via config for production.
- **Dependencies:** ORG-PR-001. **Effort:** S. **Validation:** a deliberately slow query is cut off by `statement_timeout`. **Roadmap:** Phase 4. **Standards:** ASVS V11 (resource limits). **Threats:** T-DOS.

<a id="org-pr-022"></a>
### ORG-PR-022 — App and migrations share a single Postgres superuser
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** `infra/docker-compose.yml:19` and `.env.example:42` define one `orgistry` superuser used for both runtime (`server.ts:44`) and DDL (`scripts/migrate.ts`). No `CREATE ROLE`/`GRANT`/separate roles anywhere (grep → none).
- **Current behavior:** The app runtime connection has full DDL/DROP authority.
- **Expected production behavior:** A least-privilege runtime role (DML on app tables only) distinct from a migration role with DDL rights.
- **Risk:** A compromised app connection (e.g. via ORG-PR-018) can drop/alter schema, not just read/write rows.
- **Remediation:** Provision separate migration and runtime roles with scoped grants in production.
- **Dependencies:** ORG-PR-001. **Effort:** M. **Validation:** runtime role cannot run DDL; migrations run under the DDL role. **Roadmap:** Phase 4. **Standards:** ASVS V1.11/V4 (least privilege). **Threats:** T-DBLOSS, T-SQLI.

<a id="org-pr-023"></a>
### ORG-PR-023 — No React error boundary; a render throw blanks the SPA
- **Class / Sev / Conf:** Reliability risk · P2 · High · Verified fact.
- **Evidence:** No error boundary in `apps/web-demo/src/main.tsx` or `App.tsx` (grep). `hooks/useOrganization.ts — useSelectedOrganizationId` (L23-29) throws "No organization is selected" by design.
- **Current behavior:** Any render-time throw yields a white screen with no recovery UI.
- **Expected production behavior:** A top-level error boundary rendering a recoverable fallback and (optionally) reporting the error.
- **Risk:** A single unexpected throw takes the whole UI down with no path back; worst near org-selection edge cases.
- **Remediation:** Add an error boundary around the router/shell with a reset action.
- **Dependencies:** none. **Effort:** S. **Validation:** component test that a thrown child renders the fallback. **Roadmap:** Phase 3 (frontend hardening). **Standards:** ASVS V14 (resilience). **Threats:** T-OPS.

<a id="org-pr-024"></a>
### ORG-PR-024 — No email verification (unused `email_verification_tokens` scaffolding)

> **Status: CLOSED (Sprint 16, 2026-07-18).** The Evidence/Current behavior
> lines below describe the **Sprint 14 audit baseline**, preserved as
> recorded; they no longer describe the repository. See the **Resolution**
> line at the end of this entry.

- **Class / Sev / Conf:** Product completeness gap · P2 · High · Verified fact (absence).
- **Evidence:** Table `email_verification_tokens` exists (`packages/db/src/schema/auth.ts` L130-149, migration `0001`) and `users.emailVerifiedAt` exists, but grep across `apps/`+`packages/` shows references only in schema/barrel/migrations/tests — no service, route, or consumer. No verification email is ever sent; `email_verified_at` is never set.
- **Current behavior:** Email ownership is never verified; the scaffolding is dead.
- **Expected production behavior:** A verification flow that mints/sends/redeems a token and can gate sensitive actions.
- **Risk:** Unverified emails enable typo'd/hostile-address signups and undermine any email-based recovery; unused schema misleads (ORG-PR-048).
- **Remediation:** Implement verification on the existing token table + mailer, or explicitly remove the scaffolding if deferred.
- **Dependencies:** ORG-PR-002. **Effort:** M. **Validation:** integration tests for mint/redeem/expiry/resend. **Roadmap:** Phase 2. **Standards:** ASVS V2.1. **Threats:** T-ENUM, T-INV.
- **Resolution (Sprint 16, 2026-07-18): CLOSED.** The complete lifecycle is implemented and tested: authenticated `POST /v1/auth/email-verification/request` (also the resend endpoint; current user's stored email only — no address input, so no enumeration surface), public `POST /v1/auth/email-verification/complete` (raw token in the body), hash-only 32-byte CSPRNG tokens (`email-verification.token.ts` over the shared opaque-token primitives), expiry (`EMAIL_VERIFICATION_TTL_SECONDS`, default 24 h), single-use consumption + sibling invalidation + conditional `users.email_verified_at` update in ONE transaction under `SELECT … FOR UPDATE` (`email-verification.repo.ts`), resend invalidation of all prior unused tokens, best-effort automatic first email after registration, Redis-backed rate limits, sanitized `auth.email_verification_*` security events, `emailVerified` on the current-user contract, and the web-demo banner + `/auth/verify-email` completion flow. Evidence: `email-verification.routes.test.ts` (18 route tests), `email-verification.integration.test.ts` (live PostgreSQL incl. the concurrent double-completion race), web-demo `email-verification.test.tsx` (13 tests). Verification is **advisory** in Sprint 16 (no gates) by documented product policy — see [email-and-verification.md](../email-and-verification.md). Note: closure of this finding does not close ORG-PR-002 (external delivery unvalidated).

<a id="org-pr-025"></a>
### ORG-PR-025 — No account deletion / data export (data-subject rights)
- **Class / Sev / Conf:** Compliance dependency · P2 · High · Verified fact (absence). **Legal review required.**
- **Evidence:** `users.deletedAt` soft-delete column is honored on read but no deletion route/service exists; no data-export endpoint (grep → none in auth module).
- **Current behavior:** Users cannot delete their account or export their data; operators have no supported deletion path.
- **Expected production behavior:** Account closure (soft + hard-delete/anonymization policy), data export, and correction paths consistent with the applicable privacy regime.
- **Risk:** Cannot honor data-subject requests; retention of PII (ORG-PR-043) with no deletion path.
- **Remediation:** Build deletion/export flows; define anonymization vs. hard-delete policy. **Legal review required** for scope/timelines.
- **Dependencies:** ORG-PR-015/016 (retention), legal. **Effort:** L. **Validation:** deletion/export integration tests; PII fully removed/anonymized. **Roadmap:** Phase 5 / legal gate. **Standards:** ASVS V8 (data protection). **Threats:** T-PRIV.

<a id="org-pr-026"></a>
### ORG-PR-026 — No failure-injection / degraded-dependency integration tests
- **Class / Sev / Conf:** Reliability risk · P2 · Medium · Verified fact (absence).
- **Evidence:** Degraded paths are only unit-mocked (`readiness.test.ts:35` stubbed probe; `rate-limit.test.ts:68` mocked Redis throw). `readiness.integration.test.ts` asserts only the healthy path. No test kills a live DB/Redis mid-request or a down SMTP against live services.
- **Current behavior:** Real-stack behavior under dependency failure is unverified.
- **Expected production behavior:** Integration tests exercising DB-down, Redis-down (fail-open path), and SMTP-down behavior against live services.
- **Risk:** Degradation behavior (fail-open limits, readiness, error mapping) is asserted only in mocks; production surprises likely.
- **Remediation:** Add failure-injection integration suites.
- **Dependencies:** ORG-PR-009 (fail-closed option). **Effort:** M. **Validation:** suites pass with dependencies toggled. **Roadmap:** Phase 6 (E2E & verification). **Standards:** SSDF PW.8. **Threats:** T-DOS, T-OPS.

<a id="org-pr-027"></a>
### ORG-PR-027 — No production operations documentation
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** Doc census: deploy, rollback, backup/restore, secret rotation, and production incident response are absent; `docs/roadmap.md` catalogs each as a gap. Migration-apply and local diagnosis are covered; production operations are not.
- **Current behavior:** A future maintainer cannot learn production configuration, deploy, rollback, backup/restore, rotation, or incident response from the docs.
- **Expected production behavior:** An operations guide covering all of the above, cross-linked from the README.
- **Risk:** Operability depends on tribal knowledge; slow, error-prone production changes.
- **Remediation:** Author production ops docs as the infra/reliability work lands (pairs with ORG-PR-005/006/008).
- **Dependencies:** ORG-PR-001/005/007. **Effort:** M. **Validation:** a new operator completes a deploy + restore drill from docs alone. **Roadmap:** Phase 5. **Standards:** SSDF PO.3/RV. **Threats:** T-OPS.

<a id="org-pr-028"></a>
### ORG-PR-028 — No migration rollback / recovery strategy
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** `packages/db/migrations/` contains only forward `0000-0007.sql`; no down/`.down.sql` files (find → none). Migrations are additive and transactional (`_journal.json` breakpoints=true), but there is no documented recovery for a bad migration.
- **Current behavior:** Recovery from a bad migration = restore/reset only; no rehearsed procedure.
- **Expected production behavior:** A documented forward-only recovery strategy (compensating migrations + restore), rehearsed against the backup path.
- **Risk:** A failed production migration has no rehearsed rollback; pairs with the missing restore capability (ORG-PR-005).
- **Remediation:** Document the forward-only recovery model and rehearse it with the restore drill.
- **Dependencies:** ORG-PR-005. **Effort:** S. **Validation:** a bad-migration recovery is rehearsed in staging. **Roadmap:** Phase 4 / Phase 5. **Standards:** SSDF PO.3. **Threats:** T-MIG.
- **Progress (Sprint 25, 2026-08-24): Open — the recovery MECHANISM now
  exists; the rehearsal does not.** The forward-only model is documented
  alongside two working recovery paths: restore-from-backup and PITR to a time
  just before the migration ([../backup-and-restore.md](../backup-and-restore.md),
  [../pitr.md](../pitr.md)), plus a `pnpm db:backup -- --label pre-migration`
  step in the artifact deployment guide. The restore drill proves a restored
  database is compatible with the exact migration entrypoint the deploy uses
  (re-running migrations against it must be a no-op). **Still open:** the
  failed-migration runbook is explicitly labelled *unrehearsed guidance* — no
  bad-migration recovery has been executed against a real environment, and
  there is no staging environment to rehearse it in (ORG-PR-001, open).

<a id="org-pr-029"></a>
### ORG-PR-029 — Quota ceilings are TOCTOU-racy under concurrency
- **Class / Sev / Conf:** Data-integrity risk · P3 (P2 if quotas become billing-enforced) · High · Verified fact.
- **Evidence:** For creation, the quota is checked in the service *outside* the write transaction and not re-verified under a lock: projects (`entitlement.service.ts:184-191` + `project.repo.ts` separate tx), API keys (`api-key.service.ts:196-208`), invitation reservation (`invitation.service.ts:335-341`). Invitation *acceptance* counts inside the tx but locks only the invitation row, so two distinct tokens/users race under READ COMMITTED (`invitation.acceptance.ts:142-158`). No DB constraint caps the counts. No concurrency tests (grep).
- **Current behavior:** Two concurrent authorized creates can each pass the ceiling check and both write, exceeding the plan limit by a small margin.
- **Expected production behavior:** Atomic enforcement (row-lock the plan/counter, conditional insert, or a DB constraint) so concurrent creates at the ceiling cannot exceed it.
- **Risk:** Bounded ceiling overrun; not a tenant/auth breach today, but becomes material if quotas gate billing.
- **Remediation:** Serialize the count+insert (lock plan row or use an atomic conditional write); add concurrency tests.
- **Dependencies:** none. **Effort:** M. **Validation:** concurrent-create integration tests cannot exceed the ceiling. **Roadmap:** Phase 3. **Standards:** ASVS V11.1 (business-logic limits). **Threats:** T-QUOTA.
- **Resolution (Sprint 20 — Closed, incl. same-sprint correctness
  refinement):** every quota-protected creation now evaluates its ENTIRE
  quota decision inside ONE transaction: a transaction-scoped PostgreSQL
  advisory lock keyed by organization and quota kind (`quota-lock.ts`;
  `pg_advisory_xact_lock(hashtextextended('quota:<kind>:<org>', 0))`), then
  the CURRENT plan resolved through that same transaction
  (`entitlement.snapshot.ts — lockOrganizationEntitlements`, plan row
  `FOR SHARE` — plan assignment is runtime-mutable, so a pre-transaction
  ceiling could be stale; the refinement removed every `max*` parameter from
  the repository mutation contracts so a stale ceiling is structurally
  impossible), then the count, comparison, write, and success event:
  projects (`project.repo.ts`), API keys (`api-key.repo.ts` — access gate and
  ceiling from ONE snapshot), invitation creation/seat reservation
  (`invitation.repo.ts`), and every member-capacity consumer via the shared
  acceptance body (`invitation.acceptance.ts` — `members` lock, then plan
  snapshot, then the invitation row lock; covers existing-user acceptance AND
  invited registration completion). Counting bases unchanged (active
  projects; non-revoked+non-expired keys; active members + non-expired
  pending invitations). `QUOTA_EXCEEDED` semantics unchanged. Lock order,
  plan-mutation interaction, and downgrade semantics:
  [sprint-20-quota-race-audit.md](sprint-20-quota-race-audit.md). Proven by
  `quota-concurrency.integration.test.ts` (see ORG-PR-044) — a lock-removed
  build fails deterministically — and by
  `quota-plan-coherence.integration.test.ts` (committed downgrade/upgrade
  honored by the very next create; an IN-FLIGHT plan change serializes
  against the create via FOR SHARE vs FOR UPDATE; API-key access + ceiling
  coherent; acceptance ceiling transaction-resolved; PLAN_STATE_MISSING
  fail-safe).

<a id="org-pr-030"></a>
### ORG-PR-030 — User enumeration on registration
- **Class / Sev / Conf:** Security risk · P3 · High · Verified fact.
- **Evidence:** `auth.service.ts — register` (L388-391) pre-checks the email and throws distinct `409 EMAIL_ALREADY_REGISTERED` (`auth.errors.ts:25`) vs. a 201 success. Login is enumeration-hardened (uniform error + dummy-hash timing) but register is not.
- **Current behavior:** Registration discloses which emails already have accounts.
- **Expected production behavior:** Generic "check your email" response driven through email verification, removing the existence oracle.
- **Risk:** Account enumeration feeding targeted credential-stuffing/phishing.
- **Remediation:** Return a generic response and signal existence only via the (to-be-built) verification email (ORG-PR-024).
- **Dependencies:** ORG-PR-024. **Effort:** S. **Validation:** test that register does not distinguish existing vs. new. **Roadmap:** Phase 3. **Standards:** ASVS V2.1/V3. **Threats:** T-ENUM.
- **Status (Sprint 17, 2026-07-20): OPEN — materially advanced, NOT closed.** The oracle is now bounded and observed, not removed: a per-normalized-email-digest rate limit (`RATE_LIMIT_REGISTER_PER_EMAIL_MAX`, counted before the lookup and identically for known/unknown addresses) throttles probing independent of the attacker's IP pool, and each duplicate attempt writes a durable `auth.registration_duplicate_email` security event (ANONYMOUS actor, null user id, coarse `reason` metadata — the unproven caller is never represented as the account owner, and no email or email digest is stored; request context rides on the event row's sanitized IP/UA/request-id fields). The `409 EMAIL_ALREADY_REGISTERED` response itself is unchanged and still distinguishable: registration synchronously returns a live session (`201 { user, tokens }` + cookie), so a duplicate cannot be answered uniformly without fabricating credentials or converting to the verification-required, email-first registration this remediation envisions — a product redesign out of Sprint 17 scope. The public password-recovery flow (Sprint 17) is fully enumeration-safe; login hardening is unchanged. Follow-up: full closure requires the generic-response registration redesign (signal existence only via email). Evidence: `credential-change.routes.test.ts — registration duplicate-email behavior` (conflict contract, probe event, per-email throttle, no-oracle bucket counting). Design note: [credential-management.md](../credential-management.md#registration-de-enumeration-org-pr-030--design-note).
- **Resolution (Sprint 18, 2026-07-20): CLOSED.** The public account-existence oracle is REMOVED, not merely bounded. Public registration is verification-first: `POST /v1/auth/register` answers one contract-identical `200 { ok: true, data: { accepted: true } }` for every post-validation outcome — eligible new email, existing active account, existing unverified account, disabled account, soft-deleted account, lookup failure, persistence failure, and mail-delivery failure — with no user DTO, no tokens, no refresh cookie, no organization/membership/invitation data, and no email-delivery state. No user, session, or workspace is created by the request; the account is created exclusively by `POST /v1/auth/registration/complete` after proof of the emailed single-use, hash-only-persisted completion token (the completed account is email-verified by construction). `EMAIL_ALREADY_REGISTERED` is gone from every public surface; it survives only on the authenticated email-change flow, where the caller has re-proved the account password (an intentionally allowed, documented disclosure outside this oracle). The Sprint 17 per-IP and per-email-digest rate limits run BEFORE the account lookup; the duplicate-attempt event became the anonymous `auth.registration_requested` outcome record (never the victim's user id, no email material). Evidence: `registration.routes.test.ts` (public response-equality MATRIX: direct `toEqual` comparison of status/body/cookie/auth-header across new, active, unverified, disabled, soft-deleted, and mailer-failure states; no-account-state-created assertions; secret-material hygiene), `registration.integration.test.ts` (DB-backed: advisory-lock issuance concurrency leaves exactly one usable generation; `FOR UPDATE` completion race admits exactly one account; anonymous request events), and the frontend generic check-email copy in `registration.test.tsx`. Residual accepted side channel — documented in [known-limitations.md](../known-limitations.md): response TIMING is not fully equalized (the Argon2id cost is now spent identically on every path by hashing before the lookup, but the eligible-new-email path still performs one pending-registration insert and one mailer hand-off that other paths do not); closing it requires out-of-band delivery (a queue), and the pre-lookup rate limits bound the sampling rate. This residual is a timing side channel, not a response-contract oracle, and does not reopen the finding. Design: [auth-foundation.md](../auth-foundation.md).
- **Refinement (Sprint 18 correction pass, 2026-07-21):** the full Sprint 18 invitation contract is now corrected as well. As first shipped, invitation-carrying registration surfaced explicit invitation errors from `POST /v1/auth/register` (`INVITATION_INVALID` / `INVITATION_EMAIL_MISMATCH` / `QUOTA_EXCEEDED` …) — not an ACCOUNT-existence oracle (the closure evidence above is unaffected), but an invitation-state disclosure the sprint specification prohibited on this surface. Now every private invitation-validation failure (unknown/malformed token, expired/revoked/accepted lifecycle, email mismatch, request-time quota exhaustion, resolver failure) returns the same generic `200 { accepted: true }`, stages no pending registration, creates no user, mutates no invitation, and sends no email of any kind; only a coarse anonymous `auth.registration_requested` outcome (`invitation_rejected` / `invitation_lookup_failed` — no token material, email, org/invitation ids, or quota values) is recorded, and the translation is centralized in `resolveRequestInvitation`. The dedicated invitation-INSPECT endpoint (unchanged) remains the invitation-feedback channel. Evidence: the ten-row public equality matrix in `invitation.routes.test.ts` (plain new email, existing account, unknown token, mismatch±existing account, expired, revoked, accepted, quota, internal resolver failure — byte-identical status/body/cookies/auth-headers plus zero-side-effect assertions per rejected row). The invited frontend path (invitation landing page → transient-context registration) is covered by `invitation-registration.test.tsx`.

<a id="org-pr-031"></a>
### ORG-PR-031 — No idempotency keys on create operations
- **Class / Sev / Conf:** Reliability risk · P3 · Medium · Verified fact (absence).
- **Evidence:** No `Idempotency-Key` handling anywhere (grep `idempoten` → only comments about naturally-idempotent logout/revoke). Create-org/project/api-key/invitation each produce a new row (api-key mints a new secret; invitation sends a new email) on retry.
- **Current behavior:** A client retry after a dropped response silently duplicates.
- **Expected production behavior:** Idempotency-key support on unsafe create operations (dedup store keyed by client-supplied key).
- **Risk:** Duplicate resources, duplicate invitation emails, orphaned secrets on network retries.
- **Remediation:** Add idempotency-key middleware for creates.
- **Dependencies:** none. **Effort:** M. **Validation:** duplicate-submit test returns the original result. **Roadmap:** Phase 3. **Standards:** ASVS V11 (business logic). **Threats:** T-INV.

<a id="org-pr-032"></a>
### ORG-PR-032 — Spammable authenticated mutations lack rate limits
- **Class / Sev / Conf:** Security risk · P3 · High · Verified fact.
- **Evidence:** No rate limit on `POST …/invitations` (sends an email each call — `invitation.routes.ts`), `POST …/api-keys`, `POST /v1/organizations`, or project/member mutations. Only auth + external surfaces are limited (grep `.consume(`).
- **Current behavior:** A member can loop invitation emails up to the reservation ceiling and spam key/resource creation.
- **Expected production behavior:** Per-actor rate limits on mutation surfaces, especially email-sending ones.
- **Risk:** Email-abuse/reputation damage, resource spam.
- **Remediation:** Apply per-actor limits to mutations (pairs with ORG-PR-012 global limiter).
- **Dependencies:** ORG-PR-012. **Effort:** M. **Validation:** limiter tests on invitation/key create. **Roadmap:** Phase 3. **Standards:** ASVS V11.1. **Threats:** T-INV, T-DOS.
- **Resolution (Sprint 19 — Closed; completed in the refinement iteration):**
  every surface named by this finding is now covered. Targeted per-actor
  buckets on the provisioning mutations — organization create (per user),
  project create (per user), API-key create (per user), invitation create
  (per user + per org; each create sends real email), demo plan change (per
  org) — PLUS, from the refinement iteration, member role change + removal
  (one shared per-acting-user bucket,
  `RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX`) and project update + delete
  (one shared per-acting-user bucket,
  `RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX`), both of which write a durable
  audit event per call. All buckets are enforced in the services AFTER
  permission checks so throttling never masks authorization. Only the revokes
  (invitation, API key, session) remain deliberately unthrottled: a revoked
  resource cannot be revoked twice, so their durable writes are capped by
  creation — which is itself throttled. Tested:
  `organization/mutation-throttle.test.ts` (incl. member buckets),
  `projects/project-throttle.test.ts` (incl. update/delete),
  `api-keys/api-key-create-throttle.test.ts`, `entitlements/plan-throttle.test.ts`,
  `invitation.throttle.test.ts` (thresholds, user/org isolation, standard
  envelope, permission-first regression).

<a id="org-pr-033"></a>
### ORG-PR-033 — No structured-logger redaction backstop
- **Class / Sev / Conf:** Maintainability issue (security-adjacent) · P3 · Medium · Verified fact.
- **Evidence:** `app.ts:136` configures pino with only `{ level }`; no `redact` paths. Audit/security-event metadata is sanitized (`lib/security-metadata.ts`) but the HTTP logger has no redaction. Fastify's default serializers don't log headers, so current exposure is low.
- **Current behavior:** Any future `log.info({ headers })` or error log including tokens would emit them in cleartext.
- **Expected production behavior:** A logger `redact` config for Authorization/Cookie/secret paths as defense-in-depth.
- **Risk:** Latent secret leakage into logs on any future logging change.
- **Remediation:** Add pino `redact` paths.
- **Dependencies:** none. **Effort:** S. **Validation:** log-capture test confirms redaction. **Roadmap:** Phase 3. **Standards:** ASVS V7.1 (log content). **Threats:** T-LOG.
- **Resolution (Sprint 19 — Closed):** every process logger is now built by
  `lib/logging.ts — buildLoggerOptions` (the app default in `app.ts`), which
  installs pino `redact` paths expanded from a curated sensitive-key list
  (authorization, cookie, set-cookie, the CONFIGURED CSRF header name,
  password/currentPassword/newPassword, token/refreshToken/invitationToken,
  tokenHash/passwordHash, apiKey/apiKeySecret, secret/jwtSecret/smtpPassword,
  `SMTP_PASSWORD`/`JWT_SECRET`) across header-serializer, body, config, error,
  and one-level-nested shapes. Log-capture tests (`lib/logging.test.ts`, plus
  the storm integration test) prove representative values never appear while
  safe diagnostic fields survive. Redaction is a BACKSTOP: modules still must
  not log bodies or credentials (unchanged policy).

<a id="org-pr-034"></a>
### ORG-PR-034 — "Best-effort" last-used / auth-event writes are not isolated
- **Class / Sev / Conf:** Reliability risk · P3 · Medium · Verified fact.
- **Evidence:** `api-key.authenticator.ts` awaits `apiKeys.touchLastUsed(...)` (L245-247) and each `recordAuthEvent(...)` with no try/catch; repo methods have no internal try/catch (`api-key.repo.ts:211-238`). Comments claim these are "best-effort … must never break a valid request," but a throw propagates and 500s the request.
- **Current behavior:** A transient DB hiccup on a bookkeeping write fails an otherwise-valid external API request.
- **Expected production behavior:** These writes are genuinely best-effort (wrapped/deferred) so they cannot fail the request.
- **Risk:** Availability dips on the external API from non-critical write failures; documented intent contradicts behavior.
- **Remediation:** Wrap bookkeeping writes in try/catch (log-and-continue) or defer them.
- **Dependencies:** none. **Effort:** S. **Validation:** test that a throwing `touchLastUsed`/`recordAuthEvent` does not fail the request. **Roadmap:** Phase 3. **Standards:** ASVS V7. **Threats:** T-OPS.

<a id="org-pr-035"></a>
### ORG-PR-035 — No CSP / security meta in the web demo
- **Class / Sev / Conf:** Security risk · P3 · Medium · Verified fact.
- **Evidence:** `apps/web-demo/index.html` has only `charset`/`viewport` meta; no CSP. `vite.config.ts` has no `build.sourcemap` (defaults off — good). Token is in-memory, so XSS containment matters.
- **Current behavior:** No CSP unless the serving layer adds one (unknown).
- **Expected production behavior:** A CSP (server-set or meta) constraining script/connect origins, aligned with the API header work (ORG-PR-011).
- **Risk:** XSS would expose the in-memory access token; no CSP containment.
- **Remediation:** Serve a CSP from the static host/proxy; align with API headers.
- **Dependencies:** ORG-PR-011. **Effort:** S. **Validation:** response CSP present and effective. **Roadmap:** Phase 3 / Phase 4. **Standards:** ASVS V14.4. **Threats:** T-XSS.

<a id="org-pr-036"></a>
### ORG-PR-036 — Frontend UX/robustness gaps
- **Class / Sev / Conf:** Developer-experience issue · P3 · High · Verified fact.
- **Evidence:** Invitation revoke fires with no confirmation (`InvitationsPage.tsx:53-55`), unlike Members/Projects/ApiKeys which use `window.confirm`. Deep-link not preserved: `ProtectedRoute.tsx:22` redirects without `from`; Login/Register hard-navigate to `/app/overview`. Session-expiry resets to unauthenticated with no messaging (`client.ts:133-136`). A11y: the "New team" popover (`OrganizationSwitcher.tsx:65-88`) is not a dialog (no focus trap/Escape/outside-click); no focus management on route change. Overview swallows permission/plan query errors (`OverviewPage.tsx:44-65`).
- **Current behavior:** Demo-quality UX with the above rough edges.
- **Expected production behavior:** Confirmations on all destructive actions, deep-link return, explicit session-expiry messaging, and baseline a11y.
- **Risk:** Mis-clicks (irreversible revoke), lost destination, confusing expiry, reduced accessibility.
- **Remediation:** Add revoke confirmation, `from`-state redirect, expiry toast, dialog semantics/focus management. Preserve the thin-consumer pattern.
- **Dependencies:** none. **Effort:** M. **Validation:** component tests for each. **Roadmap:** Phase 3 (frontend hardening, parallelizable). **Standards:** ASVS V14; WCAG (a11y). **Threats:** T-OPS.

<a id="org-pr-037"></a>
### ORG-PR-037 — `reset-test` destructive guard weaker than documented
- **Class / Sev / Conf:** Maintainability issue · P3 · High · Verified fact.
- **Evidence:** `packages/db/scripts/reset-test.ts:11-12` comment claims the guard is "NODE_ENV=test + explicit TEST_DATABASE_URL," but `packages/db/src/env.ts — requireTestDatabaseUrl` (L31-42) checks only that `TEST_DATABASE_URL` is set and differs from `DATABASE_URL`; `NODE_ENV` is never consulted.
- **Current behavior:** If an operator points `TEST_DATABASE_URL` at a real DB that merely differs from `DATABASE_URL` (e.g. staging), the guard passes and the schema is dropped.
- **Expected production behavior:** The guard matches its documentation (also require `NODE_ENV=test`) or the docstring is corrected to the true, weaker guarantee.
- **Risk:** Accidental destruction of a non-test database that satisfies the URL-difference check.
- **Remediation:** Strengthen the guard (add `NODE_ENV=test`) or fix the docstring; the safer fix is the stronger guard.
- **Dependencies:** none. **Effort:** S. **Validation:** test that reset refuses when `NODE_ENV!=='test'`. **Roadmap:** Phase 3. **Standards:** SSDF PW.5. **Threats:** T-OPS.

<a id="org-pr-038"></a>
### ORG-PR-038 — "One personal workspace per user" invariant unenforced
- **Class / Sev / Conf:** Data-integrity risk · P3 · Medium · Verified fact.
- **Evidence:** `type:'personal'` is created exactly once in the registration transaction (`auth.repo.ts:110`) and no other path creates personal orgs, but there is no unique constraint (e.g. partial unique on `organizations(created_by_user_id) WHERE type='personal'`) and no app pre-check.
- **Current behavior:** The invariant holds by convention only.
- **Expected production behavior:** DB-enforced (partial unique) so no future code path or backfill can create a second personal workspace.
- **Risk:** A future/edited code path silently creates duplicate personal workspaces.
- **Remediation:** Add a partial unique index in a forward migration.
- **Dependencies:** none. **Effort:** S. **Validation:** migrate-from-scratch test asserts the constraint rejects a second personal org. **Roadmap:** Phase 3. **Standards:** ASVS V11 (data integrity). **Threats:** T-QUOTA.
- **Resolution (Sprint 20 — Closed):** the finding's requirement — a DB
  constraint so no future code path or backfill can create a DUPLICATE
  personal workspace — is met by migration `0011_calm_gressill.sql`: partial
  unique index `uq_organizations_active_personal_owner` on
  `organizations (created_by_user_id) WHERE type = 'personal' AND status =
  'active'`. Precisely stated, the two guarantees are SEPARATE: (1)
  DATABASE-enforced — **at most one** active personal workspace per user
  identity (`created_by_user_id`, written once at insert; no code path
  mutates it and no ownership-transfer feature exists); (2)
  APPLICATION-enforced and transaction-tested — the registration-completion
  transaction CREATES the personal workspace, so every completed user has
  one (existence is provisioning logic, not a database constraint). Team
  organizations are unconstrained; an archived/suspended personal workspace
  frees the slot (lifecycle-compatible); seeds/demo data drive the real API
  and remain valid. Proven by `migrate.integration.test.ts` (duplicate-active
  rejected at the SQL level; team orgs unaffected; archived-then-new allowed;
  the 0011 DDL also applies FORWARD over a populated pre-Sprint-20 dataset,
  with the reviewer preflight duplicate query executed first) and by the
  completion concurrency test (each completed registrant ends with exactly
  one active personal workspace — the provisioning guarantee under
  concurrency).

<a id="org-pr-039"></a>
### ORG-PR-039 — No password-change / email-change flows
- **Class / Sev / Conf:** Product completeness gap · P3 · High · Verified fact (absence).
- **Evidence:** Grep for change-password/change-email routes/services (excl. tests) → none. No web surfaces (`apps/web-demo` has only Login/Register/Logout).
- **Current behavior:** Authenticated users cannot change their password or email.
- **Expected production behavior:** Password change (re-auth + session invalidation) and email change (verify new address).
- **Risk:** No way to rotate a compromised password or fix an email without admin/DB intervention.
- **Remediation:** Build both flows on existing auth primitives (+ verification for email change).
- **Dependencies:** ORG-PR-024 (email change), ORG-PR-002. **Effort:** M. **Validation:** integration tests. **Roadmap:** Phase 2. **Standards:** ASVS V2.1. **Threats:** T-CRED.
- **Resolution (Sprint 17, 2026-07-20): CLOSED.** Both flows implemented on the existing auth primitives, as the remediation specified. `POST /v1/auth/change-password` (Bearer): mandatory current-password re-auth against the stored Argon2id hash, shared password policy (`newPasswordSchema` — the same schema registration and reset completion parse), current-password-reuse rejection, and one transaction (`auth.repo.ts — changePasswordKeepingCurrentSession`) that swaps the hash, keeps ONLY the caller's server-resolved session, and revokes every other session + its refresh tokens. `POST /v1/auth/change-email` (Bearer): mandatory current-password re-auth, shared normalization, duplicate → the registration 409, and one transaction that swaps the address, clears `email_verified_at`, and invalidates all outstanding verification tokens, followed by a best-effort verification email to the NEW address (Sprint 16 mail-failure semantics; account stays usable under the advisory policy). Wrong current password → `INVALID_CREDENTIALS` at 400 (session-valid, so 401 would mimic expiry). Per-user rate limits on both. Evidence: `credential-change.routes.test.ts` (23 route tests), `password-recovery.integration.test.ts` (SQL-layer keep-current-session policy + email-change verification reset), web-demo `account-security.test.tsx` (10 tests). Web surface: `/app/account`. Docs: [credential-management.md](../credential-management.md).

<a id="org-pr-040"></a>
### ORG-PR-040 — `noUncheckedIndexedAccess` disabled

> **Status: CLOSED (Sprint 21, 2026-07-26).** The lines below describe the
> pre-close state; see the *Resolution* line.

- **Class / Sev / Conf:** Maintainability issue · P3 · High · Verified fact.
- **Evidence:** `tsconfig.base.json` sets `strict: true` and many strict flags but not `noUncheckedIndexedAccess` (nor `exactOptionalPropertyTypes`). Repos/mappers index arrays/records throughout.
- **Current behavior:** Index access is typed as always-defined; undefined-at-index bugs pass `tsc`.
- **Expected production behavior:** `noUncheckedIndexedAccess` on, with resulting sites fixed.
- **Risk:** Latent undefined-access runtime bugs the type system currently hides.
- **Remediation:** Enable the flag and remediate fallout. **Not implemented during the Sprint 14 audit** (would touch production code).
- **Dependencies:** none. **Effort:** M. **Validation:** `pnpm typecheck` clean with the flag on. **Roadmap:** Phase 6 / hardening. **Standards:** SSDF PW.5. **Threats:** T-OPS.
- **Resolution (Sprint 21, 2026-07-26): CLOSED.** `noUncheckedIndexedAccess: true` is set in `tsconfig.base.json` and inherited by ALL eight TypeScript projects (five packages, the API, the web demo and its node config); no project overrides it. The full initial failure surface was measured first (297 errors: 292 `apps/api`, 3 `packages/db`, 1 `packages/shared`, 1 `apps/web-demo`) and fixed without suppression: zero new non-null assertions, zero `as any`, zero `@ts-ignore`/`@ts-expect-error` (one pre-existing `match![1]` was actually removed). Guaranteed-index invariants are encoded in two named helpers instead of scattered `!` — `requireRow` (`apps/api/src/lib/db-rows.ts`) for `INSERT/UPDATE … RETURNING` and caller-verified single-row lookups, and `requireDefined` (`apps/api/src/lib/invariant.ts`) for bounds-guaranteed indexing (regex groups, populated fixtures); one-off `expect(rows[0]?.x)` narrowing is used only where a missing row still fails the assertion (never with negated matchers). Runtime behavior is unchanged except that a violated row invariant now fails loudly with query context instead of surfacing later as an undefined-property error. Evidence: `pnpm typecheck` exit 0 with the flag on; `pnpm validate` exit 0 (incl. 825 unit tests); `pnpm validate:integration` exit 0 (82 live-PostgreSQL tests).

<a id="org-pr-041"></a>
### ORG-PR-041 — Mailpit / live SMTP path never exercised in CI
- **Class / Sev / Conf:** Operational gap · P3 · High · Verified fact.
- **Evidence:** `.github/workflows/ci.yml:79-82` intentionally omits Mailpit; no integration test exercises live SMTP. The mailer has unit coverage only.
- **Current behavior:** A broken SMTP integration ships green.
- **Expected production behavior:** CI (or staging) asserts the live email-delivery path once a real provider exists.
- **Risk:** Email delivery regressions undetected until manual testing.
- **Remediation:** Add a CI Mailpit service + delivery assertion, and a staging real-provider check.
- **Dependencies:** ORG-PR-002. **Effort:** S. **Validation:** CI asserts a delivered invitation. **Roadmap:** Phase 6. **Standards:** SSDF PW.8. **Threats:** T-INV.

<a id="org-pr-042"></a>
### ORG-PR-042 — Docker infra images pinned by floating tags
- **Class / Sev / Conf:** Maintainability issue · P3 · High · Verified fact.
- **Evidence:** `infra/docker-compose.yml` uses `postgres:16-alpine`, `redis:7-alpine`, and `axllent/mailpit:latest` — floating tags, no `@sha256` digests. (Local-dev only; no app Dockerfiles yet.)
- **Current behavior:** Non-reproducible local infra; `latest` can change under you.
- **Expected production behavior:** Digest-pinned images for any production infra; pin dev images to at least patch tags.
- **Risk:** Non-reproducible environments; surprise breakage. Bounded impact today (dev-only).
- **Remediation:** Pin production images by digest; tighten dev tags.
- **Dependencies:** ORG-PR-001. **Effort:** S. **Validation:** images referenced by digest in production manifests. **Roadmap:** Phase 4. **Standards:** SLSA (reproducibility). **Threats:** T-DEP.
- **Progress (Sprint 21, 2026-07-26): Open — materially advanced.** All floating tags are removed from current repository scope: `infra/docker-compose.yml` and the CI integration service containers now pin exact patch tags (`postgres:16.14-alpine`, `redis:7.4.10-alpine`, `axllent/mailpit:v1.30.5`; `latest` eliminated). Tags were verified to exist on Docker Hub, `docker compose config` validates, the local stack and CI service definitions stay drop-in compatible (same majors as before), and the runbook's service table and examples were updated. Dependabot's `docker` ecosystem proposes tag bumps for `infra/`. **Why still open:** the finding's production half — digest-pinned images in production manifests — cannot be satisfied until the ORG-PR-001 deployment-artifact track creates those manifests; digest pinning of the dev/CI images was deliberately deferred with them so one mechanism governs both. Residual risk (accepted, documented): a registry tag can in principle be re-pushed; exact patch tags narrow but do not eliminate that window — precisely what digest pinning will close.
- **Resolution (Sprint 23, 2026-08-23): CLOSED.** The production manifests
  now exist and every active image reference is pinned exact patch tag PLUS
  manifest-list digest (`name:X.Y.Z@sha256:…`): the API/web Dockerfile base
  images (`node:22.23.2-bookworm-slim`,
  `nginxinc/nginx-unprivileged:1.31.4-alpine`), `infra/docker-compose.yml`
  and `infra/compose.production-like.yml`
  (`postgres:16.14-alpine`, `redis:7.4.10-alpine`, `axllent/mailpit:v1.30.5`),
  and the `ci.yml` service containers. No `latest`, no floating tags; the
  tag-re-push window is closed. Dependabot covers Dockerfiles (`docker`
  ecosystem) and compose files (`docker-compose`); workflow `services:`
  images are outside Dependabot's coverage and carry a documented manual
  bump procedure ([../validation.md](../validation.md#image-pinning-policy) —
  the accepted residual). Evidence: `pnpm artifact:smoke` and the CI
  `artifacts`/`integration` jobs pull and run every pinned reference.

<a id="org-pr-043"></a>
### ORG-PR-043 — PII in audit/security metadata with no retention
- **Class / Sev / Conf:** Compliance dependency · P3 · Medium · Verified fact. **Legal review required.**
- **Evidence:** `login_failed` events store `normalizedEmail` (`auth.service.ts:507,522`); invitation events store `invitedEmailNormalized` (`invitation.acceptance.ts:221,233`, `invitation.repo.ts:126,250`). The sanitizer denylist (`lib/security-metadata.ts:22-36`) has no `email` entry, so these survive to reads/storage. No retention (ORG-PR-015).
- **Current behavior:** Email addresses persist indefinitely in `security_events`/audit metadata, readable by any holder of `audit_events.read`.
- **Expected production behavior:** A retention/minimization policy for PII in event metadata, consistent with the privacy regime.
- **Risk:** Indefinite PII retention; email disclosure to auditors. Likely intended for auditing but must be policy-bounded.
- **Remediation:** Define retention + access policy; enforce via cleanup (ORG-PR-015). **Legal review required.**
- **Dependencies:** ORG-PR-015, legal. **Effort:** S. **Validation:** retention job removes/anonymizes aged PII. **Roadmap:** Phase 5 / legal gate. **Standards:** ASVS V8; privacy. **Threats:** T-PRIV, T-AUDIT.

<a id="org-pr-044"></a>
### ORG-PR-044 — Narrow concurrency test coverage
- **Class / Sev / Conf:** Reliability risk · P3 · High · Verified fact.
- **Evidence:** The only real-DB race tests are refresh-token double-refresh (`session-lifecycle.integration.test.ts:152`) and Last-Owner demotion (`member.integration.test.ts:193`). No concurrency tests for quotas (ORG-PR-029) or concurrent invitation acceptance across distinct tokens.
- **Current behavior:** Most concurrency-sensitive invariants are untested under real parallelism.
- **Expected production behavior:** Concurrency tests for each identified race (quotas, cross-invitation acceptance).
- **Risk:** Regressions in race-safety land undetected.
- **Remediation:** Add targeted concurrency integration tests alongside ORG-PR-029 fixes.
- **Dependencies:** ORG-PR-029. **Effort:** M. **Validation:** the new suites pass and fail if locking is removed. **Roadmap:** Phase 3 / Phase 6. **Standards:** SSDF PW.8. **Threats:** T-QUOTA.
- **Resolution (Sprint 20 — Closed):** `quota-concurrency.integration.test.ts`
  adds five real-PostgreSQL races, each firing 4–6 genuinely parallel attempts
  at a remaining capacity of ONE: project create, API key create (with revoked
  + expired decoys proving the counting basis), acceptance of DISTINCT
  invitation tokens, invited registration completion (all accounts commit;
  exactly one membership; losers surface the documented `unavailable`
  outcome), and invitation-create seat reservation. Every test asserts the
  exact success count, `QUOTA_EXCEEDED` on the losers, final database state
  (ceilings, no orphaned users/workspaces/sessions/pending rows, single-use
  invitations), and that success events exactly match committed mutations.
  Genuine overlap is guaranteed by a pool warm-up (`warmPool`) — discovered
  during execution: on a COLD postgres.js pool, connection handshakes stagger
  the racers enough that a lock-free build still passed; with the warmed pool
  a lock-removed build fails 100% of runs (verified as a negative control:
  6/6 attempts succeeded and the ceiling was breached 8→3 without the lock).
  The pre-existing races (double-refresh, Last-Owner demotion, same-token
  issuance/completion) are unchanged.

<a id="org-pr-045"></a>
### ORG-PR-045 — No MFA/passkeys and no security notifications
- **Class / Sev / Conf:** Product completeness gap · P3 · High · Verified fact (absence).
- **Evidence:** No MFA/TOTP/WebAuthn anywhere (grep → none). Security events are DB-only with no email/notification dispatch (no mailer call in the auth module).
- **Current behavior:** Single-factor auth; no user notification on new login/new device/credential change.
- **Expected production behavior:** Optional MFA (TOTP/passkeys) and security notifications on sensitive events.
- **Risk:** Weaker account protection; users unaware of takeover attempts. Explicitly a deferred non-goal today.
- **Remediation:** Add MFA and notification dispatch (depends on email).
- **Dependencies:** ORG-PR-002. **Effort:** L. **Validation:** MFA enrol/verify tests; notification-send tests. **Roadmap:** Phase 2 / post-launch. **Standards:** ASVS V2.2 (MFA). **Threats:** T-CRED, T-TOKEN.

<a id="org-pr-046"></a>
### ORG-PR-046 — Stale/contradictory subsystem documentation
- **Class / Sev / Conf:** Developer-experience issue · P4 · High · Verified fact.
- **Evidence:** `docs/database-foundation.md` is frozen at Sprint 4 — lists 3 schema files/auth+org tables while source has 9 schema files / 16 tables (contradicts `architecture.md`). `docs/rbac-permissions.md:156-159` calls `invitations.*/projects.*/api_keys.*/audit_events.read/plan.*` "reserved for modules not built" though all shipped. `docs/api-conventions.md` enumerates error codes only through Sprint 4. `docs/api-surface.md:46` lists `org.read` on `GET /v1/organizations/:id` but the code enforces membership only (also ORG-PR-053). (Correction from the refinement pass: `docs/evaluation-guide.md:135` "489 unit tests / 19 web-demo tests" is **accurate** — `pnpm validate` reports exactly 489 unit + 19 web-demo tests — so it is not a staleness item.)
- **Current behavior:** Several docs under-describe or misdescribe current behavior.
- **Expected production behavior:** Accurate current docs (or clear historical labeling).
- **Risk:** Maintainer confusion; wrong mental model of schema/permissions.
- **Remediation:** Refresh the stale sections. Per Sprint 14 scope these are recorded as findings, not rewritten here (except this package's own clarifications).
- **Dependencies:** none. **Effort:** S. **Validation:** docs match source on re-audit. **Roadmap:** Phase 6 / docs. **Standards:** n/a. **Threats:** n/a.

<a id="org-pr-047"></a>
### ORG-PR-047 — `COOKIE_SECRET` required but never used (unsigned cookies)

> **Status: CLOSED (Sprint 15, 2026-07-18).** The Evidence/Current behavior
> lines below describe the **Sprint 14 audit baseline**, preserved as recorded;
> `COOKIE_SECRET` no longer exists in the configuration. See the **Resolution**
> line at the end of this entry for the current state.

- **Class / Sev / Conf:** Maintainability issue · P4 · High · Verified fact.
- **Evidence:** `COOKIE_SECRET` validated (`schema.ts:75-77`) and plumbed (`config/index.ts:50`) but has no consumer; the refresh cookie is written unsigned (`lib/cookies.ts — serializeCookie`, plain `name=value`).
- **Current behavior:** Operators may assume cookies are signed/tamper-evident; they are not.
- **Expected production behavior:** Either sign cookies with it or remove the config to avoid a false sense of protection.
- **Risk:** Misleading security assumption; dead required config.
- **Remediation:** Remove or actually use `COOKIE_SECRET`.
- **Dependencies:** none. **Effort:** S. **Validation:** config no longer requires an unused secret, or signing is tested. **Roadmap:** Phase 3. **Standards:** ASVS V3 (session). **Threats:** T-CONF.
- **Resolution (Sprint 15, 2026-07-18): CLOSED — removed because unused.** A repository-wide search re-confirmed no code path signs or verifies cookies (refresh cookie remains deliberately unsigned; its integrity model is the hashed, rotated, high-entropy token itself). Removed: the `COOKIE_SECRET` schema field (`packages/config/src/schema.ts`), the `Config.auth.cookieSecret` property (`packages/config/src/index.ts`), fixtures (`packages/config/src/config.test.ts`, `apps/api/src/testing/build-test-app.ts`), the CI env value (`.github/workflows/ci.yml`), the `.env.example` line, and doc references (`docs/validation.md`, `docs/troubleshooting.md`, `docs/roadmap.md`). Signed-cookie behavior was **not** introduced to justify keeping the variable. Evidence: `packages/config/src/config.test.ts` — `does not require COOKIE_SECRET and does not expose a cookieSecret` (a stale value in an operator's `.env` is ignored). Historical sprint artifacts retain their original mentions by design.

<a id="org-pr-048"></a>
### ORG-PR-048 — `email_verification_tokens` dead schema shipped

> **Status: CLOSED (Sprint 16, 2026-07-18).** The lines below describe the
> **Sprint 14 audit baseline**, preserved as recorded. See the **Resolution**
> line at the end of this entry.

- **Class / Sev / Conf:** Maintainability issue · P4 · High · Verified fact.
- **Evidence:** Table + indexes migrated (`0001`) but never read/written (grep → schema/tests/snapshots only). `users.email_verified_at` never set.
- **Current behavior:** Dead schema implying an email-verification flow that does not exist.
- **Expected production behavior:** Implement (ORG-PR-024) or remove the scaffolding.
- **Risk:** Confusion; implies a non-existent feature.
- **Remediation:** Tie to ORG-PR-024 or drop in a forward migration.
- **Dependencies:** ORG-PR-024. **Effort:** S. **Validation:** either used by the verification flow or removed. **Roadmap:** Phase 2. **Standards:** n/a. **Threats:** n/a.
- **Resolution (Sprint 16, 2026-07-18): CLOSED via ORG-PR-024.** The table is active product behavior: written by issuance (invalidate-then-insert), consumed transactionally by completion, and read for classification. Migration `0008` added `invalidated_at` so consumed (`used_at`) and retired-unused (`invalidated_at`) states are explicit rather than overloading one column. Lifecycle-tested at the SQL layer by `email-verification.integration.test.ts`.

<a id="org-pr-049"></a>
### ORG-PR-049 — HS256 symmetric JWT with no `kid`/rotation path
- **Class / Sev / Conf:** Optional enhancement · P4 · High · Verified fact.
- **Evidence:** `packages/auth-core/src/access-token.ts` — `SIGNING_ALGORITHM='HS256'` (L18), no `kid`/issuer/audience/versioned-secret (grep). Rotating `JWT_SECRET` invalidates all live access tokens (acceptable given 15-min TTL) but there is no graceful rotation.
- **Current behavior:** Single shared secret, no key id, no rotation window.
- **Expected production behavior:** Optional `kid` + versioned-secret (or asymmetric EdDSA/RS256) if verification ever leaves the issuer; enables graceful rotation (ORG-PR-006).
- **Risk:** Disruptive secret rotation; no path if a verifier is externalized.
- **Remediation:** Add `kid`/versioned secrets or move to asymmetric signing.
- **Dependencies:** relates to ORG-PR-006. **Effort:** M. **Validation:** rotation test with overlapping keys. **Roadmap:** Phase 3 / later. **Standards:** ASVS V6.4. **Threats:** T-TOKEN-FORGE.
- **Progress (Sprint 24, 2026-08-23): Open — materially advanced.** The
  finding's stated validation — "rotation test with overlapping keys" — now
  exists: an optional `JWT_PREVIOUS_SECRET` is accepted at verification only
  (`packages/auth-core/src/access-token.ts —
  verifyAccessTokenWithRotation`), with overlapping-key tests at the primitive
  level and through `GET /v1/auth/me`, so rotating the signing secret no longer
  invalidates live access tokens. The finding's literal remediation — a `kid`
  claim or asymmetric EdDSA/RS256 — was deliberately **not** implemented: it
  changes the token format and is only required if verification ever leaves the
  issuer, which it has not. Kept open on that basis.

<a id="org-pr-050"></a>
### ORG-PR-050 — Concurrent legitimate refresh revokes family + session
- **Class / Sev / Conf:** Reliability risk · P4 · High · Verified fact.
- **Evidence:** `auth.repo.ts:239-264` + `auth.service.ts:607-628`: two near-simultaneous refreshes of the same cookie serialize on the `FOR UPDATE` lock; the loser is classified reuse and the whole family + session are revoked, logging the user out everywhere.
- **Current behavior:** Multi-tab or retry double-refresh can force a full logout.
- **Expected production behavior:** A short grace window accepting the just-issued successor to avoid punishing benign double-refresh, while preserving true reuse detection.
- **Risk:** Availability/UX hazard (unexpected logout); security behavior is correct.
- **Remediation:** Add a small grace/idempotency window on the immediate parent.
- **Dependencies:** none. **Effort:** M. **Validation:** test that benign double-refresh keeps the session while true reuse still revokes. **Roadmap:** Phase 3 / later. **Standards:** ASVS V3.3 (session). **Threats:** T-RTOKEN.

<a id="org-pr-051"></a>
### ORG-PR-051 — Redundant unique index duplicates PK on `role_permissions`
- **Class / Sev / Conf:** Optional enhancement · P4 · High · Verified fact.
- **Evidence:** `packages/db/src/schema/permissions.ts:83-88` declares both `primaryKey([roleId, permissionId])` and `uniqueIndex('uq_role_permissions_role_permission').on(roleId, permissionId)` — identical columns (migration `0002`).
- **Current behavior:** A redundant unique index duplicates the PK.
- **Expected production behavior:** Drop the redundant index (the PK already enforces uniqueness).
- **Risk:** Negligible write/storage overhead; cleanliness only.
- **Remediation:** Remove in a forward migration if desired.
- **Dependencies:** none. **Effort:** S. **Validation:** schema-drift + migrate-from-scratch pass. **Roadmap:** optional. **Standards:** n/a. **Threats:** n/a.

<a id="org-pr-052"></a>
### ORG-PR-052 — Minor API disclosures
- **Class / Sev / Conf:** Maintainability issue · P4 · Medium · Verified fact.
- **Evidence:** `/ready` returns dependency names + latency unauthenticated (`lib/readiness.ts`); `app.ts:137 requestIdHeader` trusts inbound `x-request-id` verbatim (the safe validator `shared/request-id.ts — resolveRequestId` exists but is unused); `server.ts:188` awaits `app.close()` with no timeout.
- **Current behavior:** Minor infra fingerprinting via `/ready`; client-forgeable request IDs in logs; unbounded shutdown wait.
- **Expected production behavior:** Optionally minimize `/ready` for unauthenticated callers; validate/replace inbound request IDs; bound `app.close()` with a shutdown timeout.
- **Risk:** Low — fingerprinting, log-correlation spoofing, and a possible stuck SIGTERM past the orchestrator grace period.
- **Remediation:** Use `resolveRequestId`; add a shutdown timeout; consider gating `/ready` detail.
- **Dependencies:** none. **Effort:** S. **Validation:** tests for request-id sanitization and bounded shutdown. **Roadmap:** Phase 4. **Standards:** ASVS V7.3, V14. **Threats:** T-LOG, T-OPS.
- **Resolution (Sprint 19 — Closed):** all three sub-items. (1) Inbound
  `x-request-id` is sanitized centrally (`shared/request-id.ts —
  resolveRequestId`, wired via `genReqId` with `requestIdHeader: false`):
  accepted format `[A-Za-z0-9._-]{1,128}`; anything else (empty, overlong,
  whitespace, CR/LF/NUL, control chars) is REPLACED with a generated id used
  consistently across response header, logs, and error envelope
  (`plugins/request-id.test.ts`). (2) Production `/ready` is coarse — ready /
  not-ready only, no dependency inventory; dev/test keep detail; per-check
  outcomes log server-side (`routes/readiness.ts`, `readiness.test.ts`).
  (3) Shutdown is idempotent across repeated signals and bounded by a 10s
  unref'd force-exit timer (`server.ts`).

<a id="org-pr-053"></a>
### ORG-PR-053 — Two read paths skip the permission gate
- **Class / Sev / Conf:** Maintainability issue · P4 · High · Verified fact (no current gap).
- **Evidence:** `organization.service.ts — readOrganization` (L154-157) uses `resolveOrganizationContext` (membership only), not `requirePermission(org.read)`, diverging from the canonical membership→permission pattern (also surfaced as doc drift in ORG-PR-046). `org-rbac.service.ts — getEffectivePermissions` (L75-84) is membership-only by design. Harmless today (all roles hold `org.read`).
- **Current behavior:** Two read paths authorize on membership alone.
- **Expected production behavior:** Consistent membership→permission enforcement, or an explicit documented exception, so future permission narrowing doesn't silently mis-authorize.
- **Risk:** Latent — becomes a real gap only if `org.read` is ever narrowed.
- **Remediation:** Add the explicit permission check (or document the exception) for consistency.
- **Dependencies:** none. **Effort:** S. **Validation:** test asserts the permission is enforced. **Roadmap:** Phase 3. **Standards:** ASVS V4.1. **Threats:** T-BOLA.
- **Resolution (Sprint 20 — Closed):** `organization.service.readOrganization`
  now enforces `org.read` after membership resolution (matching the canonical
  membership→permission composition and the long-documented `api-surface.md`
  contract — the drift is resolved in the CODE direction; no observable
  behavior change today since every fixed role holds `org.read`).
  `org-rbac.service.getEffectivePermissions` is retained as the ONE
  intentional membership-only surface, now explicitly documented as a stable
  contract (self-introspection gated on a permission would be circular).
  Evidence: `organization.routes.test.ts` (all roles allowed; a role stripped
  of `org.read` fails closed with the safe 403; disabled actor 401; removed
  membership / cross-tenant keep the uniform 404). Docs:
  [rbac-permissions.md](../rbac-permissions.md), [api-surface.md](../api-surface.md).

<a id="org-pr-054"></a>
### ORG-PR-054 — `esbuild` moderate dev-only advisory (via `drizzle-kit`)

> **Status: CLOSED (Sprint 21, 2026-07-26).** The lines below describe the
> pre-close state; see the *Resolution* line.

- **Class / Sev / Conf:** Optional enhancement · P4 · High · Verified fact.
- **Evidence:** `pnpm audit` → 2 moderate: `esbuild <=0.24.2` (dev-server request exposure) via `packages__db>drizzle-kit>...>esbuild`. Dev/build-time only; not in the runtime path.
- **Current behavior:** A transitive dev dependency carries a moderate advisory.
- **Expected production behavior:** Resolved on the dependency track or documented as dev-only, not shipped.
- **Risk:** Low — affects only the local dev server, not production runtime.
- **Remediation:** Address on the dependency-update track (ORG-PR-020). **Not upgraded here** per scope.
- **Dependencies:** ORG-PR-020. **Effort:** S. **Validation:** `pnpm audit` clean or documented acceptance. **Roadmap:** Phase 3. **Standards:** SSDF PW.4. **Threats:** T-DEP.
- **Resolution (Sprint 21, 2026-07-26): CLOSED.** Every vulnerable `esbuild` copy (0.18.20 and 0.19.12; GHSA-67mh-4wv8-2f99 — dev-server CORS exposure, fixed in 0.25.0) is GONE from the lockfile: `drizzle-kit` 0.31.10 depends on esbuild ^0.25 and dropped `esbuild-register`, and the deprecated `@esbuild-kit/core-utils` chain it still carries is forced to esbuild ^0.25 by a scoped pnpm override (`"@esbuild-kit/core-utils>esbuild": "^0.25.0"` — path-scoped, not global). Remaining copies are 0.25.12 (vite) and 0.28.1 (tsx), both ≥ the fix. Dependency-path evidence: `pnpm why -r esbuild` shows no copy below 0.25; `osv-scanner` reports no esbuild finding. The advisory was dev-only (drizzle-kit is a devDependency and no repository path ever starts the affected esbuild dev server — vite's own dev server carries the fixed 0.25.12) — but it is now absent rather than risk-accepted. Validation: drizzle-kit codegen under the override is exercised by the schema-drift check (clean), migrations by `pnpm db:migrate` + the integration suite (green), full `pnpm validate` exit 0.

<a id="org-pr-055"></a>
### ORG-PR-055 — Audit-log read has unbounded query cost and no per-actor ceiling

> **Status: MITIGATED (Sprint 22, 2026-07-26).** Discovered during CodeQL alert
> triage (alert 12, `js/missing-rate-limiting`). The exploitation path is
> closed; the underlying query cost is not — see *Residual*.

- **Class / Sev / Conf:** Security risk · P3 · High · Verified fact.
- **Evidence:** `GET /v1/organizations/:organizationId/audit-events` reaches `audit.repo.ts:39 listAuditEvents`, whose `targetId` filter is an OR across five JSONB expressions (`metadata ->> 'targetProjectId'`, `targetKeyId`, `targetInvitationId`, `targetMembershipId`, `membershipId`). No index covers those expressions: `packages/db/src/schema/auth.ts:311-317` declares indexes on `user_id`, `event_type`, `created_at`, and the composite `(organization_id, created_at, id)`. The composite orders the keyset scan but cannot satisfy the predicate.
- **Current behavior (pre-fix):** PostgreSQL walks the organization's slice of `security_events` in keyset order and filters row by row. A `targetId` matching nothing reads the entire slice before returning an empty page. `security_events` has no retention or cleanup policy (ORG-PR-015), so the scanned range grows without bound. The permission gate (`audit_events.read`) and the independent entitlement gate (`audit_log_access`) bound WHO may ask; nothing bounded HOW OFTEN. The only ceiling was the global per-IP bucket — 300/60s, shared with all other traffic from that IP, and keyed on IP rather than on the actor or tenant whose history is being scanned, so a distributed client evaded it entirely.
- **Expected production behavior:** A read whose cost is not bounded by its page size carries a per-actor and per-tenant ceiling, like the mutation surfaces do.
- **Risk:** An authenticated member of an entitled organization can force repeated full scans of that tenant's event history — a self-inflicted database load amplifier that grows with the table and is invisible to per-IP limiting when distributed.
- **Remediation (applied):** Per-actor and per-tenant fixed-window buckets in `audit.service.ts`, placed AFTER the membership, permission, and entitlement gates (so throttling never masks or precedes an authorization decision) and immediately before the query they protect: `rl:audit:read:user:<userId>` (`RATE_LIMIT_AUDIT_READ_PER_USER_MAX`, default 60/60s) then `rl:audit:read:org:<organizationId>` (`RATE_LIMIT_AUDIT_READ_PER_ORG_MAX`, default 240/60s). Per-user is consumed first so a runaway client is attributed to itself before consuming the shared tenant allowance. Reuses the existing `RateLimiter` interface, the `enforceStoreAvailability` failure-mode policy (production: fail closed), and the standard `RATE_LIMITED` envelope — no parallel throttling mechanism was introduced. Files: `packages/config/src/schema.ts`, `packages/config/src/index.ts`, `apps/api/src/modules/audit/audit.service.ts`, `apps/api/src/server.ts`, `apps/api/src/modules/audit/testing/build-audit-test-app.ts`, `.env.example`.
- **Dependencies:** ORG-PR-012 (global limiter), ORG-PR-032 (mutation buckets). **Effort:** S. **Validation:** `apps/api/src/modules/audit/audit-read-throttle.test.ts` — 8 cases: per-user ceiling with the standard envelope; the expensive `targetId` path specifically bounded; per-user isolation between members of one org; the per-org ceiling firing across distinct members each under their own limit; cross-organization isolation; legitimate traffic below the ceiling succeeding; non-member still 404 not 429; non-entitled member still 403 not 429 and never consuming the allowance. **Roadmap:** Phase 3. **Standards:** ASVS V11.1. **Threats:** T-DOS.
- **Residual (OPEN):** The limiter bounds exploitation; it does not make the query cheap. A legitimate operator on a large tenant still pays a full-slice scan for a non-matching `targetId`. A durable fix is either (a) an index covering the target-id metadata keys — a GIN index on `metadata`, or expression indexes per key — or (b) retention/cleanup on `security_events` under ORG-PR-015, or both. Neither is in Sprint 22 scope. Owner: repository maintainer. Re-review when ORG-PR-015 is scheduled.

<a id="org-pr-056"></a>
### ORG-PR-056 — Demo bootstrap printed a one-time API key secret to stdout

> **Status: CLOSED — fully remediated (Sprint 22 completion iteration,
> 2026-07-26).** Surfaced by CodeQL alerts 5, 6, 7 (`js/clear-text-logging`);
> the surviving sink was tracked as alert 45. This finding passed through an
> intermediate ACCEPTED-RISK state within the same sprint; that decision and
> its reasoning are preserved below under *Remediation history* rather than
> rewritten, because the reversal is the useful part of the record.

- **Class / Sev / Conf:** Security risk · P4 · High · Verified fact.
- **Evidence:** `tooling/demo-seed.mjs` created an API key during bootstrap and printed the returned raw secret to stdout — originally twice (once labelled, once interpolated into a ready-to-run `curl` example). A third alert on the `log()` helper resolved to `created.apiKey.name` (a display label, not the secret) and was a genuine false positive.
- **Original behavior:** The secret was written to stdout by a local developer CLI. The API's Pino redaction backstop (ORG-PR-033) does NOT cover it — a separate process using `console.log` with string interpolation bypasses path-based redaction entirely.
- **Expected production behavior:** Credential-issuing tooling emits no credential to any logging sink. A one-time secret is delivered to a human directly and retained nowhere else.
- **Risk:** Terminal scrollback, screen shares, terminal recordings, wrappers, CI transcripts, and redirected stdout all retain a printed credential far longer than the moment it was needed.

**Remediation history (both steps preserved deliberately):**

1. **Partial mitigation, then accepted (first pass).** The duplicate print inside the `curl` example was removed, and `assertLocalTarget` (`tooling/lib/demo-target-guard.mjs`) was added to refuse any non-loopback target before the first request. The remaining print was then recorded as an accepted residual risk on the argument that the API returns a key secret exactly once, so printing it *was* the delivery channel and the demo depended on it. **That argument was wrong on the decisive point:** it treated the delivery channel as fixed. The Definition of Done condition — no raw secrets, tokens, passwords, Authorization headers, cookies, or SMTP credentials are logged — admits no accepted-risk exception, and a loopback guard bounds *where* the credential is emitted without stopping it being emitted.
2. **Full remediation (completion iteration, applied).** The delivery channel was changed instead of the secret being protected in transit to a terminal:
   - `ensureApiKey` was **removed** from `tooling/demo-seed.mjs`; the bootstrap now creates no API key and touches no `/api-keys` endpoint.
   - The summary block emits identifiers and locations only. The owner password — a published local-only value — is **pointed at** (`see docs/demo-walkthrough.md`) rather than reprinted, so no output path in the tool carries a credential of any kind.
   - Key creation moved to the **existing** authenticated web-demo surface (`/app/api-keys`, `ApiKeysPage`), where the backend returns the raw secret exactly once to the requesting browser and no tool-side copy exists. No new product feature, API route, or contract was added — walkthrough steps 12–13 already documented this path.
   - The loopback guard was **kept** and its documentation corrected: it now protects against seeding published demo credentials into a shared environment and mutating organization/plan/project/invitation state somewhere real. It is no longer standing between a secret and a terminal.

- **Explicitly rejected substitutions:** switching `console.log` to `process.stdout.write`, base64-encoding the secret, printing it via an error, embedding it in a command example, printing the whole HTTP response, writing it to a file, or suppressing the query. Each would defeat the scanner without changing the exposure, which is the opposite of the intent.
- **Dependencies:** none. **Effort:** S. **Validation:**
  - `tooling/demo-seed.output.test.ts` (7 cases) runs the REAL script as a child process against a stub API on loopback and inspects everything it actually wrote: exits 0 with empty stderr; issues **no** request to any `/api-keys` path; emits no owner password, no access token, and no key secret — asserted both by literal value and by shape (`/orgistry_[A-Z0-9]{6,}_/`, `/Bearer\s+\S+/`, `/[A-Za-z0-9_-]{40,}/`) so a *different* credential would also be caught; still prints the org id, sign-in address, and web-demo URL; directs the operator to the API Keys page; leaves the rest of the flow intact (login, org list/create, plan change, three projects, invitation); and refuses a non-loopback target before issuing any request.
  - Negative control: temporarily reinstating API-key creation plus a secret print made exactly two of those cases fail (`creates no API key…`, `emits no password, token, or key secret…`), then the file was restored byte-identically. The test has teeth rather than passing vacuously.
  - `tooling/demo-target-guard.test.ts` (5 cases) unchanged and still green.
- **CodeQL evidence:** recorded in [sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md) against the final analysis of the merged `main` commit.
- **Roadmap:** n/a. **Standards:** ASVS V7.1 (log content). **Threats:** T-SECRET.
- **Owner / follow-up:** Repository maintainer. Re-review whenever `demo-seed.mjs` gains new output or the demo gains a non-local mode. **No accepted clear-text logging risk remains in this repository.**
