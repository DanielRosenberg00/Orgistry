# Sprint 24 Artifact Package — Runtime Secrets and External Email Validation

> **Status: SPRINT 24 COMPLETE — DEFINITION OF DONE MET.** This is the official
> Sprint 24 closing artifact.
>
> Every mandatory DoD condition is satisfied, and the required post-change
> remote workflows are green for implementation commit **`de6780f`** on PR #33:
> CI (`32663739832`), CodeQL (`32663739811`), and Security scans
> (`32663739952`) — all seven required checks pass (§19).
>
> **Sprint completion is not production readiness, and it is not finding
> closure.** Both are deliberately separate, and both remain unchanged:
>
> - **ORG-PR-002 stays OPEN — materially advanced.** External SMTP provider
>   validation was **not performed**: no provider credentials, no verified
>   sending domain, no readable test mailbox. The binding specification permits
>   that DoD condition to be met by a *precisely documented blocker*, which it
>   is (§11–§14) — so it is not a failed deliverable, and it is equally not
>   evidence that production email works. **Orgistry has no evidence that
>   production email works.**
> - **ORG-PR-006 stays OPEN — materially advanced.** Sprint 24 delivered the
>   runtime secret-source and rotation foundation; a secrets manager,
>   least-privilege secret access, access auditability, automated rotation, and
>   a rehearsed real-runtime rotation remain unbuilt. `<NAME>_FILE` support plus
>   manual runbooks is a foundation, **not** a secrets-management platform.
> - **Readiness stays `C — Ready to continue production implementation`. NOT
>   ready for staging. NOT ready for production.** Four P1 blockers remain open
>   (ORG-PR-001/002/005/006), plus ORG-PR-015 (P2).
>
> Getting here took three commits and two remote failures, both of them
> **Linux-only portability defects in validation fixtures** — never in the
> application, and neither fixed by weakening the production security model. The
> full chain is preserved in §17 as evidence that the validation system worked.
>
> **One nuance about this document.** The green evidence above belongs to
> `de6780f`. This closing pass is documentation-only and will itself become a
> later commit, which has **not** run through CI at the time of writing. Sprint
> 24's repository closure is fully sealed once that documentation commit also
> shows green required checks; the implementation DoD result above does not
> depend on it.

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
  remains. *(No condition carries this status at closure.)*
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
| Post-change remote status (CI, Security, CodeQL, Artifacts) | **PASS** — all seven required checks green for `de6780f`: CI `32663739832`, CodeQL `32663739811`, Security scans `32663739952` (§19) |

### Result

**34 PASS · 2 SATISFIED BY EXPLICIT EXTERNAL BLOCKER · 0 PENDING OPERATOR
ACTION · 0 FAIL/MISSING.**

**SPRINT 24 DEFINITION OF DONE: MET.** No condition failed, nothing is
outstanding, and the required remote workflows are green for `de6780f` (§19).

The two `SATISFIED BY EXPLICIT EXTERNAL BLOCKER` entries are the real external
SMTP provider validation and the actual SPF/DKIM/DMARC verdicts. To be
unambiguous about what that status does and does not mean:

| It means | It does NOT mean |
|---|---|
| The DoD allowed this condition to be met by completing the validation **or** documenting the blocker precisely, and the blocker is documented precisely (§11–§14). | ✗ Provider validation passed. |
| Every repository-side prerequisite within Sprint 24's scope is implemented and tested. | ✗ Real delivery was proven. |
| The exact missing external resources and the exact evidence still required are named, with an executable operator procedure. | ✗ ORG-PR-002 is closed — it stays **OPEN — materially advanced**. |

Reaching this took three commits. Two remote runs each exposed a genuine
Linux-only portability defect in a **validation fixture** — first the artifact
smoke harness, then one SMTP unit test — each fixed without weakening the
production security model, and the full chain is preserved in §17. The
validation system doing its job is the point of that history, not noise.

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

**Manually validated** — `bash tooling/artifact-smoke.sh` exits 0 with
`SMOKE OK: all artifact checks passed.` (2026-08-23, re-run after the Linux
portability fix below).

### Remote CI history for this gate

Sprint 24 landed over three commits on PR #33. Each remote run is recorded
because the progression is itself evidence: two Linux-only portability defects
existed in **validation fixtures**, CI caught both, and neither was masked or
worked around.

