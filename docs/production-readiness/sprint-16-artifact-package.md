# Sprint 16 Artifact Package — Production Email and Email Verification

```text
Sprint status: COMPLETE (repository scope)
External-provider delivery validation: NOT PERFORMED (no credentials available)
```

| Dimension | State |
| --- | --- |
| Engineering | Account-mailer boundary + nodemailer production SMTP driver + full email-verification lifecycle implemented and tested |
| Sprint | All repository-executable Definition-of-Done items satisfied; hardening refinement applied (§23) |
| Findings | ORG-PR-024 and ORG-PR-048 closed; ORG-PR-002 materially advanced, still open |
| Validation state | `pnpm validate`, `pnpm validate:integration`, `git diff --check` all exit 0 (see §13) |

Executed 2026-07-18 against `main` in three same-day passes: implementation
close, a security/transport hardening refinement (§23), and a final evidence
audit. **Git state, honestly:** the working tree is NOT clean — it carries the
uncommitted Sprint 14/15 production-readiness work plus all Sprint 16
implementation and documentation changes. Exactly one commit exists for
Sprint 16: `0aff351` (HEAD), containing ONLY the generated migration `0008`
(the schema-drift gate requires committed migrations); every other Sprint 16
change is uncommitted. No commit was created during the refinement or
completion passes, nothing was amended or rewritten, and nothing was pushed.
Committing the sprint is deliberately left to the repository owner.

---

## 1. Implementation summary

- **One reusable account-email boundary** (`apps/api/src/modules/mail/`):
  feature modules render a plain-text `AccountEmail`; the mailer owns sender
  identity, transport, and timeout. Invitations were migrated onto it;
  verification uses it; future recovery/security emails are intended to.
- **Three explicit drivers** selected deterministically by `MAIL_DRIVER`:
  `mailpit` (local dev sink, plaintext), `smtp` (production driver: SMTP over
  implicit TLS with certificate/hostname verification, SASL auth negotiated
  from server capabilities, bounded timeouts, construction-time validation,
  no credential logging; nodemailer transport since the §23 refinement),
  `memory` (in-memory capture for tests). No fallback chain.
- **Fail-closed production mail config** (extends the Sprint 15 guard):
  production refuses non-`smtp` drivers, missing/placeholder SMTP credentials,
  local-only/reserved-domain senders, and non-HTTPS/localhost public web URLs.
