# Standards Matrix

Practice-level mapping of Orgistry controls and gaps against the **practice areas**
of OWASP ASVS 5.0, NIST SSDF (SP 800-218), OWASP SAMM, and SLSA. Classifications
are drawn only from: **Satisfied**, **Partially satisfied**, **Not satisfied**,
**Not applicable**, **Not verifiable from repository**.

> **This is a repository evidence mapping, not a certification, attestation, or
> formal conformance assessment.**
>
> **Verification basis / limitations (read first).** The authoritative published
> texts of ASVS 5.0, SSDF, SAMM, and SLSA were **not available in this execution
> environment** (no network/document access). Accordingly, this document maps at
> the **practice/domain level using the standards' own practice-area names** and
> deliberately **does not cite exact numbered control identifiers or paraphrase
> official control wording as if exact**, because those could not be verified
> against the source. Rows are practice-level mappings only. A complete matrix
> with verified identifiers requires an external reviewer holding the authoritative
> documents (see "External verification required" below).

## OWASP ASVS 5.0 — application security (practice areas)

| Practice area | Class | Evidence | Gap | Sev | Findings |
| --- | --- | --- | --- | --- | --- |
| Authentication — password strength/storage | Satisfied | Argon2id `password.ts`; length 12–200 | length-only policy (no breach check) | — | — |
| Authentication — credential recovery | Not satisfied | no reset flow (grep) | password recovery absent | P1 | ORG-PR-004 |
| Authentication — verification / MFA | Partially satisfied (S16) | email-verification lifecycle implemented + tested (advisory, not enforced); no MFA | verification enforcement + MFA absent | P3 | ORG-PR-024 closed, 045 |
| Authentication — anti-enumeration | Partially satisfied | login hardened; register not | register oracle | P3 | ORG-PR-030 |
| Session management | Satisfied | rotation+reuse detection, HttpOnly/SameSite, revocation | unsigned cookie; multi-tab logout | P4 | ORG-PR-047, 050 |
| Access control (object/function level) | Partially satisfied | permission-first, repo org-scoping, uniform 404 | Admin→Owner; 2 read paths skip gate | P2/P4 | ORG-PR-017, 053 |
| Validation & injection | Partially satisfied | Zod on all inputs; parameterized queries | drizzle advisory in range | P2 | ORG-PR-018 |
| Cryptography & secret management | Partially satisfied | jose HS256 allowlist; hash-only secrets; production secret guards (S15); runtime env/file secret sources validated before the guard and graceful access-token key rotation (S24) | no secrets manager, no least-privilege secret access, no automated/rehearsed rotation, no `kid`/versioned keys | P1 | ORG-PR-003 (closed), 006, 049 |
| Logging & monitoring | Partially satisfied (S19) | request IDs (inbound id sanitized, S19), sanitized event metadata, centralized pino redaction backstop (S19) | no metrics/alerts | P2 | ORG-PR-007; 033 closed (S19) |
| Data protection & privacy | Partially satisfied (S25) | soft-delete; a bounded, enforced retention window for `security_events` and the account-lifecycle token tables (policy + tested cleanup, ORG-PR-015 closed) | no export/delete; retention is growth control, not erasure or per-subject deletion; cleanup is operator-invoked (no scheduler) | P2/P3 | ORG-PR-025, 043, 016 |
| Resilience & recovery (ASVS V14 / SSDF PO.3 adjacent) | Partially satisfied (S25) | repeatable logical backup with integrity checksum and provenance; restore drill into a fresh database reaching the packaged artifact; **PITR VERIFIED**; CI-gated; documented runbooks | nothing schedules a backup; no encrypted remote backup storage; no continuous WAL archiving on a long-lived database; no provider-managed PITR; no measured RPO/RTO | P1 | ORG-PR-005, 028 |
| Business logic / anti-automation | Partially satisfied (S19) | per-surface auth limits; global per-trusted-IP limit + per-actor mutation buckets (S19); sensitive buckets fail closed in production (S19) | quota TOCTOU; limiter-outage alerting pending ORG-PR-007 | P2/P3 | ORG-PR-029; 012/032 closed, 009 materially advanced (S19) |
| API & configuration | Partially satisfied (S19) | uniform envelope; safe error handler; prod config guard (S15); security headers + typed proxy trust (S19) | no DB/pool/statement timeouts | P2 | ORG-PR-021; 003 closed (S15), 010/011 closed (S19) |

## NIST SSDF (SP 800-218) — named practice groups