| # | Commit | CI run | Validate | Integration | Artifacts | Security | CodeQL |
|---|---|---|---|---|---|---|---|
| 1 | `74f50e4` | `32656512688` **failure** | pass | pass | **FAIL** | pass (`32656512690`) | pass (`32656512661`) |
| 2 | `486bee8` | `32657860558` **failure** | **FAIL** | pass | pass | pass (`32657860599`) | pass (`32657860565`) |
| 3 | `de6780f` | `32663739832` **success** | pass | pass | pass | pass (`32663739952`) | pass (`32663739811`) |

Commit 1 was the implementation; commits 2 and 3 were the two fixture fixes
below. `de6780f` is the final, fully remote-validated implementation commit.

**Neither defect was a production application failure.** Both were portability
bugs in test fixtures — one in the smoke harness, one in a unit test — and in
the first case the application behaved exactly as designed, failing closed with
a sanitized error. Neither fix weakened the production security model: the API
artifact still runs non-root, mounted secrets are still read-only, and no
assertion was removed or loosened.

### Defect 1 — Linux secret-directory permissions (fixed; green remotely from `486bee8`)

The first remote run of this gate **failed** — PR #33, CI run `32656512688`,
job `Artifacts (build + smoke)` — at the first Sprint 24 step:

```text
== Artifact boots with runtime secrets mounted as files (_FILE)
SMOKE FAIL: http://localhost:3010/health did not return 200 within 30s
```

Every other check in that run passed, and every other required workflow was
green. The defect was in the **test fixture**, not in the application.

**Root cause (confirmed by reproduction, not inferred).** `mktemp -d` creates
the directory mode **0700** owned by the invoking user — uid 1001 (`runner`) on
a GitHub Actions runner. The API artifact runs as the non-root `node` user, uid
**1000**. On Linux a bind mount passes the host inode through unchanged, so uid
1000 could not **traverse** the directory; both secret files were unreadable,
`loadConfig` refused to boot, and the container exited before `/health` existed.
Reproduced by mounting a Docker volume populated with that exact ownership and
mode, which produced the CI symptom verbatim:

```text
Failed to start API: ConfigValidationError: Invalid configuration:
  - JWT_SECRET_FILE: the secret file "…/jwt_secret" does not exist or is not
    accessible to this process
```

Note that the application behaved **correctly**: it failed closed and its error
named the variable and path without echoing any content.

**Why it passed locally.** Docker Desktop on macOS remaps bind-mount ownership
to the requesting container user — a 0700 host directory owned by `501:20` is
presented to the container as `1000:1000` and reads fine. Verified in both
directions on this machine, so a macOS-only test can never catch this class of
defect.

**Fix.** `tooling/artifact-smoke.sh` now sets explicit fixture permissions
after creating the temporary files — directory `0755` (traversal only) and
files `0444` (read-only for everyone) — with a comment recording why they must
not be deleted as "unnecessary" by someone testing only on Docker Desktop.
`chown` is not usable: the harness runs unprivileged and cannot give files to
uid 1000. Verified under genuine Linux semantics: with the files still owned by
uid 1001 and the runtime still uid 1000, `/health` returns 200.

The API artifact remains non-root, the mounted files remain read-only, the
application's secret-file safety rules are unchanged, and no assertion was
removed or weakened.

**Diagnostics added.** A boot failure in this standalone check now prints the
container status and exit code, the host fixture's modes, and the container's
logs with every fake secret value masked, before failing. On a passing run it
prints nothing. One assertion was also tightened: the unsafe-file-secret check
now matches the production guard's own message
(`JWT_SECRET is a known development-only default`) instead of the bare string
`JWT_SECRET`, which a permission error mentioning `JWT_SECRET_FILE` could have
satisfied — so a mount failure can no longer masquerade as a guard rejection.

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

### Defect 2 — SMTP timeout test bound IPv4, dialled `localhost` (fixed; green remotely from `de6780f`)

CI run `32657860558` (`486bee8`) had `Artifacts (build + smoke)` green but
`Validate (offline)` red: **913 of 914 unit tests passed**, with one failure in
`apps/api/src/modules/mail/smtp-failure-redaction.test.ts` →
*connection timeout (unresponsive provider endpoint)*. The runner reported
`connect ECONNREFUSED ::1:<ephemeral-port>` where the test asserts the error
contains `timeout`.

