# Sprint 15 Artifact Package — Production Configuration and Secret Safety

```txt
Sprint status: COMPLETE
DG-1, DG-2, and DG-5 were ratified by the Project Owner on 2026-07-18.
```

| Dimension | State |
| --- | --- |
| **Engineering state** | Complete. |
| **Sprint state** | Complete — all Sprint 15 Definition of Done and exit criteria are satisfied. |
| **Product-decision state** | DG-1, DG-2, and DG-5 ratified by the Project Owner. DG-3 and DG-4 remain open as permitted by the sprint specification. |
| **Validation state** | Complete based on the recorded passing config tests, repository validation, integration validation, web build, schema-drift check, and diff check (§5). |

Sprint 15 completion is **not** launch clearance: the repository remains not
ready for staging and not ready for production (§16).

- **Sprint:** 15 — Production Configuration and Secret Safety
- **Dates:** 2026-07-18 (implementation, refinement, and owner ratification)
- **Base revision:** `d0b2f97` (`main`), work uncommitted
- **Findings closed:** ORG-PR-003 (P1), ORG-PR-047 (P4)
- **Decision record:** [sprint-15-decisions.md](sprint-15-decisions.md)

## 1. Implementation summary

Under `NODE_ENV=production`, configuration loading fails closed — the API
cannot boot — when `JWT_SECRET` is a known development default, shorter than
32 characters, placeholder-style, or a single repeated character, or when
`COOKIE_SECURE` is not `true`. The policy lives in
`packages/config/src/production-policy.ts` (sole export:
`enforceProductionConfigSafety`) and is wired into `envSchema` via
`superRefine`, so the single existing `loadConfig` path enforces it with no
second config authority. `apps/api/src/server.ts — main` calls `getConfig()`
before any service creation or `listen`, so unsafe production config
structurally cannot boot the API. The dead `COOKIE_SECRET` variable was
removed end-to-end. Development and test workflows are unchanged.
Secret-generation guidance is standardized on `openssl rand -hex 32`.

## 2. Findings closed