Mapped at the four SSDF practice-group level (the standard's own group names),
not at the individual task identifier level.

| Practice group | Class | Evidence | Gap | Findings |
| --- | --- | --- | --- | --- |
| Prepare the Organization | Partially satisfied | strong docs/DX; validation matrix | no ops/incident process | ORG-PR-008, 027 |
| Protect the Software | Partially satisfied | lockfile, `onlyBuiltDependencies`, SHA-pinned actions, secret scanning enforced as a required check (S22), runtime-only secret injection with no build-time secret dependency (S23/S24) | no secrets manager; no SBOM/signing | ORG-PR-006, 001 |
| Produce Well-Secured Software | Partially satisfied | strict TS incl. `noUncheckedIndexedAccess` (Sprint 21), ESLint, broad tests, code review culture; CodeQL executing remotely with all 41 baseline alerts triaged and dispositioned (Sprint 22) | no failure-injection; no DAST | ORG-PR-026 |
| Respond to Vulnerabilities | Largely satisfied (Sprint 22) | audit gates + Gitleaks + Dependabot + CodeQL running remotely and enforced as required checks; secret gate proved to fail on a seeded finding; documented CodeQL alert policy with evidence-bearing dispositions; advisories remediated with two documented acceptances | no VDP / security.txt; no coordinated-disclosure process | ORG-PR-008 |

## OWASP SAMM (governance→operations)

| Business function / practice | Maturity (0–3, indicative) | Evidence | Gap |
| --- | --- | --- | --- |
| Governance — Policy & Compliance | ~1 | known-limitations, honest scope; a documented, enforced ENGINEERING retention policy (S25) | no privacy/LEGAL retention policy or review — ORG-PR-025/043 |
| Design — Threat Assessment | ~1→2 | this threat model (new) | no prior model; keep current |
| Design — Security Architecture | ~2 | permission/entitlement/quota separation, tenant model | RLS absent (defense-in-depth, deferred) |
| Implementation — Secure Build | ~2 | reproducible via lockfile; CI-built non-root container artifacts + smoke gate (S23); build-once/promote-by-digest with a schema-validated release manifest whose migration identity is derived, not supplied; environment-neutral images (no build arguments); publication authorised only by the required checks succeeding for the exact release SHA, with their run IDs recorded in the manifest (S26) | no signing or SLSA provenance attestation; published images are single-arch amd64 — ORG-PR-001 |
| Implementation — Secure Deployment | ~2→3 | production-shaped artifacts + smoke gate (S23); runtime secret sources + manual rotation runbooks (S24); deployment mechanism with digest-only promotion, a target that cannot rebuild source, migrate-once with verified applied head, post-deploy smoke, an evidence ledger, and rehearsed application rollback (S26); **executed against a durable staging-like target with public HTTPS smoke and a real application rollback (S27, 2026-08-27) — ORG-PR-001 closed; Sprint 27 itself remains open pending remote validation of its repository changes** | no PRODUCTION target; the `staging-like` GitHub Environment has a deployment-branch policy but no reviewer separation (single maintainer, documented); no secrets manager, no automated rotation, no observability — ORG-PR-006/007 |
| Verification — Security Testing | ~2 | strong functional/negative tests; SAST (CodeQL) running remotely with triaged findings (S22) | no DAST/E2E/pentest — ORG-PR-026 |
| Operations — Incident Mgmt | ~0→1 | data-loss and PITR recovery procedures with executed evidence (S25) | no incident process, on-call, severity model, or alerting — ORG-PR-008 |
| Operations — Environment Mgmt | ~1 | local runbook; backup/restore/PITR and retention runbooks with executed evidence (S25) | no prod runbook; nothing SCHEDULES backup or retention; no remote/encrypted backup storage — ORG-PR-005/016/027 |

## SLSA (build/provenance)

| Requirement (practice-level) | Class | Evidence | Gap | Findings |
| --- | --- | --- | --- | --- |
| Scripted/consistent build | Satisfied | `pnpm build:web`, `pnpm build:api`, both Dockerfiles; reproducible via lockfile; one scripted release path (S26) | — | — |
| Version-controlled source | Satisfied | git; PR-triggered CI; `main` ruleset requires a PR and the CI/Security/CodeQL checks (Sprint 22) | ruleset lives in GitHub config, not in the repository tree | — |
| Build service (not local) | Partially | CI builds and smoke-tests the container artifacts (S23); a release workflow publishes them to GHCR under an immutable commit-SHA tag with digest capture, only after proving all six required checks succeeded for that exact commit, and refuses to publish from a dirty tree (S26) | executed for real (run 32776576782): both images published to GHCR for commit 91664d0, and **deployed to a durable staging-like target by digest (S27)**; no signing/attestation | ORG-PR-001 closed; signing/provenance still open |
| Provenance generated | Partially | the release manifest records source provenance (`commit` vs `working-tree`), deployability, image digests, derived migration identity, and the required-check run IDs that authorised publication (S26) — a verifiable build record, but unsigned and self-asserted | no signed, independently verifiable attestation | ORG-PR-001 |
| Provenance/dependencies signed | Not satisfied | images tag+digest-pinned (S23, ORG-PR-042 closed); releases promoted by digest with the digest recorded in a validated manifest and in deployment evidence (S26) — identity, not authenticity | no signing/SBOM/provenance | ORG-PR-001 |

Indicative build-integrity maturity: a scripted, version-controlled build with **no
provenance or signing** (roughly the lowest SLSA tier). Higher tiers require a
build service emitting signed provenance (Phase 4/6 roadmap work). The exact tier
name/number is not asserted here pending verification against the authoritative
SLSA text.

## External verification required before a complete matrix

1. Re-map against the **authoritative ASVS 5.0 / SSDF / SAMM / SLSA texts** with
   verified identifiers (network/document access needed).
2. **Independent security review / penetration test** (ties to the T-DEP/T-CI/
   T-PRIV threats and ORG-PR-018 triage).
3. **DAST** against a running staging instance (no DAST exists; SAST is now
   covered by CodeQL — Sprint 22).
4. **Legal/privacy review** for the data-protection & privacy classifications
   (ORG-PR-025/043).

No certification or formal conformance is claimed by this document.
