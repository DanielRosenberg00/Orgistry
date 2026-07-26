# Sprint 22 Artifact Package — CodeQL Alert Triage and CI Security Gate Closure

Closing artifact for Sprint 22 (executed 2026-07-26). Objective: convert CodeQL
from a scanner that merely runs into a security control that is fully triaged,
evidence-backed, remediated where defects are real, governed by a stated gate
policy, and enforceable. Addresses ORG-PR-020; opens and resolves ORG-PR-055 and
ORG-PR-056.

Authoritative finding statuses live in
[findings-register.md](findings-register.md). Per-alert triage lives in
[sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md). This
artifact records the implementation, evidence, and decisions.

## 1. Implementation summary

Sprint 21 shipped scanners. They ran, produced 41 High alerts, and stopped
there — a wall of untriaged findings is not a control, and ORG-PR-020 was
correctly left open. Sprint 22 closed that gap in four parts:

1. **Triaged all 41 alerts individually**, tracing each to its source and sink,
   grouping them into ten root causes, and giving every one an evidence-bearing
   GitHub disposition. No bulk dismissal; no alert left ambiguous.
2. **Fixed the three real defects the triage found.** The audit-log read
   scanned an entire tenant's event history on an un-indexed filter with no
   per-actor ceiling (ORG-PR-055). The demo bootstrap emitted a one-time API
   key secret to stdout — twice, once inside a copy-pasteable `curl` command
   (ORG-PR-056).
3. **Wrote the gate policy** — who triages, when, what evidence a dismissal
   requires, what blocks a merge — into `docs/validation.md`, and made it
   enforceable with a repository ruleset rather than leaving it as prose.
4. **Proved the gate fails**, remotely, on a seeded finding, on a temporary
   branch that was deleted and never merged.

Two results are worth more than the count.

First, the 34 `js/missing-rate-limiting` alerts all shared one architectural
cause — limiters live in the service layer, one module from the handler CodeQL
analyses — and that reasoning is correct for 33 of them and **wrong for one**.
Dismissing the cluster by pattern, which the shared explanation invites, would
have buried a genuine defect.

Second, this sprint's own first pass got a call wrong and had to reverse it.
The demo bootstrap's credential print was initially classified as an accepted
residual risk with a compensating control. That contradicted a mandatory
Definition of Done condition — *no raw secrets, tokens, passwords,
Authorization headers, cookies, or SMTP credentials are logged* — which admits
no accepted-risk exception. The completion iteration removed the output
instead of defending it. **The sprint now carries zero accepted clear-text
logging risks**; §7 records both the original decision and why it did not
stand.

## 2. Repository and baseline state

