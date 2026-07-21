# Demo Walkthrough

A realistic, executable reviewer flow for exercising Orgistry end to end. It
requires nothing beyond the documented setup — no hidden manual steps. There are
two paths:

- **Automated bootstrap** (`pnpm demo:seed`) — populates a presentable demo state
  in seconds.
- **Manual flow** — click through the web demo yourself.

Both drive the **real public API**, so every backend invariant
(registration-completion provisioning, permissions, entitlements, quotas,
tenant isolation) holds exactly as in normal operation.

## 0. Prerequisites

```bash
pnpm install
cp .env.example .env
pnpm infra:up        # PostgreSQL, Redis, Mailpit (see docs/runbook.md)
pnpm db:migrate      # apply the migration baseline
```

If `pnpm infra:up` fails on a port (most often Postgres 5432), see the
[runbook port-conflict section](./runbook.md#handling-port-conflicts).

Start the API and web demo (in separate terminals, or `pnpm dev` for both):

```bash
pnpm dev:api         # http://localhost:3000
pnpm dev:web         # http://localhost:5173
```

Confirm health: `curl -s http://localhost:3000/ready` should report `postgres`
and `redis` healthy.

## Automated bootstrap: `pnpm demo:seed`

With the API running:

```bash
pnpm demo:seed
```

This drives the public API to create a presentable, **idempotent** demo state and
prints a summary. Re-running reuses existing state instead of duplicating it.
The seed logs in first; if the owner does not exist it registers, reads the
NEWEST registration-completion link from the Mailpit API (explicit
newest-first ordering, so stale messages and superseded links from earlier
runs cannot make it nondeterministic), and completes it — still driving only
the public HTTP API (registration is verification-first as of Sprint 18).
Both paths are runtime-validated against the real API + PostgreSQL + Redis +
Mailpit stack: the fresh registration-completion run and the idempotent
login-first re-run. It creates:

- a registered owner (`demo.owner@orgistry.local` / `demo-password-123` —
  **local-only**, not a secret) with an auto-provisioned personal workspace;
- a team organization **Acme Corp** on the **Pro** plan (so API keys and audit are
  unlocked);
- three projects;
- a pending invitation to `demo.invitee@orgistry.local` (email delivered to
  Mailpit);
- an API key whose **one-time secret** is printed, with a ready-to-run `curl` for
  the external API.

Then log in to the web demo at <http://localhost:5173> with the printed
credentials and explore. The audit log will already show the seeded actions.

> The seed prints an API key secret and the owner password. These are
> intentionally non-secret local demo values. Never reuse them outside a
> throwaway local database. To mint a fresh API key secret, revoke the existing
> key in the web demo and re-run `pnpm demo:seed`.

## Manual flow

Do the same journey by hand to see the permission-aware UX and backend-
authoritative errors.

1. **Start infrastructure** — `pnpm infra:up` (step 0).
2. **Start the API** — `pnpm dev:api`.
3. **Start the web demo** — `pnpm dev:web`, open <http://localhost:5173>.
4. **Register or log in.** Register a new account — registration is
   verification-first (Sprint 18): submitting the form shows a generic
   check-email confirmation (identical for every account state; nothing signs
   you in yet). Open Mailpit (<http://localhost:8025>), find **Complete your
   Orgistry registration**, and follow the
   `…/auth/complete-registration#token=…` link (the token rides in the URL
   fragment, which the browser never sends to any server): completion creates
   your account already email-verified, atomically provisions your **personal
   workspace**, and signs you in. Try the link a second time to see the
   single-use rejection. (Reload the page to see session restore via the
   refresh cookie.)
5. **Exercise the email-verification lifecycle (Sprint 16).** New accounts are
   created verified (the completion link was the mailbox proof), so no
   unverified banner appears after registration. To see the flow, change your
   email on the **Account security** page (requires your current password):
   the advisory unverified banner appears and a verification email for the
   new address lands in Mailpit. Follow the `…/auth/verify-email#token=…`
   link (fragment transport, like completion): the page captures it, removes
   it from the URL, submits it to the backend in a POST body, and shows
   success; the banner disappears once the refreshed current user reports
   `emailVerified: true`. Try the link a second time to see the single-use
   rejection, and use **Resend email** in the banner to see resend invalidate
   the older link. Verification is advisory — nothing is blocked while
   unverified.
6. **Recover a forgotten password (Sprint 17).** Log out, click **Forgot your
   password?** on the sign-in page, and submit your email. The page shows one
   generic confirmation (identical for unknown addresses — try one), and a
   reset email lands in Mailpit. Follow the `…/auth/reset-password#token=…`
   link (fragment transport, like verification), choose a new password, and
   note that success sends you to sign in — the reset revoked every session,
   so nothing auto-authenticates. The old password now fails; the reset link
   is single-use (try it again). On the **Account security** page you can also
   change your password (other sessions are signed out; the current one
   survives) and change your email (requires your current password; the new
   address starts unverified and gets its own verification email).
7. **Create / select an organization.** Use the org switcher to create a team
   organization (e.g. "Acme Corp"); you become its Owner. Switch between your
   personal workspace and the team org.
8. **View the overview.** The overview surfaces the selected org and your
   membership/role.
9. **Create a project.** On Projects, create one or more projects. On the **Free**
   plan you will hit `QUOTA_EXCEEDED` at `max_projects = 3` — a backend-authoritative
   error surfaced in the UI.
10. **Change the plan (optional).** On Plan & Entitlements, switch to **Pro** (demo
   plan change — no billing). Quotas widen and `api_keys_access` /
   `audit_log_access` unlock. Re-try the project create that was blocked.
11. **Invite a user and view Mailpit.** On Invitations, invite an email address.
   Open Mailpit at <http://localhost:8025> to read the invitation email; the raw
   token appears only here and in the emailed link. Following the link opens
   the invitation landing page (`/invitations/accept`), which inspects the
   token (organization, role, invited address), scrubs the token from the URL,
   and offers either direct acceptance (signed in) or the invited
   verification-first registration (signed out): the register page carries the
   invitation in transient memory, the check-email state follows, and the
   completion email finishes account + membership together.
12. **Create an API key and copy the one-time secret.** On API Keys, create a key
    with the `projects:read` scope. The raw secret is shown **once** — copy it now.
13. **Call the external read-only Projects API.** Use the secret as a bearer token
    against the tenant-derived external endpoint:

    ```bash
    curl -H "Authorization: Bearer orgistry_<displayId>_<secret>" \
      http://localhost:3000/v1/external/projects
    ```

    Note there is **no organization ID in the URL** — the tenant is derived from
    the key.
14. **View the audit log.** On Audit, see the org action events generated by the
    steps above (project created, invitation created, API key created, plan
    changed), with metadata sanitized.
15. **Observe permission-aware UX and backend-authoritative errors.** Invite a
    second user as a **Viewer**, accept from a second account, and confirm the
    Viewer sees disabled/absent admin controls (a UI hint) **and** receives
    `FORBIDDEN` from the API if a write is attempted directly. The backend, not
    the UI, is the authority.

## What this demonstrates

- The full identity/access chain: account → org → membership → role → permission
  → entitlement → quota → resource.
- Correct, attributable errors: `FORBIDDEN` (permission), `ENTITLEMENT_REQUIRED`
  (plan), `QUOTA_EXCEEDED` (capacity).
- Machine access decoupled from user sessions (API key → external API).
- The invitation lifecycle end to end, including local email delivery.
- The verification-first registration lifecycle end to end (enumeration-safe
  request → Mailpit completion link → transactional completion creating a
  verified account + workspace + session → single-use rejection).
- The email-verification lifecycle end to end (issue → deliver → complete →
  single-use rejection → resend invalidation), advisory by policy and reached
  via email change.
- The credential lifecycle end to end (enumeration-safe recovery request →
  fragment-transported reset link → single-use completion with full session
  revocation → fresh login; current-password-gated password/email change).
- The audit log as a sanitized, permission- and entitlement-gated read.

See [known limitations](./known-limitations.md) for what is intentionally out of
scope (no billing, no externally validated production email delivery,
demo-quality UI).
