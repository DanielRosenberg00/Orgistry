# Rotation & Secret Operations Runbook

Operator procedures for Orgistry's runtime secrets and its email provider.
Written for an engineer executing a rotation or handling an incident. The
design and guarantees behind these steps are in
[runtime-secrets.md](runtime-secrets.md); local service operation is in
[runbook.md](runbook.md).

**Every value in this document is a placeholder.** Never paste a real
credential into a shell that records history, a ticket, a screenshot, or a
commit.

**Applies to a deployment that does not exist yet.** Orgistry has no staging or
production environment and no deploy pipeline (ORG-PR-001 open), so "deploy" and
"restart" below mean whatever your platform does with the container artifacts in
[deployment-artifacts.md](deployment-artifacts.md). The procedures are written
to be platform-agnostic and have been rehearsed only against the production-like
compose reference.

## Contents

- [Injecting secrets at runtime](#injecting-secrets-at-runtime)
- [Rotate the access-token signing secret](#rotate-the-access-token-signing-secret)
- [Emergency: compromised JWT secret](#emergency-compromised-jwt-secret)
- [Emergency: invalidate sessions](#emergency-invalidate-sessions)
- [Rotate SMTP credentials](#rotate-smtp-credentials)
- [Rotate database and Redis credentials](#rotate-database-and-redis-credentials)
- [Validate external email delivery](#validate-external-email-delivery)
- [Sender domain: SPF, DKIM, DMARC](#sender-domain-spf-dkim-dmarc)
- [Email provider incident handling](#email-provider-incident-handling)
- [Roll back a bad mail configuration](#roll-back-a-bad-mail-configuration)
- [Collecting logs safely](#collecting-logs-safely)

## Injecting secrets at runtime

Two supported forms; pick one per variable (setting both is refused at boot).

**Direct environment value:**

```bash
JWT_SECRET=<value>
SMTP_PASSWORD=<value>
DATABASE_URL=postgres://<user>:<password>@<host>:5432/orgistry
```

**Mounted secret file** — the process reads the path itself:

```bash
JWT_SECRET_FILE=/run/secrets/jwt_secret
SMTP_PASSWORD_FILE=/run/secrets/smtp_password
```

Supported `_FILE` variables: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`JWT_PREVIOUS_SECRET`, `SMTP_USERNAME`, `SMTP_PASSWORD`.

Write a secret file without leaving the value in shell history:

```bash
install -m 0400 /dev/null /run/secrets/jwt_secret
openssl rand -hex 32 > /run/secrets/jwt_secret     # generated, never echoed
```

Rules the process enforces at boot: one terminal newline is stripped; an empty,
missing, unreadable, or directory path is refused; contents are never logged.
**A secret change takes effect only on process restart** — there is no hot
reload.

Generate a new signing secret:

```bash
openssl rand -hex 32      # 64 hex characters; clears the 32-char production floor
```

## Rotate the access-token signing secret

Routine rotation with **no user impact**. Access tokens signed with the outgoing
key keep verifying for the rest of their lifetime.

Preconditions: you can set two environment values (or two file mounts) and
restart the API.

1. **Generate** the new secret and place it where the deployment reads secrets
   from. Do not echo it.

   ```bash
   openssl rand -hex 32 > /run/secrets/jwt_secret.new
   ```

2. **Configure the swap.** The new value becomes `JWT_SECRET`; the value it
   replaces becomes `JWT_PREVIOUS_SECRET`.

   ```bash
   JWT_SECRET=<new value>
   JWT_PREVIOUS_SECRET=<the value JWT_SECRET had a moment ago>
   ```

   Or with files:

   ```bash
   JWT_SECRET_FILE=/run/secrets/jwt_secret.new
   JWT_PREVIOUS_SECRET_FILE=/run/secrets/jwt_secret
   ```

   The two values must differ — an equal pair is refused at boot as a no-op
   rotation. Both are held to the production strength rules.

3. **Restart / redeploy.** Boot fails loudly if either value is weak, a known
   development default, a placeholder, or equal to the other. Watch for a
   successful listen line before proceeding.

   ```bash
   curl -fsS https://<api-host>/health
   curl -fsS https://<api-host>/ready
   ```

4. **Verify new tokens use the current key.** Sign in with a test account and
   confirm the returned access token authenticates:

   ```bash
   curl -fsS -H "Authorization: Bearer <new access token>" https://<api-host>/v1/auth/me
   ```

5. **Wait out the window.** Tokens signed with the previous key remain valid for
   at most `AUTH_ACCESS_TOKEN_TTL_SECONDS` (default 900 s) from their issue
   time. Waiting one full TTL after the restart completes is sufficient; there
   is no reason to hold the window open longer, and every extra minute is extra
   time a leaked old key is useful.

6. **Complete the cutover.** Remove `JWT_PREVIOUS_SECRET` (and its `_FILE`
   variant) entirely.

7. **Restart again.** From this point only the current key verifies. Confirm a
   previously issued old-key token now returns 401 and that current sessions
   still work (refresh does not depend on this key).

8. **Destroy the retired value** in your secret store.

If you skip steps 2's previous-key half — i.e. you set only the new
`JWT_SECRET` — the rotation still works, but every access token issued before
the restart fails immediately. Clients that handle 401-then-refresh recover
silently; others surface an error until the user's next refresh.

## Emergency: compromised JWT secret

**This is NOT the routine procedure.** The goal is to make every outstanding
access token signed with the leaked key stop working *now*, accepting user
impact.

1. Generate a new secret (as above).
2. Set `JWT_SECRET` to the new value and **do not set**
   `JWT_PREVIOUS_SECRET`. If a rotation window is currently open and the leaked
   key is the previous one, remove `JWT_PREVIOUS_SECRET`.
3. Restart immediately.
4. Every access token signed with the leaked key is now rejected. **Refresh
   tokens and sessions are unaffected** — they do not depend on this key — so
   clients that refresh obtain working tokens without re-authenticating.
5. If the compromise may extend to session material (database exfiltration,
   stolen refresh cookies), the secret change is **not sufficient**. Continue
   with [Emergency: invalidate sessions](#emergency-invalidate-sessions).
6. Record the incident: what leaked, when, which key ids/values were retired,
   and the restart timestamps. Do not record the values.

Difference from routine rotation, stated plainly: routine rotation keeps a
previous key so nobody is interrupted; emergency rotation deliberately omits it
so the leaked key is worthless the moment the process restarts.

## Emergency: invalidate sessions

There is no session signing secret, so sessions cannot be invalidated by
rotating anything. Invalidation is a **database** operation against the
persisted session and refresh-token state
([session-lifecycle.md](session-lifecycle.md)).

Supported mechanisms, in increasing blast radius:

| Scope | Mechanism |
|---|---|
| One session | `DELETE /v1/auth/sessions/:sessionId` as the owning user (the API's session-management surface). |
| One user, all sessions | A password change or a completed password recovery revokes every session and refresh token of that user inside its transaction. This is the supported product path. |
| One refresh-token family | Automatic: presenting a consumed refresh token is classified as reuse and revokes the family plus its session. |
| Every session, platform-wide | **No API exists.** Operator SQL against the deployment database is the only mechanism. |

Platform-wide invalidation (operator SQL, no product surface — run it
deliberately and record it):

```sql
-- Revoke every session and every outstanding refresh token.
UPDATE sessions
   SET revoked_at = now(), revoked_reason = 'incident_response'
 WHERE revoked_at IS NULL;

UPDATE refresh_tokens
   SET revoked_at = now(), revoked_reason = 'incident_response'
 WHERE revoked_at IS NULL AND used_at IS NULL;
```

Every user must sign in again. Verify the column names against the current
migrations before running this — it is not covered by an automated test.

## Rotate SMTP credentials

User impact: none, provided the old credential stays valid until the restart
completes. Account email fails while the value is wrong.

1. **Create a replacement credential at the provider.** Prefer a second,
   additional credential over replacing in place — that is what makes the
   rollback in step 7 possible.
2. **Update the runtime source** (`SMTP_PASSWORD` or `SMTP_PASSWORD_FILE`, and
   `SMTP_USERNAME` if the provider issues a new identity). Placeholder-looking
   values are refused at boot in production.
3. **Restart / redeploy.** Required — the credential is read once at start.
4. **Validate authentication** without sending to a real user: trigger a
   password-recovery request for a mailbox you control.

   ```bash
   curl -fsS -X POST https://<api-host>/v1/auth/password-recovery/request \
     -H 'content-type: application/json' \
     -d '{"email":"<your-test-mailbox>"}'
   ```

   The endpoint always returns `{ accepted: true }` (it is enumeration-safe), so
   the response proves nothing on its own — confirm via the provider's
   accepted-message log and the mailbox.
5. **Validate real delivery.** Confirm the message arrives in the inbox, the
   `From` address is correct, and the link completes.
6. **Cut over.** Once delivery is confirmed, delete the old credential at the
   provider.
7. **Roll back** (before step 6): restore the previous value and restart. This
   is why step 1 adds rather than replaces.
8. **Failure testing.** To confirm failure handling is safe, point
   `SMTP_PASSWORD` at a deliberately wrong value in a non-production process and
   check that delivery fails closed and the logs carry a coarse provider error
   with no credential (see [Collecting logs safely](#collecting-logs-safely)).

## Rotate database and Redis credentials

1. Create the new credential **alongside** the existing one at the database (a
   second role, or a second password where the engine supports it). Orgistry has
   no dual-credential support: the old value must remain valid until every
   process has restarted.
2. Update `DATABASE_URL` / `DATABASE_URL_FILE` (or `REDIS_URL`).
3. Restart / redeploy; `/ready` reports the outcome per instance.
4. Revoke the old credential only after every instance is running on the new
   one.

Rotating `REDIS_URL` resets the fixed-window rate-limit counters (they are
ephemeral by design) and briefly fails `/ready`. Sensitive limiters fail
**closed** in production during the gap.

## Validate external email delivery

**Status: not performed.** No provider credentials, sender domain, or test
inbox exist in this repository's environments, so ORG-PR-002 remains open. This
is the exact procedure to close it.

Prerequisites: a provider account with implicit-TLS SMTP (port 465 —
Orgistry's driver offers no STARTTLS upgrade), a domain you control, and a
mailbox you can read.

1. **Configure a throwaway runtime.** Never commit these; use file mounts or a
   shell that does not persist history.

   ```bash
   NODE_ENV=production
   JWT_SECRET_FILE=/run/secrets/jwt_secret          # openssl rand -hex 32
   COOKIE_SECURE=true
   DATABASE_URL_FILE=/run/secrets/database_url
   REDIS_URL=redis://<host>:6379
   MAIL_DRIVER=smtp
   SMTP_HOST=<provider smtp host>
   SMTP_PORT=465
   SMTP_USERNAME_FILE=/run/secrets/smtp_username
   SMTP_PASSWORD_FILE=/run/secrets/smtp_password
   MAIL_FROM_EMAIL=no-reply@<your-domain>
   WEB_DEMO_URL=https://<your-web-origin>
   ```

2. **Verify the sender at the provider** and publish the DNS records it
   requires — see [Sender domain](#sender-domain-spf-dkim-dmarc). Do this
   *first*: most providers refuse to send from an unverified sender.

3. **Exercise every account-email family** against mailboxes you control, and
   record for each one whether the provider accepted it *and* whether it
   arrived:

   | Family | Trigger |
   |---|---|
   | Registration completion | `POST /v1/auth/register` |
   | Existing-account guidance | `POST /v1/auth/register` with an already-registered address |
   | Password recovery | `POST /v1/auth/password-recovery/request` |
   | Email verification | `POST /v1/auth/email-verification/request` (Bearer) |
   | Email-change verification | `POST /v1/auth/change-email` (Bearer) |
   | Organization invitation | `POST /v1/organizations/:organizationId/invitations` (Bearer) |

4. **For each delivered message, check:** the `From` matches
   `MAIL_FROM_EMAIL`/`MAIL_FROM_NAME`; the subject is the expected one; the
   link carries its token in the **fragment** (`#token=`) for the four auth
   families and in the **query string** for invitations (by design — see
   [invitations.md](invitations.md)); the body contains no other secret; the
   message carries no `List-Unsubscribe`/bulk semantics; and the emailed link
   actually completes the flow.

5. **Check the received headers** for `Authentication-Results` — SPF, DKIM, and
   DMARC verdicts. Save them as evidence with the mailbox identity removed.

6. **Confirm no credential leaked:** the application logs for the send must
   contain no SMTP password (see
   [Collecting logs safely](#collecting-logs-safely)).

7. **Record the evidence** in the Sprint 24 artifact package and the findings
   register: provider name, sender address, sender-domain verification state,
   date, per-family accepted/received results, and the SPF/DKIM/DMARC verdicts.
   Record message-ids, **never** credentials. Only then close ORG-PR-002.

Keep this off routine CI: it needs real credentials and sends real mail. If it
is ever automated, it must be a manually dispatched, environment-scoped workflow
that fork pull requests cannot reach.

## Sender domain: SPF, DKIM, DMARC

**Status: no sending domain exists.** Nothing below has been validated for
Orgistry; it is the procedure to follow once a domain is chosen.

| Item | What Orgistry controls | What the operator must do |
|---|---|---|
| `From` address | `MAIL_FROM_EMAIL` (production rejects reserved/non-routable domains) | Point it at a domain you control |
| `From` display name | `MAIL_FROM_NAME` | — |
| `Reply-To` | Not set — no reply address is emitted | Decide whether a monitored reply address is wanted (would need a code change) |
| Envelope sender / return path | Not set by Orgistry; the provider supplies it | Configure at the provider; it is what SPF authenticates |
| Sender/domain verification | — | Complete the provider's verification flow |
| SPF | — | Publish the provider's `include:` in the domain's `TXT` SPF record |
| DKIM | — | Publish the provider's DKIM public key at the selector it specifies; enable signing |
| DMARC | — | Publish `_dmarc.<domain>`; start at `p=none` with `rua=` reporting, then tighten |

Validate the published records before sending:

```bash
dig +short TXT <your-domain>                   # SPF
dig +short TXT <selector>._domainkey.<domain>  # DKIM
dig +short TXT _dmarc.<domain>                 # DMARC
```

DNS caveats: propagation is bounded by each record's TTL, so a change can take
hours to be visible everywhere; a domain may publish only **one** SPF TXT record
(merge providers into it rather than adding a second); and a provider's
verification check passing does not prove third-party receivers see the same
records. Treat a received message's `Authentication-Results` header as the
authoritative check.

If any of SPF/DKIM/DMARC cannot be validated, record it as **pending** with the
reason. Do not infer a passing verdict from the provider's own dashboard.

## Email provider incident handling

Symptoms: account email stops arriving, or invitation creation starts failing.

1. **Classify the failure.** Invitation creation and explicit verification
   resend are **fail-closed** (the API returns an error). Registration
   completion, guidance, password-recovery, and post-email-change verification
   emails are **best-effort** — the user-facing operation already succeeded and
   the failure is visible only in logs and security events. Consistency
   semantics per family: [email-and-verification.md](email-and-verification.md).
2. **Check the process, then the provider.** `/ready` does not probe SMTP, so a
   mail outage will not show there. Look for delivery errors in the API logs and
   the provider's status page/dashboard.
3. **Distinguish authentication failure (535) from connection/TLS failure from
   provider rejection (5xx on `MAIL`/`RCPT`).** The log carries a coarse
   category and the request id; it never carries the credential.
4. **If credentials were revoked or leaked**, follow
   [Rotate SMTP credentials](#rotate-smtp-credentials) and treat the old value
   as compromised.
5. **If the provider is down or throttling you**, there is no retry, no queue,
   and no outbox — Orgistry makes exactly one delivery attempt per request and
   undelivered best-effort messages are simply lost. Affected users recover by
   requesting a new recovery/verification link or by having the invitation
   re-sent once the provider recovers. There is no send-side rate limiter
   either: outbound volume is bounded only by the per-endpoint abuse limits on
   the flows that trigger email, so size the provider plan for your peak rather
   than expecting application backpressure. Full posture:
   [email-and-verification.md](email-and-verification.md#delivery-posture-retries-provider-limits-bounces).
6. **Bounces, complaints, and suppression lists are not implemented** — Orgistry
   ingests no bounce or feedback-loop notification and keeps no suppression
   list, so it will keep sending to a hard-bounced address. Monitor and act on
   these at the provider; repeated hard bounces damage sender reputation.

## Roll back a bad mail configuration

1. Restore the previous `MAIL_*`/`SMTP_*` values from the secret store and
   restart. Boot-time validation is the safety net: a configuration that would
   silently disable production email (`MAIL_DRIVER=mailpit`/`memory`, missing
   credentials, a reserved-domain sender) refuses to boot rather than starting
   in a broken state.
2. If the process refuses to boot, read the `ConfigValidationError` — it names
   every offending field and the fix, and never echoes the value.
3. Verify with a real send to a mailbox you control before declaring recovery.
4. **Never** "fix" a production mail failure by switching `MAIL_DRIVER` away
   from `smtp`; production refuses those drivers precisely so account email
   cannot be silently swallowed.

## Collecting logs safely

```bash
# Container logs for the API only, no interactive paging.
docker logs --since 30m <api-container> > /tmp/orgistry-api.log

# Confirm no credential is present before sharing the file.
grep -c -F "$SMTP_PASSWORD" /tmp/orgistry-api.log    # expect 0
```

Rules:

- Never run `env`, `printenv`, or `set -x` around secret values — a single
  traced command can put a credential in a CI log forever.
- Never paste raw provider logs without checking them for credentials first.
- Application logs are redacted by path (see
  [runtime-secrets.md](runtime-secrets.md#redaction-guarantees)), but provider
  and shell output are **not** — those are yours to sanitize.
- Share request ids, coarse failure categories, and timestamps; they are enough
  to correlate with provider logs.