| Item | Value |
| --- | --- |
| Branch | `main` |
| HEAD at sprint start | `c33a150fd0feaa1ce74313fc9185837ec2c2e1ef` (identical to the specification's baseline) |
| Working tree at start | clean |
| Remote sync at start | `origin/main`, 0 ahead / 0 behind |
| Remote | `https://github.com/DanielRosenberg00/Orgistry.git` (public) |
| GitHub CLI | authenticated as `DanielRosenberg00`, scopes `gist, read:org, repo, workflow` |
| Package manager | pnpm 10.29.3, Node ≥ 20 |
| Branch protection at start | **none** — `/branches/main/protection` returned 404, `/rulesets` returned `[]` |
| Code scanning default setup | `not-configured` (analysis is driven by the committed `codeql.yml`) |

The specification warned not to assume the baseline commit was still HEAD. It
was — verified rather than assumed.

## 3. CodeQL alert inventory summary

Full per-alert detail:
[sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md).

Baseline analysis `1528655701` (`c33a150f`, `refs/heads/main`, 2026-07-26
14:04:51Z): 41 results. The specification's stated distribution and the observed
GitHub state agreed exactly — 34 / 3 / 2 / 2, alert numbers 1–41, all
`security-severity: high`, none previously dismissed or fixed.

## 4. Alert counts before and after

| Query | Baseline | Present in the final analysis | Δ |
| --- | --- | --- | --- |
| `js/missing-rate-limiting` | 34 | 34 | — |
| `js/clear-text-logging` | 3 | **0** | −3 (every sink removed from the code) |
| `js/insufficient-password-hash` | 2 | 4 | +2 (invariant test's negative controls) |
| `js/biased-cryptographic-random` | 2 | 1 | −1 (two sites merged into one helper) |
| **Total** | **41** | **39** | 45 alerts created in total |

- Baseline analysis: `1528655701` (`c33a150f`), 41 results.
- Final analysis: `1528856173` (`688f78b8`, `refs/heads/main`), **39 results**.

The full state-by-state reconciliation — and the distinction between GitHub
state and security classification — is in §11. That is the single authoritative
set of numbers for this sprint.

## 5. Root-cause groups

| Group | Cause | Alerts | Count |
| --- | --- | --- | --- |
| `S22-RC-001` | Per-actor mutation limiter in the SERVICE layer | 8, 13, 15, 18, 19, 22, 24, 25, 30, 34, 36, 37 | 12 |
| `S22-RC-002` | Per-key/per-org limiter inside the API-key AUTHENTICATOR | 11 | 1 |
| `S22-RC-003` | Read bounded by the global per-IP `onRequest` limiter | 9, 14, 16, 17, 20, 23, 26–29, 31, 32, 33, 35, 38, 39, 40 | 17 |
| `S22-RC-004` | Idempotent revoke, state-bounded by throttled creation | 10, 21 | 2 |
| `S22-RC-005` | Fastify `onSend` hook misread as a route handler | 41 | 1 |
| `S22-RC-006` | **Confirmed defect** — unbounded-cost audit read | 12 | 1 |
| `S22-RC-007` | SHA-256 over a 32-byte CSPRNG token read as password hashing | 3, 4 | 2 |
| `S22-RC-008` | Modulo over a 32-char alphabet that divides 256 exactly | 1, 2 | 2 |
| `S22-RC-009` | **Confirmed defect** — demo bootstrap emitted the one-time API key secret | 6, 7 | 2 |
| `S22-RC-010` | Demo log helper flagged on a non-secret field | 5 | 1 |
| | | **Total** | **41** |

## 6. Classification counts

| Final classification | Count |
| --- | --- |
| Fixed defect | 3 |
| Covered by endpoint-specific control but invisible to CodeQL | 13 |
| Covered by global control but invisible to CodeQL | 19 |
| Framework/model false positive | 4 |
| High-entropy-token false positive | 2 |
| Accepted residual risk | 0 |
| Duplicate of another alert | 0 |
| Confirmed defect (unresolved) | 0 |
| Needs follow-up | 0 |
| Not reproducible | 0 |
| **Total** | **41** |

## 7. Fixed defects

### ORG-PR-055 — Audit-log read: unbounded query cost, no per-actor ceiling

**Alert 12.** The one true positive among the 34 rate-limiting alerts.

`audit.repo.ts:59-66` builds the `targetId` filter as an OR across five JSONB
expressions (`metadata ->> 'targetProjectId'`, `targetKeyId`,
`targetInvitationId`, `targetMembershipId`, `membershipId`). No index covers
them — `packages/db/src/schema/auth.ts:311-317` declares indexes on `user_id`,
`event_type`, `created_at`, and the composite `(organization_id, created_at,
id)`. The composite orders the keyset scan but cannot satisfy the predicate, so
PostgreSQL walks the organization's slice of `security_events` row by row. A
`targetId` matching nothing reads the entire slice — and `security_events` has
no retention policy (ORG-PR-015), so that slice grows without bound.

The permission gate (`audit_events.read`) and the independent entitlement gate
(`audit_log_access`) bound *who* may ask. Nothing bounded *how often*. The only
ceiling was the global per-IP bucket: 300/60s, shared with all other traffic
from that IP, keyed on IP rather than on the actor or tenant being scanned — so
a distributed client evaded it entirely.

**Fix.** Two fixed-window buckets in `audit.service.ts`, after the membership,
permission, and entitlement gates and immediately before the query:

- `rl:audit:read:user:<userId>` — `RATE_LIMIT_AUDIT_READ_PER_USER_MAX` (60/60s)
- `rl:audit:read:org:<organizationId>` — `RATE_LIMIT_AUDIT_READ_PER_ORG_MAX` (240/60s)

Per-user is consumed first so a runaway client exhausts its own allowance before
the shared tenant one. Reuses the existing `RateLimiter` interface,
`enforceStoreAvailability` failure-mode policy (production: fail closed), and
`rateLimitedError()` envelope — no parallel throttling mechanism.

**Residual, still open under ORG-PR-055:** the limiter bounds exploitation; it
does not make the query cheap. A legitimate operator on a large tenant still
pays a full-slice scan for a non-matching `targetId`. The durable fix is an
index over the target-id metadata keys or retention under ORG-PR-015. Neither is
in Sprint 22 scope.

### ORG-PR-056 — Demo bootstrap emitted a one-time API key secret

**Alerts 6, 7 (successor 45).** Recorded here in full because the sprint
reversed itself, and the reversal is the useful part of the record.

**The defect.** `tooling/demo-seed.mjs` created an API key during bootstrap and
printed the returned raw secret to stdout — originally twice, once labelled and
once interpolated into a ready-to-run `curl` example. The API's Pino redaction
backstop (ORG-PR-033) does not cover it: a separate process using `console.log`
with string interpolation bypasses path-based redaction entirely.

**First pass — partial, and wrongly closed out as accepted.** The duplicate
`curl` print was deleted (alert 7, genuinely fixed), and `assertLocalTarget`
was added to refuse any non-loopback target before the first request. The
remaining print was then accepted as residual risk, reasoning that the API
returns a key secret exactly once so printing it *was* the delivery channel.

**Why that reasoning did not stand.** It treated the delivery channel as fixed
and protected it, rather than questioning it. Three things make it
indefensible:

1. The Definition of Done condition — *no raw secrets, tokens, passwords,
   Authorization headers, cookies, or SMTP credentials are logged* — admits no
   accepted-risk exception. A finding that contradicts a mandatory condition is
   not a candidate for acceptance.
2. A terminal is a logging sink like any other. Scrollback, screen shares,
   terminal recordings, tmux and CI capture, and `> out.txt` all retain it.
   "Interactive terminal, not an aggregated log pipeline" understated that.
3. The loopback guard bounds *where* a credential is emitted. It never stopped
   it being emitted. A compensating control that does not remove the exposure
   cannot discharge a condition that forbids the exposure.

**Full remediation — the delivery channel was changed instead.**

- `ensureApiKey` **removed** from `tooling/demo-seed.mjs`. The bootstrap creates
  no API key and touches no `/api-keys` endpoint, so no secret exists for it to
  print.
- The summary block emits identifiers and locations only. The owner password —
  a published local-only literal — is **pointed at** (`see
  docs/demo-walkthrough.md`) rather than reprinted, so no output path in the
  tool carries a credential of any kind.
- Key creation moved to the **existing** authenticated web-demo surface
  (`/app/api-keys`, `ApiKeysPage`), where the backend returns the raw secret
  exactly once to the requesting browser and no tool-side copy exists. No new
  product feature, API route, or contract was added — walkthrough steps 12–13
  already documented that path.
- The loopback guard was **kept**, with its documentation corrected. It no
  longer stands between a secret and a terminal; it prevents seeding published
  demo credentials into a shared environment and mutating organization, plan,
  project, and invitation state somewhere real.

**Substitutions explicitly rejected**, because each defeats the scanner without
changing the exposure: `process.stdout.write`, base64-encoding, printing via an
error, embedding in a command example, printing the whole HTTP response,
writing to a file, or suppressing the query.

**Result:** ORG-PR-056 is **Closed — fully remediated**, and the repository
carries **no accepted clear-text logging risk**.

### Flaky test fixed (found by the remote gate, not by CodeQL)

`audit.routes.test.ts > redacts sensitive top-level and nested metadata keys`
seeded two-character sentinels (`'pw'`, `'rt'`) and asserted their absence from
`JSON.stringify(item).toLowerCase()` — a payload containing generated Crockford
base32 ids. Any id containing `PW` or `RT` lowercased into a false "leak".
Measured over 100,000 generated organization ids: `RT` 2.37%, `PW` 2.43%,
either **4.77%**. That is a pre-existing ≥1-in-20 flake rate; local runs had
simply been lucky, and the first remote CI run on `9733b880` failed on it.

Fixed by replacing every sentinel with a long distinctive value and, while
there, asserting the two that had been seeded but never checked
(`apiKeySecret`, `invitationTokenHash`) — so the test now proves more than
before. Re-ran 15 consecutive times: 15/15 green. This mattered beyond
tidiness: a check that fails randomly cannot honestly be made a required
status check.

## 8. Dismissed false positives

38 dismissed *false positive*, 2 *used in tests*. Each carries an individual
comment naming its own route, limiter key, enforcing line, or arithmetic.
Highlights of the reasoning, in full in the inventory:

- **33 rate-limiting alerts** — the limiter exists but lives in the service
  (`S22-RC-001`), in the API-key authenticator (`S22-RC-002`), or is the global
  `onRequest` hook (`S22-RC-003`). CodeQL reasons per handler and follows
  neither the service interface nor Fastify's hook chain. The limiters are not
  moved into handlers to satisfy the scanner: Sprint 19 placed them after the
  permission check on purpose, and `mutation-throttle.test.ts:178` /
  `project-throttle.test.ts:85` pin that a non-member sees 404, never 429.
  Hoisting them would reintroduce the existence oracle those tests forbid.
- **2 revokes** (`S22-RC-004`) — verified idempotent rather than assumed:
  `api-key.repo.ts:220` returns `alreadyRevoked` *before* `recordKeyEvent`, and
  `invitation.repo.ts:279` throws in `assertAcceptable` before
  `recordInvitationEvent`. Durable writes are capped by creation, which is
  throttled.
- **`security-headers.ts`** (`S22-RC-005`) — an `onSend` response hook, not a
  route handler. It registers no route and runs no query.
- **2 token-hash alerts** (`S22-RC-007`) — SHA-256 over 32-byte CSPRNG values
  used as unique-index lookup keys. Verified that all seven password call sites
  use Argon2id and that no password reaches `createHash` on any path.
- **1 biased-random alert** (`S22-RC-008`) — 256 = 32 × 8, so the mapping is
  exactly uniform.
- **1 logging alert** (`S22-RC-010`) — the value at the sink was
  `created.apiKey.name`, a display label, not the sibling `created.secret`.
  The completion iteration removed that call site entirely along with API-key
  creation, so the alert now also carries `fixed_at`; the false-positive
  classification was left in place because it was and remains accurate.
- **2 test-only alerts** (43, 44) — the new invariant test computes
  `sha256(password)` precisely so it can assert the stored Argon2id hash is
  *not* that value. The scanner cannot distinguish a negative control from a
  hashing path; deleting the test to satisfy it would remove the best evidence
  the invariant holds.

## 9. Accepted residual risks

**No accepted clear-text credential-logging risk remains.** ORG-PR-056 was
initially recorded here and has been fully remediated — see §7. One deliberate
architectural tradeoff remains, carried forward from Sprint 19.


### Global limiter fails open during a Redis outage

Carried forward from Sprint 19, restated because 17 read alerts were dismissed
on the strength of that limiter. `plugins/global-rate-limit.ts:20-25` fails
**open** on a store outage regardless of `RATE_LIMIT_FAILURE_MODE`. During a
Redis outage those 17 reads have no rate limit. Compensating: `/ready` reports
the instance unhealthy (removing it from rotation), and every sensitive surface
keeps its own fail-closed bucket. Deliberate and documented, not an oversight.
Tracked under ORG-PR-009.

## 10. Remaining open alerts

**Zero.** Read back from the API after the final analysis: 0 open, 5 `fixed`,
40 dismissed, 45 created in total.

Reaching zero was an outcome, not a target: 34 of the 41 belonged to one
architectural pattern the query cannot model. The honest consequence is
recorded in [known-limitations.md](../known-limitations.md) — this repository
cannot use "zero open alerts" as a health signal, and relies instead on the
dismissal-evidence rule in the
[CodeQL alert policy](../validation.md#codeql-alert-policy).

## 11. GitHub alert disposition evidence

The authoritative reconciliation. Every figure was read from the GitHub API
after the final analysis of the merged `main` commit `688f78b8`; any number
elsewhere in this repository that disagrees is stale.

GitHub's `?state=fixed` *filter* and the `state` *field* disagree — the filter
returns any alert absent from the latest analysis, while the field reports a
dismissal in preference to a fix. The field is used throughout.

| Dimension | Count | Detail |
| --- | --- | --- |
| Original baseline alerts | 41 | numbers 1–41, analysis `1528655701` on `c33a150f` |
| Successor alerts created during remediation | 4 | 42, 43, 44, 45 |
| **Total alerts ever created** | **45** | |
| Final open | **0** | |
| Final `state: fixed` | 5 | 1, 2, 6, 7, 45 |
| Final `state: dismissed` | 40 | 38 *false positive* + 2 *used in tests* |
| — dismissed *false positive* | 38 | |
| — dismissed *used in tests* | 2 | 43, 44 |
| — dismissed *won't fix* (accepted risk) | **0** | none remain |
| Present in the final analysis | 39 | 34 rate-limiting + 4 password-hash + 1 random |

**GitHub state is not security classification.** A dismissed alert can be a
remediated defect (the fix is real but invisible to the query); a `fixed` alert
can be no defect at all (the code merely moved). Both occur here:

| Security classification | Count | Alerts | GitHub state |
| --- | --- | --- | --- |
| Confirmed defect — remediated, removal **visible** to CodeQL | 3 | 6, 7, 45 (ORG-PR-056) | `fixed` |
| Confirmed defect — remediated, remediation **invisible** to CodeQL | 1 | 12 (ORG-PR-055) | dismissed *false positive* |
| Not a defect — alert closed by code relocation | 2 | 1, 2 | `fixed` |
| False positive — control exists but is invisible to CodeQL | 33 | 8–11, 13–41 | dismissed *false positive* |
| False positive — high-entropy token modelled as a password | 2 | 3, 4 | dismissed *false positive* |
| False positive — arithmetic proof (uniform modulo) | 1 | 42 | dismissed *false positive* |
| False positive — non-secret field; call site since removed | 1 | 5 | dismissed *false positive* (+ `fixed_at`) |
| False positive — test-only negative control | 2 | 43, 44 | dismissed *used in tests* |
| **Accepted residual risk** | **0** | — | — |
| **Total** | **45** | | |

**Confirmed security defects remediated: 2 findings** — ORG-PR-055 (audit-read
cost) and ORG-PR-056 (credential output), carried by four alerts.

**Platform behaviour worth recording.** When the demo-seed sink was removed,
GitHub set `fixed_at` on alert 45 but left `state: dismissed` with
`dismissed_reason: won't fix` — a dismissal takes precedence over a fix in the
`state` field, so the alert kept asserting a decision *not* to fix something
that had in fact been fixed. Clearing the dismissal (`PATCH state=open`) made
GitHub immediately reclassify it `state: fixed`, `dismissed_reason: null`,
retaining `fixed_at` of 2026-07-26T16:28:31Z. Removing a sink does not on its
own correct a stale dismissal; the dismissal must be withdrawn explicitly.

Alert 5 was deliberately left dismissed as *false positive* although the same
change removed its call site: the classification was and remains accurate (the
value was `created.apiKey.name`, a display label), and `fixed_at` already
records the removal. Reopening it would discard a correct analysis to gain
nothing. No other disposition was touched.

Every dismissal carries an individual comment naming its own route, control, or
arithmetic; dismissals with a comment shorter than 50 characters number zero.
GitHub caps `dismissed_comment` at 280 characters (an initial attempt with
longer comments was rejected `HTTP 422`), so each cites its root-cause group in
the inventory rather than reproducing the analysis.

## 12. CodeQL gate policy

Canonical text: [validation.md § CodeQL alert policy](../validation.md#codeql-alert-policy).
Summary of what it commits to:

| Question | Answer |
| --- | --- |
| Does a CodeQL workflow failure fail the required check? | Yes — the analyze job is a required status check; a run that errors, times out, or is cancelled blocks the merge |
| Do new Critical/High alerts block merge? | Yes, via code-scanning merge protection in the `main` ruleset |
| Pre-existing reviewed alerts | Grandfathered — but only because each was individually reviewed with recorded evidence and dispositioned |
| Who owns initial triage? | The PR author, during review; scheduled-run alerts belong to the maintainer |
| Triage cadence | Both: at PR review and on the weekly scheduled run (within one week) |
| Immediate remediation threshold | Critical/High before merge; Medium within the sprint; Low recorded and scheduled |
| Evidence required to dismiss | Specific: the real value at the sink, the control the query cannot model with file and line, or the arithmetic. "Framework false positive" alone is insufficient |
| Duplicate handling | Root-cause group IDs organize analysis; every alert still gets its own row, classification, and comment |
| Accepted risks | Rationale + compensating control + named owner + findings-register ID; never labelled a false positive |
| Enforcement mechanism | Repository ruleset on `main` |
| Where GitHub cannot enforce | Documented as a manual control, not claimed as enforced |

**Enforcement implemented and demonstrated.** Repository ruleset `19769611`
("main branch protection"), target `branch`, condition `~DEFAULT_BRANCH`,
enforcement `active`, **no bypass actors**. Rules: `deletion`,
`non_fast_forward`, `pull_request`, `required_status_checks` (all five checks —
`Validate (offline)`, `Integration (PostgreSQL + Redis)`,
`Dependency audit (pnpm)`, `Secret scan (Gitleaks)`,
`Analyze (javascript-typescript)`), and `code_scanning` with CodeQL at
`security_alerts_threshold: high_or_higher` / `alerts_threshold: errors`.

Enforcement was verified empirically, not assumed. A direct push to `main` was
attempted and **refused**:

```
GH013: Repository rule violations found for refs/heads/main.
 - Changes must be made through a pull request.
 - 5 of 5 required status checks are expected.
 - Code scanning is waiting for results from CodeQL for the commit cd9dccc.
```

The same commit then landed through pull request
[#9](https://github.com/DanielRosenberg00/Orgistry/pull/9), which reported
`mergeable=MERGEABLE`, `mergeStateStatus=CLEAN`, and all five required checks
`SUCCESS` before merging. That PR is the first exercise of the new gate.

`required_approving_review_count` is **0**. On a single-maintainer repository a
non-zero count would block every change, since an author cannot approve their
own pull request. Zero still forces the pull-request path, which is what makes
the status checks and code-scanning merge protection apply at all — the review
requirement is the part that is deliberately not enforced, and should be raised
if a second maintainer joins.

This is a deliberate change to the repository's working model: every sprint
through 21 pushed directly to `main`; from now on changes go through a pull
request. Verify the live configuration with
`gh api /repos/DanielRosenberg00/Orgistry/rulesets`.

**Honest limits.** Code-scanning merge protection blocks on alert *severity* and
cannot express a per-query allow-list, nor "block new alerts but permit the
reviewed baseline" beyond its own new-vs-existing distinction. The rest of the
policy — evidence-bearing individual dismissals, no bulk dismissal, no
dismissing to reach zero — is a **manual control**. It is stated as such here
and in `validation.md`, and is not claimed as technically enforced.

## 13. Tests added or updated

| File | Cases | What it proves |
| --- | --- | --- |
| `apps/api/src/modules/audit/audit-read-throttle.test.ts` (new) | 8 | Per-user ceiling returns the standard `RATE_LIMITED` envelope; the expensive `targetId` path is specifically bounded; per-user buckets are isolated between members; the per-org ceiling fires across distinct members each under their own limit; cross-organization isolation; legitimate traffic below the ceiling still succeeds; a non-member sees 404 not 429; a non-entitled member sees 403 not 429 and never consumes the allowance |
| `packages/auth-core/src/hashing-invariants.test.ts` (new) | 8 | Password hashes carry the `$argon2id$` prefix and never equal or contain `sha256(password)`; `verifyPassword` rejects a SHA-256 digest presented as a stored hash (no fast-hash fallback exists); password hashes are salted and so unusable as lookup keys; opaque tokens decode to exactly 32 bytes and match the 43-char base64url shape; token digests match `^[0-9a-f]{64}$` and never carry the Argon2 prefix |
| `packages/shared/src/random-alphabet.test.ts` (new) | 8 | The Crockford alphabet is 32 chars and `256 % 32 === 0`; every divisor length is accepted; lengths 3, 30, 31, 33, 62 and the empty alphabet are rejected with an actionable message; output length is exact; output draws only from the supplied alphabet. Deterministic — no statistical assertions, so nothing here can flake |
| `tooling/demo-target-guard.test.ts` (new) | 5 | Loopback forms accepted (`localhost`, `127.0.0.1`, `[::1]`, with/without port, http/https); hosted and private-network targets refused; `localhost.evil.example.com` and `127.0.0.1.evil.example.com` refused (a prefix check would pass them); the rejected host is named; malformed URLs refused rather than passed through |
| `tooling/demo-seed.output.test.ts` (new) | 7 | Runs the REAL bootstrap as a child process against a stub API on loopback and inspects captured stdout/stderr: exits 0 with empty stderr; issues **no** request to any `/api-keys` path; emits no owner password, access token, or key secret — asserted by literal value AND by shape (`/orgistry_[A-Z0-9]{6,}_/`, `/Bearer\s+\S+/`, `/[A-Za-z0-9_-]{40,}/`) so a *different* credential also fails; still prints org id, sign-in address, and web-demo URL; directs the operator to the API Keys page; leaves login/org/plan/projects/invitation flow intact; refuses a non-loopback target before any request |
| `apps/api/src/modules/audit/audit.routes.test.ts` (updated) | 1 | De-flaked: sentinels lengthened so random ids cannot collide with them; two previously-unasserted sentinels added |
| `apps/api/src/modules/audit/testing/build-audit-test-app.ts` (updated) | — | Optional limiter/ceiling overrides; throttling stays OFF unless a test wires both, so existing route tests are unaffected |

Existing tests cited as evidence for dismissals (not modified):
`plugins/global-rate-limit.test.ts`, `organization/mutation-throttle.test.ts`,
`projects/project-throttle.test.ts`, `api-keys/api-key-create-throttle.test.ts`,
`entitlements/plan-throttle.test.ts`, `invitations/invitation.throttle.test.ts`,
`auth/rate-limit.routes.test.ts`, `auth/rate-limit.failure-mode.test.ts`,
`auth/email-verification.routes.test.ts`,
`api-keys/external-projects.routes.test.ts`,
`api-keys/api-key.failed-auth-bounding.test.ts`,
`plugins/security-headers.test.ts`, `app.proxy-trust.test.ts`.

## 14. Local validation results

All mandatory commands executed in the final repository state.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm validate` | 0 | typecheck, ESLint, 867 unit tests in 81 files, 78 web tests in 10 files, web build, schema drift, whitespace — all pass |
| `pnpm validate:integration` | 0 | 15 integration files, 82 tests, against live PostgreSQL + Redis |
| `git diff --check` | 0 | no whitespace errors |
| `pnpm scan:deps` | 0 | prod and dev gates pass; exactly the two documented GHSA ignores reported |
| `pnpm scan:deps:local` | 0 | osv-scanner 2.4.0, 446 packages, no issues; the two documented filters applied |
| `pnpm scan:secrets` | 0 | gitleaks 8.30.1, full git history, no leaks |
| `actionlint` | 0 | actionlint 1.7.12, all three workflows clean |

**Deviation, recorded honestly.** `pnpm validate:integration` was run with
`DATABASE_URL` / `TEST_DATABASE_URL` pointed at port **55432**, not the
`.env` default of 5432. Host port 5432 is held by an unrelated PostgreSQL
container on this machine; the project's own validation database listens on
55432 (`orgistry-pg-validate`, `postgres:16-alpine`). This is a local
environment condition, not a repository change — CI uses its own service
container on 5432 and is unaffected, and the integration job passed remotely
(see §15).

**Initial failure and remediation.** The first remote CI run on `9733b880`
failed one unit test that had passed locally. Root cause was a pre-existing
flaky assertion, not a Sprint 22 regression — see §7. Fixed, re-verified 15×,
and re-run remotely green.

## 15. Remote workflow evidence

**Baseline commit `c33a150fd0feaa1ce74313fc9185837ec2c2e1ef`** (event `push`,
`refs/heads/main`):

| Workflow | Run ID | Conclusion | URL |
| --- | --- | --- | --- |
| CI | 30205303375 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30205303375 |
| Security scans | 30205303370 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30205303370 |
| CodeQL | 30205303373 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30205303373 |

**Sprint 22 commit `9733b880fbc3b7c483d40db774cfd53f478c884a`** (event `push`,
`refs/heads/main`):

| Workflow | Run ID | Conclusion | Note |
| --- | --- | --- | --- |
| Security scans | 30208119023 | success | |
| CodeQL | 30208119054 | success | produced analysis `1528767654`, 41 results |
| CI | 30208118988 | **failure** | Integration job success; Validate job failed on the pre-existing flaky test (§7) |

**Final commit `fa40790e51dc78c258f42560fd588845ce64d975`** (flaky-test fix +
artifact package; event `push`, `refs/heads/main`):

| Workflow | Run ID | Conclusion | URL |
| --- | --- | --- | --- |
| CI | 30208939280 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30208939280 |
| Security scans | 30208939287 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30208939287 |
| CodeQL | 30208939261 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30208939261 |

All three workflows are green on the final commit, including the CI job that
had failed on the flaky assertion.

CodeQL analyses on `refs/heads/main`:

| Analysis | Commit | Created | Results |
| --- | --- | --- | --- |
| 1528655701 | `c33a150f` | 2026-07-26T14:04:51Z | 41 |
| 1528767654 | `9733b880` | 2026-07-26T15:25:25Z | 41 |
| 1528799472 | `fa40790e` | 2026-07-26 | 41 |

**Completion iteration — final merged `main` commit
`688f78b8ea41454d3dfa8b57bfba77a9fd54b3e3`** (event `push`, `refs/heads/main`),
landed through pull request
[#11](https://github.com/DanielRosenberg00/Orgistry/pull/11) with all five
required checks `SUCCESS`:

| Workflow | Run ID | Conclusion | URL |
| --- | --- | --- | --- |
| CI | 30210460708 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30210460708 |
| Security scans | 30210460682 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30210460682 |
| CodeQL | 30210460680 | success | https://github.com/DanielRosenberg00/Orgistry/actions/runs/30210460680 |

CodeQL analyses on `refs/heads/main`, in order:

| Analysis | Commit | Results |
| --- | --- | --- |
| 1528655701 | `c33a150f` | 41 |
| 1528767654 | `9733b880` | 41 |
| 1528799472 | `fa40790e` | 41 |
| 1528813898 | `eb37b05d` | 41 |
| **1528856173** | **`688f78b8`** | **39** |

The drop from 41 to 39 is the demo-seed remediation: every
`js/clear-text-logging` sink is gone from the code. Final alert state is
reconciled in §11.

## 16. Negative-path proof evidence

**Completed remotely.** The requirement was evidence that the secret-scanning
gate actually *fails*, not merely that it runs.

| Item | Value |
| --- | --- |
| Temporary branch | `chore/sprint-22-scanner-negative-path` (based on `origin/main`) |
| Commit | `75daffcdfd7e52969a1e97a52e15af751ccbb662` |
| Fixture | `SPRINT-22-SCANNER-NEGATIVE-PATH.txt` — one synthetic high-entropy assignment, no provider key format, never valid anywhere, labelled in-file as a deliberate test |
| Trigger | `gh workflow run security.yml --ref chore/sprint-22-scanner-negative-path` (`workflow_dispatch`, which scans full history) |
| Run | 30207672121 — https://github.com/DanielRosenberg00/Orgistry/actions/runs/30207672121 |
| Conclusion | **failure** |
| Job: Dependency audit (pnpm) | success — proves the failure is specific, not a broken workflow |
| Job: Secret scan (Gitleaks) | **failure** at the gitleaks action step |
| Reported finding | `RuleID: generic-api-key`, `File: SPRINT-22-SCANNER-NEGATIVE-PATH.txt`, `Line: 13`, `Commit: 75daffcd`, `leaks found: 1` |
| Redaction | `Finding: api_key = "REDACTED"`, `Secret: REDACTED` — the redaction guarantee holds on a real failure |
| Cleanup | Remote branch deleted, worktree removed, local branch deleted. `gh api /repos/.../branches` lists only `main` and Dependabot branches |
| Merge safety | Nothing from that branch was merged or cherry-picked into `main`. The GitHub run record persists as durable evidence |

The fixture was validated locally against the repository's own `.gitleaks.toml`
in a throwaway git repository before being pushed, to confirm it would be
detected and that it matched no cloud-provider pattern that GitHub push
protection would block. Push protection was not weakened or bypassed.

## 17. Documentation index

| Document | Change |
| --- | --- |
| [sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md) | **New.** Per-alert triage: evidence, root-cause groups, classifications, dispositions, triage log |
| [sprint-22-artifact-package.md](sprint-22-artifact-package.md) | **New.** This document. §11 holds the single authoritative reconciliation |
| [../demo-walkthrough.md](../demo-walkthrough.md) | Bootstrap section rewritten: the seed prints no credentials and creates no API key; keys are minted interactively at steps 12–13 |
| [findings-register.md](findings-register.md) | ORG-PR-020 closed with evidence; ORG-PR-055 and ORG-PR-056 added; Sprint 22 status update |
| [../validation.md](../validation.md) | **New sections:** CodeQL alert policy; Branch protection |
| [../security-model.md](../security-model.md) | Audit-read buckets documented; the rule they encode ("a read needs its own bucket when its cost is not bounded by its page size"); failure-mode list updated |
| [../audit-log.md](../audit-log.md) | Rate-limiting section; pipeline order updated; gate-before-limiter added to the must-not-change list; un-indexed `targetId` recorded as a known limitation |
| [../known-limitations.md](../known-limitations.md) | Replaced the "workflows have not run remotely" limitation; added that dismissals, not absence, explain the empty alert list |
| [README.md](README.md) | Sprint 22 status block; index entries for both new documents |
| [production-scorecard.md](production-scorecard.md) | CI/CD and Supply chain raised 2 → 3 with revised gaps |
| [standards-matrix.md](standards-matrix.md) | SSDF PW/RV, SAMM verification, SLSA source rows updated |
| [production-roadmap.md](production-roadmap.md) | Sprint 22 entry; Sprint 21's ORG-PR-020 note corrected forward |
| [launch-checklist.md](launch-checklist.md) | LC-1.5 closed with run IDs |
| [repository-inventory.md](repository-inventory.md) | Ruleset noted as GitHub-side configuration, not a tree artifact |
| [security-assessment.md](security-assessment.md) | Sprint 22 update; supply-chain and CI/CD gaps revised |
| [sprint-21-artifact-package.md](sprint-21-artifact-package.md) | **Dated follow-up cross-reference only.** The Sprint 21 record is unchanged — its judgement that configuration is not enforcement was correct and is preserved verbatim |
| [../../README.md](../../README.md) | Scanners described as required checks |
| `.env.example` | Three new audit-read variables, documented |

## 18. Scope-control confirmation

Not implemented, by design: deployment automation, production Dockerfiles, IaC,
staging or production environments, release or package publishing, container
publishing, artifact signing, SLSA provenance, secrets-manager integration,
secret or JWT rotation, backup/PITR/restore, production SMTP validation, bounce
or complaint processing, observability platforms, background workers, retention
or cleanup jobs, MFA, passkeys, OAuth, SAML, SCIM, unrelated product features.

No attempt was made to close ORG-PR-001, 002, 005, 006, 015, or 042.

No CodeQL query was globally disabled. No alert was mass-dismissed. No fake,
no-op, or duplicated control was added to influence the scanner. Git history was
not rewritten and nothing was force-pushed. The deliberate negative-path fixture
never entered `main`.

Two changes deserve explicit justification as in-scope rather than drift:

- **The `random-alphabet.ts` extraction** touched two files to remove duplicated
  logic flagged by two alerts. It was made because the original comment
  ("uniform enough") framed an exact property as an approximation, inviting a
  future edit that would introduce real bias. The assertion converts an implicit
  invariant into a checked one. Behavior is unchanged, proven by the existing
  `ids.test.ts` and `api-key-secret.test.ts` passing untouched.
- **The flaky-test fix** was not a CodeQL finding. It was fixed because it broke
  the very CI gate this sprint was making authoritative; a required check that
  fails ~5% of the time at random is not a gate.

## 19. Findings register updates

| Finding | Change |
| --- | --- |
| ORG-PR-020 | **Open → Closed.** Remote green runs, remote negative-path failure proof, full SAST triage, ruleset enforcement |
| ORG-PR-055 | **New — Mitigated.** Audit-read cost bound; residual scan cost open |
| ORG-PR-056 | **New — Closed (fully remediated).** Demo bootstrap credential output; accepted with a loopback guard in the first pass, then removed outright in the completion iteration. **Zero accepted clear-text logging risks remain** |
| ORG-PR-032 | Unchanged (Closed). Its revoke analysis was re-verified against the code and holds |
| ORG-PR-015 | Unchanged (Open). Now additionally referenced as the reason ORG-PR-055's residual matters |
| ORG-PR-042 | Unchanged (Open). Explicitly out of scope |

## 20. ORG-PR-020 closure decision

**Closed.** Sprint 21 named three outstanding conditions; all three now have
remote evidence.

1. **First green remote runs** — CI 30205303375, Security scans 30205303370,
   CodeQL 30205303373, all `success` on `c33a150f`.
2. **Verified failure on a seeded finding, remotely** — run 30207672121, Secret
   scan job `failure`, `generic-api-key`, redacted output, branch deleted and
   never merged, while the dependency-audit job in the same run succeeded.
3. **SAST operational AND triaged** — 41 alerts produced, all 41 individually
   dispositioned with evidence; one true positive found and fixed.

Plus the condition Sprint 21 implied by calling it a *gate*: **enforcement**. A
ruleset on `main` makes the three checks required, so a scanner failure now
blocks a merge instead of merely being visible.

**Residual (does not reopen the finding, tracked elsewhere):** merge protection
blocks on severity and cannot express a per-query allow-list, so the remainder
of the alert policy is a documented manual control; image digest pinning remains
under ORG-PR-042; artifact signing and SLSA provenance remain out of scope under
ORG-PR-001.

## 21. Confidence assessment

| Claim | Confidence | Basis |
| --- | --- | --- |
| All 41 baseline alerts triaged and dispositioned | High | GitHub API read-back: 0 open, 5 `fixed`, 40 dismissed, 45 total (§11) |
| The audit-read defect is real | High | Query source read, index list read, no covering index exists, retention finding open |
| The audit-read fix works | High | 8 behavior-level tests including gate-ordering and both isolation dimensions |
| The 33 other rate-limit dismissals are correct | High | Each traced to a specific limiter line and key; existing tests cited per bucket |
| Password hashing is Argon2id-only | High | All seven call sites enumerated; behavior test proves no fast-hash fallback |
| Both modulo sites are unbiased | High | Arithmetic proof plus an assertion that now enforces the precondition |
| The secret-scan gate fails on a real finding | High | Remote run 30207672121, job-level and rule-level detail |
| The ruleset enforces the documented policy | High | A direct push to `main` was refused by GH013 naming all three rules, and PR #9 then merged only after all five required checks reported SUCCESS |
| No further true positives hide in the dismissed set | Medium | Every alert was individually traced, but 33 share one reasoning pattern; the audit-read case shows that pattern can be wrong |
| The demo bootstrap emits no credential | High | The real script is executed in test and its captured stdout/stderr asserted against literal AND shape patterns; a negative control proved the test fails when key creation is reinstated; the final CodeQL analysis reports **zero** `js/clear-text-logging` results |

The one remaining Medium rating is the honest one, and it is why the gate policy
forbids dismissing rate-limiting alerts by pattern.

## 22. Final readiness classification

```
C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

Unchanged. Sprint 22 hardened a CI control and fixed one application defect; it
shipped no deployment capability, and none of the P1 blockers moved.

## 23. Remaining P1 blockers

| Finding | Title |
| --- | --- |
| ORG-PR-001 | No production deployment automation |
| ORG-PR-002 | No production email provider (Mailpit-only) |
| ORG-PR-005 | No database backup / PITR / tested restore |
| ORG-PR-006 | No secrets management or rotation procedure |

ORG-PR-015 (no retention/cleanup) also remains open and now carries additional
weight: it is what makes ORG-PR-055's residual scan cost grow without bound.

## 24. Readiness for the next sprint

The Sprint 22 gateway is satisfied: scanners run remotely, fail correctly, are
required checks, and their findings are fully triaged with a stated policy. The
supply-chain and CI trust boundary is now a control rather than a report, which
was the precondition for building deployable artifacts.

## 25. Recommended next sprint

**Sprint 23 — Deployable artifact and pipeline (Phase 4, ORG-PR-001).**

Rationale: the CI gate is closed and enforced, so an artifact built by this
pipeline can now be trusted to have passed dependency, secret, and SAST review.
That was the ordering dependency Sprint 21 and 22 existed to satisfy.

Carry into Sprint 23 or the sprint that follows:

- **ORG-PR-055 residual** — an index over the audit target-id metadata keys, or
  retention under ORG-PR-015. The limiter bounds abuse; the query is still
  expensive.
- **ORG-PR-042** — image digest pinning, explicitly deferred to the artifact
  track.
- **Raise `required_approving_review_count` above 0** if a second maintainer
  joins; today it is 0 so that a single maintainer is not locked out, which
  means human review is the one part of the gate that is not enforced.
- **Historical sprint artifacts (9, 12, 21) are left unedited by design.** Each
  is a dated closing record of what was true when it closed, and two of them
  mention the demo seed printing an API key secret. That statement was accurate
  then and is preserved rather than rewritten, matching how Sprint 21's
  ORG-PR-020 judgement was handled. All *current* documentation is correct.
