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
| Cryptography & secret management | Partially satisfied | jose HS256 allowlist; hash-only secrets | dev-default secrets in prod; no rotation/manager | P1 | ORG-PR-003, 006, 049 |
| Logging & monitoring | Partially satisfied (S19) | request IDs (inbound id sanitized, S19), sanitized event metadata, centralized pino redaction backstop (S19) | no metrics/alerts | P2 | ORG-PR-007; 033 closed (S19) |
| Data protection & privacy | Not satisfied | soft-delete only | no export/delete; PII retained | P2/P3 | ORG-PR-025, 043 |
| Business logic / anti-automation | Partially satisfied (S19) | per-surface auth limits; global per-trusted-IP limit + per-actor mutation buckets (S19); sensitive buckets fail closed in production (S19) | quota TOCTOU; limiter-outage alerting pending ORG-PR-007 | P2/P3 | ORG-PR-029; 012/032 closed, 009 materially advanced (S19) |
| API & configuration | Partially satisfied (S19) | uniform envelope; safe error handler; prod config guard (S15); security headers + typed proxy trust (S19) | no DB/pool/statement timeouts | P2 | ORG-PR-021; 003 closed (S15), 010/011 closed (S19) |

## NIST SSDF (SP 800-218) — named practice groups

Mapped at the four SSDF practice-group level (the standard's own group names),
not at the individual task identifier level.

| Practice group | Class | Evidence | Gap | Findings |
| --- | --- | --- | --- | --- |
| Prepare the Organization | Partially satisfied | strong docs/DX; validation matrix | no ops/incident process | ORG-PR-008, 027 |
| Protect the Software | Partially satisfied | lockfile, `onlyBuiltDependencies` | no secrets manager; no SBOM/signing | ORG-PR-006, 020 |
| Produce Well-Secured Software | Partially satisfied | strict TS, ESLint, broad tests, code review culture | no SAST; `noUncheckedIndexedAccess` off; no failure-injection | ORG-PR-020, 040, 026 |
| Respond to Vulnerabilities | Not satisfied | manual `pnpm audit` only | no scanning/Dependabot/CodeQL; no VDP | ORG-PR-020, 018 |

## OWASP SAMM (governance→operations)

| Business function / practice | Maturity (0–3, indicative) | Evidence | Gap |
| --- | --- | --- | --- |
| Governance — Policy & Compliance | ~1 | known-limitations, honest scope | no privacy/retention policy (legal) — ORG-PR-025/043 |
| Design — Threat Assessment | ~1→2 | this threat model (new) | no prior model; keep current |
| Design — Security Architecture | ~2 | permission/entitlement/quota separation, tenant model | RLS absent (defense-in-depth, deferred) |
| Implementation — Secure Build | ~1 | reproducible via lockfile | no pipeline/artifacts — ORG-PR-001 |
| Implementation — Secure Deployment | ~0→1 | none | no deploy/secrets automation — ORG-PR-001/006 |
| Verification — Security Testing | ~1 | strong functional/negative tests | no SAST/DAST/E2E/pentest — ORG-PR-020/026 |
| Operations — Incident Mgmt | ~0 | none | no incident process — ORG-PR-008 |
| Operations — Environment Mgmt | ~1 | local runbook | no prod runbook/backup — ORG-PR-005/027 |

## SLSA (build/provenance)

| Requirement (practice-level) | Class | Evidence | Gap | Findings |
| --- | --- | --- | --- | --- |
| Scripted/consistent build | Partially | `pnpm build:web`; reproducible via lockfile | no server build/artifact | ORG-PR-001 |
| Version-controlled source | Satisfied | git; PR-triggered CI | no branch-protection evidence in repo | ORG-PR-019 |
| Build service (not local) | Not satisfied | build runs in CI but produces no release artifact | no release pipeline | ORG-PR-001 |
| Provenance generated | Not satisfied | none | no provenance/attestation | ORG-PR-020 |
| Provenance/dependencies signed | Not satisfied | none | no signing/SBOM; floating image tags | ORG-PR-042, 020 |

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
3. **DAST** against a running staging instance (no DAST exists — ORG-PR-020).
4. **Legal/privacy review** for the data-protection & privacy classifications
   (ORG-PR-025/043).

No certification or formal conformance is claimed by this document.
