# Sprint 24 Artifact Package — Runtime Secrets and External Email Validation

> **Status: SPRINT 24 IS NOT YET CLOSED — pending post-change remote workflow
> validation. This is the current (provisional) evidence package; it becomes
> the closing artifact once those workflows are green.**
>
> **No Sprint 24 DoD condition has failed and no repository work remains.**
> Repository implementation and local validation are complete. Exactly **one**
> DoD gate is outstanding: the changes are uncommitted, so CI, Security scans,
> CodeQL, and `Artifacts (build + smoke)` have not run against them
> (**PENDING OPERATOR ACTION**, §19).
>
> External SMTP provider validation was **not performed** — no provider
> credentials, verified sending domain, or readable test mailbox exist here.
> The binding specification permits that condition to be met by a *precisely
> documented blocker*, which it is (§11–§14), so it is **not** a failed
> deliverable. It does mean **ORG-PR-002 stays open** and Orgistry has **no
> evidence that production email works** — three different statements that this
> document keeps apart throughout.
>
> Finding closure is likewise **not** a Sprint 24 DoD condition: ORG-PR-002 and
> ORG-PR-006 remaining open is the honest, specification-permitted outcome. See
> the [DoD reconciliation](#definition-of-done-reconciliation) below,
> [what is NOT a DoD condition](#what-is-not-a-sprint-24-dod-condition), §21,
> and §25.

Every statement in this document is labelled by evidence class:

- **Implemented** — code exists in the working tree.
- **Test-proven** — an automated test asserts the behavior.
- **Manually validated** — a human ran it and observed the result.
- **Remotely validated** — a GitHub Actions run proved it.
- **Pending operator action** — repository work is done; an operator step remains.
- **Not performed / blocked** — the required external resource is unavailable;
  the blocker and the evidence still needed are named. This is an evidence
  state, never a substitute for validation.

Execution date: **2026-08-23**. Base commit: `938a688` (`main`, clean at
start). Changes are **uncommitted and unpushed** in the working tree, so no
Sprint 24 remote evidence exists (see §19).

---

## Definition-of-Done reconciliation

Rebuilt from the binding Sprint 24 Definition of Done, condition by condition.
No condition is invented here, and finding-closure or production-maturity
criteria are **not** counted as Sprint DoD items — see
[What is NOT a Sprint 24 DoD condition](#what-is-not-a-sprint-24-dod-condition).

Status vocabulary:

- **PASS** — implemented and evidenced.
- **SATISFIED BY EXPLICIT EXTERNAL BLOCKER** — the specification permits this
  condition to be met either by completing the validation *or* by documenting
  the blocker precisely; the required external resource is unavailable and the
  blocker is recorded with the exact evidence still needed.
- **PENDING OPERATOR ACTION** — repository work is complete; an operator step
  remains.
- **FAIL/MISSING** — repository work is still required.

### Runtime secrets

| Condition | Status | Evidence |
|---|---|---|
| Full runtime secret inventory | PASS | `../runtime-secrets.md` §Secret inventory; §2 |
| Direct environment source preserved | PASS | `secret-source.test.ts`; §4 |
| Mounted-file source (`<NAME>_FILE`) | PASS | `secret-source.test.ts`; §3–4 |
| Ambiguity semantics (both set → fail closed) | PASS | `secret-source.test.ts`; artifact smoke; §4 |
| Production validation applied to the RESOLVED value | PASS | `secret-source.test.ts`; artifact smoke; §5 |
| No build-time / image / frontend secret dependency | PASS | artifact smoke; §17 |
| Secrets absent from logs | PASS | `logging.test.ts`, artifact smoke; §6 |
| Invalid / unsafe file-loaded secret rejected | PASS | `secret-source.test.ts`; artifact smoke; §5, §17 |
| Artifact smoke covers the mounted-secret path | PASS | §17 |

### Secret rotation

The binding DoD requires the rotation **model, procedures, and honest
manual-vs-automated wording** — not a rehearsal against a deployed system.

| Condition | Status | Evidence |
|---|---|---|
| Rotation model documented for each major secret | PASS | `../runtime-secrets.md` §Secret inventory; §7 |
| JWT/access-token rotation implemented, or precisely deferred | PASS — implemented (current signs; current + previous verify) | `access-token.test.ts`, `jwt-secret-rotation.routes.test.ts`; §8 |
| Refresh/session rotation behavior documented | PASS — documented from the implementation, including that no session secret exists | §9 |
| SMTP credential rotation procedure | PASS | `../rotation-runbook.md` §Rotate SMTP credentials; §10 |
| Emergency rotation procedure, distinct from routine | PASS | `../rotation-runbook.md` §Emergency: compromised JWT secret; §7 |
| Session invalidation procedure | PASS — per-session, per-user, per-family, and platform-wide (operator SQL, verified against the live schema) | §9; `../rotation-runbook.md` §Emergency: invalidate sessions |
| Database / Redis credential rotation at the operator boundary | PASS | `../rotation-runbook.md`; `../runtime-secrets.md` |
| No overclaiming while rotation remains manual | PASS — every rotation is stated as manual and restart-requiring | §7; `../runtime-secrets.md` §Known limitations |

### External email

The binding DoD and Exit Criteria permit real external SMTP provider
validation to be **completed OR explicitly blocked by missing
credentials/domain access**. No provider credentials, verified sending domain,
or readable test mailbox exist here (re-confirmed: repository secrets empty,
zero GitHub Actions environments), so this condition is met in its
blocker form — with the blocker and the exact evidence still required recorded
in §11–§14 and `../rotation-runbook.md`.

| Condition | Status |
|---|---|
| Repository-side prerequisites for external validation implemented | PASS — credential source, provider-agnostic mailer, failure-mode redaction (§10, §16) |
| Per-family delivery matrix with separated evidence classes | PASS (§12) |
| Local generation for every existing family | PASS (§12) |
| Link/token hygiene per family | PASS (§12) |
| Real external SMTP provider validation | **SATISFIED BY EXPLICIT EXTERNAL BLOCKER** — not performed; blocker and required evidence recorded (§11–§13) |
| Operator validation procedure documented | PASS — `../rotation-runbook.md` §Validate external email delivery |

**The evidence facts are unchanged and are not softened by this
classification:** provider acceptance — *not performed*; real inbox receipt —
*not performed*; sender identity as received — *not performed*. Local
generation is never counted as delivery validation, and "not performed" is
never rewritten as "validated". ORG-PR-002 stays **OPEN — materially
advanced** (§21).

### Sender domain

Same blocker allowance: no sending domain exists, so nothing could be
validated and nothing is claimed.

| Condition | Status |
|---|---|
| `From` (`MAIL_FROM_EMAIL`/`MAIL_FROM_NAME`) configured and production-guarded | PASS |
| `Reply-To` posture | PASS — confirmed not emitted (§14) |
| Sender-domain posture documented (envelope sender/Return-Path, provider verification, SPF, DKIM, DMARC) | PASS — documented; every verdict recorded as *not performed* (§14) |
| Sender-domain validation procedure incl. DNS propagation caveats | PASS — `../rotation-runbook.md` §Sender domain |
| Actual SPF / DKIM / DMARC verdicts | **SATISFIED BY EXPLICIT EXTERNAL BLOCKER** — no domain to validate; evidence still required is named (§14) |

### CI

| Condition | Status |
|---|---|
| Routine CI independent of real credentials | PASS — `../validation.md` §CI security policy |
| Fork-PR safety (no secret reachable) | PASS — no repository secrets, no environments, no `pull_request_target` |
| Least-privilege workflow permissions preserved | PASS — workflows unmodified |
| Gitleaks / CodeQL / artifact gate preserved | PASS — workflows unmodified |
| Post-change remote status (CI, Security, CodeQL, Artifacts) | **PENDING OPERATOR ACTION** (§19) |

### Result

**33 PASS · 2 SATISFIED BY EXPLICIT EXTERNAL BLOCKER · 1 PENDING OPERATOR
ACTION · 0 FAIL/MISSING.**

**No Sprint 24 DoD condition has failed, and no repository work remains.**
Sprint 24 is **NOT YET CLOSED — pending post-change remote workflow
validation**. That single gate is the operator's commit/push/PR; once CI,
Security scans, CodeQL, and `Artifacts (build + smoke)` are green for the exact
Sprint 24 commit, this document can be finalized as the Sprint 24 closing
artifact (§25).

### What is NOT a Sprint 24 DoD condition

These are real and remain recorded — as production-readiness risks (§22) and
finding-closure blockers (§21) — but the binding specification does not make
any of them a Sprint 24 deliverable, and none of them is a repository
implementation failure:

| Item | Where it belongs |
|---|---|
| A rehearsed rotation against a real deployed runtime | ORG-PR-006 closure criterion; needs an environment (ORG-PR-001). §21, §22 |
| A secrets manager / platform secret store, least-privilege secret access, secret-access auditability, automated rotation, expiry tracking | ORG-PR-006 closure criteria. §21, §22 |
| Real provider acceptance, inbox receipt, and SPF/DKIM/DMARC verdicts | ORG-PR-002 closure criteria. §21, §22 |
| Hot reload of secrets | Documented limitation. `../runtime-secrets.md` §Known limitations |
| Deployment environment, promotion, rollback | ORG-PR-001 — explicitly out of Sprint 24 scope |

**An open finding does not fail a sprint.** ORG-PR-002 and ORG-PR-006 remaining
open is the honest, specification-permitted outcome of Sprint 24, not evidence
that its deliverables were missed.

---

---

## 1. Implementation Summary

Two production-runtime foundations were the sprint's binding objective.

**Runtime secret injection and rotation — implemented and test-proven.**

- A single narrow resolution boundary (`packages/config/src/secret-source.ts`)
  gives six variables an optional mounted-file source (`<NAME>_FILE`) alongside
  the existing direct environment value.
- Resolution runs *before* schema validation and normalizes onto the canonical
  variable name, so a file-backed secret gets byte-identical validation and
  cannot bypass a production guard.
- Graceful access-token key rotation: an optional `JWT_PREVIOUS_SECRET` is
  accepted at verification only; signing stays current-key-only.
- Manual rotation and incident procedures are written down
  (`docs/rotation-runbook.md`).

**External production-equivalent SMTP delivery — BLOCKED.**

- SMTP credentials now flow through the same runtime secret boundary, and every
  representative provider failure mode is proven not to leak the password.
- No real provider send was performed: no provider credentials, no verified
  sending domain, and no test mailbox exist in this environment. ORG-PR-002
  stays open.

Nothing outside that scope was implemented. No deployment environment,
pipeline, promotion, rollback, registry, backup, retention, observability,
queue, bounce-handling, or authentication feature was added.

---

## 2. Secret Inventory

Full inventory with purpose, secrecy, requirement, rotation frequency, rotation
impact, and dual-read need: **`docs/runtime-secrets.md` §Secret inventory**
(single source of truth; not duplicated here).

Summary of what the implementation actually uses:

| Class | Variables |
|---|---|
| Secret, file-backed | `JWT_SECRET`, `JWT_PREVIOUS_SECRET`, `SMTP_PASSWORD`, `SMTP_USERNAME`, `DATABASE_URL`, `REDIS_URL` |
| Non-secret, production-guarded | `COOKIE_SECURE`, `MAIL_DRIVER`, `MAIL_FROM_EMAIL`, `WEB_DEMO_URL`, `RATE_LIMIT_FAILURE_MODE`, `TRUST_PROXY` |
| Non-secret tuning | `AUTH_*`, `RATE_LIMIT_*`, `*_TTL_SECONDS`, `SMTP_HOST`/`SMTP_PORT`, `MAIL_*`, `HSTS_MAX_AGE_SECONDS` |

**Corrections made to stale documentation.** Two secret-material claims in the
repository were checked against the implementation and found to need
correction:

- Docs implied a rotatable session/refresh secret. There is **none**: refresh
  tokens are opaque, unsigned, unencrypted, hash-only-persisted values and the
  refresh cookie is deliberately unsigned. Recorded in
  `docs/runtime-secrets.md` and `docs/session-lifecycle.md`.
- `COOKIE_SECRET` (removed in Sprint 15) still appeared in the operator's local
  `.env`; it is silently ignored. No repository file re-introduces it.

Only one secret was added this sprint (`JWT_PREVIOUS_SECRET`), and it exists
because rotation needs it — no secret was invented to populate the inventory.

---

## 3. Runtime Secret-Source Design

**Implemented.** `packages/config/src/secret-source.ts`, ~190 lines, no new
dependency.

```
resolveSecretSources(source, readSecretFile?) -> { env, issues }
```

- Closed list of six supported names (`FILE_BACKED_SECRET_NAMES`); any other
  `*_FILE` variable is ignored so unrelated tooling (`SSL_CERT_FILE`) keeps
  working — **test-proven**.
- The reader is injected, so tests exercise resolution without a filesystem and
  the production path (`readSecretFileFromDisk`) stays small.
- Reads exactly the configured path: no directory scan, no globbing, no
  fallback candidates. Directories and non-regular files are rejected by
  `statSync` before any read.
- The underlying `fs` error is never propagated; it is replaced by a fixed
  category string.
- No file watching, no hot reload — replacing a mounted secret requires a
  restart (**documented**, `docs/runtime-secrets.md` §Restart behavior).
- Secret-file paths are supplied through ordinary non-secret configuration.

Rejected alternatives: a generic secret-provider abstraction (nothing needs the
indirection yet); reading a whole secrets *directory* (turns a typo into a
silent wrong-secret); a config-reload signal handler (a partially reloaded
process is worse than a restart).

---

## 4. Direct Env vs File Semantics

**Implemented and test-proven** (`packages/config/src/secret-source.test.ts`).

| `NAME` | `NAME_FILE` | Result | Test |
|---|---|---|---|
| set | unset | direct value used verbatim | ✔ |
| unset | set | file read; one terminal line ending stripped | ✔ |
| set | set | **rejected** — ambiguous source, both dropped | ✔ |
| unset | unset | absent; schema decides required vs optional | ✔ |

Additional proven semantics: a blank value or blank path counts as *unset* (not
as a configured source); exactly one `\n` or `\r\n` is stripped and a second is
preserved; leading/interior/trailing whitespace inside the value is preserved;
an empty file is rejected; a missing path, a directory, and an unreadable file
are each rejected with the path but never the contents; the source record is
never mutated.

Ambiguity fails closed rather than choosing a precedence because a two-source
configuration is a real bug (typically a stale env value shadowing a rotated
file mount), and silently preferring one hides it until the wrong secret is
already signing tokens. Rationale documented in
`docs/runtime-secrets.md`.

---

## 5. Production Config Validation Evidence

**Test-proven.** The ordering invariant — resolve, then validate — is asserted
directly:

| Case | Expected | Test |
|---|---|---|
| File-loaded `JWT_SECRET` = `dev-only-jwt-secret-change-me` | same known-default + placeholder rejections as the direct value | `secret-source.test.ts` |
| File-loaded `JWT_SECRET` shorter than 32 chars in production | 32-character floor still applies | `secret-source.test.ts` |
| File-loaded `SMTP_PASSWORD` = `placeholder-value` | placeholder-marker rejection | `secret-source.test.ts` |
| Fully file-backed production config with safe values | loads; resolved values reach `config.auth.jwtSecret` / `config.mail.smtp.password` | `secret-source.test.ts` |
| `MAIL_DRIVER=smtp` with no `SMTP_PASSWORD` from either source | mailer completeness rejection | `secret-source.test.ts` |
| Rejected values echoed in the error | never | `secret-source.test.ts`, `config.test.ts` |

All pre-existing production guards are preserved unchanged: known development
secrets, placeholder markers, degenerate values, the 32-character floor,
`COOKIE_SECURE=false`, non-`smtp` mail drivers in production, placeholder SMTP
credentials, reserved/non-routable senders, non-HTTPS or localhost
`WEB_DEMO_URL`, and `RATE_LIMIT_FAILURE_MODE=open`. Sprint 24 added
`JWT_PREVIOUS_SECRET` to the same secret-strength helper rather than writing a
second validation path.

Also **manually validated** against the packaged artifact: the smoke test boots
the real image with `JWT_SECRET_FILE`/`SMTP_PASSWORD_FILE`, and separately
proves an unsafe file-loaded secret is still refused (§17).

---

## 6. Secret Redaction Evidence

**Test-proven** unless noted.

| Path | Evidence |
|---|---|
| Successful startup logs | `tooling/artifact-smoke.sh` — fake env- and file-injected secrets absent from API + migrate logs (**manually validated**, see §17) |
| Failed startup / config-validation errors | `config.test.ts`, `secret-source.test.ts` — rejected values never echoed |
| Secret-file handling errors | `secret-source.test.ts` — variable + path named, contents never |
| SMTP authentication failure | `smtp-failure-redaction.test.ts` — password absent from message, stack, and own properties |
| SMTP connection failure, rejected sender, rejected recipient, untrusted certificate, connection timeout | `smtp-failure-redaction.test.ts` (same assertion per mode) |
| Structured logger backstop | `logging.test.ts` — `JWT_PREVIOUS_SECRET`/`previousJwtSecret` added to the redaction paths |
| Access-token rejection envelope | `jwt-secret-rotation.routes.test.ts` — neither key reaches the 401 body |
| Security-event payloads | `security-events.test.ts` (pre-existing) — `sanitizeSecurityMetadata` |
| Built web assets | `tooling/artifact-smoke.sh` — server secrets absent from `/usr/share/nginx/html` |

Operational errors were **not** weakened to achieve this. They retain the
configuration field name, the secret-file path, the coarse provider failure
category (e.g. SMTP `535`), and the request id.

`_FILE` variables hold **paths**, which are configuration rather than secrets,
and are deliberately left unredacted so a failed mount is debuggable — asserted
by a dedicated test in `logging.test.ts`.

---

## 7. Rotation Model

**Implemented and documented** (`docs/rotation-runbook.md`); **not automated**.

| Secret | Model | Restart required |
|---|---|---|
| `JWT_SECRET` | Two-key window: new value becomes current, outgoing value becomes `JWT_PREVIOUS_SECRET`, previous removed after one access-token lifetime | Yes, twice (open window, close window) |
| `SMTP_PASSWORD` / `SMTP_USERNAME` | Add-then-cut-over at the provider; rollback by restoring the previous value | Yes |
| `DATABASE_URL` / `REDIS_URL` | Old credential must stay valid until every process restarts (no dual-credential support) | Yes |
| Session/refresh material | No secret exists; invalidation is a database operation | n/a |

Every rotation is **manual and operator-driven**. There is no scheduler, no
expiry tracking, no secret-access audit, and no hot reload.

---

## 8. JWT / Access-Token Rotation Status

**Implemented and test-proven.**

`packages/auth-core/src/access-token.ts — verifyAccessTokenWithRotation`, wired
at the single verification site (`auth.service.ts —
requireAuthenticatedSession`) and configured through
`config.auth.previousJwtSecret`.

| Required semantic | State | Evidence |
|---|---|---|
| New tokens signed with the current secret only | Holds — signing paths untouched | `access-token.test.ts`, `jwt-secret-rotation.routes.test.ts` |
| Verification accepts the current secret | Holds | both suites |
| Verification may additionally accept the previous secret | Holds | both suites |
| Previous secret optional | Holds — absent by default | `config.test.ts` |
| Current and previous must differ | Holds — rejected at config load in **every** mode | `config.test.ts` |
| Both receive the same production strength validation | Holds — same helper | `config.test.ts` (4 rejection classes) |
| An arbitrary older secret fails | Holds | both suites |
| Token expiry behavior unchanged | Holds — expired tokens fail under both keys | both suites |
| Auth/authorization semantics unchanged | Holds — claims, session binding, revocation untouched | route suite + full regression suite |
| Removing the previous secret completes cutover | Holds | both suites |

Route-level proof that the window is real: a token re-signed with the retiring
key authenticates `GET /v1/auth/me` while `previousJwtSecret` is configured,
and returns 401 on an otherwise identical app without it.

This is deliberately **not** a `kid`/versioned-key scheme — ORG-PR-049 remains
open. A two-key window is what a symmetric single-issuer deployment with
15-minute tokens needs, and it changes no token format or claim.

---

## 9. Refresh / Session Rotation Status

**Verified against the implementation; no code change made.**

- Refresh tokens are opaque 32-byte CSPRNG values
  (`packages/auth-core/src/opaque-token.ts`) — **not signed, not encrypted**.
- Only the SHA-256 hash is persisted; the raw value lives only in the HttpOnly
  cookie.
- Cookie integrity depends on **no secret**: `apps/api/src/lib/cookies.ts`
  serializes a plain `name=value` cookie deliberately.
- **There is no separate refresh/session signing secret.** No secret was added
  to satisfy the inventory.
- Token families are persisted on `refresh_tokens` (`family_id`,
  `parent_token_id`, `replacement_token_id`, `used_at`, `revoked_at`,
  `revoked_reason`); presenting a consumed token is classified as reuse and
  revokes the family plus its session.

Consequences documented this sprint: rotating `JWT_SECRET` logs nobody out
(`POST /v1/auth/refresh` reads only the cookie), and **sessions cannot be
invalidated by rotating anything**. Compromise containment is:

| Scope | Mechanism | State |
|---|---|---|
| One session | `DELETE /v1/auth/sessions/:sessionId` | Implemented (pre-existing) |
| One user, all sessions | password change / completed recovery, in-transaction | Implemented (pre-existing) |
| One family | automatic reuse detection | Implemented (pre-existing) |
| Platform-wide | **operator SQL only — no API** | Documented, untested |

---

## 10. SMTP Credential Rotation Status

**Implemented (credential source) and documented (procedure); provider
validation blocked.**

- `SMTP_USERNAME` and `SMTP_PASSWORD` resolve through the shared runtime secret
  boundary, so both accept a direct value or a mounted file.
- The mailer stays **provider-agnostic**: it consumes a resolved `Config`,
  contains no provider SDK, and gained no provider-specific branch this sprint.
- File-backed SMTP credentials receive identical production validation
  (**test-proven**, §5).
- Rotation procedure — obtain replacement, update source, restart, validate
  authentication, validate real delivery, cut over, roll back, safe failure
  testing, log collection — is in
  `docs/rotation-runbook.md` §Rotate SMTP credentials.
- No real credential appears in any repository file, fixture, test, doc, or log.

The delivery-validation steps of that procedure are **blocked** on the same
missing provider access as ORG-PR-002.

---

## 11. External Email Provider Used

**None. Blocked.**

Availability was checked without exposing any value:

| Check | Result |
|---|---|
| Provider/SMTP variables in the execution environment | none present |
| Repository secrets (`gh secret list`) | empty |
| GitHub Actions environments (`gh api .../environments`) | `total_count: 0` |
| Verified sending domain | none exists |
| Test mailbox | none exists |

No provider was used, no message was sent externally, and no delivery claim is
made.

---

## 12. External Delivery Validation Matrix

Six account-email families exist. None was created or removed this sprint.

| Family | App generates | Provider accepts | Inbox receipt | Sender identity | Link token pattern | Raw token logged | Bulk/unsubscribe semantics |
|---|---|---|---|---|---|---|---|
| Registration completion | **Test-proven** | **Blocked** | **Blocked** | **Blocked** | fragment `#token=` — **test-proven** | never — **test-proven** | none emitted — **implemented** |
| Existing-account guidance | **Test-proven** | **Blocked** | **Blocked** | **Blocked** | no token at all — **test-proven** | n/a | none emitted |
| Password recovery | **Test-proven** | **Blocked** | **Blocked** | **Blocked** | fragment `#token=` — **test-proven** | never — **test-proven** | none emitted |
| Email verification | **Test-proven** | **Blocked** | **Blocked** | **Blocked** | fragment `#token=` — **test-proven** | never — **test-proven** | none emitted |
| Email-change verification | **Test-proven** | **Blocked** | **Blocked** | **Blocked** | fragment `#token=` — **test-proven** | never — **test-proven** | none emitted |
| Organization invitation | **Test-proven** | **Blocked** | **Blocked** | **Blocked** | **query string** `?token=` — deliberate Sprint 9 exception, **test-proven** | never — **test-proven** | none emitted |

Evidence classes are kept strictly separate:

- **Automated/local:** message generation, recipient, subject, link
  construction, header-injection rejection, and the full SMTP conversation
  (implicit-TLS handshake, AUTH, 5xx refusals) against an in-process fake
  server.
- **Manually validated (local sink only):** delivery to the Mailpit container —
  plaintext, unauthenticated, not a provider.
- **Provider acceptance:** blocked.
- **Inbox receipt:** blocked.

Provider acceptance is never inferred from local evidence, and inbox receipt is
never inferred from provider acceptance.

Bodies were reviewed for unintended secret content: they carry the product
name, the purpose, the link, an expiry timestamp, and an
ignore-if-unexpected line — plus, for invitations, the organization name and
role (already disclosed by the public inspect surface to any token holder). No
internal id, hash, password, or account-state disclosure. No
`List-Unsubscribe` or bulk header is emitted by any driver.

---

## 13. Real Inbox Validation Evidence

**None. Blocked** — no test mailbox exists in this environment. No message
was received, no headers were captured, and no screenshot or transcript is
offered. Any future evidence must come from the procedure in
`docs/rotation-runbook.md` §Validate external email delivery.

---

## 14. SPF / DKIM / DMARC Posture

**Blocked — no sending domain exists**, so nothing could be validated and
nothing is claimed.

| Item | Orgistry's part | Evidence |
|---|---|---|
| Sending domain | operator-chosen; production rejects reserved/non-routable senders | **Blocked** — none chosen |
| `From` address | `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | **Implemented**; production guard **test-proven** |
| `Reply-To` | not set — no reply address is emitted | **Implemented** (verified in `smtp-transport.ts`) |
| Envelope sender / return path | not set by Orgistry; supplied by the provider | **Blocked** |
| Provider sender verification | operator action | **Blocked** |
| SPF | operator DNS | **Blocked** |
| DKIM | operator DNS + provider signing | **Blocked** |
| DMARC | operator DNS | **Blocked** |

The full setup and validation procedure, including the `dig` commands, the
one-SPF-record and TTL/propagation caveats, and the instruction to treat a
received `Authentication-Results` header as authoritative over a provider
dashboard, is `docs/rotation-runbook.md` §Sender domain.

---

## 15. Sender Verification Status

**Blocked.** No provider account, no domain, no verification performed. The
production config guard does enforce the parts Orgistry controls
(**test-proven**): the shipped local-only sender and every reserved,
non-routable domain suffix are refused under `NODE_ENV=production`, and
`WEB_DEMO_URL` — embedded in every emailed link — must be HTTPS and
non-localhost.

---

## 16. Failure-Mode Validation

**Test-proven** against an in-process fake SMTP server
(`smtp-failure-redaction.test.ts`), with the complementary fail-closed
assertions in the pre-existing `smtp-account-mailer.test.ts`:

| Failure mode | Validated | Credential leaked |
|---|---|---|
| Invalid authentication (535) | Yes | No — message, stack, own properties all clean |
| Rejected sender (5xx on `MAIL`) | Yes | No |
| Rejected recipient (5xx on `RCPT`) | Yes | No |
| Connection refused (wrong host/port) | Yes | No |
| TLS/certificate failure | Yes | No |
| Connection timeout | Yes — real timeout against a silent listener | No |
| Temporary provider error (4xx) | **Documented only** — the fake server models permanent refusals | n/a |

Against a **real provider**: none of these were exercised — **blocked**. No
abusive or unsafe traffic was generated to manufacture provider errors.

Preserved in every case: fail-closed delivery, sanitized internal and public
errors, request-id propagation, a coarse failure category in logs, and the
established per-family transaction/commit semantics
(`docs/email-and-verification.md` §Delivery-failure policy) — unchanged by this
sprint.

---

## 17. Artifact Smoke Evidence

**Manually validated** — `bash tooling/artifact-smoke.sh` ran to
`SMOKE OK: all artifact checks passed.` on 2026-08-23 against the working tree.

Sprint 24 additions, all passing:

| Check | Result |
|---|---|
| Artifact boots with safe fake secrets mounted as files (`JWT_SECRET_FILE`, `SMTP_PASSWORD_FILE`) — `/health` 200 | pass |
| File-loaded secrets absent from container logs | pass |
| Unsafe file-loaded production secret rejected at boot, naming `JWT_SECRET`, without echoing it | pass |
| Ambiguous `JWT_SECRET` + `JWT_SECRET_FILE` refused, explaining the conflict, echoing neither value | pass |
| Missing secret file fails closed naming the path (not the contents) | pass |
| Neither image's config declares a secret-bearing variable (no build-time secret dependency) | pass |

Pre-existing checks still passing: both images build; one-shot migration exits
0; `NODE_ENV=production` boot; `/health` and `/ready`; coarse production
`/ready` body; fail-closed readiness on a Redis stop and recovery; web
production build + SPA fallback + baked public API base URL; server secrets
absent from web assets; non-root API and web runtimes; read-only application
tree; image hygiene; env-injected fake secrets absent from logs; structured
JSON logs with request ids; config-guard rejection of a direct development
secret; exit-0 SIGTERM shutdown; full teardown.

The harness remains **fully self-contained**: no real SMTP or provider
credential, no workspace install, no published image. The fake secret files are
created in a `mktemp -d` directory and removed on exit (including on failure,
via the `trap`) — no secret file is stored in the repository.

---

## 18. Local Validation Evidence

All commands executed on 2026-08-23 against the working tree.

| Command | Result |
|---|---|
| `pnpm validate` | **exit 0** — typecheck, ESLint, 914 unit tests (84 files), 78 web tests, web build, schema-drift check, whitespace check |
| `pnpm validate:integration` | **exit 0** — 82 integration tests (15 files) against live PostgreSQL + Redis |
| `git diff --check` | **exit 0** |
| `pnpm scan:deps` | **exit 0** — 1 high ignored (documented react-router RSC advisory), no others |
| `pnpm scan:deps:local` | **exit 0** — no issues; 1 filtered advisory; reports `GHSA-mh99-v99m-4gvg` as an unused ignore (pre-existing, unrelated to this sprint) |
| `pnpm scan:secrets` | **exit 0** — 39 commits scanned, no leaks |
| `actionlint` | **exit 0** |
| `tooling/artifact-smoke.sh` | **`SMOKE OK`** — every check passed, including the six new secret-source checks |

`pnpm validate:integration` required `DATABASE_URL`/`TEST_DATABASE_URL`
pointed at the alternate-port validation Postgres (`localhost:55432`) because
host port 5432 is held by an unrelated local Postgres. That is an environment
condition documented in `docs/runbook.md` §Handling port conflicts, not a
Sprint 24 defect.

Focused suites run during implementation:

```sh
pnpm vitest run packages/config
pnpm vitest run packages/config/src/secret-source.test.ts
pnpm vitest run packages/auth-core/src/access-token.test.ts
pnpm vitest run apps/api/src/modules/auth/jwt-secret-rotation.routes.test.ts
pnpm vitest run apps/api/src/modules/mail/smtp-failure-redaction.test.ts
pnpm vitest run apps/api/src/lib/logging.test.ts
```

---

## 19. Remote Validation Evidence

**PENDING OPERATOR ACTION — no Sprint 24 remote evidence exists.** This is one
of the two unsatisfied DoD gates.

The sprint's repository-safety rules prohibit committing and pushing, so these
changes have never reached GitHub and no workflow has run against them. The
latest remote evidence in this repository is Sprint 23's (`main` @ `6019db8`),
which predates every change here and **must not be read as Sprint 24
validation**.

`main` is protected by ruleset `19769611` with no bypass actors, so a direct
push to `main` is rejected — the changes must land through a pull request whose
six required checks pass.

**Step 1 — branch, stage, and commit (operator does this manually):**

```sh
git switch -c sprint-24-runtime-secrets
git add -A
git status                 # review the staged set before committing
git commit                 # write the message in your editor
git push -u origin sprint-24-runtime-secrets
```

**Step 2 — open the pull request (required by the ruleset):**

```sh
gh pr create --base main --head sprint-24-runtime-secrets \
  --title 'feat(config): runtime secret sources and access-token key rotation' \
  --body-file -    # or --web to compose in the browser
```

**Step 3 — watch the checks for the exact commit:**

```sh
SHA="$(git rev-parse HEAD)"

# Every run GitHub started for this commit.
gh run list --commit "$SHA" --limit 20 \
  --json workflowName,status,conclusion,databaseId

# Follow CI to completion (resolves the run id for this commit first).
CI_RUN_ID="$(gh run list --commit "$SHA" --workflow ci.yml --limit 1 \
  --json databaseId -q '.[0].databaseId')"
gh run watch "$CI_RUN_ID"

# Per-workflow conclusion for this commit.
for wf in ci.yml security.yml codeql.yml; do
  gh run list --commit "$SHA" --workflow "$wf" --limit 1 \
    --json workflowName,status,conclusion,databaseId
done

# Per-JOB conclusions inside the CI run — this is where the artifact gate shows
# up. (`gh run view --job` takes a numeric job ID, never a job name.)
gh run view "$CI_RUN_ID" --json jobs \
  -q '.jobs[] | "\(.name)\t\(.conclusion)"'

# Aggregate PR check state, i.e. exactly what the ruleset gates on.
gh pr checks
```

**Step 4 — confirm all four required surfaces are green** for that commit:

| Workflow (file) | Job / check name |
|---|---|
| CI (`ci.yml`) | `Validate (offline)`, `Integration (PostgreSQL + Redis)`, `Artifacts (build + smoke)` |
| Security scans (`security.yml`) | `Dependency audit (pnpm)`, `Secret scan (Gitleaks)` |
| CodeQL (`codeql.yml`) | `Analyze (javascript-typescript)` |

To read the artifact gate's log specifically, resolve its numeric job ID first:

```sh
ARTIFACT_JOB_ID="$(gh run view "$CI_RUN_ID" --json jobs \
  -q '.jobs[] | select(.name == "Artifacts (build + smoke)") | .databaseId')"
gh run view --job "$ARTIFACT_JOB_ID" --log
```

`Artifacts (build + smoke)` now additionally exercises the mounted secret-file
path; it needs no new credential, so **no workflow secret and no Actions
environment must be created** for Sprint 24.

Workflow definitions were reviewed and **not modified**: `ci.yml`,
`security.yml`, and `codeql.yml` keep their SHA-pinned actions, explicit
least-privilege `permissions:`, concurrency groups, `pull_request` (never
`pull_request_target`) triggers, and credential-free jobs.

Record the resulting run IDs and conclusions in this section once they exist.
Until then this gate stays PENDING OPERATOR ACTION and Sprint 24 stays open.

---

## 20. Documentation Index / Updates

New:

| Document | Contents |
|---|---|
| `docs/runtime-secrets.md` | Source model, direct-vs-file semantics, file safety, validation ordering invariant, secret inventory, placeholder convention, access-token rotation contract, refresh/session material findings, redaction guarantee table, restart behavior, known limitations, safe-extension guide |
| `docs/rotation-runbook.md` | Runtime injection, routine JWT rotation, emergency JWT rotation, session invalidation (incl. platform-wide operator SQL), SMTP rotation, database/Redis rotation, external email validation procedure, sender-domain/SPF/DKIM/DMARC procedure, provider incident handling, bad-mail-configuration rollback, safe log collection |
| `docs/production-readiness/sprint-24-artifact-package.md` | This artifact |

Updated:

| Document | Change |
|---|---|
| `README.md` | Sprint 24 summary; both new docs added to the authoritative index |
| `.env.example` | `_FILE` source model, `JWT_PREVIOUS_SECRET`, per-variable file alternatives |
| `docs/production-config-guard.md` | Resolution-before-validation invariant; `JWT_PREVIOUS_SECRET` rules; new module locations; ORG-PR-006 status corrected |
| `docs/deployment-artifacts.md` | Secret boundary extended with mounted files; env-contract rows for `JWT_PREVIOUS_SECRET` and `<NAME>_FILE`; smoke-test coverage |
| `docs/email-and-verification.md` | SMTP credential source; account-email family matrix; external-validation evidence table replacing the old procedure stub |
| `docs/security-model.md` | Access-token key rotation and runtime secret sources as stated invariants; limitations corrected |
| `docs/session-lifecycle.md` | Explicit "no secret backs the refresh credential" invariant and its consequences |
| `docs/credential-management.md` | SMTP credential source + per-user vs platform-wide invalidation |
| `docs/known-limitations.md` | Secret-management entry rewritten to what is now true and what is still missing; email entry extended with SPF/DKIM/DMARC and the acceptance-vs-receipt distinction |
| `docs/validation.md` | New smoke checks; SMTP failure-redaction suite; explicit "routine CI never consumes a real credential" policy |
| `docs/runbook.md` | Pointer to the new operational runbook |
| `infra/compose.production-like.yml` | Note that the file form is exercised by the smoke test, not checked in |
| `docs/production-readiness/README.md` | Sprint 24 status entry |
| `docs/production-readiness/findings-register.md` | ORG-PR-002 and ORG-PR-006 progress entries; summary-table rows |
| `docs/production-readiness/security-assessment.md`, `standards-matrix.md`, `production-roadmap.md`, `launch-checklist.md`, `production-scorecard.md`, `repository-inventory.md` | Sprint 24 state reconciled |

Engineering knowledge now captured: the validation-ordering invariant and why
it is the load-bearing property of file-backed secrets; why ambiguity fails
closed; why one terminal line ending is stripped and no more; why there is no
session secret and what that implies for incident response; the difference
between graceful and emergency key rotation; and why provider acceptance,
inbox receipt, and local SMTP evidence are three different facts.

---

## 21. Findings Reconciliation

**Finding closure is not a Sprint 24 DoD condition.** Every closure blocker
below is a production-readiness or finding-level gap; none of them is a missed
Sprint 24 deliverable, and none was retro-fitted into this sprint's scope. The
binding specification explicitly allows findings to remain honestly open.

### ORG-PR-002 — No production email provider

**OPEN — materially advanced (unchanged classification from Sprint 16;
advanced again in Sprint 24).**

Advanced this sprint: SMTP credentials flow through the runtime secret
boundary with identical production validation for file-backed values; every
representative provider failure mode is proven not to leak the credential; the
account-email family matrix is enumerated with explicit evidence classes; and a
precise, safe operator validation procedure now exists.

**Exact closure blocker:** no email-provider credentials, no verified sending
domain, and no readable test mailbox exist in this repository or any of its
validation environments (repository secrets empty; zero Actions environments).
Closure requires, at minimum: a real external send through a real provider,
provider acceptance evidence, real inbox receipt for the relevant families,
verified sender identity, documented provider/domain verification state, and
SPF/DKIM/DMARC verdicts from a received `Authentication-Results` header.
Procedure: `docs/rotation-runbook.md` §Validate external email delivery.

### ORG-PR-006 — No secrets management or rotation procedure

**OPEN — materially advanced.**

Delivered: a runtime secret-source boundary with direct-env and mounted-file
support, deterministic and test-proven semantics, resolution ordered before
production validation, graceful access-token key rotation with a two-key
verification window, redaction proofs across startup/config/SMTP/log paths,
artifact-level evidence from the packaged image, and written manual rotation
and emergency procedures.

**Why it does not close:** the finding's expected behavior is "secrets sourced
from a manager (or the platform's secret store), documented routine + emergency
rotation, and least-privilege access", and its validation criterion is a
*rehearsed* rotation. Missing: any secrets-manager or platform-store
integration; least-privilege secret access control; automated rotation,
scheduling, or expiry tracking; secret-access auditing; hot reload; a
`kid`/versioned-key scheme (ORG-PR-049); dual-credential support for
`DATABASE_URL`/`REDIS_URL`; and — decisively — a rehearsal against a real
deployment, which cannot happen until a deployment environment exists
(ORG-PR-001). File-based injection plus runbooks is not secrets management.

**These are ORG-PR-006 closure criteria and future production-maturity work —
not Sprint 24 DoD conditions.** The binding Sprint 24 rotation DoD asks for a
documented rotation model, an implemented-or-precisely-deferred JWT rotation,
documented refresh/session behavior, SMTP and emergency rotation procedures, a
session-invalidation procedure, and no overclaiming while rotation is manual.
All of those are satisfied (see the DoD reconciliation). It does **not** ask
for a secrets manager or a rehearsal against a deployed runtime, and this
document does not treat their absence as a sprint failure.

### ORG-PR-001 — No production deployment automation

**OPEN — unchanged.** No deployment environment, promotion path, rollback path,
registry publishing, or deployment automation was implemented; those were
explicitly out of scope. The Sprint 23 artifact evidence stands as recorded.

### ORG-PR-005 — No database backup / PITR / tested restore

**OPEN — unchanged.** Out of scope; nothing in this sprint touches it.

### ORG-PR-015 — No retention/cleanup for unbounded tables

**OPEN — unchanged.** Out of scope; nothing in this sprint touches it.

### ORG-PR-049 — HS256 symmetric JWT with no `kid`/rotation path

**OPEN — materially advanced.** Graceful rotation now exists via a two-key
verification window with test evidence, which is the finding's practical
motivation. The finding's literal remediation (a `kid` claim or asymmetric
signing) was deliberately not implemented: it changes the token format and is
only required if verification ever leaves the issuer, which it has not.

---

## 22. Remaining Risks

1. **No secrets manager.** Secrets live wherever the operator's platform puts
   them; there is no least-privilege access control or access audit.
2. **Every rotation is a restart.** A rotation executed wrongly (e.g. equal
   keys, an unmounted file) fails the process at boot — safe, but it is an
   availability event if applied to every instance at once.
3. **Production email is unproven.** A deployment could pass every guard and
   still fail to deliver a single message; sender-domain authentication is
   entirely unvalidated, so even a working provider could see mail filtered.
4. **No platform-wide session-invalidation API.** The most severe containment
   action is hand-written SQL with no test coverage.
5. **No dual-credential database rotation.** The old credential must remain
   valid across the restart window, which is a manual coordination step.
6. **Config validation does not prove entropy.** A weak-but-passing secret is
   still possible.
7. **No bounce, complaint, or suppression handling**, and no email queue or
   outbox — a provider outage silently loses best-effort messages.
8. **Everything downstream of a deployment remains absent** — environment,
   pipeline, rollback, backups, retention, observability.

---

## 23. Remaining P1 Blockers

`ORG-PR-001`, `ORG-PR-002`, `ORG-PR-005`, `ORG-PR-006` — four, unchanged. No P1
finding was closed this sprint. `ORG-PR-015` (P2) also remains open.

---

## 24. Final Readiness Classification

**C — Ready to continue production implementation.**

**Not ready for staging. Not ready for production.**

The evidence supports no other reading: four P1 production blockers remain
open, no deployment environment exists, and external email delivery is
unvalidated. Sprint 24 improved the runtime security posture of a system that
still cannot be deployed.

---

## 25. Recommended Next Sprint

**None yet — Sprint 24 is not closed.** The single outstanding Sprint 24 DoD
gate is post-change remote workflow validation (§19), so the immediate next
action is finishing Sprint 24, not starting anything new.

### Step 1 — close Sprint 24 (the only mandatory remaining work)

Commit, push, and open a PR for this working tree, then confirm CI, Security
scans, CodeQL, and `Artifacts (build + smoke)` are green for that exact commit
(§19). Record the run IDs there. That clears the last DoD gate, and this
document can then be finalized as the Sprint 24 closing artifact.

**Neither ORG-PR-002 nor ORG-PR-006 has to close first.** Sprint completion and
finding closure are separate; both findings remaining open is the honest,
specification-permitted outcome of this sprint.

### Step 2 — after Sprint 24 closes

**Sprint 25 — Backup, PITR, Restore, and Retention Foundation** (ORG-PR-005,
with the retention groundwork tracked by ORG-PR-015/016) is the expected next
production-readiness sprint. Its scope is unchanged; it is **not authorized to
begin** while Sprint 24's remote gate is outstanding.

Two workstreams run alongside it and are **not** absorbed into it:

- **ORG-PR-002 — external email validation (operator-blocked).** Provision
  provider credentials, a verified sending domain with SPF/DKIM/DMARC, and a
  readable test mailbox; execute `../rotation-runbook.md` §Validate external
  email delivery; record per-family acceptance/receipt and the
  `Authentication-Results` verdicts in §12–§14; then close the finding from that
  evidence. Until then Orgistry has **no evidence that production email works**.
- **ORG-PR-006 — residual secrets-management capability.** A secrets manager or
  platform secret store, least-privilege secret access, secret-access
  auditability, automated rotation and expiry tracking, and a rehearsed
  rotation against a real runtime (which needs ORG-PR-001's environment) all
  remain unbuilt. `<NAME>_FILE` support plus manual runbooks is a foundation,
  not secrets management. This is future scoped work — it was deliberately
  **not** retro-fitted into Sprint 24's requirements.