- **Complete email-verification lifecycle**: authenticated request/resend
  (current user's stored email only), public completion by raw-token
  possession (token in the request body), hash-only 32-byte CSPRNG tokens,
  24 h expiry, single-use transactional consumption under `FOR UPDATE`,
  resend invalidation, sibling invalidation, best-effort automatic first
  email after registration, Redis-backed rate limits, sanitized security
  events.
- **Web demo**: advisory unverified-email banner with resend states, public
  `/auth/verify-email` completion route (token captured once from the URL
  fragment into transient memory, fragment removed from URL/history, POSTed
  exactly once), current-user refresh after success.
- **Security hardening refinement (§23)**: fragment-based verification links
  (`#token=`, never a query string — the token is not sent in the initial
  HTTP request), a central CR/LF/NUL header-injection guard enforced in
  production code on every delivery, the nodemailer transport replacement,
  and an explicit SMTP/database consistency contract.
- **Advisory policy**: nothing anywhere gates on `emailVerified` in v1.

## 2. Findings closed or materially advanced

| Finding | Status | Basis |
| --- | --- | --- |
| ORG-PR-024 — No email verification | **CLOSED** | Complete lifecycle implemented, active, lifecycle-tested (unit + DB integration incl. concurrency). Resolution line in the [findings register](findings-register.md#org-pr-024). |
| ORG-PR-048 — Dead `email_verification_tokens` schema | **CLOSED** | Table is active product behavior; migration `0008` adds `invalidated_at` for explicit consumed-vs-retired semantics. |
| ORG-PR-002 — No production email provider | **OPEN — materially advanced** | Adapter, driver selection, and fail-closed config exist and are tested; **external-provider delivery was NOT validated** (no credentials/sandbox inbox in the environment). Adapter existence is not delivery evidence. |

## 3. Files changed

**Configuration**
- `packages/config/src/schema.ts` — `MAIL_DRIVER`, `MAIL_FROM_EMAIL`,
  `MAIL_FROM_NAME`, `MAIL_TIMEOUT_MS`, `SMTP_HOST/PORT/USERNAME/PASSWORD`,
  `EMAIL_VERIFICATION_TTL_SECONDS`, `RATE_LIMIT_EMAIL_VERIFICATION_*`.
- `packages/config/src/mail-policy.ts` — NEW: driver-conditional completeness.
- `packages/config/src/production-policy.ts` — production mail rejections.
- `packages/config/src/index.ts` — `Config.mail`, `Config.emailVerification`,
  `rateLimit.emailVerification`.
- `.env.example` — mail/SMTP/verification sections (safe placeholders only).
- `apps/api/src/testing/build-test-app.ts` — test config selects `memory`.

**Mailer**
- `apps/api/src/modules/mail/account-mailer.ts` — NEW: types + central
  header-injection guard (serialization moved to nodemailer in §23).
- `apps/api/src/modules/mail/smtp-transport.ts` — NEW (§23): shared
  nodemailer transport + policy layer. (The initial sprint pass shipped a
  hand-rolled `smtp-delivery.ts`, removed by the refinement.)
- `apps/api/src/modules/mail/mailpit-account-mailer.ts` — NEW: local driver.
- `apps/api/src/modules/mail/smtp-account-mailer.ts` — NEW: production driver.
- `apps/api/src/modules/mail/account-mailer-factory.ts` — NEW: selection.
- `apps/api/src/modules/mail/testing/in-memory-account-mailer.ts` — NEW.
- `apps/api/src/modules/mail/testing/fake-smtp-server.ts` — NEW (tests).
- `apps/api/src/modules/mail/testing/tls-fixtures.ts` — NEW: test-only
  self-signed localhost certificate (public by design; not a credential).
- REMOVED: `invitation.mailpit-mailer.ts` (+ test),
  `testing/in-memory-invitation-mailer.ts` (superseded by the shared module).

**Authentication and verification**
- `apps/api/src/modules/auth/email-verification.{service,repo,routes,types,errors,email,token}.ts` — NEW.
- `apps/api/src/modules/auth/security-events.ts` — three
  `auth.email_verification_*` event types.
- `apps/api/src/modules/auth/auth.types.ts` — `RegistrationEmailVerification`
  port (best-effort by contract).
- `apps/api/src/modules/auth/auth.service.ts` — post-commit best-effort first
  verification email on register.
- `apps/api/src/modules/invitations/invitation.mailer.ts` — now a pure
  renderer producing an `AccountEmail`.
- `apps/api/src/modules/invitations/invitation.service.ts` — depends on
  `AccountMailer`.
- `apps/api/src/{app,server}.ts` — wiring (`emailVerificationService`,
  shared `accountMailer`).

**Database and migrations**
- `packages/db/src/schema/auth.ts` — `invalidated_at` column + lifecycle
  documentation; scaffolding comments retired.
- `packages/db/migrations/0008_many_molly_hayes.sql` (+ snapshot/journal) —
  `ALTER TABLE email_verification_tokens ADD COLUMN invalidated_at
  timestamp with time zone;` (committed as `0aff351`; drift check clean).
- `packages/db/src/index.ts`, `src/schema/index.ts` — row/insert type exports.

**Contracts**
- `packages/contracts/src/auth.ts` — request/complete schemas + types.
- `packages/contracts/src/error-codes.ts` — three verification codes.
- `packages/contracts/src/index.ts` — exports.

**Frontend**
- `apps/web-demo/src/pages/VerifyEmailPage.tsx` — NEW.
- `apps/web-demo/src/components/EmailVerificationBanner.tsx` — NEW.
- `apps/web-demo/src/auth/{auth-context.ts,AuthProvider.tsx}` — `refreshUser`.
- `apps/web-demo/src/{App.tsx,components/AppShell.tsx}` — route + banner.

**Tests** — see §12. **Documentation** — see §15.

## 4. API surfaces added or changed

- `POST /v1/auth/email-verification/request` (Bearer; no body) →
  `{ ok, data: { sent, alreadyVerified } }`. Also the resend endpoint.
- `POST /v1/auth/email-verification/complete` (public; body `{ token }`) →
  `{ ok, data: { verified: true } }`; errors
  `EMAIL_VERIFICATION_TOKEN_INVALID` 404 / `…_EXPIRED` 410 / `…_USED` 409.
- Current-user contract unchanged in shape: `authUserSchema.emailVerified`
  already existed and is now live behavior (`emailVerifiedAt !== null`).
- No other route, envelope, or DTO changed.

## 5. Mailer architecture

See [docs/email-and-verification.md](../email-and-verification.md) for the
full design. Key decisions: one narrow boundary (no notification platform, no
event bus, no template framework, no HTML layer); implicit TLS only (STARTTLS
deliberately absent, documented); delivery-failure policy is caller-owned
(invitations and explicit resend fail-closed; post-registration best-effort).
The initial sprint pass extended the Sprint 9 hand-rolled SMTP client; the
**refinement iteration (§23) replaced that protocol implementation with
nodemailer** — Orgistry keeps only a thin policy layer (`smtp-transport.ts`:
header-injection guard, TLS posture, timeouts, append-only CA seam,
no-logging rule) around the mature transport.

## 6. Email configuration summary

| Variable | Default | Notes |
| --- | --- | --- |
| `MAIL_DRIVER` | `mailpit` | `mailpit \| smtp \| memory`; production requires `smtp` |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | `no-reply@orgistry.local` / `Orgistry` | production rejects local-only/reserved senders |
| `MAIL_TIMEOUT_MS` | `10000` | socket timeout per delivery |
| `SMTP_HOST/USERNAME/PASSWORD` | unset | required iff `MAIL_DRIVER=smtp` (any mode) |
| `SMTP_PORT` | `465` | SMTPS (implicit TLS) |
| `EMAIL_VERIFICATION_TTL_SECONDS` | `86400` | token lifetime |
| `RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_USER_MAX` | `3` | shared auth window |
| `RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_IP_MAX` | `10` | |
| `RATE_LIMIT_EMAIL_VERIFICATION_COMPLETE_PER_IP_MAX` | `10` | also throttles invalid submissions |

No deprecated duplicates; no committed real credential; `WEB_DEMO_URL` remains
the single public-web-URL source for emailed links.

## 7. Verification token security model

32-byte CSPRNG raw tokens (`generateOpaqueToken`) stored ONLY as SHA-256
hashes behind a unique index (same primitives and lookup pattern as refresh,
invitation, and API-key secrets — no second token model). Raw token exists
transiently in server memory, the emailed link, the web route, and the POST
body; never in the DB, logs, events, API responses, backend URL paths,
frontend storage, or fixtures. Two terminal timestamps: `used_at` (consumed)
vs `invalidated_at` (retired unused) — never overloaded. Completion is
transactional under `SELECT … FOR UPDATE` with a conditional
(`email_verified_at IS NULL`) user update; the integration suite fires two
concurrent completions and asserts exactly one 200 and one 409.

## 8. Registration and invitation integration

Registration (standard and invitation-token) is byte-for-byte transactionally
unchanged; new users start unverified; the first verification email is sent
best-effort AFTER commit (failure recorded as a sanitized event; resend
available; proven by a failing-mailer test that still returns 201).
Invitations now deliver through the shared boundary with identical fail-closed
semantics; the full invitation suite (31 route + integration tests) passes
unchanged apart from the renamed capture helper. Invitation receipt is NOT
treated as email-ownership proof. Demo-seeded users register through the real
API and therefore start unverified (advisory policy: nothing blocked).

## 9. Rate-limit summary

Reuses the existing Redis fixed-window infrastructure (fail-open) with three
new buckets (values above): `rl:email-verification:request:user:<id>`,
`rl:email-verification:request:ip:<ip>`,
`rl:email-verification:complete:ip:<ip>`. Keys/metadata never contain the
submitted token; exceedance emits the standard `auth.rate_limit_exceeded`
event and `RATE_LIMITED` envelope (tested).

## 10. Security-event summary

`auth.email_verification_requested` (`{ delivered, trigger? }`),
`auth.email_verification_succeeded` (user-attributed),
`auth.email_verification_failed` (`{ reason }`, unattributed — the token
proved nothing). All metadata passes `sanitizeSecurityMetadata`; tests assert
the absence of raw tokens, hashes, and verification URLs across all recorded
events.

## 11. Web demo summary

Advisory banner (unverified users; resend with pending/sent/rate-limited/
failure states; backend-derived visibility) and the public
`/auth/verify-email` page (single capture → URL scrub → one POST →
loading/success/invalid/expired/used/missing/failure states → current-user
refresh). No client-side authorization rules were added; no token persistence.

## 12. Tests (final state, including the §23 refinement)

Sprint 16 test surface as it exists at closure:

- `packages/config/src/config.test.ts` — 39 total (+19 this sprint): driver
  defaults, no-credential local/test modes, smtp completeness, driver
  rejection matrix in production, placeholder SMTP password rejection (and no
  length floor), sender/web-URL rejections, rate-limit bucket defaults, no
  secret echo.
- `apps/api/src/modules/mail/` — 27 tests across three files: the central
  header-injection guard (sender name/email, recipient, subject,
  organization-name-in-subject; lone CR/LF/NUL; no value echo); factory
  selection + production refusals; nodemailer interop against the in-process
  fake server for both drivers — real implicit-TLS handshake with
  authentication (AUTH PLAIN directly evidenced), credential-redacted
  failures, 5xx refusals, untrusted-certificate rejection, plaintext-server
  refusal, non-ASCII encoded-word subjects, driver-level injection refusal,
  construction-failure matrix.
- `apps/api/src/modules/auth/email-verification.routes.test.ts` — 21 tests:
  the full request/resend/complete matrix (hash-only storage, response
  redaction, fragment link + no `?token=`, resend invalidation + stale-token
  409, expiry, unknown-token 404, disabled-account 404 indistinguishability,
  sibling invalidation, reuse, rate limits, sanitized events, registration
  integration incl. best-effort failure) plus the §23 consistency contract
  (failed resend preserves the delivered link; persistence-failure window;
  successful replacement).
- `apps/api/src/modules/auth/email-verification.integration.test.ts` — 6
  DB-backed tests incl. the concurrent double-completion race and durable
  event sanitization.
- `apps/web-demo/src/test/email-verification.test.tsx` — 15 tests: banner
  states + resend wiring, completion route states, single POST, token never
  in storage/DOM/query-string/API URLs, fragment scrubbed from the visible
  URL, current-user refresh.
- `packages/contracts/src/auth.test.ts` — +4 contract-shape tests.
- Updated: invitation suites to the shared in-memory account mailer
  (`lastLinkToken`), `invitation.mailer.test.ts` to the renderer API.

## 13. Validation evidence (final, completion pass 2026-07-18)

Commands run without output pipelines; exit codes captured directly:

```text
pnpm validate               EXIT 0
pnpm validate:integration   EXIT 0
git diff --check            EXIT 0
```

Exact counts from the command output (no double counting):

```text
Offline validation (pnpm validate):
- backend + packages unit tests (root vitest run): 569 tests / 56 files
- web-demo tests (separate vitest run):             34 tests /  6 files
  (the 569 does NOT include the 34 — different runners)
- plus: typecheck (7 projects), lint, web build, schema-drift clean,
  whitespace clean

Integration validation (pnpm validate:integration; counted separately,
never part of the offline totals):
- DB (packages/db):   13 tests / 1 file
- API (apps/api):     44 tests / 9 files
- Total integration:  57 tests
```

Environment note: local port 5432 is held by an unrelated PostgreSQL, so
integration runs used a temporary container (`orgistry-pg-sprint16`, host
port 5434) with `DATABASE_URL`/`TEST_DATABASE_URL` pointed at it — an
environment workaround, not an implementation issue. The container was
**removed after the final run** (verified absent). One unrelated
single-occurrence flake was observed during the sprint
(`audit.routes.test.ts`, module untouched) and passed on every re-run.

Live local delivery evidence: a verification-shaped email was sent through
the REAL Mailpit driver (nodemailer transport) to the running Mailpit
container and read back via Mailpit's HTTP API
(`Verify your email address for Orgistry` →
`sprint16-live-check-…@example.com`).

## 14. External provider validation status

**Not performed — not claimed.** No provider credentials or sandbox inbox
exist in this environment. What remains: one live send through a real
provider to a real external inbox, evidenced by provider/message-id. The
exact safe procedure is documented in
[email-and-verification.md §External provider validation](../email-and-verification.md#external-provider-validation).
Until executed, ORG-PR-002 stays open.

## 15. Documentation index

**Authoritative current documentation** (owns the stated knowledge):

| Document | Owns |
| --- | --- |
| [`docs/email-and-verification.md`](../email-and-verification.md) | The Sprint 16 design reference: mailer boundary + drivers, transport capabilities and their evidence, header safety, verification lifecycle, fragment link transport and its honest protection scope, SMTP/DB consistency contract, stable invariants, testing guide, external-provider validation procedure. |
| `docs/production-config-guard.md` | Production configuration rejection rules, incl. the Sprint 16 mail rules. |
| `docs/security-model.md` | The security posture summary (verification section: tokens, fragment transport, resend semantics, header-injection guard, enumeration safety, advisory policy). |
| `docs/api-surface.md`, `docs/api-conventions.md` | Route table + error-code catalog incl. the two verification endpoints and three error codes. |
| `docs/known-limitations.md` | The honest scope boundary (external delivery unproven, implicit-TLS only, no bounce/complaint/suppression, advisory policy). |
| `docs/validation.md`, `docs/evaluation-guide.md` | What the suites prove and current test counts. |
| `docs/web-demo.md`, `docs/demo-walkthrough.md`, `docs/local-development.md`, `docs/troubleshooting.md`, `docs/invitations.md`, `docs/auth-foundation.md`, `docs/roadmap.md`, `README.md`, `.env.example` | Consumer-facing behavior, developer workflow, and configuration touched by Sprint 16. |

**Historical Sprint 14 baseline evidence** — the findings register
(`production-readiness/findings-register.md`) deliberately preserves the
original Sprint 14 audit text of every entry; Sprint 15/16 state is carried
in clearly labeled status blockquotes and Resolution lines, never by
rewriting the baseline. `production-scorecard.md`, `product-gap-analysis.md`,
`standards-matrix.md`, `production-roadmap.md`, and `launch-checklist.md`
likewise keep audit-time content with appended Sprint 15/16 status updates.

**Sprint 16 closing artifacts** — this file (the official closing artifact,
living changelog §24, and refinement record §23), plus the
production-readiness `README.md` post-audit status block.

## 16. Scope-control confirmation

Not implemented (verified against the diff): password recovery/reset/change,
email change, MFA, passkeys, OAuth/social login, account deletion/export,
marketing/bulk email, bounce/complaint webhook ingestion, suppression lists,
template CMS, notification preferences, deployment automation, Dockerfiles,
IaC, staging infra, secrets-manager/rotation, backup/PITR, observability
infra, incident response, security-header/proxy/rate-limit redesigns,
role-transition enforcement, unrelated dependency changes. No attempt was
made to close ORG-PR-001/004/005/006. Registration-enumeration remediation
(Sprint 17) was not pulled forward; the new endpoints introduce no
enumeration surface of their own.

## 17. Remaining risks and known limitations

- **No external-provider delivery evidence** (§14) — the sprint's one
  unexecutable item in this environment; ORG-PR-002 stays open.
- **Implicit-TLS-only SMTP**: no STARTTLS, so a 587-STARTTLS-only provider
  endpoint is unsupported by this driver.
- **SMTP/database non-atomicity**: the documented residual window (mailer
  accepted → persistence fails) yields one dead emailed link; the previous
  link stays usable and resend is the recovery path. Email delivery is not —
  and is not claimed to be — atomic or exactly-once.
- **No bounce processing, complaint processing, or suppression lists**:
  repeated sends to dead or complaining addresses are possible.
- **Advisory verification policy**: a hostile or typo'd address can operate
  an account exactly as before this sprint until enforcement lands.
- **Rate limits fail open** (unchanged system policy): a Redis outage
  disables the verification rate limits along with all others.
- **nodemailer is a new runtime dependency** of `apps/api` — supply-chain
  exposure tracked under the existing dependency findings (ORG-PR-018/020:
  no CI dependency/vuln scanning yet).
- **No full browser E2E coverage**: the frontend token-hygiene guarantees
  are proven in jsdom, not a real browser; live Mailpit delivery is verified
  manually, not in CI.
- Password recovery remains absent (ORG-PR-004; Sprint 17).

## 18. Remaining P1 blockers

ORG-PR-001 (deployment automation), **ORG-PR-002 (external email delivery
validation — the remaining half)**, ORG-PR-004 (password recovery),
ORG-PR-005 (backup/PITR/restore), ORG-PR-006 (secrets management/rotation).

## 19. Confidence assessment (evidence-based, per dimension)

| Dimension | Confidence | Evidence |
| --- | --- | --- |
| Configuration + driver selection | High | 39 config tests incl. the full production rejection matrix; factory second-line defense tested; fail-closed by construction. |
| Token lifecycle (hash-only, expiry, single-use, resend invalidation) | High | 21 route tests + 6 DB integration tests exercise every state transition at both the service and SQL layers. |
| Concurrency behavior | High | Integration test fires two concurrent completions against live PostgreSQL and asserts exactly one 200 and one 409 (`FOR UPDATE` serialization). |
| Enumeration safety | High | Structural (request endpoint accepts no address) plus tests proving unknown-token and unverifiable-account responses are indistinguishable. |
| Header-injection protection | High | Central guard enforced in production code at construction and per delivery; 10 guard tests + driver-level tests proving injection attempts never reach a socket. |
| Frontend token handling | Medium-high | 15 jsdom tests prove fragment capture, URL scrub, single POST, and absence from storage/DOM/query strings — but in jsdom, not a real browser (no E2E harness). |
| Mailpit (local) delivery | High | Live round-trip through the real nodemailer driver to the running Mailpit container, read back via Mailpit's API. |
| External-provider delivery | **Unproven** | No evidence exists. Compatibility of the implicit-TLS + negotiated-auth transport with real providers is asserted from nodemailer's maturity and the fake-server evidence only. Confidence stays low until a real external send is performed (§14). |

## 20. Final readiness classification

```text
C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

Unchanged by design: five P1 blockers remain open and the overriding rule in
the [scorecard](production-scorecard.md) applies. Sprint 16 completion is not
launch clearance.

## 21. Readiness for Sprint 17

**Ready.** Sprint 17 — Recovery and Credential Management can begin and can
reuse, directly:

- the account-mailer boundary (recovery emails are just another renderer);
- the verified, fail-closed configuration/driver selection;
- secure opaque-token generation + SHA-256 hashing seams;
- the expiry + single-use + `used_at`/`invalidated_at` lifecycle pattern and
  the transactional `FOR UPDATE` consumption pattern;
- the Redis rate-limit infrastructure and bucket conventions;
- the enumeration-safe current-user-only request pattern;
- the frontend completion-page pattern (fragment capture, scrub, single POST,
  backend-derived states);
- the sanitized security-event conventions.

No repository prerequisite is unresolved. External-provider delivery
validation (ORG-PR-002) remains a documented **parallel** production-readiness
task — an operational prerequisite for production email, not a blocker for
Sprint 17 development against Mailpit; it does not close ORG-PR-002 until
performed.

## 22. Recommended next sprint

**Sprint 17 — Recovery and Credential Management** (per the
[production roadmap](production-roadmap.md)): password reset on the Sprint 16
mailer + token foundation, password/email change, and registration
de-enumeration (ORG-PR-004, 039, 030). If provider credentials become
available first, execute the §14 external-delivery validation as a
short-turn task and close ORG-PR-002.

## 23. Refinement iteration (2026-07-18, same day)

One surgical hardening pass after the initial sprint close; scope, findings
statuses, and readiness classification are unchanged.

1. **Token-fragment hardening.** The emailed verification link now carries
   the raw token in the URL **fragment** (`/auth/verify-email#token=…`)
   instead of a query string — the fragment is never sent in an HTTP request,
   so the token cannot reach the web server, a reverse proxy, an access log,
   or a `Referer` header. The completion page captures it once from the
   fragment, immediately removes it via history replacement, never copies it
   into a query string, and still POSTs it exactly once (StrictMode-safe).
2. **Transport decision.** The hand-written SMTP protocol client
   (`smtp-delivery.ts`, ~190 lines) was **replaced with nodemailer 9.0.3** as
   the protocol implementation for both socket drivers. Rationale: a
   production SMTP client must correctly handle multiline replies, EHLO
   capability parsing, AUTH mechanism negotiation, TLS certificate/hostname
   verification, per-phase timeouts, socket teardown, dot-stuffing, and
   RFC 2047 non-ASCII header encoding — a mature, narrowly scoped library is
   strictly lower risk than re-proving a bespoke client. Orgistry keeps a
   thin policy layer (`smtp-transport.ts`). One adapter, no provider SDKs, no
   plugin architecture; the in-memory test mailer is unchanged. The fake
   SMTP server tests were kept and now prove nodemailer interop, including a
   real TLS handshake, authentication, 5xx refusals, credential-redacted
   errors, untrusted-certificate rejection, and plaintext-server refusal.
3. **Header-injection protection.** A central CR/LF/NUL guard
   (`assertSafeAccountEmail` / `assertSafeSenderIdentity` in
   `account-mailer.ts`) now runs at driver construction (sender identity) and
   on every delivery (recipient, subject — including feature-supplied values
   such as invitation organization names), before any transport. Tests prove
   `Acme\r\nBcc: attacker@example.com`-style inputs in MAIL_FROM_NAME, sender
   email, recipient, subject, and organization name cannot create an
   additional header or recipient; rejection errors never echo the value.
4. **Issuance/delivery consistency contract** made explicit (service comment
   + docs): the previous usable generation is untouched until the mailer has
   ACCEPTED the replacement; the single non-atomic window (mailer accepted →
   issue transaction fails) yields an error response, a permanently dead
   candidate link (hash never stored), and a still-usable previous
   generation. Tests cover failed resend (old link still completes), the
   persistence-failure window (500, candidate 404, old link works, no token
   in events), successful replacement (old 409 / new 200, one usable
   generation), and registration delivery failure (unchanged). No queue,
   worker, or outbox; email delivery is NOT atomic with the database and is
   not claimed to be.
5. **Capability-honest transport claims.** Removed categorical statements
   ("every mainstream transactional provider supports 465",
   "provider-neutral") across code comments and docs; replaced with precise
   capabilities: implicit TLS only (no STARTTLS), authentication negotiated
   by nodemailer from server capabilities (AUTH PLAIN directly
   test-evidenced; other mechanisms untested here), automated + local-Mailpit
   evidence only, no external-provider evidence.
6. **Test TLS fixture** retained as a clearly isolated committed fixture
   (Node cannot mint certificates without a system `openssl`, so runtime
   generation would be environment-dependent): imported only by test code,
   never trusted by any production path, explicitly documented as a
   non-secret whose scanner hits are false positives.
7. **Tests:** mail module 17 → 27 (injection, non-ASCII, 5xx, interop);
   verification routes 18 → 21 (consistency contract); web demo 13 → 15
   (fragment scrub, no-query-string). Net: 566 unit + 34 web tests.
8. **Dependency added:** `nodemailer` (runtime) + `@types/nodemailer` (dev)
   in `apps/api` — the one deliberate exception to "no new dependencies",
   made to reduce production transport risk.
9. **Refinement validation (2026-07-18):** `pnpm validate` exit 0 (569 unit /
   34 web tests, lint, build, drift + whitespace clean),
   `pnpm validate:integration` exit 0 (13 db + 44 api tests; temporary
   alternate-port container `orgistry-pg-sprint16`, removed afterwards),
   `git diff --check` exit 0. Live Mailpit round-trip re-verified through the
   nodemailer transport. No new commit was created in the refinement; the
   working tree remains uncommitted apart from the pre-existing migration
   commit `0aff351`.

## 24. Sprint changelog

- Mapped the mailer/auth/db/web/config/docs subsystems; confirmed the
  Sprint 9 zero-dependency SMTP convention and the existing
  `email_verification_tokens`/`emailVerifiedAt`/`emailVerified` scaffolding.
- Config: mail driver + sender + SMTP + TTL + rate-limit variables;
  driver-conditional completeness policy; production guard extensions;
  19 new config tests (first pass, all green).
- Mail module: boundary types/serialization, shared net/tls+AUTH SMTP
  conversation, three drivers, factory, fake SMTP server + committed
  test-only TLS fixture. Corrections during implementation: AUTH PLAIN
  separators initially written as literal NUL bytes into source (would have
  made git treat files as binary) — normalized to `\u0000` escapes.
- Invitations migrated onto the boundary; superseded transport files removed;
  suites updated (`lastLinkToken`).
- Schema: `invalidated_at` + migration `0008`; committed (`0aff351`) because
  the drift gate requires committed migrations.
- Contracts: three error codes + three schemas + tests.
- Verification service/repo/routes/events/errors/renderer/token seam;
  registration best-effort integration; server/app wiring; in-memory repo +
  extended auth test harness.
- 18 route tests green first run; 6 DB integration tests incl. the
  concurrency race (alternate-port PostgreSQL due to a local 5432 conflict).
- Web demo: banner, completion page, `refreshUser`. Correction during
  validation: post-completion user refresh raced the boot-time session
  restore — moved to a status-gated effect; 13 frontend tests green after.
- Live Mailpit round-trip evidence captured via the real driver + Mailpit API.
- Documentation synchronized (see §15); findings register updated with
  evidence-based statuses; this artifact written.
- Final validation: `pnpm validate` ×2, `pnpm validate:integration`,
  `git diff --check` — all pass. One unrelated single-occurrence audit-test
  flake observed and documented.