**Root cause (confirmed by reproduction).** The fixture's silent listener binds
IPv4 loopback only (`server.listen(0, '127.0.0.1', …)`), while the shared
`mailer()` helper dialled `host: 'localhost'` — so the test was never
endpoint-deterministic. On a dual-stack Linux host `localhost` resolves to
`::1` first, and **nodemailer resolves the hostname itself rather than handing
the name to `net.connect`** (`resolveHostname` in
`nodemailer/lib/shared/index.js`), so Node's happy-eyeballs behavior does not
apply the way it does to a plain `net.connect('localhost')`. The runner's
client reached the empty IPv6 loopback and was refused instead of reaching the
intentionally silent listener.

This test is the one that surfaced it because its budget is 300 ms rather than
the suite's usual 5 s; the sibling cases against the same IPv4-only fixture
stayed green. The precise interaction between address ordering and that short
budget was not pinned down and does not need to be — the fix removes the
ambiguity entirely by dialling the address the listener actually bound.

Demonstrated under Linux Node 22 against an IPv4-only silent listener:

```text
host=::1       -> connect ECONNREFUSED ::1:41599   # the CI failure
host=127.0.0.1 -> Connection timeout               # the intended path
```

This was a **test-fixture address-family mismatch**. No SMTP application
behavior, transport configuration, timeout logic, or redaction code was
involved or changed.

**Fix.** `startSilentListener` now returns the address it actually bound, and
`mailer()` takes an optional `host` defaulting to `localhost`; only the timeout
case passes the listener's literal address. The other five cases — rejected
authentication, rejected sender, rejected recipient, connection refused, and
untrusted certificate — deliberately keep `localhost`, because the TLS fixture
certificate certifies that name. The assertion was **not** loosened to accept
`ECONNREFUSED`; doing so would have destroyed the test's purpose.

**Verified behavior, not just the assertion:** the listener accepts 1 socket
(so the connection genuinely succeeds), the failure arrives at ~307 ms against
a 300 ms budget, the message is `Connection timeout`, and `ECONNREFUSED` is
absent. The suite passed 5 consecutive runs.

**Remote status: resolved.** `Validate (offline)` passes for `de6780f`
(CI run `32663739832`), alongside every other required check.

---

## 18. Local Validation Evidence

All commands below were executed on 2026-08-23 against the working tree that
became **`de6780f`** — i.e. after both fixture fixes. They were **not** re-run
during the documentation-only closing pass that produced this section's final
wording; that pass ran only `git diff --check`, `pnpm scan:secrets`, and
`actionlint` (all exit 0).

| Command | Result |
|---|---|
| `pnpm validate` | **exit 0** — typecheck, ESLint, 914 unit tests (84 files), 78 web tests, web build, schema-drift check, whitespace check |
| `pnpm validate:integration` | **exit 0** — 82 integration tests (15 files) against live PostgreSQL + Redis |
| `git diff --check` | **exit 0** |
| `pnpm scan:deps` | **exit 0** — 1 high ignored (documented react-router RSC advisory), no others |
| `pnpm scan:deps:local` | **exit 0** — no issues; 1 filtered advisory; reports `GHSA-mh99-v99m-4gvg` as an unused ignore (pre-existing, unrelated to this sprint) |
| `pnpm scan:secrets` | **exit 0** — 39 commits scanned, no leaks |
| `actionlint` | **exit 0** |
| `tooling/artifact-smoke.sh` | **exit 0, `SMOKE OK`** — 26/26 steps, including the six new secret-source checks |

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

**PASS — all required checks are green for the final implementation commit.**