| Finding | Resolution |
| --- | --- |
| ORG-PR-003 (P1) | Production guard implemented and test-proven; see the Resolution line in the [findings register](findings-register.md#org-pr-003). |
| ORG-PR-047 (P4) | `COOKIE_SECRET` **removed because unused** (no code path signs/verifies cookies); see [findings register](findings-register.md#org-pr-047). |

Explicitly **not** closed: ORG-PR-001, ORG-PR-002, ORG-PR-004, ORG-PR-005,
ORG-PR-006 (open P1 blockers, §15) and ORG-PR-017 (policy ratified via DG-2;
enforcement is Sprint 19 work). Rejecting weak secrets is not secrets
management or rotation (ORG-PR-006 remains fully open).

## 3. Files changed

Code and config:

- `packages/config/src/production-policy.ts` — **new**: policy constants,
  predicates, single issue-creation path, `enforceProductionConfigSafety`.
- `packages/config/src/schema.ts` — guard wired via `superRefine`;
  `COOKIE_SECRET` field removed.
- `packages/config/src/index.ts` — `Config.auth.cookieSecret` removed.
- `packages/config/src/config.test.ts` — production-guard suite added.
- `apps/api/src/testing/build-test-app.ts` — `COOKIE_SECRET` fixture removed.
- `.github/workflows/ci.yml` — dead `COOKIE_SECRET` env value removed.
- `.env.example` — production boundaries, `openssl rand -hex 32` guidance,
  `COOKIE_SECURE` production requirement, `COOKIE_SECRET` removal note.

Documentation: `docs/production-config-guard.md` (**new**);
`docs/production-readiness/` — `findings-register.md`, `launch-checklist.md`,
`production-roadmap.md`, `production-target.md`, `security-assessment.md`,
`repository-inventory.md`, `README.md`, `sprint-15-decisions.md` (**new**),
this artifact (**new**); `docs/security-model.md`,
`docs/known-limitations.md`, `docs/roadmap.md`, `docs/validation.md`,
`docs/troubleshooting.md`, `docs/evaluation-guide.md`; root `README.md`.

## 4. Tests added or updated

`packages/config/src/config.test.ts` — 20 tests (12 new). The
`production configuration guard (NODE_ENV=production)` suite covers: a
generated-style secret + `COOKIE_SECURE=true` loads; known dev-default,
test-fixture, and CI secrets fail (exact rejection); <32-char,
placeholder-marker, and repeated-character `JWT_SECRET` fail;
`COOKIE_SECURE=false` and unset both fail naming the field; error messages
never echo the secret; production rules do not apply in development/test.
Plus: `.env.example` defaults load in development; `COOKIE_SECRET` is neither
required nor exposed. All cases pass explicit env records to `loadConfig` —
no `process.env` mutation, no state leakage.

## 5. Validation evidence

Executed 2026-07-18 on this working tree (exit codes captured directly):

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm exec vitest run packages/config` | 0 | 20/20 tests pass |
| `pnpm validate` | 0 | typecheck, lint, **501 unit tests** (53 files), **19 web tests** (5 files), web build, schema-drift clean, whitespace clean |
| `pnpm validate:integration` | 0 | test DB reset + migrated from scratch; **13 db + 38 api integration tests**, all passed, **0 skipped** |
| `git diff --check` | 0 | clean |

Integration validation ran against isolated disposable services per the
repository's documented mechanism (`docs/runbook.md` § Handling port
conflicts, option 3): one-off `postgres:16-alpine` on host port 55432 and
`redis:7-alpine` on 63790, addressed via explicit `DATABASE_URL` /
`TEST_DATABASE_URL` / `REDIS_URL` overrides (explicit env wins over `.env`),
containers removed afterwards; the unrelated local PostgreSQL on 5432 was
never touched. The closure pass changed documentation only, so this evidence
remains authoritative for the final tree.

## 6. DG-1 decision and rationale

**RATIFIED — Project Owner, 2026-07-18.** Primary distribution model:
self-hosted, single-region, low-scale multi-tenant B2B identity foundation,
operated by a single operator or small team. Secondary: low-scale managed or
hosted evaluation. Explicitly not a large public SaaS. *Rationale:* matches
Orgistry's role as an open-source, production-oriented SaaS identity and
access foundation; keeps infrastructure and operations proportional to
intended scale while preserving a later hosted-evaluation option;
public-SaaS-scale requirements must not be assumed unless the Project Owner
changes this decision. Affected: ORG-PR-001/003/006/007/008/009/012/013/027;
Sprints 21, 23. Full record: [sprint-15-decisions.md](sprint-15-decisions.md).

## 7. DG-2 decision and rationale

**RATIFIED — Project Owner, 2026-07-18.** Only an active Owner may grant or
remove the Owner role. An Admin may not grant Owner to themselves or another
member, and may not remove Owner from another member. Every Owner transition
remains subject to last-owner protection (≥1 active Owner per organization).
*Rationale:* Owner is the highest organization authority; Admin-conferred
Owner would let a lower-privileged role cross its own authorization boundary.
The ratified policy preserves least privilege, makes delegation explicit,
prevents self-escalation, and stays consistent with the last-owner invariant.
Affected: ORG-PR-017 (open until enforced); Sprint 19 must implement and test
the full rule set, including audit-logging of authorization failures where
the architecture requires it. **No enforcement was implemented in Sprint 15.**

## 8. DG-5 decision and rationale

**RATIFIED — Project Owner, 2026-07-18.** Production RPO: at most one hour of
accepted production data may be lost; PITR must be available before the
system accepts production data. Daily snapshots are acceptable only in
evaluation-only environments holding no production data. Production RTO:
recovery within four hours via a documented, rehearsed restore process.
*Rationale:* a meaningful recovery boundary proportional to the approved
small-operator, single-region profile; a backup mechanism is not
production-ready until restore has been exercised. Affected: ORG-PR-005
(open until implemented), ORG-PR-028; Sprint 21 (PITR-capable Postgres
selection), Sprint 22 (backups, PITR, monitoring, retention, restore docs,
restore drill proving the RTO). **No backup/PITR/restore behavior was
implemented in Sprint 15.**

## 9. Gates remaining open

- **DG-3 — Compliance regime:** OPEN. Legal/privacy review required (Project
  Owner + Legal). Affected: ORG-PR-025, ORG-PR-043.
- **DG-4 — Quota/billing semantics:** OPEN. Product decision required
  (Project Owner). Affected: ORG-PR-029.

The Sprint 15 specification explicitly permits both to remain open; they do
not block Sprint 15 completion.

## 10. Config contracts and invariants

See [docs/production-config-guard.md](../production-config-guard.md). Summary
— future infrastructure work must not weaken:

1. `NODE_ENV=production` requires `COOKIE_SECURE=true`.
2. Known local-development secrets are invalid in production.
3. Production secrets must meet the quality floor (≥32 chars, no placeholder
   markers, not degenerate).
4. Unsafe config fails at load time, before API boot.
5. Development/test defaults are never production credentials.
6. Required config fields must correspond to real runtime behavior (why
   `COOKIE_SECRET` was removed rather than retained).

## 11. Documentation index

- [docs/production-config-guard.md](../production-config-guard.md) —
  implementation/architecture reference.
- [sprint-15-decisions.md](sprint-15-decisions.md) — ratified decisions +
  authority history.
- [findings-register.md](findings-register.md) — ORG-PR-003/047 resolutions;
  ORG-PR-017 policy update; historical baseline preserved.
- [launch-checklist.md](launch-checklist.md) — LC-1.1/1.2/1.3 closed.
- [production-target.md](production-target.md) /
  [production-roadmap.md](production-roadmap.md) — ratified gate status.
- [docs/known-limitations.md](../known-limitations.md) — limitation
  statement.
- `.env.example` — operator-facing boundaries and generation guidance.

## 12. Scope-control confirmation

No excluded area was changed at any point in the sprint: no deployment
automation, Dockerfiles, IaC, staging infrastructure, secrets-manager or
rotation code, JWT key rotation, email/verification/recovery work, MFA,
backups/PITR/restore, observability, incident response, security headers,
proxy configuration, rate-limit redesign, quota-concurrency changes,
role-transition enforcement, legal/privacy implementation, audit-retention
enforcement, dependency upgrades, or Sprint 16 functionality. The DG-2/DG-5
ratifications are recorded decisions only — their enforcement and
implementation remain future sprint work. The ratification/closure pass
changed documentation only. Nothing was committed or pushed; pre-existing
uncommitted work was preserved.

## 13. Confidence assessment

**High** for the guard's behavior (unit-proven at the real `loadConfig`
boundary; boot ordering structural), the `COOKIE_SECRET` removal (search-,
test-, and integration-proven), and validation coverage (unit, web, build,
drift, whitespace, and full integration all green on this tree). **High** for
decision-record accuracy: the ratified decisions were supplied verbatim by
the Project Owner with owner, date, and rationale recorded. **Medium** for
historical-document consistency — Sprint 14 audit documents preserve their
baseline wording with explicit temporal framing rather than rewrites.

## 14. Remaining risks

- The secret quality floor is deliberately not an entropy proof; a contrived
  weak-but-passing value still boots. Real mitigation is ORG-PR-006 (secrets
  management), which remains open.
- No JWT `kid`/rotation path (ORG-PR-049): rotating `JWT_SECRET` invalidates
  all live access tokens.
- Until Sprint 19 lands, the ratified DG-2 policy is **not enforced** —
  Admin→Owner promotion is still possible in code (ORG-PR-017).
- A pre-existing flaky web-demo test (`admin-surfaces.test.tsx`) can
  intermittently fail `pnpm validate`; unrelated to this sprint.

## 15. Remaining production blockers (all open, P1)

- **ORG-PR-001** — no production deployment automation (distribution model
  now decided via DG-1; infrastructure still absent).
- **ORG-PR-002** — no production email provider.
- **ORG-PR-004** — no password recovery flow.
- **ORG-PR-005** — no backup/PITR/tested restore (targets now decided via
  DG-5; implementation still absent).
- **ORG-PR-006** — no secrets management or rotation.

## 16. Final readiness state

```txt
C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

Completing Sprint 15 is not launch clearance.

## 17. Readiness for the next sprint

With the config layer fail-closed and DG-1/DG-2/DG-5 ratified, the roadmap's
next sprint is **Sprint 16 — Production Email and Email Verification**
(ORG-PR-002 groundwork; also unblocks recovery/verification work). Sprint 19
now has an authoritative DG-2 policy to implement; Sprints 21/22 have
authoritative DG-1/DG-5 targets to build against. No Sprint 16 work was begun
during Sprint 15.

## 18. Sprint changelog

- Add production config guard (`production-policy.ts` + `superRefine`
  wiring); close ORG-PR-003.
- Remove dead `COOKIE_SECRET` end-to-end; close ORG-PR-047.
- Add 12 config tests (20 total in the package); unit suite 489 → 501.
- Rewrite `.env.example` auth-secret guidance; add
  `docs/production-config-guard.md`; update security model, known
  limitations, roadmaps, validation/troubleshooting docs.
- Refinement pass (historical): status was recorded as NOT COMPLETE while
  DG-1/DG-2/DG-5 awaited an owner decision; temporal framing added to
  historical audit statements; secret guidance standardized on
  `openssl rand -hex 32`; policy module narrowed to a single export; full
  integration validation executed against isolated disposable services
  (51/51, 0 skipped).
- Closure pass: **DG-1, DG-2, and DG-5 ratified by the Project Owner
  (2026-07-18)** and synchronized across the production-readiness
  documentation; Sprint 15 marked COMPLETE. Documentation-only change.