**Validated commit: `de6780f`** (PR #33, `sprint-24-runtime-secrets`).

| Workflow | Run ID | Conclusion |
|---|---|---|
| CI | `32663739832` | success |
| CodeQL | `32663739811` | success |
| Security scans | `32663739952` | success |

All seven required checks pass — verified via `gh pr checks 33` and
`gh run list --commit de6780f`:

| Required check | Result |
|---|---|
| CI / Validate (offline) | pass |
| CI / Integration (PostgreSQL + Redis) | pass |
| CI / Artifacts (build + smoke) | pass |
| Security scans / Dependency audit (pnpm) | pass |
| Security scans / Secret scan (Gitleaks) | pass |
| CodeQL / Analyze (javascript-typescript) | pass |
| CodeQL (rollup) | pass |

`0 failing · 0 pending · 0 cancelled · 0 skipped · 7 successful.`

The two earlier failing runs are retained in §17 as the Sprint 24 CI evidence
chain; they are historical, not current status.

`Artifacts (build + smoke)` exercises the mounted secret-file path and required
**no** workflow secret and **no** Actions environment — routine CI remains
credential-free.

Workflow definitions were reviewed and **not modified** during Sprint 24:
`ci.yml`, `security.yml`, and `codeql.yml` keep their SHA-pinned actions,
explicit least-privilege `permissions:`, concurrency groups, `pull_request`
(never `pull_request_target`) triggers, and credential-free jobs.

### Scope of this evidence

The green result above belongs to **`de6780f`, the final implementation
commit**. This closing artifact is a documentation-only change made after that
commit, so it will become a **later commit that has not yet run through CI**.

- **Sprint 24's implementation DoD is MET** on the evidence of `de6780f`; that
  does not change when documentation is added.
- **Repository closure is fully sealed** once the closing-documentation commit
  also shows green required checks.

`main` is protected by ruleset `19769611` with no bypass actors, so the
documentation commit lands the same way: pushed to the existing branch, merged
through PR #33 after its checks pass.

```sh
git switch sprint-24-runtime-secrets   # PR #33 branch; upstream already set
git diff                               # review the closing documentation
git add -A
git status                             # review the staged set
git commit                             # write the message in your editor
git push                               # updates PR #33

SHA="$(git rev-parse HEAD)"
gh run list --commit "$SHA" --limit 20 \
  --json workflowName,status,conclusion,databaseId
CI_RUN_ID="$(gh run list --commit "$SHA" --workflow ci.yml --limit 1 \
  --json databaseId -q '.[0].databaseId')"
gh run watch "$CI_RUN_ID"
gh run view "$CI_RUN_ID" --json jobs -q '.jobs[] | "\(.name)\t\(.conclusion)"'
gh pr checks 33
```


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

**Sprint completion is not production readiness.** Sprint 24's DoD being met
says the sprint's own deliverables were completed and validated; it says
nothing about launch clearance. Nothing in this document should be read as
staging or production readiness.

---

## 25. Recommended Next Sprint

Sprint 24 is complete, so the roadmap may advance.

### Sprint 25 — Backup, PITR, Restore, and Retention Foundation

The expected next production-readiness sprint. Primary focus:

- **ORG-PR-005** — automated backups, point-in-time recovery, and a **tested
  restore drill** (the mandatory launch gate: a restore that reconstructs the
  database to a target timestamp and then passes readiness and integration
  checks);
- **ORG-PR-015** — retention/cleanup foundation for the unbounded tables, to
  the extent the Sprint 25 specification authorizes it. Note that enforcement
  depends on a background runtime (ORG-PR-016), which does not exist.

Not started here, and not scoped further by this document.

### Sprint 24 residuals that Sprint 25 does NOT absorb

These stay visible as outstanding production-readiness work and must not be
quietly folded into the next sprint or treated as closed:

| Residual | Status | What closure needs |
|---|---|---|
| **ORG-PR-002** — external production email | OPEN — materially advanced | Operator-provided provider credentials, a verified sending domain with SPF/DKIM/DMARC, and a readable test mailbox; then execute [`../rotation-runbook.md` §Validate external email delivery](../rotation-runbook.md#validate-external-email-delivery) and record per-family provider-acceptance and inbox-receipt evidence plus `Authentication-Results` verdicts in §12–§14 |
| **ORG-PR-006** — complete secrets management | OPEN — materially advanced | A secrets manager or platform secret store, least-privilege secret access control, secret-access auditability, automated rotation and expiry tracking, and a rehearsed rotation against a real runtime (which needs ORG-PR-001's environment) |

Both are genuine production-readiness gaps. Sprint 24 closing with them open is
the specification-permitted outcome, not an oversight — and neither is evidence
of readiness.

### Remaining P1 blockers after Sprint 24

Sprint completion changes none of these:

| Finding | Sev | Status |
|---|---|---|
| ORG-PR-001 — production deployment automation, environment, promotion, rollback | P1 | Open |
| ORG-PR-002 — external production email validation | P1 | Open — materially advanced |
| ORG-PR-005 — backup / PITR / tested restore | P1 | Open |
| ORG-PR-006 — complete secrets management and rotation capability | P1 | Open — materially advanced |
| ORG-PR-015 — retention/cleanup for unbounded tables | P2 | Open |

**Orgistry is `C — Ready to continue production implementation`. It is NOT
ready for staging and NOT ready for production.**
