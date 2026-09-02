# Sprint 29 Artifact — External Email Provider Closure

```
Status: COMPLETE
Sprint 29 DoD met:                   YES
ORG-PR-002:                          CLOSED 2026-09-02
ORG-PR-005:                          CLOSED (unchanged)
ORG-PR-006:                          OPEN (untouched by this sprint)
ORG-PR-007:                          OPEN (untouched by this sprint)
ORG-PR-009:                          OPEN (untouched by this sprint)
Provider:                            Resend — mail.drsvp.com, eu-west-1, smtp.resend.com:2465
Provider acceptance:                 VERIFIED
Provider reported delivered:         VERIFIED
Real external inbox receipt:         VERIFIED
SPF / DKIM / DMARC (received):       PASS / PASS / PASS
DKIM alignment:                      EXACT (d=mail.drsvp.com)
SPF alignment:                       RELAXED (org domain drsvp.com)
Provider link rewriting:             NOT OBSERVED
Wrong-credential failure class:      SATISFIED + restored + cleaned
Connection/provider failure class:   SATISFIED + restored + cleaned
Families with real inbox receipt:    2 of 6 (registration completion, existing-account guidance)
Staging ready:                       NO (ORG-PR-007 observability)
Production ready:                    NO (ORG-PR-006 P1 open)
```

**Date opened:** 2026-08-29 · **Finding:**
[ORG-PR-002](findings-register.md#org-pr-002)

This is a **living** artifact. Sections 2–7 and 9–12 describe **external facts
that do not yet exist**; they are structured and explicitly marked
`PENDING_OPERATOR` so real evidence can be dropped into a known place rather
than reconstructed later. **No section may be marked verified without
evidence.**

The seven states this artifact keeps strictly separate, because collapsing them
is the most common way an email sprint reports a false pass:

| # | Fact | Current |
|---|---|---|
| 0 | Provider **selected** | **YES — Resend** |
| 0a | **Transport reachable + fully verified TLS** from the staging host | **YES — port 2465, 2026-08-29** |
| 0b | Sending domain **added and provider-verified**, DNS published + resolving | **YES — 2026-08-30** |
| 0c | Credential created, installed in the protected boundary, and deployed | **YES — 2026-08-30** |
| 1 | Provider **configured end to end** (the credential actually **authenticates**) | **YES — 2026-08-30** |
| 2 | Provider **accepted** the message | **YES — 2026-08-30** |
| 2b | Provider **reported delivered** | **YES — 2026-08-30** |
| 3 | A real **inbox received** the message | **YES — real external Gmail mailbox** |
| 4 | **SPF passed** on the received message | **YES — `spf=pass`** |
| 5 | **DKIM passed** on the received message | **YES — `dkim=pass`, `d=mail.drsvp.com`** |
| 6 | **DMARC passed and was aligned** | **YES — `dmarc=pass`, `header.from=mail.drsvp.com`** |
| 7 | **Production email readiness** | **NO** — not because of email evidence, which is complete, but because ORG-PR-006 (secrets management) remains an open P1 blocker |

**Facts 0–6 are now evidenced (2026-08-30).** Fact 7 is not: production email
readiness additionally requires the mandatory real-provider failure evidence in
§14, which has not been collected. Each fact above was observed independently —
none was inferred from another, and delivery was **not** used to infer DMARC. Facts 4–6
are independent of each other and none implies fact 6: DMARC requires an
*aligned* pass, not merely a pass. Production email readiness (fact 7) requires
all of 1–6 plus the mandatory real-provider failure evidence in §14.

---

## 1. Implementation Summary

Sprint 29 opened against an unusually complete repository baseline. Phase A
discovery read the code rather than the specification summary and confirmed
that Sprints 16, 17, 18, and 24 had already delivered the account-mailer
boundary, the production SMTP driver, the fail-closed production config guard,
the runtime secret source for SMTP credentials, the failure-mode
credential-redaction proofs, the six-family matrix, and the operator validation
procedure.

**No application change proved necessary, and none was kept.**

The first iteration added an optional `MAIL_REPLY_TO` header. The refinement
iteration **reverted it in full**. The sprint specification treats reply-to as
runtime configuration *if supported*; no definition-of-done condition requires a
Reply-To header, a monitored reply mailbox, a Reply-To production policy, or any
new Reply-To application behaviour, and none existed before Sprint 29. Building
one was scope expansion.

Reverted to the exact pre-Sprint-29 state: the schema variable,
`Config.mail.replyTo`, `SenderIdentity.replyTo`, the transport header, the
factory wiring, the production reserved-domain rule, the helper extracted only
to support that rule, every Reply-To test, and the `.env.example` entry.
**Reply-To is not emitted** — as Sprint 24 already recorded in
[../rotation-runbook.md](../rotation-runbook.md#sender-domain-spf-dkim-dmarc)
and its own artifact.

Sprint 29's retained output is therefore **analysis and documentation**, not
code: the provider-selection gate below, the corrected authentication identity
model (§§3–7), and the corrected failure-validation boundary (§14).

**Deliberately not built** (all out of scope, all still absent): durable
outbox, retry queue, bounce/complaint webhooks, suppression management,
secrets-management platform, automated rotation, observability stack, alert
routing. **No provider-specific branching exists** — the mailer remains
provider-agnostic.

### Provider endpoint compatibility gate — decide before provisioning

The `smtp` driver uses **implicit TLS from the first byte (SMTPS, conventionally
port 465)** and offers **no STARTTLS upgrade** (`smtp-transport.ts`,
`secureTransport: true`; driver test *"refuses a plaintext server (implicit TLS
is unconditional for this driver)"*). A provider endpoint that only offers
STARTTLS on 587/25 will fail closed and deliver nothing.

**Transport sufficiency is now EVIDENCED (2026-08-29), not merely assumed.**
The credential-free check in §9 completed a fully verified implicit-TLS session
against `smtp.resend.com:2465` from `orgistry-staging-01`. The existing
driver's implicit-TLS-only posture is therefore **confirmed compatible with the
selected provider in this environment, with no code change and no STARTTLS**.

Two caveats are preserved rather than smoothed over: the verified endpoint is
port **2465**, because port **465 timed out from this host** (§9 — cause not
established); and transport sufficiency is only the *transport* half. Nothing
about authentication, sender authorization, acceptance, or delivery follows
from it.

STARTTLS was **not** implemented, and there is now no evidenced requirement for
it — the selected provider's endpoint speaks implicit TLS as the driver
requires. Had it not, an explicit transport-security mode in configuration
would have been the correct scoped change; an opportunistic upgrade would be
downgrade-attackable and is rejected.

## 2. Provider Selection

**Status: `SELECTED` — account created and sending domain verified (§§3–4); SMTP credential not yet created.**

**Provider: Resend.** This is the operator's provider-selection decision,
recorded 2026-08-29.

Provider selection is one state among several, and only the first is currently
true. This artifact never collapses them:

| State | Current |
|---|---|
| **Provider selected** | **YES — Resend** |
| **Provider account created** | **YES** |
| **Sending domain verified at provider** | **YES — `mail.drsvp.com`, `eu-west-1`, 2026-08-30** |
| **SMTP credential created + installed + deployed** | **YES — 2026-08-30 (§19)** |
| Provider accepted a message | NO |
| Real inbox received a message | NO |

### Recorded provider-documentation facts

Independently verified from current Resend documentation. These are
**provider-documentation evidence only** — nothing here has been externally
observed from Orgistry, and no inference beyond these statements is drawn.

| Fact | Value |
|---|---|
| SMTP host | `smtp.resend.com` |
| Implicit TLS / SMTPS port | `465` |
| Additional documented SSL port | `2465` |
| Recommended SSL/SMTPS port | `465` |
| SMTP username | `resend` |
| SMTP password credential type | Resend API key |
| Transport compatibility | The current Orgistry SMTP transport **appears protocol-compatible without a code change** |
| Open/click tracking default | **Disabled by default** at the domain level |
| Custom Return-Path | Supported |
| Default Return-Path subdomain | `send` |
| Custom Return-Path role | Used for SPF authentication, DMARC alignment, and bounce handling |
| Free-plan limits | 3,000 emails/month · 100/day · 3 verified domains |

**Not yet recorded, and not to be inferred from the above:** provider account
existence, domain verification, TLS certificate validity as observed from the
staging host, provider acceptance, inbox delivery, SPF pass, DKIM pass, or
DMARC pass.

### Selection rationale

- The current Orgistry transport requires **authenticated implicit TLS**
  (§1) — this was the binding constraint.
- Resend documents an **SMTPS endpoint on port 465**, which matches the
  existing driver **without speculative STARTTLS work**.
- It supplies **username/password-style SMTP authentication**, compatible with
  the existing `SMTP_USERNAME` / `SMTP_PASSWORD` config surface and its
  `<NAME>_FILE` runtime secret source, with no schema change.
- **Tracking is disabled by default**, reducing account-link rewriting risk for
  token-bearing mail (§7 of this section's concerns; see also §13).
- The current **free quota is sufficient for the Sprint 29 validation matrix**
  (see *Quota posture* below).
- **Custom Return-Path support** yields useful SPF/DMARC/bounce evidence for
  §§5–7 and §16.

### Rejected alternative — evidence the selection gate was real

**Postmark was not selected for the current transport because its current
documented SMTP endpoints use STARTTLS and it explicitly does not support
implicit TLS on port 465.**

This is recorded solely to show the provider-selection gate in §1 was a real
constraint that excluded a credible candidate, not a hypothetical one. No
broader provider comparison is documented or intended.

### Tracking safety (verified provider fact + required setting)

Resend's **open and click tracking are disabled by default**. For Sprint 29
account-critical mail they **must remain disabled**, and tracking must not be
enabled.

Reason: verification, recovery, invitation, and lifecycle messages may carry
**live account tokens**. Link rewriting would route those credentials through a
provider tracking redirect — a third party would observe a usable credential,
and the emailed link would no longer be the application's own URL. During real
inbox validation (§§10–13) the delivered account links must be verified to
remain byte/semantically equivalent to the application's generated URLs and
**not rewritten**.

### Return-Path posture

Recorded as **provider capability, not observed state**: Resend supports a
custom Return-Path and documents that it participates in SPF authentication,
DMARC alignment, and bounce handling. Its default Return-Path subdomain is
`send`.

A custom Return-Path is **not configured in this iteration** and will not be
unless the domain-provisioning flow requires it. **The final envelope identity
is not inferred** — the received message's `Return-Path` and
`Authentication-Results` remain the authority (§3, §5, §12).

### Quota posture

Current verified Free-plan limits: **3,000 emails/month, 100 emails/day, 3
verified domains.**

These limits are **sufficient for the small controlled Sprint 29 validation
matrix** (six families, a handful of sends each, plus the mandatory failure
cases). **This is a Sprint-validation sufficiency statement only and is
explicitly NOT a production-capacity claim.** Future production suitability
remains a separate scale and plan decision, and §17 stays `UNVERIFIED` for any
production-scale assessment.

### Endpoint configuration to be used once provisioning begins

Not yet installed anywhere. Recorded so the next iteration has an unambiguous
target. The port reflects the **observed** staging result, not the provider's
general recommendation:

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.resend.com` — **transport verified from staging (§9)** |
| `SMTP_PORT` | **`2465`** — the verified operational SMTPS endpoint for this environment; `465` timed out from the staging host (§9) |
| `SMTP_USERNAME` | `resend` — a **public provider constant**, not a secret |
| `SMTP_PASSWORD` | Resend **sending-access** API key, domain-restricted to `mail.drsvp.com` — secret; never a shell argument, never committed, never pasted into evidence |
| `MAIL_DRIVER` | `smtp` |
| `MAIL_FROM_EMAIL` | `no-reply@mail.drsvp.com` (§3 — established `no-reply` convention) |
| `MAIL_FROM_NAME` | `Orgistry` |

**No provider-specific application coupling was added**: no SDK, no API client,
no Resend-specific branch, no custom headers, no webhook handling, no bounce or
suppression ingestion, no tracking headers. Orgistry continues to use generic
SMTP, and the provider selection lives entirely in runtime configuration and in
this document.

## 3. Sender Domain Strategy

**Status: `VERIFIED` for domain identity and DNS; received-message
authentication remains pending.**

| Field | Value | State |
|---|---|---|
| Root domain (operator-controlled) | `drsvp.com` | supplied by operator |
| **Sending domain (transactional subdomain)** | **`mail.drsvp.com`** | **VERIFIED at provider** |
| Authoritative DNS | Cloudflare | supplied by operator |
| Resend region | **`eu-west-1` (Ireland)** | **VERIFIED** |
| Resend domain status | **Verified** | **VERIFIED** (dashboard) |
| `MAIL_FROM_EMAIL` (`RFC5322.From`) | `no-reply@mail.drsvp.com` | derived from the repository's established convention — see below |
| `MAIL_FROM_NAME` | `Orgistry` | repository default |
| Return-Path subdomain (provider default) | `send.mail.drsvp.com` | DNS **VERIFIED**; *final envelope identity as received* still pending |
| DKIM selector | `resend` | DNS **VERIFIED**; *observed `d=`* still pending |

The dedicated transactional subdomain strategy documented since the first
Sprint 29 iteration was followed: `mail.drsvp.com` isolates transactional
reputation and lets SPF/DKIM/DMARC be published without touching the root
domain's records. **No production web or API DNS was changed** — this sprint
touches email sender-domain DNS only.

**Sender local-part is not a new decision.** `no-reply` is the repository's
established convention, not an invention here: `.env.example`
(`MAIL_FROM_EMAIL=no-reply@orgistry.local`),
[../rotation-runbook.md](../rotation-runbook.md) (`no-reply@<your-domain>`),
[../deployment.md](../deployment.md) (`no-reply@<a domain the operator
controls>`), and `infra/compose.production-like.yml`
(`no-reply@smoke.orgistry.dev`) all use it.

### Message identities — what Orgistry does and does not determine

| Identity | What it is | Who determines it |
|---|---|---|
| **`RFC5322.From`** | The visible message `From:` header. **The central identity DMARC evaluates.** | **Orgistry, directly**, via `MAIL_FROM_EMAIL` |
| **Initial `RFC5321.MailFrom`** | The SMTP envelope sender Orgistry presents at submission. `smtp-transport.ts` never sets nodemailer's `envelope`, so under nodemailer's documented default it is **derived from the message `from`** — i.e. from `MAIL_FROM_EMAIL`. **Initial value at the Orgistry → provider boundary only; NOT proof of the final envelope identity.** | Orgistry, indirectly (derived) |
| **Final `RFC5321.MailFrom`** | What the provider actually transmits onward. The published Return-Path MX at `send.mail.drsvp.com` (→ `feedback-smtp.eu-west-1.amazonses.com.`) indicates the provider **intends** to use its own bounce path — but the transmitted value is still **unobserved**. | Provider — observed, never assumed |
| **`Return-Path`** | The envelope sender as recorded by the receiving system; authoritative record of the final `RFC5321.MailFrom`. | Receiving system |
| **`Reply-To`** | **Not emitted by Orgistry.** Not a DMARC authentication identifier; irrelevant to alignment. | — |

The published SPF record delegates to `amazonses.com`, and the Return-Path MX
points at an Amazon SES feedback host — consistent with Resend operating on SES
underneath. **This is a DNS observation, not an authentication result.** What
domain SPF is finally evaluated against, and whether it aligns with
`RFC5322.From`, can only come from a received message (§5).

## 4. DNS Configuration and Verification

**Status: DNS published, publicly resolving, and provider-verified
(2026-08-30). Received-message authentication remains PENDING.**

The four states are kept strictly separate and only the first three are
evidenced:

| # | Fact | State |
|---|---|---|
| 1a | DNS records **published** at Cloudflare | **VERIFIED** |
| 1b | DNS records **publicly resolve** | **VERIFIED** — operator resolved each independently, 2026-08-30 |
| 2 | **Resend reports the domain verified** | **VERIFIED** — `mail.drsvp.com — Verified`, region `eu-west-1` |
| 3–6 | **Received email shows SPF/DKIM/DMARC results** | **PENDING** — no message has been sent or received |

Publishing is not resolving; resolving is not provider verification; and
provider verification is **not** an authentication result on a delivered
message. **No received-message result is inferred from DNS.**

### Published records

| Record type | Host / name | Purpose | Observed value | Provider state |
|---|---|---|---|---|
| `TXT` | `send.mail.drsvp.com` | SPF for the Return-Path domain | `v=spf1 include:amazonses.com ~all` | **Verified** |
| `MX` | `send.mail.drsvp.com` | Return-Path / bounce handling | priority `10` → `feedback-smtp.eu-west-1.amazonses.com.` | **Verified** |
| `TXT` | `resend._domainkey.mail.drsvp.com` | DKIM public key, selector `resend` | RSA public key (`p=MIGfMA0GCSqGSIb3…`, **truncated deliberately**) | **Verified** |
| `TXT` | `_dmarc.mail.drsvp.com` | DMARC policy | `v=DMARC1; p=none` | **Verified** |

Public DNS values are **not secrets**, but evidence is kept to what is
operationally necessary: the full DKIM public key is **not reproduced** — the
selector (`resend`), key type (RSA), and verification result are sufficient.

**DKIM signing domain.** The DNS identity implies a signing domain of
`mail.drsvp.com` with selector `resend`. The **actual `d=` on a received
message is unverified** and is recorded separately in §6.

**DMARC policy is `p=none`, deliberately.** This is an initial staging
validation / observation policy: no enforcement is introduced before real
received-message authentication evidence exists. Recording an explicit `p=none`
record is itself evidence (a DMARC record is published and resolves) and is
**not** a DMARC pass. Tightening the policy is a later decision, gated on §7.

## 5. SPF Evidence — VERIFIED 2026-08-30

**DNS: VERIFIED. Received-message verdict: VERIFIED.**

Published record: `TXT send.mail.drsvp.com` = `v=spf1 include:amazonses.com ~all`.

Observed on the received Gmail message:

| Item | Observed |
|---|---|
| Verdict | **`spf=pass`** |
| **Authenticated SMTP domain** | **`send.mail.drsvp.com`** — the envelope-from / `Return-Path` domain, **not** the header `From` |
| `RFC5322.From` domain | `mail.drsvp.com` |
| **DMARC SPF alignment** | **PASS under RELAXED alignment** |
| Why relaxed and not exact | `send.mail.drsvp.com` ≠ `mail.drsvp.com`, but both share the organizational domain **`drsvp.com`**. Relaxed alignment accepts an organizational-domain match; **strict alignment would NOT pass on SPF here** |

This is exactly the identity separation §3 predicted: SPF authenticated the
provider's Return-Path domain, and alignment to `From` is what made it count
for DMARC.

## 6. DKIM Evidence — VERIFIED 2026-08-30

**DNS: VERIFIED. Received-message verdict and observed `d=`: VERIFIED.**

Published record: `TXT resend._domainkey.mail.drsvp.com` (RSA, selector
`resend`; public key not reproduced).

Observed on the received Gmail message:

| Item | Observed |
|---|---|
| Verdict | **`dkim=pass`** |
| **Aligned signing domain** | **`d=mail.drsvp.com`** |
| **Selector** | **`s=resend`** |
| `RFC5322.From` domain | `mail.drsvp.com` |
| **DMARC DKIM alignment** | **EXACT** — `d=` equals the `From` domain |

**A second signature is present and also passes, with `d=amazonses.com`.** That
is the provider/SES infrastructure signature. **It is NOT aligned with the
Orgistry `From` identity** and is not the signature DMARC alignment relies on
here — it must never be presented as an Orgistry-aligned result. The aligned
identity is `d=mail.drsvp.com` alone.

The DNS identity predicted `mail.drsvp.com` / selector `resend`; the **observed**
values confirm it. That confirmation is the evidence — the DNS was only a
prediction.

## 7. DMARC Evidence — VERIFIED 2026-08-30

**DNS: VERIFIED. Received-message verdict and alignment: VERIFIED.**

Published record: `TXT _dmarc.mail.drsvp.com` = `v=DMARC1; p=none`.

Observed on the received Gmail message:

| Item | Observed |
|---|---|
| Verdict | **`dmarc=pass`** |
| Evaluated identity | **`header.from=mail.drsvp.com`** (`RFC5322.From`) |
| Policy in force | **`p=NONE`** |
| Aligned mechanisms present | **both** — DKIM aligned **exactly** (`d=mail.drsvp.com`), and SPF aligned under **relaxed** alignment (`send.mail.drsvp.com` → org domain `drsvp.com`) |

**Cited from the received `Authentication-Results` header, not inferred from
delivery.** Under `p=none` a non-aligned message would still have been
delivered, so arrival proves nothing about authentication — the header is the
evidence, and it is unambiguous.

**Strength note.** DKIM carries the alignment *exactly*, which is the durable
result: a DKIM signature survives forwarding, whereas SPF alignment breaks on it.
This message therefore holds up better than one that passed on SPF alone.

### Supplementary transport observation (not an authentication result)

The received headers show delivery from an Amazon SES outbound host in
**`eu-west-1`** to Gmail over **TLS 1.3**, consistent with the Resend Ireland
sending region selected in §2. This is a single-message transport observation
recorded for completeness. **It is not a data-residency claim** — no assertion is
made about where mail is processed or stored in general, and none is supported
by one message's headers.

## 8. Staging Runtime SMTP Configuration

**Status: `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`, with sufficiency conditional
on provider selection (§1).** Every variable below exists, is validated, and is
settable through the existing runtime secret boundary. No real provider values
have been installed.

| Concern | Variable | Supported | Notes |
|---|---|---|---|
| SMTP host | `SMTP_HOST` | yes | Required when `MAIL_DRIVER=smtp`. Staging value: `smtp.resend.com` (transport verified, §9) |
| SMTP port | `SMTP_PORT` | yes | Schema default is `465`; **staging must set `2465`** — 465 timed out from the staging host while 2465 verified (§9). Pure runtime configuration; no code change and no schema change |
| TLS behaviour | — | fixed | Implicit TLS, verification always on; no toggle by design. **Confirmed against the real endpoint on 2465** (§9) |
| Username | `SMTP_USERNAME` / `SMTP_USERNAME_FILE` | yes | Runtime env **or** mounted file |
| Password | `SMTP_PASSWORD` / `SMTP_PASSWORD_FILE` | yes | Runtime env **or** mounted file; never in Git |
| From address (`RFC5322.From`) | `MAIL_FROM_EMAIL` | yes | Production rejects local/reserved domains |
| Sender display name | `MAIL_FROM_NAME` | yes | RFC 2047-encoded when non-ASCII |
| Reply-To | — | **not emitted** | No application capability; unchanged from Sprint 24, and deliberately not added in Sprint 29 |
| Envelope sender | — | not independently configurable | Derived by nodemailer from `from` unless the provider rewrites it (§3) |

### Proposed staging `runtime.env` additions/changes

Non-secret values (safe to record here):

```
MAIL_DRIVER=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=2465
SMTP_USERNAME=resend
MAIL_FROM_EMAIL=no-reply@mail.drsvp.com
MAIL_FROM_NAME=Orgistry
```

Secret value — **not recorded, not requested, never pasted**:

```
SMTP_PASSWORD=<Resend sending-access API key>      # Option A (see §18.3)
# or, only if Option B's read-only volume is added first:
# SMTP_PASSWORD_FILE=<mounted path inside the API container>
```

`SMTP_USERNAME_FILE` offers **no benefit here**: `resend` is a public provider
constant, not secret material, so file-backing it would add a mount dependency
for a non-secret. Keep `SMTP_USERNAME=resend` direct and file-back only the key
if Option B is chosen.

`MAIL_REPLY_TO` is **not** reintroduced — reverted in refinement and out of
scope (§1).

Preserved and unchanged by this sprint:

- **deployment-by-digest** — mail configuration is runtime environment only;
  changing it requires no image rebuild;
- **runtime secret boundary** — `SMTP_USERNAME`/`SMTP_PASSWORD` resolve through
  `resolveSecretSources` before any production guard runs, so a file-backed
  credential receives byte-identical validation;
- **`/health` and `/ready`** — unchanged; `/ready` still probes only PostgreSQL
  and Redis;
- **SMTP connectivity remains lazy.** Nothing connects to the provider at boot
  or during readiness. Stated honestly: a wrong `SMTP_HOST` produces a healthy,
  ready process that fails on first send. Making `/ready` perform a live SMTP
  check was explicitly **not** done — it would couple readiness to a third
  party and cause rolling restarts to fail during provider incidents.

## 9. Provider Connectivity Evidence

**Status: `PENDING_OPERATOR`.** No connection to `smtp.resend.com` — or any
external SMTP endpoint — has been attempted from any environment.

Local fake-server and Mailpit evidence proves Orgistry speaks SMTP correctly.
It is **not** provider connectivity evidence and is never presented as such.

### Step 1 — unauthenticated transport check (next operator action)

The first external step is deliberately **credential-free**: it validates the
public endpoint from the real staging-like host (`orgistry-staging-01`) *before*
any API key exists, so a transport or egress problem is diagnosed without a
secret in play.

It proves exactly **five separate** things and nothing more. They are listed
separately so this artifact cannot overclaim from a single "TLS worked":

| # | Property | Proven by | Why it matters |
|---|---|---|---|
| 1 | **DNS resolution** of `smtp.resend.com` from the host | the connect step resolving at all | the deployed host, not a workstation, must resolve it |
| 2 | **TCP connection** to port `465` | the socket opening | egress firewalls commonly block submission ports |
| 3 | **TLS handshake** completes (implicit TLS from the first byte) | a negotiated protocol + cipher | confirms SMTPS, matching the driver's transport |
| 4 | **Trusted CA-chain verification** | `-verify_return_error` making a chain failure fatal, with `Verification: OK` | the driver appends extra CAs to system roots and never disables verification |
| 5 | **Certificate hostname verification for `smtp.resend.com`** | **`-verify_hostname smtp.resend.com`** | see the correction note below — this is a *separate* check from 4 |

**Correction (recorded so the earlier weaker command is not reused).** An
earlier revision of this section used `-servername smtp.resend.com` together
with `-verify_return_error` and described that as proving certificate/hostname
verification. **It does not.** `-servername` only sets the TLS **SNI
extension** — what the client *asks* for; it does not check what the server
*presented*. `-verify_return_error` makes certificate-**chain** verification
failures fatal, but hostname identity verification is a distinct OpenSSL
verification option. Without an explicit `-verify_hostname` (or `-checkhost`),
`s_client` can complete with a valid chain for the **wrong** name. Property 5
therefore requires `-verify_hostname smtp.resend.com` explicitly. **SNI is never
to be equated with hostname verification anywhere in this artifact.**

The check explicitly does **not** authenticate, does not send `MAIL FROM`, and
does not send mail. Verification must not be disabled, `-verify_quiet` must not
be used (it hides the evidence being collected), and the check must not be left
sitting in an interactive SMTP session.

**Preflight — the host's OpenSSL must support every flag used:**

```bash
openssl version

openssl s_client -help 2>&1 \
  | grep -E -- '-servername|-verify_return_error|-verify_hostname|-brief'
```

If `-brief` is unavailable it may be omitted (output is longer; verification
semantics are unchanged). **If `-verify_hostname` is unavailable, do NOT weaken
the test and do NOT substitute SNI as hostname verification** — stop and report
the OpenSSL version and the available verification flags instead.

**Check (run on `orgistry-staging-01`, not a workstation):**

```bash
openssl s_client \
  -connect smtp.resend.com:465 \
  -servername smtp.resend.com \
  -verify_hostname smtp.resend.com \
  -verify_return_error \
  -brief </dev/null

echo "openssl_exit=$?"
```

`</dev/null` closes stdin immediately so no interactive SMTP session is left
open. **No credential is involved.**

### Result — RECEIVED 2026-08-29, from `orgistry-staging-01`

**The credential-free transport check was executed on the real DigitalOcean
staging-like host. No credential was used, no authentication occurred, and no
message was sent.**

#### Port reachability — observed fact

| Port | TCP result | Status |
|---|---|---|
| `465` | `tcp465_exit=124` — connection attempt **timed out** | **NOT reachable from this host** |
| `2465` | `tcp2465_exit=0` — connection **succeeded** | **Reachable** |

> **Port 465 timed out from the DigitalOcean staging target; port 2465 is the
> verified operational SMTPS endpoint for this environment.**

The *cause* of the 465 timeout is **not** established and is deliberately not
asserted — no evidence was gathered about egress filtering, provider-side
behaviour, or routing. Only the observed outcome is recorded. Resend documents
both 465 and 2465 as SSL/SMTPS ports (§2), so 2465 is a documented endpoint,
not a workaround.

#### Verified properties — implicit TLS on `smtp.resend.com:2465`

All five properties **VERIFIED** (`openssl2465_exit=0`):

| # | Property | Result | Observed evidence |
|---|---|---|---|
| 1 | DNS resolution of `smtp.resend.com` from the host | **VERIFIED** | resolved, including `54.157.71.137` and `54.205.195.44` |
| 2 | Outbound TCP to Resend on port `2465` | **VERIFIED** | `tcp2465_exit=0`; `CONNECTION ESTABLISHED` |
| 3 | Implicit-TLS handshake (TLS from the first byte) | **VERIFIED** | Protocol `TLSv1.3`, cipher `TLS_AES_256_GCM_SHA384`, temporary key `X25519` |
| 4 | Trusted CA-chain verification | **VERIFIED** | `Verification: OK` under `-verify_return_error` |
| 5 | Certificate hostname verification for `smtp.resend.com` | **VERIFIED** | `-verify_hostname smtp.resend.com`; `Verified peername: *.resend.com` |

Sanitized certificate facts: peer certificate `CN = *.resend.com` (a wildcard
covering `smtp.resend.com`), signature type **ECDSA**, signature hash
**SHA256**. Host-identifying details are not recorded.

| — | SMTP `220` greeting | Not recorded | Optional and non-evidential; stdin closure may end the command immediately after a verified handshake. Its absence is a complete pass for 1–5. |

#### What this evidence proves

The **transport half** of the provider integration is now externally
demonstrated: this host can reach Resend's SMTPS endpoint and complete a
fully verified implicit-TLS session against it. This resolves the §1
conditional **at the transport layer** — the existing driver's
implicit-TLS-only posture is compatible with the selected provider **in this
environment, on port 2465**, with **no code change and no STARTTLS**.

#### What this evidence does NOT prove

Explicitly still unproven, and not inferable from a TLS handshake:

Resend account provisioning · SMTP authentication · API-key validity ·
sender-domain authorization · message acceptance · real inbox delivery · SPF ·
DKIM · DMARC · bounce behaviour · production email readiness.

Those all remain `PENDING_OPERATOR` in §§2–7 and §§10–12, unchanged by this
result.

## 10. Account Email Family Validation Matrix

Six families exist, confirmed by reading the code. Implementation and local test
evidence are real; every real-provider column is `PENDING_OPERATOR`.

| # | Family | Trigger (deployed app) | Token transport | Local evidence | Provider accepted | Inbox receipt | SPF | DKIM | DMARC aligned |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Registration completion | `POST /auth/register` (new address) | fragment `#token=` | proven | pending | pending | pending | pending | pending |
| 2 | Existing-account guidance | `POST /auth/register` (existing address) | **none** | proven | pending | pending | pending | pending | pending |
| 3 | Password recovery | `POST /auth/password-recovery/request` | fragment `#token=` | proven | pending | pending | pending | pending | pending |
| 4 | Email verification | authenticated verification request/resend | fragment `#token=` | proven | pending | pending | pending | pending | pending |
| 5 | Email-change verification | `POST /auth/change-email` (after commit) | fragment `#token=` | proven | pending | pending | pending | pending | pending |
| 6 | Organization invitation | invitation create | **query string** `?token=` | proven | pending | pending | pending | pending | pending |

For each family the completed matrix must additionally record: synthetic
staging-only recipient, timestamp, subject, sender as received, token/link
hygiene, account-flow completion, and token-leak status.

**No family was invented.** There is no separate email-change renderer — family
5 reuses the verification renderer with `trigger: 'email_change'`.

## 11. Real Inbox Delivery Evidence — VERIFIED 2026-08-30

**The success proof chain is complete.** Executed once; **not to be repeated.**

### 11.1 Application-side evidence — VERIFIED

| Item | Observed |
|---|---|
| Request | `POST /v1/auth/register` |
| Correlation request id | `sprint29-first-send-20260830T131057Z` (preserved by the API, as `resolveRequestId` predicted) |
| HTTP status | **200** |
| Response body | `{"ok":true,"data":{"accepted":true}}` |
| `security_events` event type | `auth.registration_requested` |
| actor type | `anonymous` |
| **metadata `outcome`** | **`sent`** |
| **metadata `delivered`** | **`true`** |
| request id (row) | `sprint29-first-send-20260830T131057Z` |
| created at | `2026-08-30 13:11:34.730202+00` |

**`application send attempt succeeded: VERIFIED`.**

The HTTP response alone proves nothing — it is byte-identical on failure. The
**database row** is the application-side record, exactly as §7 derived, and it is
what makes this a verified send attempt rather than a served request.

### 11.2 Provider evidence — VERIFIED

| Item | Observed |
|---|---|
| From | `"Orgistry" <no-reply@mail.drsvp.com>` |
| Created at | `2026-08-30 13:11:34.784000+00` |
| Subject | `Complete your Orgistry registration` |
| **Provider final event** | **`delivered`** |

Recorded as two separate facts:

- **`provider acceptance: VERIFIED`** — the message exists at Resend, so SMTP
  authentication against `smtp.resend.com:2465` with the installed credential
  **succeeded**. This is the first proof the credential actually works.
- **`provider-reported delivery: VERIFIED`** — distinct from acceptance, and
  distinct again from mailbox receipt below.

The provider's stored text payload retained a **direct application URL** at
`https://staging.drsvp.com/auth/complete-registration#token=<REDACTED>` — no
provider redirect wrapper. See §11.4.

### 11.3 Real mailbox receipt — VERIFIED

Received by a **real external Gmail mailbox** (address deliberately not
recorded).

| Item | Observed |
|---|---|
| Visible From | `Orgistry <no-reply@mail.drsvp.com>` |
| Subject | `Complete your Orgistry registration` |
| Received time | corresponds to the provider/application send |

**`real external inbox receipt: VERIFIED`.**

**Placement (inbox vs spam/junk) is NOT evidenced** and is deliberately kept
distinct — receipt does not establish placement, and it is not inferred from it.

### 11.4 Return-Path — VERIFIED

| Item | Observed |
|---|---|
| **Final envelope-sender domain** | **`send.mail.drsvp.com`** |
| Local part | provider-generated; **not reproduced** — it carries no evidential value |

**`final RFC5321.MailFrom / Return-Path identity observed: VERIFIED`.**

This settles the §3 open question empirically: the provider **did** substitute
its own Return-Path domain rather than transmitting `MAIL_FROM_EMAIL` as the
envelope sender. The initial envelope sender nodemailer derives from
`MAIL_FROM_EMAIL` is *not* what the recipient observed — precisely why the
identity model insisted that only a received message settles this.

### 11.5 Link and token transport — VERIFIED, no rewriting

The delivered message is `Content-Transfer-Encoding: quoted-printable`. In the
raw EML the URL therefore appears with **MIME transport encoding**:

- a trailing `=` at end of line is a **soft line break**, not part of the URL;
- `=3D` is the quoted-printable escape that **decodes to `=`**.

**This is transport encoding, not link rewriting**, and must not be
misclassified as such. After MIME decoding the received link retains exactly the
application-generated structure:

| Property | Observed | Expected from `buildRegistrationCompletionUrl` |
|---|---|---|
| scheme | `https` | `https` |
| host | `staging.drsvp.com` | the `WEB_DEMO_URL` origin |
| path | `/auth/complete-registration` | same |
| query | **absent** | absent |
| fragment | **present** | present |
| fragment key | **`token`** | `token` |
| provider tracking / redirect host | **absent** | absent |

**`provider link rewriting: NOT OBSERVED / VERIFIED`**
**`fragment token transport preserved: VERIFIED`**

Tracking was disabled by default at the domain and left disabled (§2); this is
the observed confirmation. The token value is **not recorded**.

### 11.6 Success-path assessment

The positive external-email proof chain is complete and each link was observed
independently:

```
staging application trigger  (HTTP 200 + security_events outcome=sent)
  -> SMTP authentication      (implied by provider acceptance, not by deployment health)
  -> provider acceptance      (message present at Resend)
  -> provider delivery        (final event: delivered)
  -> real external mailbox receipt (Gmail)
  -> observed final Return-Path    (send.mail.drsvp.com)
  -> SPF pass + relaxed alignment  (§5)
  -> DKIM pass + exact alignment   (§6)
  -> DMARC pass                    (§7, cited from Authentication-Results)
  -> application link structure preserved (§11.4)
```

**This does not close ORG-PR-002.** The mandatory real-provider **failure**
evidence (§14) has not been collected, and the exposed-token safety action
(§19.7) is outstanding.

### First real send — repository-derived contract (prepared, NOT executed)

**Flow: registration completion.** Re-confirmed from the current code as the
safest first deployed real-email flow: it needs no existing account, no
authenticated session, no organization, and no CSRF header; it creates only an
expiring *pending registration* row, never a user; and its send is best-effort
so a failure cannot corrupt state.

| Contract element | Derived value | Source |
|---|---|---|
| Method | `POST` | `registration.routes.ts:37` |
| Route | `/v1/auth/register` (absolute — no prefix plugin) | `registration.routes.ts:37` |
| Headers | `content-type: application/json`. **No CSRF header** — `requireCsrfHeader` appears only in `auth.routes.ts:83,106` (refresh/logout), never in registration. **No auth** | `registration.routes.ts`, `auth.routes.ts` |
| Body | `{ email, password, displayName, invitationToken? }` | `registerRequestSchema`, `contracts/src/auth.ts:64` |
| `email` | trimmed, 1–320 chars, valid email | `emailSchema` |
| `password` | **min 12**, max 200 characters | `newPasswordSchema`, `MIN_PASSWORD_LENGTH=12` |
| `displayName` | trimmed, 1–100 chars | `displayNameSchema` |
| `invitationToken` | optional; **omit** for this test | `registerRequestSchema` |
| Success status | **200** (`sendSuccess` default) | `envelope.ts:11` |
| Success body | `{"ok":true,"data":{"accepted":true}}` | `registerAcceptedResponseSchema` |
| Mail family triggered | **Registration completion** — `renderRegistrationCompletionEmail`, subject **“Complete your Orgistry registration”** | `auth/registration.email.ts` |
| Link shape | `<WEB_DEMO_URL>/auth/complete-registration#token=<raw>` — token in the **fragment** | `buildRegistrationCompletionUrl` |
| DB state | one `pending_registrations` row (email, normalized email, **password hash**, display name, token hash, expiry). **No `users` row, no session, no cookie** | `registration.repo.ts — issuePendingRegistration` |
| Address must not already have an **active account** | If it does, the *existing-account guidance* family is sent instead — a different email, no token | `registration.service.ts — sendExistingAccountGuidance` |
| Repeat requests | Each request **retires every prior unused generation** for that normalized email (`invalidatedAt`) and inserts a replacement, under a per-email advisory lock. Older emailed links then fail as superseded — exactly one generation is usable | `issuePendingRegistration` |
| Rate limits | per-IP and per-email-digest on request (`RATE_LIMIT_REGISTER_PER_EMAIL_MAX`, default 3/60 s) | `config.rateLimit.registration` |

**On the password.** It *is* argon2-hashed and persisted in the pending row — so
this is not a "no credential is created" situation, and I will not claim it is.
It is not yet an account credential: no `users` row exists until the emailed
token is completed, and **completion requires only `{ token }`**
(`registrationCompleteRequestSchema`) — the password is never needed again for
this evidence exercise. A **randomly generated, never-displayed** password is
therefore correct: nothing needs to know it, and if the flow is later completed
the resulting staging account simply has an unrecoverable random password.

### Evidence to capture, separately

| # | Evidence | Source |
|---|---|---|
| 1 | Application trigger reached the endpoint | HTTP response (generic acceptance — proves the request was served, **not** that mail was sent) |
| 1b | Application's own record of the attempt | **`security_events` DB row**: `registration_requested` with `metadata.outcome` = `sent` \| `send_failed` and `delivered` = true \| false. A database row, **not** a log line — read it with `psql` on the host if needed |
| 2 | **Provider SMTP acceptance** | Resend dashboard / logs |
| 3 | Resend dashboard state for the message | dashboard |
| 4 | **Real mailbox receipt** | the mailbox itself |
| 5 | Sender, subject, timestamp | received message |
| 6 | **`Return-Path`** (final envelope identity) | received headers |
| 7 | **`Authentication-Results`** (verbatim) | received headers |
| 8 | SPF verdict | `Authentication-Results` |
| 9 | DKIM verdict | `Authentication-Results` |
| 10 | **Observed DKIM `d=`** | DKIM-Signature / `Authentication-Results` |
| 11 | DMARC verdict **and which mechanism aligned** | `Authentication-Results` |
| 12 | Placement — inbox / spam / junk | the mailbox |
| 13 | **Link/token rewriting status** | compare the delivered URL to the application-generated URL |

Items 1–4 are four distinct facts and none implies another. Item 13 is
security-critical: tracking is disabled by default at the domain and **must
stay disabled** — a rewritten link would route a live account token through a
provider redirect. Under `p=none` (§7) a message can be delivered while failing
alignment, so **placement is not evidence of authentication**.

Sanitization rules for items 5–12: §12.

### Secret-safe trigger procedure (prepared, NOT executed)

Run on any machine that can reach `https://api-staging.drsvp.com`. The
recipient mailbox is **read into a shell variable and never echoed** — it is not
a credential, but the workflow stays privacy-minimising and the address never
needs to be disclosed to any assistant.

```bash
set +o history

(
  set -euo pipefail
  umask 077

  BODY=''
  cleanup() {
    rc=$?
    if [[ -n "${BODY:-}" && -e "${BODY:-}" ]]; then
      shred -u "${BODY}" 2>/dev/null || rm -f "${BODY}"
    fi
    unset TEST_EMAIL TEST_PASSWORD
    return "${rc}"
  }
  trap cleanup EXIT INT TERM

  # Recipient: hidden input, never echoed, never in history or a command argument.
  read -rs -p 'Recipient mailbox (hidden): ' TEST_EMAIL; echo
  [[ -n "${TEST_EMAIL}" ]] || { echo 'ABORT: empty recipient' >&2; exit 1; }

  # Random 32-char password: satisfies min-12, never displayed, discarded.
  TEST_PASSWORD="$(openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-32)"

  # Correlation id: matches ^[A-Za-z0-9._-]{1,128}$ so the API PRESERVES it
  # (packages/shared — resolveRequestId), giving an exact security_events key.
  REQ_ID="sprint29-first-send-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "correlation request id: ${REQ_ID}"

  # Build the JSON in a 0600 temp file so neither value reaches the process list.
  BODY="$(mktemp)"; chmod 600 "${BODY}"
  jq -n --arg e "${TEST_EMAIL}" --arg p "${TEST_PASSWORD}" \
        '{email:$e, password:$p, displayName:"Sprint 29 Delivery Test"}' > "${BODY}"

  # -sS shows errors but not progress; only headers + response body are printed.
  curl -sS -D - -o /tmp/register-response.json \
    -X POST 'https://api-staging.drsvp.com/v1/auth/register' \
    -H 'content-type: application/json' \
    -H "x-request-id: ${REQ_ID}" \
    --data-binary "@${BODY}"

  echo; echo '--- response body ---'; cat /tmp/register-response.json; echo
)

set -o history
```

Expected: HTTP **200** with `{"ok":true,"data":{"accepted":true}}` and a
response `x-request-id` echoing `${REQ_ID}`. **That response proves only that
the request was served** — it is identical whether mail succeeded or failed.

Send it **once**. A repeat retires the first generation's token (§ contract
above), invalidating the link already in the mailbox.

### Application-side evidence — `security_events` (prepared, NOT executed)

Derived from `packages/db/src/schema/auth.ts — securityEvents` and
`registration.service.ts — recordRequestOutcome`:

- **Table:** `security_events`
- **Event type:** `auth.registration_requested`
- **Metadata keys:** `outcome` (`sent` \| `send_failed` \| `persist_failed` \|
  `existing_account_notice_*` \| a throttle outcome) and `delivered` (boolean)
- **Recipient email: NOT stored.** `user_id` and `session_id` are `NULL`,
  `actor_type` is `anonymous`, and metadata carries no address — the sanitizer
  drops any key containing `password`/`token`/`secret`/`hash`/… anyway. There is
  therefore **no email predicate to write**, which is exactly why the
  correlation id above matters.
- **Identify the test event by `request_id`** — the value the trigger printed.

```bash
# On orgistry-staging-01. PostgreSQL runs in the SEPARATE `orgistry-infra`
# project, so exec into that container and use its own trusted local socket —
# no credential is passed, typed, or printed.
sudo docker exec -i "$(docker ps -q \
      --filter 'label=com.docker.compose.project=orgistry-infra' \
      --filter 'label=com.docker.compose.service=postgres')" \
  psql -U orgistry -d orgistry -x -c \
  "SELECT id, event_type, actor_type, metadata, request_id, created_at
     FROM security_events
    WHERE event_type = 'auth.registration_requested'
      AND request_id = 'PASTE_THE_REQ_ID_HERE'
    ORDER BY created_at DESC
    LIMIT 1;"
```

If the container/service labels differ, substitute the observed ones. Every
selected column is safe: `metadata` is sanitizer-guarded, and **no raw
registration token, password hash, SMTP credential, JWT, or secret-bearing URL
is selected** — none of those live in this table.

Expected on success: one row with `metadata` containing `"outcome": "sent"` and
`"delivered": true`. On failure: `"outcome": "send_failed"`, `"delivered":
false`. **Remember there is no corresponding log line** — this row *is* the
application-side record.


## 12. Provider, Mailbox, and Link Evidence (prepared, NOT executed)

### 12.1 Resend provider evidence

Capture from the Resend dashboard (Emails / Logs). **A 200 from Orgistry is not
provider acceptance** — these are separate facts and each is recorded on its own.

| Fact | What to record |
|---|---|
| **Accepted by Resend** | the message appears at all — Resend took it over SMTP |
| **Delivered by Resend** | the delivery status the dashboard reports |
| **Bounced / rejected** | status plus the provider's reason string, if any |
| Timestamp | provider-side accept/deliver time (UTC) |
| Recipient | may be **redacted to a placeholder** in returned evidence |
| Sender | expected `no-reply@mail.drsvp.com` |
| Subject / message identity | subject verbatim; the provider message id may be **redacted** unless needed for a support ticket |

Absence of any message here, combined with a `send_failed` `security_events`
row, is coherent failure evidence.

### 12.2 Real mailbox authentication evidence

**Do not paste the entire raw email.** Return only the authentication-relevant
headers and the derived verdicts.

| # | Item | How to read it |
|---|---|---|
| 1 | Real inbox receipt | the message physically arrived |
| 2 | **Placement** — inbox vs spam/junk | stated plainly; under `p=none` delivery says nothing about alignment |
| 3 | Visible `From` | expected `Orgistry <no-reply@mail.drsvp.com>` = `RFC5322.From` |
| 4 | Subject | expected **“Complete your Orgistry registration”** |
| 5 | Receipt timestamp | UTC |
| 6 | **`Return-Path`** | the **final** `RFC5321.MailFrom`. Expected to be a provider bounce domain (DNS shows the Return-Path MX at `send.mail.drsvp.com` → `feedback-smtp.eu-west-1.amazonses.com.`) — **observe, do not assume** |
| 7 | **`Authentication-Results`** | verbatim (the one header worth returning in full) |
| 8 | **SPF verdict** | `pass` / `fail` / `softfail` / `none` |
| 9 | **SPF authenticated domain** | the domain SPF actually evaluated — normally the envelope-from/`Return-Path` domain, **not** `From` |
| 10 | **SPF alignment to `RFC5322.From`** | does #9 align with `mail.drsvp.com` under the DMARC policy? Relaxed alignment permits an organizational-domain match; strict requires exact |
| 11 | **DKIM verdict** | `pass` / `fail` / `none` |
| 12 | **Actual DKIM `d=`** | read from `Authentication-Results` / `DKIM-Signature`. DNS *implies* `mail.drsvp.com` with selector `resend` — the observed value is the fact |
| 13 | **DKIM alignment to `RFC5322.From`** | does #12 align with `mail.drsvp.com`? |
| 14 | **DMARC verdict** | `pass` / `fail` |
| 15 | **Which aligned mechanism satisfied DMARC** | SPF, DKIM, or both. A pass carried only by SPF is weaker — SPF breaks on forwarding, a DKIM signature survives it |

Sanitisation: **redact the recipient mailbox** to a placeholder; **omit
intermediate `Received:` hops** (internal routing/host naming); redact the
provider message id unless needed. `From`, `Return-Path` domain, `d=`, selector,
and all verdicts are returned verbatim — they are the evidence.

### 12.3 Link / token rewriting evidence — token redacted

Open/click tracking is **disabled by default** at the domain and must stay
disabled (§2). This check proves the delivered link was not rewritten, **without
returning the token**.

Expected, derived from `auth/registration.email.ts —
buildRegistrationCompletionUrl` (not guessed):

```
<WEB_DEMO_URL>/auth/complete-registration#token=<url-encoded raw token>
```

From the received message, copy the link and compare **structure only**:

```bash
set +o history
read -rs -p 'Paste the delivered registration link (hidden): ' LINK; echo

python3 - "$LINK" <<'PY2'
import sys
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
print('scheme          :', u.scheme)
print('host            :', u.netloc)
print('path            :', u.path)
print('query present   :', bool(u.query), '(expected: False)')
print('fragment present:', bool(u.fragment), '(expected: True)')
print('fragment key    :', u.fragment.split('=')[0] if u.fragment else '<none>')
print('token length    :', len(u.fragment.split('=',1)[1]) if '=' in u.fragment else 0)
print('TOKEN VALUE     : <redacted — never printed>')
PY2

unset LINK
set -o history
```

| Property | Expected (unrewritten) | Meaning if different |
|---|---|---|
| scheme | `https` | — |
| host | the staging web origin (`WEB_DEMO_URL`) | a provider tracking host = **link was rewritten** |
| path | `/auth/complete-registration` | a redirect path = rewritten |
| query present | **False** | a token in the query = transport semantics changed |
| fragment present | **True**, key `token` | fragment lost = the token would now reach web server logs and `Referer` |
| token length | non-zero | — |

**Any deviation is a finding, not a curiosity**: a rewritten link routes a live
account credential through a third-party redirect and defeats the fragment
transport the four auth families rely on. If it occurs, confirm tracking is off
for `mail.drsvp.com` before sending again.

Only the derived structure fields above are returned — never the token value.

## 13. Link and Token Hygiene Evidence

**Status: `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`.** The contracts below are
implemented and locally tested; they must be re-checked against a
**real-provider-delivered** message, because providers rewrite links.

| Contract | Implementation |
|---|---|
| Verification / recovery / registration tokens ride in the **URL fragment** | fragments are never sent in an HTTP request, so the token cannot reach a web server, proxy, access log, or `Referer` |
| Invitation token rides in a **query string** | deliberate Sprint 9 exception |
| Raw tokens never in API responses, backend URL paths, logs, security events, or DB rows | only hashes stored |
| No mailer or renderer logs message content | enforced by convention, reviewed this sprint |
| Used / expired / stale-token behaviour | covered by existing route and integration suites |

**Recorded asymmetry, not a defect fixed this sprint.** Family 6's query-string
token is visible to the *web* server's access log and to `Referer` headers from
the acceptance page, which the five fragment-based families are structurally
immune to. This is the documented Sprint 9 design; Sprint 29 found **no new
defect** and did not redesign token behaviour. A real-provider message may also
be **link-rewritten by provider click tracking** — if the selected provider does
that, it must be disabled for account email, because a rewritten link routes a
live credential through a third party. That check is part of §10's per-family
hygiene column.

## 14. Failure-Mode Validation

Local deterministic evidence and real external provider evidence are separate
classes and are never merged.

### Local deterministic regression proof — complete

Sprint 24 proved, against an in-process fake SMTP server, that the SMTP password
appears in **neither the message, the stack, nor any own property** of the
thrown error for six failure modes
(`apps/api/src/modules/mail/smtp-failure-redaction.test.ts`). Re-run and passing
this sprint. This is **accepted as regression evidence only** — it does not
satisfy the Sprint 29 real-provider failure boundary.

### Mandatory real-provider validation — outstanding

These must be validated through the **real staging/provider path** once a
provider is configured. Neither is optional.

| # | Failure mode | Local proof | Real-provider requirement |
|---|---|---|---|
| 1 | **Wrong SMTP credential / authentication failure** | proven | **MANDATORY — outstanding** |
| 2 | **Connection / provider failure** | proven | **MANDATORY — outstanding** |

### Evidence model for the real-provider failure tests

**There is no `sent` / `send_failed` application log, and none will be added.**
`recordRequestOutcome` → `writeSecurityEvent` → `repo.insertSecurityEvent`
persists a **`security_events` database row**; the mail module contains no
logger calls at all, by design (bodies carry raw tokens; the AUTH exchange
carries the credential). Any requirement for a "coarse SMTP/provider error log"
is therefore **withdrawn** — its absence is a design property, not a test
failure.

Evidence is split into three classes and no class substitutes for another:

**(a) Positive failure evidence — the send genuinely failed**

| Source | What it shows |
|---|---|
| HTTP request handled | the endpoint served the request (generic acceptance for registration — proves nothing about delivery) |
| **`security_events` row** | `registration_requested` with `metadata.outcome = 'send_failed'`, `delivered = false` — the application's own record that delivery was attempted and failed |
| **No provider acceptance event** | Resend dashboard shows no accepted message for the attempt |
| No mailbox arrival | the recipient mailbox stays empty |
| *(optional, fail-closed flow)* invitation create returns an API error | the one family that surfaces the SMTP failure directly to the caller |

**(b) Runtime and account-state evidence — the failure stayed contained**

| Check | Expectation |
|---|---|
| `GET /health`, `GET /ready` | still 200 — SMTP is lazy and is not a readiness dependency |
| Account/token state | per §15: registration leaves an expiring pending row and no user; invitation writes nothing at all |
| Other flows | unaffected |

**(c) Negative credential-leak log inspection — a leak check, not a failure check**

Logs are inspected **only** to prove absence, via
[../rotation-runbook.md](../rotation-runbook.md#collecting-logs-safely):

- no SMTP password / Resend API key (valid or deliberately invalid);
- no credential-bearing URL;
- no raw account token.

**Finding no provider error line is an expected pass, not a gap.**

### Conditional real-provider validation — only where safely feasible

| # | Failure mode | Local proof | Real-provider requirement |
|---|---|---|---|
| 3 | Sender rejection | proven | Conditional — only if the provider documents a safe way |
| 4 | Recipient rejection | proven | Conditional — only if the provider documents a safe way |
| 5 | Provider timeout-specific behaviour | proven | Conditional — only if safely observable |

**Do not manufacture these conditions and do not trigger provider abuse
controls.** Where a condition cannot be produced safely, it stays local-only and
that fact is recorded rather than faked.

### Test 1 — WRONG SMTP CREDENTIAL — EXECUTED 2026-09-02

**Recorded exactly as observed.** The outcome differed from the planned
`send_failed|false`; it is **not** rewritten to match the expectation.

#### 1. Failure deployment

| Item | Observed |
|---|---|
| Commit / manifest | `91664d0fd639…` / `…-9b79d72c045f.json` — same immutable release |
| Migration head | `0012_shocking_warbound` |
| Backup/WAL protection | **`verified`** |
| Pre-deploy backup | `orgistry-20260902T110333Z-pre-deploy.dump` |
| Smoke | **9/9** |
| API / web digests | unchanged |
| Deployment record | `…/records/20260902T110350044Z-91664d0fd639-deploy.json` |

The invalid credential deployed cleanly — as designed, since SMTP is lazy.

#### 2. One application request

| Item | Observed |
|---|---|
| Request id | `sprint29-authfail-20260902T110447Z` |
| HTTP | `200`, `{"ok":true,"data":{"accepted":true}}` |
| `security_events` | `auth.registration_requested`, actor `anonymous` |
| metadata | **`{"outcome":"existing_account_notice_failed","delivered":false}`** |
| verdict | **`existing_account_notice_failed|false`** |

The recipient already had an account, so the request took the
**existing-account guidance** branch rather than the new-registration branch.
The operator correctly did **not** retry while the invalid credential was live.

#### 3. Local negative leak evidence

`invalid credential marker present in logs: no` ·
`registration token present in logs: no`

**Scope-limited:** this covers only the inspected API-container log window
(`--since 15m`) on that container. It is not a claim about all logs for all time.

#### 4. Provider-side evidence

**`matching accepted/delivered message: NO`** — checked in Resend around the
failure timestamp, after restoration.

Together this establishes: the deployed application attempted a real mail path ·
an intentionally invalid **real** Resend credential was live in the API
container · the application recorded delivery failure · **no message reached
provider acceptance**. The failure therefore occurred **before** provider
message acceptance.

**No Resend authentication-failure event is claimed** — Resend was not
established to expose one, and none is invented.

### Existing-account guidance branch — repository-derived

Every point below is read from the implementation.

| Question | Answer |
|---|---|
| Mail family / template | **Existing-account guidance**, `auth/registration.email.ts — renderExistingAccountNoticeEmail`. Family #2 of the six. Subject: *"A registration was attempted with your email address"* |
| Sender method | `registration.service.ts — sendExistingAccountGuidance`, via the shared `AccountMailer.deliver` seam |
| Success metadata | `recordRequestOutcome('existing_account_notice_sent', ctx)` |
| **Exact success `outcome` string** | **`existing_account_notice_sent`** |
| **Is `delivered=true` recorded?** | **NO — impossible on this branch.** `recordRequestOutcome` computes `metadata.delivered` as `outcome === 'sent'`, a **strict equality on the literal string `'sent'`**. `existing_account_notice_sent` is not `sent`, so `delivered` is **`false` even on success**. `delivered=true` is reachable only from the new-registration branch |
| Pending-registration row | **NO.** The branch comment is explicit: *"NEVER a duplicate user, NEVER a pending registration"* |
| Registration-completion token | **NO.** The notice *"carries NO token and NO account state — it is guidance only… it never creates a recovery token"* |
| Invalidation / supersession | **Not applicable** — nothing is staged, so there is no generation to supersede |
| Enumeration behaviour | **Yes, deliberately identical.** Both branches `return GENERIC_ACCEPTANCE`. The service marks *"The enumeration-safe boundary starts HERE: once payload validation and rate limiting have passed, no internal outcome — invitation state, account state, persistence, delivery, or the event write — may alter the public response."* |
| Throttle | Internal bucket `existingAccountNoticePerEmailMax`, **default 1 per 60 s window** (`RATE_LIMIT_REGISTRATION_NOTICE_PER_EMAIL_MAX=1`). A repeat inside the window records `existing_account_notice_throttled` and sends **nothing** |

### Sprint requirement decision

**`WRONG-CREDENTIAL FAILURE CLASS SATISFIED`**

**Binding requirement.** The Sprint 29 specification's failure-validation
mandate is: validate *"wrong SMTP credential / authentication failure"* through
the **real staging/provider path**, proving *safe error behaviour*, *no
credential leakage*, *unrelated application runtime remains healthy*, and
*account-flow behaviour remains consistent*. **It nowhere names the
new-registration branch, and nowhere requires the literal verdict
`send_failed|false`.** That verdict was this artifact's operational
*expectation* for the planned trigger — not the Sprint requirement.

**Repository behaviour.** Both branches deliver through the **same single
account-mailer seam** and the same SMTP transport; the only difference is which
renderer produced the message. The SMTP-authentication failure path exercised is
therefore identical. The existing-account guidance branch is one of the six
in-scope account-email families, and its observed behaviour matched its
documented contract exactly: generic response preserved, no pending row, no
token, failure recorded.

**Actual evidence, mapped to each mandated invariant:**

| Mandated invariant | Evidence |
|---|---|
| Real staging/provider path | Deployed app, live container, real `smtp.resend.com:2465`, real invalid Resend credential |
| Authentication failure occurred | `existing_account_notice_failed`, `delivered=false`; **no Resend acceptance** — failure preceded acceptance |
| Safe error behaviour | Failed closed; generic `{"accepted":true}`; no crash |
| No credential leakage | No invalid-credential marker and no token in the inspected log window |
| Runtime remains healthy | `/health`, `/ready`, smoke 9/9; digests unchanged |
| Account-flow consistency | Existing-account contract honoured exactly (no pending row, no token, generic response) |

Accepting this does **not weaken** the requirement — every mandated invariant is
evidenced on the real path. Rejecting it would **expand** the requirement beyond
its binding wording by inventing a branch constraint the specification never
states. Both were forbidden; the evidence satisfies the requirement as written.

**ORG-PR-002 does not close:** the connection/provider-failure class is still
pending.

### Restoration incident — recorded, not smoothed over

**The first restoration redeploy FAILED CLOSED** during `Backup protection
preflight`. WAL health at that moment: `archive_mode` PASS · 48 segments
archived · no archiver failures · **local recent WAL FAIL** · spool drained PASS
· off-host WAL present PASS · **off-host WAL current FAIL**. The deployment
aborted **before migrations**, leaving the target unchanged — the intended safe
behaviour of the `require` gate.

**Split state, explicitly documented:**

```
runtime_env_state    = NON_TEST_VALUE           (known-good restored ON DISK)
live_api_smtp_state  = INVALID_TEST_CREDENTIAL  (container still running the old config)
```

> **Restoring `/opt/orgistry/config/runtime.env` on disk does NOT update the
> already-running API container.** Configuration reaches the process only
> through a successful redeploy/recreation — the runtime reads its environment
> once at start, and there is no hot reload. Until that redeploy succeeds the
> environment is **NOT RESTORED**, however correct the file on disk looks.

**Remediation and final restoration.** `SELECT pg_switch_wal();` →
`systemctl --user start orgistry-wal-ship.service` → `wal-health` returned
**HEALTHY (0 warnings)**: 49 segments archived, no failures, none pending, spool
drained, 22 off-host segments, newest `00000001000000000000002B`, off-host WAL
current. The same immutable release then redeployed successfully: protection
verified · pre-deploy backup `orgistry-20260902T111030Z-pre-deploy.dump`,
recovery point `2026-09-02T11:10:35Z` · head `0012_shocking_warbound` · API and
web digests unchanged · `/health` and `/ready` PASS · smoke **9/9** · record
`…/records/20260902T111047807Z-91664d0fd639-deploy.json`. Final container check:
`live_api_smtp_state=NON_TEST_VALUE`.

- **`known-good runtime on disk: VERIFIED`**
- **`known-good credential loaded in live API container: VERIFIED`**
- **`wrong credential no longer active: VERIFIED`**
- **`known-good staging restoration: VERIFIED`**

### WAL health assessment — classification **B** (false negative), ORG-PR-005 stays CLOSED

Derived from `tooling/lib/backup-health.mjs`, `tooling/backup-ops.mjs`, and
`tooling/pg-enable-wal-archiving.sh`:

- Both failing checks are gated on **`archiver.walPending`**, computed as
  `currentWalOffset > 512 bytes` — i.e. *"the open segment has content not yet
  archived"*. `recent WAL archived locally` fails when `walPending` **and** the
  last **sealed** segment is older than `walMaxAgeMinutes` (**default 15**);
  `off-host WAL is current` fails when `walPending` **and** the newest off-host
  segment is older than `2 × 15 = 30` minutes.
- **Does the shipper upload only completed segments?** Effectively yes. It ships
  what `archive_command` places in the spool, and PostgreSQL archives a segment
  only once **sealed**. An open segment is never shipped.
- **Does anything force rotation periodically?** Yes — `archive_timeout = 300s`
  (5 min), set by `pg-enable-wal-archiving.sh` — but **only if something was
  written since the last switch**. A genuinely idle database rotates nothing,
  which is correct.
- **Can a low-write environment exceed the thresholds?** Yes, and this is
  exactly what happened. After a long idle period the last sealed segment was
  well over 15 minutes old. The failure-test request wrote WAL (the
  `security_events` row and related activity), flipping `walPending` to true
  **while the segment was still within its 5-minute `archive_timeout` window**.
  Both age checks then fired against a stale `lastArchivedTime`.

**Classification: B — a false negative from an overly strict policy at the
first-write-after-idle boundary.** The health-check author already anticipated
idle databases and gated the age limits on `walPending`; the gap is that
`walPending` cannot distinguish *"the archiver is behind"* from *"a write just
landed and `archive_timeout` has not sealed the segment yet"*. Nothing was
broken: archive_mode on, **zero** archiver failures, spool drained, off-host
segments present, and the unsealed data was ≤5 minutes from being archived.
`pg_switch_wal()` simply forced early what `archive_timeout` would have done.

**Not C.** There is no evidence of failed backup operations or lost protection.
The genuine residual — data in an unsealed segment is not yet off-host, an RPO
of up to `archive_timeout` — is inherent to WAL archiving and is the already
documented model, not a regression. **ORG-PR-005 remains CLOSED.**

**New operational consequence worth recording:** now that
`ORGISTRY_BACKUP_CONFIG` is wired and the check defaults to `require`, this
false negative can **block a deployment** on a low-write environment — as it did
here. That is a new interaction introduced by the (correct) wiring fix, and it
is a candidate for a narrow health-policy refinement in a later sprint. No fix
is implemented here.

### Procedure defect — masked deploy failure, corrected

**Defect.** The earlier wrapper printed `DANGER INTERVAL CLOSED — KNOWN-GOOD
STAGING RESTORED` even though the first restoration deploy had **failed** during
backup preflight. Root cause: `orgistry_restore_deploy` ran
`sudo bash tooling/deploy.sh …` and then continued to further commands whose
success became the function's exit status, masking the non-zero deploy. The
banner was reached on a false success, while the live container still held the
invalid credential.

**Correction — applied to the living procedure:**

1. `tooling/deploy.sh` is invoked as its **own guarded statement**; a non-zero
   status **returns immediately** from the wrapper.
2. **No post-deployment identity or evidence command runs after a failed
   deploy** — the function exits before them.
3. The closure banner is printed **only** on the `else` branch, i.e. only when
   the restoration deploy itself returned 0 **and** the re-assertion passed.
4. Disk state and live state are tracked as **two separate facts**; the banner
   requires the live-container proof, not just the file on disk.
5. A running API container still holding the invalid credential is explicitly
   **`NOT RESTORED`**.

```bash
orgistry_restore_deploy() (
  set -euo pipefail
  umask 077
  rm -f /tmp/orgistry-restore-images-before.txt
  tmp="$(mktemp /tmp/.orgistry-restore-before.XXXXXX)"
  trap 'rm -f "${tmp}"' EXIT
  orgistry_image_evidence api  >"${tmp}"
  orgistry_image_evidence web >>"${tmp}"
  orgistry_assert_identities "${tmp}"
  mv -f "${tmp}" /tmp/orgistry-restore-images-before.txt
  trap - EXIT

  # FAIL-CLOSED: the deploy is its own statement; non-zero returns immediately.
  if ! sudo bash tooling/deploy.sh --manifest "${MANIFEST}" --config "${DEPLOYCFG}"; then
    echo 'FATAL: restoration deploy FAILED — live container is NOT RESTORED' >&2
    return 1
  fi

  rm -f /tmp/orgistry-restore-images-after.txt
  tmp2="$(mktemp /tmp/.orgistry-restore-after.XXXXXX)"
  orgistry_image_evidence api  >"${tmp2}"
  orgistry_image_evidence web >>"${tmp2}"
  mv -f "${tmp2}" /tmp/orgistry-restore-images-after.txt
  diff -u /tmp/orgistry-restore-images-before.txt /tmp/orgistry-restore-images-after.txt \
    || { echo 'FATAL: identity changed during restoration' >&2; return 1; }
  echo 'IMAGE IDENTITY UNCHANGED for BOTH api and web'
  sudo node tooling/deploy-evidence.mjs current \
    --dir /opt/orgistry/evidence --environment staging-like
)

# Live-container proof — disk state is NOT sufficient.
orgistry_assert_live_container_restored() (
  set -euo pipefail
  CID="$(docker ps -q --filter 'label=com.docker.compose.project=orgistry' \
                      --filter 'label=com.docker.compose.service=api')"
  [[ -n "${CID}" ]] || { echo 'FATAL: api container not found' >&2; exit 1; }
  if docker exec "${CID}" sh -c 'case "$SMTP_PASSWORD" in sprint29-invalid-*) exit 0;; *) exit 1;; esac'; then
    echo 'live_api_smtp_state=INVALID_TEST_CREDENTIAL — NOT RESTORED' >&2; exit 1
  fi
  echo 'live_api_smtp_state=NON_TEST_VALUE'
)
```

The banner branch becomes:

```bash
else
  orgistry_assert_known_good_values \
    && orgistry_assert_live_container_restored \
    && echo 'DANGER INTERVAL CLOSED — KNOWN-GOOD STAGING RESTORED'
fi
```

The live check tests only whether the value **matches the test marker prefix**;
it never prints the credential.

### Pending-registration state — corrected for what actually happened

The pre-execution analysis assumed the failure would land on the
**new-registration** branch, which persists a pending row before sending. **It
did not.** The request took the **existing-account guidance** branch, and that
branch is explicit in the code: *"NEVER a duplicate user, NEVER a pending
registration"*, and the notice *"carries NO token and NO account state"*.

**Consequently there is no staged generation from this failure test** — no
pending row, no completion token, nothing to supersede or invalidate. The
earlier "reuse the same recipient to invalidate the failed generation" rationale
**does not apply to what occurred**.

The same recipient is still required for Phase G, but for a different reason:
it is what keeps the success proof on the **same branch** that produced the
failure evidence.

### Wrong-credential class — CLOSED 2026-09-02

**`WRONG-CREDENTIAL FAILURE CLASS SATISFIED`** — decision unchanged; the class is
now complete end to end.

**Phase E2 — provider failure lookup (after restoration):**
**`matching accepted/delivered message: NO`**.

**Phase G — post-restoration real delivery, same existing-account branch:**

| Item | Observed |
|---|---|
| Request id | `sprint29-authfail-restored-20260902T113401Z` |
| `security_events` | `auth.registration_requested`, actor `anonymous` |
| metadata | `{"outcome":"existing_account_notice_sent","delivered":false}` |
| verdict | **`existing_account_notice_sent|false`** |
| Provider | **Resend: delivered** |
| Mailbox | **received** |

> **`delivered=false` here is NOT a delivery failure.** It is the documented
> semantic of this branch: `recordRequestOutcome` computes `delivered` as
> `outcome === 'sent'` — strict equality on the literal string — so
> `existing_account_notice_sent` necessarily yields `delivered=false`. External
> delivery is proven by **Resend `delivered` + real mailbox receipt**, not by
> that flag.

- **`APPLICATION EXISTING-ACCOUNT NOTICE SEND: VERIFIED`**
- **`Resend delivery after restoration: VERIFIED`**
- **`real mailbox receipt after restoration: VERIFIED`**

**Phase H — cleanup: `PHASE H: PASS`.** `authfail rollback copies remaining: 0`
(consumed by restoration, as expected); all seven state/evidence files removed;
final assertions `ABSENT: authfail rollback`, `SMTP_PASSWORD count=1`,
`SMTP_PASSWORD_FILE count=0`, `invalid credential retained: no`.

- **`wrong-credential cleanup: VERIFIED`**

No wrong-credential rollback, state file, or invalid credential remains.

---

## Test 2 — CONNECTION / PROVIDER FAILURE — EXECUTED 2026-09-02

**`CONNECTION / PROVIDER FAILURE CLASS SATISFIED`**

### Condition

Known-good `smtp.resend.com:2465` → failure configuration `smtp.resend.com:465`.
**Only `SMTP_PORT` was changed**; the real Resend credential, SMTP username,
hostname, and From identity were unchanged. The §9 staging evidence had already
established that 2465 is reachable and completes verified TLS while **465 times
out from this host**. **No cause for the 465 timeout is claimed.**

### Phase A — pre-test baseline (PASS)

Backup health `HEALTHY (0 warning(s))`; initial WAL health **all PASS**, so
`wal-health already clean — pg_switch_wal NOT called`; final
`BACKUP + WAL HEALTH: CLEAN`. Runtime `600 daniel:daniel`; all eight key counts
correct (`SMTP_PASSWORD=1`, `SMTP_PASSWORD_FILE=0`); all six known-good values
exact including `SMTP_PORT=2465`; `live_api_smtp_port=2465`; connfail namespace
`0 existing`. Protected rollback created at
`/opt/orgistry/config/.runtime.env.sprint29-connfail-rollback.M0fsHD` (contents
never exposed).

### Phases B–C — mutation and failure deployment

`PHASE B: PASS — SMTP_PORT=465 INSTALLED`. The **same immutable release**
deployed successfully. Record
`…/records/20260902T120127278Z-91664d0fd639-deploy.json`:

| Item | Observed |
|---|---|
| Commit | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` |
| API digest | `sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` — unchanged |
| Web digest | `sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` — unchanged |
| Migration head | `0012_shocking_warbound` |
| Pre-deploy backup | `orgistry-20260902T120104Z-pre-deploy.dump`, recovery point `2026-09-02T12:01:13Z` |
| Protection | `verified` |
| Smoke | **9/9** |
| Live API | `SMTP_PORT=465` |

### Phase D — one request, real connection failure

| Item | Observed |
|---|---|
| Request id | `sprint29-connfail-20260902T120300Z` |
| HTTP | `200`, `application/json; charset=utf-8` |
| **`time_total`** | **`20.250115` seconds** |
| Body | `{"ok":true,"data":{"accepted":true}}` |
| `security_events` | `auth.registration_requested`, actor `anonymous` |
| metadata | `{"outcome":"existing_account_notice_failed","delivered":false}` |
| verdict | **`existing_account_notice_failed|false`** |
| Result | `PHASE D: EXPECTED CONNECTION FAILURE CONFIRMED` |

> **The measured duration was ~20.25 s, not the ~10 s predicted from
> `MAIL_TIMEOUT_MS=10000`.** Recorded as measured. The prediction assumed a
> single bounded connect attempt; the observed figure is roughly double it. **No
> explanation is asserted** — the timeout semantics under this specific failure
> were not instrumented, and inventing a cause would be as wrong as inventing a
> cause for the port-465 timeout itself.

**Local log evidence:** `registration token present in logs: no`;
`SMTP password present in logs: no` — scoped to the inspected container window.

**Provider (checked after restoration):** `matching accepted/delivered message:
NO` — proving no message reached provider acceptance. **Absence alone does not
prove the network cause;** the classification comes from the known real
port-465 staging transport condition combined with this real application
failure.

### Phase F — restoration incident (recorded, not hidden)

**The first scripted restoration did NOT complete.** After the failure event,
`runtime.env` was restored on disk to `SMTP_PORT=2465` while the **live API
remained on 465**.

The restoration WAL gate then observed a **second, narrower variant** of the
low-write false negative — only **`recent WAL archived locally`** FAILED, with
`archive_mode`, `WAL segments archived`, `archive_command not failing`,
`WAL spool drained`, `WAL present off-host` **and `off-host WAL is current`** all
PASS (the off-host age was still inside its longer `2 × 15 = 30` minute
threshold).

The strict remediation matcher required **both** freshness checks to fail, so it
**correctly refused** to apply an unapproved repair — the narrowing worked as
designed.

**But a second procedure control-flow defect was exposed:** the restoration
function continued past the non-zero WAL gate because it relied on `set -e` in a
context where that was unsafe. The subsequent deployment then also **correctly
failed closed** at Backup protection preflight.

State at that moment: known-good runtime on disk **yes**; live API still on port
465 **yes**; **restoration NOT COMPLETE**. The B–F block exited **90**.

### Phase F (emergency restore) — COMPLETE

Initial proof: `known_good_runtime_on_disk=VERIFIED`,
`runtime_on_disk_smtp_port=2465`, `live_api_smtp_port_before_restore=465`.

By then PostgreSQL's `archive_timeout` had **sealed the segment naturally**, and
wal-health had returned to `HEALTHY (0 warning(s))` — 51 archived, no WAL
pending, spool drained, 24 segments off-host, newest
`00000001000000000000002D`, off-host WAL current. So
`wal-health already clean — no rotation required`, then
`BACKUP + WAL HEALTH: CLEAN`.

The same immutable release redeployed successfully. Record
`…/records/20260902T120751519Z-91664d0fd639-deploy.json`: backup
`orgistry-20260902T120731Z-pre-deploy.dump`, recovery point
`2026-09-02T12:07:38Z`, protection `verified`, head `0012_shocking_warbound`,
API/web digests unchanged, smoke **9/9**, `/health` PASS, `/ready` PASS, live API
`SMTP_PORT=2465`.

Observed: **`DANGER INTERVAL CLOSED — KNOWN-GOOD STAGING RESTORED`**,
`emergency restore exit status=0`.

**`connection-test known-good restoration: VERIFIED`**

### Phase G — post-restoration success

| Item | Observed |
|---|---|
| Request id | `sprint29-connfail-restored-20260902T121031Z` |
| HTTP | `200`, `time_total 1.456895` |
| metadata | `{"outcome":"existing_account_notice_sent","delivered":false}` |
| verdict | **`existing_account_notice_sent|false`** |
| Provider | **Resend: delivered** |
| Mailbox | **received** |

`POST-RESTORATION APPLICATION SEND: VERIFIED`. The 1.46 s round trip against the
20.25 s failure is itself corroborating: the transport was working again.
`delivered=false` remains this branch's semantic (`outcome === 'sent'` strict
equality) — **not** an external delivery failure; Resend + mailbox prove
delivery.

### Phase H — cleanup (PASS)

`connfail rollback copies remaining: 0` (consumed by restoration, expected). Six
state/evidence files removed. Final assertions: `runtime SMTP_PORT=2465:
VERIFIED`, `SMTP_PASSWORD count=1`, `SMTP_PASSWORD_FILE count=0`,
`live_api_smtp_port=2465`, `ABSENT: connfail rollback`, `no test-only SMTP
configuration retained`. **`PHASE H: PASS`** →
**`connection-failure cleanup: VERIFIED`**

## WAL health policy — two variants of one issue (ORG-PR-005 stays CLOSED)

Sprint 29 exposed the same low-write first-write-after-idle health-policy issue
twice, in two different shapes:

| Variant | Failing checks | Context |
|---|---|---|
| **1** | `recent WAL archived locally` **and** `off-host WAL is current` | wrong-credential restoration; off-host age had also passed its 30-minute limit |
| **2** | **only** `recent WAL archived locally` | connection-failure restoration; off-host age still inside 30 minutes |

In both cases the backup/WAL system was functioning: `archive_mode` on, no
archiver failures, spool drained, WAL present off-host, and `archive_timeout`
eventually sealed the open segment after which WAL archived and shipped
normally — in variant 2 the seal happened **on its own**, with no operator
rotation, which is the clearest evidence the system was never broken.

**This is a health-policy false negative / operational edge case, not evidence
that PITR protection is broken. ORG-PR-005 remains CLOSED.** No fix is
implemented in Sprint 29; it is recorded as a candidate for a later narrow
health-policy refinement — for example, exempting the freshness checks while the
open segment's age is under `archive_timeout`.

## Operator-procedure defects — two, both recorded

**Defect 1 (wrong-credential restoration).** A failed `tooling/deploy.sh` was
followed by successful commands inside the wrapper, so the wrapper's exit status
came from the later commands. The deployment failure was masked and a **false
closure banner** printed while the live container still held the invalid
credential.

**Defect 2 (connection-failure restoration).** A failed WAL gate inside the
restoration function did not stop the later restoration commands, because the
function was invoked in a shell context where relying on `set -e` was unsafe.

**Final procedural rule, adopted:**

> **Do not rely on Bash `set -e` as the sole failure-propagation mechanism in
> safety-critical restoration procedures.** Every critical command or gate must
> use explicit control flow — `if ! command; then return/exit; fi` or
> `command || return $?`.

The danger-interval closure banner must be explicitly gated on **all** of:
known-good disk runtime · successful protection gate · successful restoration
deploy · immutable identity verification · health/readiness · smoke ·
correct live-container SMTP state.

Both defects were caught by evidence rather than by the procedure itself, which
is the weaker of the two ways to find them — hence the rule above rather than a
narrower patch.

### Pending-registration state — corrected for what actually happened

The pre-execution analysis assumed the failure would land on the
**new-registration** branch, which persists a pending row before sending. **It
did not.** The request took the **existing-account guidance** branch, and that
branch is explicit in the code: *"NEVER a duplicate user, NEVER a pending
registration"*, and the notice *"carries NO token and NO account state"*.

**Consequently there is no staged generation from this failure test** — no
pending row, no completion token, nothing to supersede or invalidate. The
earlier "reuse the same recipient to invalidate the failed generation" rationale
**does not apply to what occurred**.

The same recipient is still required for Phase G, but for a different reason:
it is what keeps the success proof on the **same branch** that produced the
failure evidence.

### Wrong-credential class — CLOSED 2026-09-02

**`WRONG-CREDENTIAL FAILURE CLASS SATISFIED`** — decision unchanged; the class is
now complete end to end.

**Phase E2 — provider failure lookup (after restoration):**
**`matching accepted/delivered message: NO`**.

**Phase G — post-restoration real delivery, same existing-account branch:**

| Item | Observed |
|---|---|
| Request id | `sprint29-authfail-restored-20260902T113401Z` |
| `security_events` | `auth.registration_requested`, actor `anonymous` |
| metadata | `{"outcome":"existing_account_notice_sent","delivered":false}` |
| verdict | **`existing_account_notice_sent|false`** |
| Provider | **Resend: delivered** |
| Mailbox | **received** |

> **`delivered=false` here is NOT a delivery failure.** It is the documented
> semantic of this branch: `recordRequestOutcome` computes `delivered` as
> `outcome === 'sent'` — strict equality on the literal string — so
> `existing_account_notice_sent` necessarily yields `delivered=false`. External
> delivery is proven by **Resend `delivered` + real mailbox receipt**, not by
> that flag.

- **`APPLICATION EXISTING-ACCOUNT NOTICE SEND: VERIFIED`**
- **`Resend delivery after restoration: VERIFIED`**
- **`real mailbox receipt after restoration: VERIFIED`**

**Phase H — cleanup: `PHASE H: PASS`.** `authfail rollback copies remaining: 0`
(consumed by restoration, as expected); all seven state/evidence files removed;
final assertions `ABSENT: authfail rollback`, `SMTP_PASSWORD count=1`,
`SMTP_PASSWORD_FILE count=0`, `invalid credential retained: no`.

- **`wrong-credential cleanup: VERIFIED`**

No wrong-credential rollback, state file, or invalid credential remains.

---

## Test 2 — CONNECTION / PROVIDER FAILURE (prepared, NOT executed)

**The only remaining ORG-PR-002 blocker.**

### Design

**Real failure under test.** Port **465** is used instead of 2465, keeping the
real host, real credential, and real sender identity. The §9 staging evidence
already established from this exact host that `smtp.resend.com:2465` completes a
fully verified TLS session while **`smtp.resend.com:465` times out**. This is a
*real, previously observed* network failure against the *real* provider endpoint
— no fabricated condition, no unrelated hostname, no risk of tripping provider
abuse controls. **The cause of the 465 timeout is not asserted**; only the
observed outcome is used.

**Mutation scope: `SMTP_PORT` only.** `SMTP_PASSWORD`, `SMTP_USERNAME`,
`SMTP_HOST`, and the From identity all keep their known-good values. **No
secret-bearing value is mutated.** The full-runtime rollback still contains every
runtime secret, so it is protected exactly as before.

**Branch: the same existing-account guidance branch**, already
repository-derived and proven — same `AccountMailer.deliver` seam, no pending
row, no token, no second account-flow branch introduced.

**Expected failure outcome — verified from code, not assumed.**
`sendExistingAccountGuidance` wraps `mailer.deliver` in an **unconditional
`catch`**: any throw — an AUTH rejection or a connect/greeting timeout alike —
records `existing_account_notice_failed`. So the expected verdict is
**`existing_account_notice_failed|false`**, identical to the credential test.
`MAIL_TIMEOUT_MS` (**default 10 000 ms**) bounds connect/greeting, so the request
returns its generic acceptance after roughly ten seconds.

**Throttle interaction.** The notice limiter is **1 per 60 s**
(`RATE_LIMIT_REGISTRATION_NOTICE_PER_EMAIL_MAX=1`) and is consulted **before**
any send. A throttled request records `existing_account_notice_throttled` and
**performs no delivery attempt at all** — it is a no-op, not a failed test. The
procedure therefore treats `throttled` as *"wait out the window and repeat
once"*, distinct from an unexpected outcome. That preserves the "exactly one
send attempt" intent.

### Phase A — WAL/backup gate + baseline + protected rollback (FINAL)

**Run this alone.** It inspects configuration, may perform the **narrowly
authorised** low-write WAL remediation, and creates the protected rollback.
**It changes no SMTP setting, redeploys nothing, sends nothing, and does not
enter the danger interval.**

#### Narrowed WAL remediation condition

`pg_switch_wal()` is **not** a generic repair. It is authorised **only** for the
exact first-write-after-idle signature observed during the wrong-credential
restoration:

| Requirement | Value |
|---|---|
| PASS | `archive_mode`, `WAL segments archived`, `archive_command not failing`, `WAL spool drained`, `WAL present off-host` |
| FAIL — **exactly these two, and nothing else** | `recent WAL archived locally`, `off-host WAL is current` |

**Any other failing check — a different check, an additional check, or a
different combination — aborts Phase A immediately.** No rotation, no rollback,
no mutation. The signature is evaluated from `wal-health --json`
(`{healthy, failedCount, warnedCount, checks:[{name,status,detail}]}`), not from
text scraping.

```bash
cd /opt/orgistry/deploy
(
  set -euo pipefail
  umask 077

  RUNTIME=/opt/orgistry/config/runtime.env
  BACKUPCFG=/opt/orgistry/config/backup.env
  STATE=/tmp/orgistry-sprint29-connfail-rollback-path
  PATTERN='.runtime.env.sprint29-connfail-rollback.*'
  KNOWN_LOWWRITE_FAILSET='off-host WAL is current|recent WAL archived locally'

  # ================= A1. Backup / WAL gate =================
  echo '--- backup health ---'
  ORGISTRY_BACKUP_CONFIG="${BACKUPCFG}" node tooling/backup-ops.mjs health \
    || { echo 'ABORT: backup health is not clean — investigate; nothing was created' >&2; exit 1; }

  echo '--- wal health (initial) ---'
  wal_json="$(ORGISTRY_BACKUP_CONFIG="${BACKUPCFG}" node tooling/backup-ops.mjs wal-health --json 2>/dev/null || true)"
  [[ -n "${wal_json}" ]] || { echo 'ABORT: could not read wal-health --json' >&2; exit 1; }
  printf '%s\n' "${wal_json}" | jq -r '.checks[] | "\(.status)  \(.name) — \(.detail)"'

  wal_healthy="$(printf '%s' "${wal_json}" | jq -r '.healthy')"

  if [[ "${wal_healthy}" == 'true' ]]; then
    echo 'wal-health already clean — pg_switch_wal NOT called'
  else
    # Exact signature match, or abort. Sorted FAIL names joined with '|'.
    failset="$(printf '%s' "${wal_json}" \
      | jq -r '[.checks[] | select(.status=="FAIL") | .name] | sort | join("|")')"
    passok="$(printf '%s' "${wal_json}" | jq -r '
      [ .checks[]
        | select(.name=="archive_mode" or .name=="WAL segments archived"
                 or .name=="archive_command not failing" or .name=="WAL spool drained"
                 or .name=="WAL present off-host")
        | select(.status=="PASS") ] | length')"

    echo "failed checks: ${failset}"
    if [[ "${failset}" != "${KNOWN_LOWWRITE_FAILSET}" || "${passok}" -ne 5 ]]; then
      echo 'ABORT: wal-health failure does NOT match the known low-write signature.' >&2
      echo '       pg_switch_wal is NOT authorised as a repair for this condition.' >&2
      echo '       No rollback created, runtime.env untouched. Investigate the output above.' >&2
      exit 1
    fi
    echo 'known low-write first-write-after-idle signature confirmed — remediation authorised'

    # Exactly one PostgreSQL container, or abort.
    mapfile -t PGIDS < <(docker ps -q \
      --filter 'label=com.docker.compose.project=orgistry-infra' \
      --filter 'label=com.docker.compose.service=postgres')
    [[ "${#PGIDS[@]}" -eq 1 ]] \
      || { echo "ABORT: expected exactly 1 postgres container, found ${#PGIDS[@]}" >&2; exit 1; }

    sudo docker exec -i "${PGIDS[0]}" psql -U orgistry -d orgistry -c 'SELECT pg_switch_wal();'
    systemctl --user start orgistry-wal-ship.service
    sleep 5
    echo '--- wal health (after remediation) ---'
    ORGISTRY_BACKUP_CONFIG="${BACKUPCFG}" node tooling/backup-ops.mjs wal-health
  fi

  # Final gate — BOTH must exit 0.
  ORGISTRY_BACKUP_CONFIG="${BACKUPCFG}" node tooling/backup-ops.mjs health >/dev/null \
    || { echo 'ABORT: backup health not clean at final gate' >&2; exit 1; }
  ORGISTRY_BACKUP_CONFIG="${BACKUPCFG}" node tooling/backup-ops.mjs wal-health >/dev/null \
    || { echo 'ABORT: wal-health not clean at final gate — do NOT enter the danger interval' >&2; exit 1; }
  echo 'BACKUP + WAL HEALTH: CLEAN'

  # ================= A2. Known-good runtime on disk =================
  mode="$(sudo stat -c '%a' "${RUNTIME}")"; owner="$(sudo stat -c '%U:%G' "${RUNTIME}")"
  [[ "${mode}"  == '600'           ]] || { echo "ABORT: runtime.env mode ${mode}, expected 600" >&2; exit 1; }
  [[ "${owner}" == 'daniel:daniel' ]] || { echo "ABORT: runtime.env owner ${owner}, expected daniel:daniel" >&2; exit 1; }
  echo "runtime.env metadata OK: ${mode} ${owner}"

  assert_count() {
    local key="$1" want="$2" got
    got="$(sudo grep -cE "^${key}=" "${RUNTIME}" || true)"
    [[ "${got}" -eq "${want}" ]] || { echo "ABORT: ${key} count=${got}, expected ${want}" >&2; return 1; }
    printf '%-20s count=%s OK\n' "${key}" "${got}"
  }
  assert_count MAIL_DRIVER 1;   assert_count SMTP_HOST 1
  assert_count SMTP_PORT 1;     assert_count SMTP_USERNAME 1
  assert_count SMTP_PASSWORD 1; assert_count SMTP_PASSWORD_FILE 0
  assert_count MAIL_FROM_EMAIL 1; assert_count MAIL_FROM_NAME 1

  for line in 'MAIL_DRIVER=smtp' 'SMTP_HOST=smtp.resend.com' 'SMTP_PORT=2465' \
              'SMTP_USERNAME=resend' 'MAIL_FROM_EMAIL=no-reply@mail.drsvp.com' \
              'MAIL_FROM_NAME=Orgistry'; do
    sudo grep -Fxq -- "${line}" "${RUNTIME}" \
      || { echo "ABORT: expected line not present: ${line}" >&2
           sudo grep -E "^${line%%=*}=" "${RUNTIME}" >&2 || true
           exit 1; }
    echo "OK: ${line}"
  done
  # SMTP_PASSWORD is never read or printed.

  # ================= A3. Known-good LIVE container =================
  mapfile -t APIIDS < <(docker ps -q \
    --filter 'label=com.docker.compose.project=orgistry' \
    --filter 'label=com.docker.compose.service=api')
  [[ "${#APIIDS[@]}" -eq 1 ]] \
    || { echo "ABORT: expected exactly 1 api container, found ${#APIIDS[@]}" >&2; exit 1; }
  live_port="$(docker exec "${APIIDS[0]}" printenv SMTP_PORT)"
  [[ "${live_port}" == '2465' ]] \
    || { echo "ABORT: live_api_smtp_port=${live_port}, expected 2465" >&2; exit 1; }
  echo "live_api_smtp_port=${live_port}"

  # ================= A4. Clean connfail namespace =================
  mapfile -t stale < <( sudo find /opt/orgistry/config -maxdepth 1 -type f -name "${PATTERN}" -print | sort )
  if [[ "${#stale[@]}" -ne 0 ]]; then
    echo "ABORT: ${#stale[@]} stale connfail rollback file(s) present — resolve manually:" >&2
    for f in "${stale[@]}"; do sudo stat -c '%a %U:%G %n' "${f}" >&2; done
    echo '       Nothing was created. Do NOT delete these automatically.' >&2
    exit 1
  fi
  echo 'connfail rollback namespace clean (0 existing)'

  if [[ -e "${STATE}" ]]; then
    echo "ABORT: stale state file already exists — not trusted, not overwritten:" >&2
    stat -c '%a %U:%G %n' "${STATE}" >&2
    exit 1
  fi
  echo 'connfail state file absent (as required)'

  # ================= A5. Protected rollback + state file =================
  ROLLBACK="$(sudo mktemp "$(dirname "${RUNTIME}")/.runtime.env.sprint29-connfail-rollback.XXXXXX")"
  sudo cp --preserve=mode,ownership "${RUNTIME}" "${ROLLBACK}"
  rbm="$(sudo stat -c '%a' "${ROLLBACK}")"; rbo="$(sudo stat -c '%U:%G' "${ROLLBACK}")"
  if [[ "${rbm}" != '600' || "${rbo}" != 'daniel:daniel' ]]; then
    sudo shred -u "${ROLLBACK}" 2>/dev/null || sudo rm -f "${ROLLBACK}"
    echo "ABORT: rollback metadata ${rbm} ${rbo}; removed to avoid an ambiguous secret copy" >&2
    exit 1
  fi
  sudo stat -c '%a %U:%G %n' "${ROLLBACK}"   # metadata only; contents never printed

  # State file. If ANY part fails, destroy the rollback so no ambiguous copy remains.
  if ! ( printf '%s\n' "${ROLLBACK}" >"${STATE}" \
         && chmod 600 "${STATE}" \
         && [[ "$(cat "${STATE}")" == "${ROLLBACK}" ]] \
         && [[ "$(cat "${STATE}")" == /opt/orgistry/config/.runtime.env.sprint29-connfail-rollback.* ]] ); then
    rm -f "${STATE}"
    sudo shred -u "${ROLLBACK}" 2>/dev/null || sudo rm -f "${ROLLBACK}"
    echo 'ABORT: state file creation/validation failed; rollback securely removed' >&2
    exit 1
  fi
  stat -c '%a %U:%G %n' "${STATE}"
  echo "rollback path recorded in ${STATE}"

  echo 'PHASE A: PASS — BACKUP/WAL CLEAN, KNOWN-GOOD BASELINE ASSERTED, CONNFAIL ROLLBACK CREATED'
)
```

**Phase A changes no SMTP setting, performs no deployment, sends no mail, and
does not enter the danger interval.**

> ## ⚠ DANGER INTERVAL BEGINS AT PHASE B
> **Once Phase B reports the port change installed, PHASE F RESTORATION IS
> MANDATORY** — even if C, D, or E fails. Do not investigate, do not retry; run
> Phase F or EMERGENCY RESTORE first.

---

### Phases B → F — one contiguous sequence

```bash
cd /opt/orgistry/deploy
set +o history

RUNTIME=/opt/orgistry/config/runtime.env
STATE=/tmp/orgistry-sprint29-connfail-rollback-path
MANIFEST=/opt/orgistry/evidence/staging-like/releases/91664d0fd639ca6ca8b5681317757bbcf0f0209b-9b79d72c045f.json
DEPLOYCFG=/opt/orgistry/config/deploy.env
REQFILE=/tmp/orgistry-sprint29-connfail-request-id

orgistry_image_evidence() (
  set -euo pipefail
  service="$1"; project='orgistry'
  ids="$(docker ps -q --filter "label=com.docker.compose.project=${project}" \
                      --filter "label=com.docker.compose.service=${service}")"
  n="$(printf '%s\n' "${ids}" | grep -c . || true)"
  [[ "${n}" -eq 1 ]] || { echo "FATAL: expected 1 '${service}' container, found ${n}" >&2; exit 1; }
  configured="$(docker inspect --format '{{.Config.Image}}' "${ids}")"
  runtime="$(docker inspect --format '{{.Image}}' "${ids}")"
  repo_digest="$(docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}<none>{{end}}' "${runtime}")"
  printf '%s.configured_image=%s\n%s.runtime_image_id=%s\n%s.repo_digest=%s\n' \
    "${service}" "${configured}" "${service}" "${runtime}" "${service}" "${repo_digest}"
)

orgistry_assert_identities() (
  set -euo pipefail
  f="$1"
  for want in \
    'api.configured_image=ghcr.io/danielrosenberg00/orgistry-api@sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f' \
    'api.runtime_image_id=sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f' \
    'web.configured_image=ghcr.io/danielrosenberg00/orgistry-web@sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855' \
    'web.runtime_image_id=sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855'; do
    grep -Fxq -- "${want}" "${f}" || { echo "FATAL: identity mismatch — expected: ${want}" >&2; exit 1; }
  done
  echo 'identities OK'
)

orgistry_assert_known_good_runtime() (
  set -euo pipefail
  mode="$(sudo stat -c '%a' "${RUNTIME}")"; owner="$(sudo stat -c '%U:%G' "${RUNTIME}")"
  [[ "${mode}" == '600' && "${owner}" == 'daniel:daniel' ]] || { echo "FATAL: ${mode} ${owner}" >&2; exit 1; }
  [[ "$(sudo grep -cE '^SMTP_PASSWORD='      "${RUNTIME}" || true)" -eq 1 ]] || { echo 'FATAL: SMTP_PASSWORD count' >&2; exit 1; }
  [[ "$(sudo grep -cE '^SMTP_PASSWORD_FILE=' "${RUNTIME}" || true)" -eq 0 ]] || { echo 'FATAL: SMTP_PASSWORD_FILE' >&2; exit 1; }
  [[ "$(sudo grep -cE '^SMTP_PORT='          "${RUNTIME}" || true)" -eq 1 ]] || { echo 'FATAL: SMTP_PORT count' >&2; exit 1; }
  for line in 'MAIL_DRIVER=smtp' 'SMTP_HOST=smtp.resend.com' 'SMTP_PORT=2465' \
              'SMTP_USERNAME=resend' 'MAIL_FROM_EMAIL=no-reply@mail.drsvp.com' 'MAIL_FROM_NAME=Orgistry'; do
    sudo grep -Fxq -- "${line}" "${RUNTIME}" || { echo "FATAL: ${line}" >&2; exit 1; }
  done
  echo 'known-good runtime asserted on disk'
)

# Live-container proof: reads ONE non-secret variable, never dumps the env.
orgistry_assert_live_port() (
  set -euo pipefail
  want="$1"
  CID="$(docker ps -q --filter 'label=com.docker.compose.project=orgistry' \
                      --filter 'label=com.docker.compose.service=api')"
  [[ -n "${CID}" ]] || { echo 'FATAL: api container not found' >&2; exit 1; }
  got="$(docker exec "${CID}" printenv SMTP_PORT)"
  [[ "${got}" == "${want}" ]] \
    || { echo "FATAL: live_api_smtp_port=${got}, expected ${want} — NOT RESTORED" >&2; exit 1; }
  echo "live_api_smtp_port=${got}"
)

orgistry_phase_b() (
  set -euo pipefail
  umask 077
  TMP=''
  cleanup() {
    rc=$?; trap - EXIT INT TERM
    if [[ -n "${TMP:-}" && "${TMP:-}" != "${RUNTIME}" && -e "${TMP:-}" ]]; then
      sudo shred -u "${TMP}" 2>/dev/null || sudo rm -f "${TMP}"
    fi
    exit "${rc}"
  }
  trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

  [[ -s "${STATE}" ]] || { echo "ABORT: ${STATE} missing; run Phase A" >&2; exit 1; }
  ROLLBACK="$(cat "${STATE}")"
  [[ "${ROLLBACK}" == /opt/orgistry/config/.runtime.env.sprint29-connfail-rollback.* ]] \
    || { echo 'ABORT: rollback path fails the connfail pattern' >&2; exit 1; }
  sudo test -f "${ROLLBACK}" || { echo "ABORT: rollback missing: ${ROLLBACK}" >&2; exit 1; }
  rbm="$(sudo stat -c '%a' "${ROLLBACK}")"; rbo="$(sudo stat -c '%U:%G' "${ROLLBACK}")"
  [[ "${rbm}" == '600' && "${rbo}" == 'daniel:daniel' ]] \
    || { echo "ABORT: rollback metadata ${rbm} ${rbo}" >&2; exit 1; }
  echo "rollback validated: ${ROLLBACK} (${rbm} ${rbo})"

  # Replace ONLY the SMTP_PORT line, in place. No secret is read or written.
  TMP="$(sudo mktemp "$(dirname "${RUNTIME}")/.runtime.env.connfail.XXXXXX")"
  sudo chown --reference="${RUNTIME}" "${TMP}"
  sudo chmod --reference="${RUNTIME}" "${TMP}"
  sudo awk '
    /^SMTP_PORT=/ { print "SMTP_PORT=465"; replaced++; next }
    { print }
    END { if (replaced != 1) { print "FATAL: replaced " replaced+0 " SMTP_PORT lines" > "/dev/stderr"; exit 1 } }
  ' "${RUNTIME}" | sudo tee "${TMP}" >/dev/null

  [[ "$(sudo grep -cE '^SMTP_PORT=465$'      "${TMP}" || true)" -eq 1 ]] || { echo 'ABORT: staged port' >&2; exit 1; }
  [[ "$(sudo grep -cE '^SMTP_PASSWORD='      "${TMP}" || true)" -eq 1 ]] || { echo 'ABORT: staged password count' >&2; exit 1; }
  [[ "$(sudo grep -cE '^SMTP_PASSWORD_FILE=' "${TMP}" || true)" -eq 0 ]] || { echo 'ABORT: staged password file' >&2; exit 1; }
  # Prove the credential line is byte-identical to the rollback's (no printing).
  sudo cmp -s <(sudo grep -E '^SMTP_PASSWORD=' "${ROLLBACK}") \
              <(sudo grep -E '^SMTP_PASSWORD=' "${TMP}") \
    || { echo 'ABORT: SMTP_PASSWORD line changed; refusing' >&2; exit 1; }
  echo 'SMTP_PASSWORD unchanged (compared without display)'

  sudo mv -f "${TMP}" "${RUNTIME}"; TMP=''
  sudo grep -E '^(MAIL_DRIVER|SMTP_HOST|SMTP_PORT|SMTP_USERNAME|MAIL_FROM_EMAIL|MAIL_FROM_NAME)=' "${RUNTIME}"
  echo 'PHASE B: PASS — SMTP_PORT=465 installed'
)

orgistry_phase_c_deploy() (
  set -euo pipefail
  umask 077
  rm -f /tmp/orgistry-connfail-images-before.txt
  tmp="$(mktemp /tmp/.orgistry-connfail-before.XXXXXX)"
  trap 'rm -f "${tmp}"' EXIT
  orgistry_image_evidence api  >"${tmp}"
  orgistry_image_evidence web >>"${tmp}"
  echo '--- identities before ---'; cat "${tmp}"
  orgistry_assert_identities "${tmp}"
  mv -f "${tmp}" /tmp/orgistry-connfail-images-before.txt
  trap - EXIT
  if ! sudo bash tooling/deploy.sh --manifest "${MANIFEST}" --config "${DEPLOYCFG}"; then
    echo 'FATAL: failure-test deploy FAILED — go straight to PHASE F' >&2
    return 1
  fi
)

orgistry_phase_c_verify() (
  set -euo pipefail
  umask 077
  before=/tmp/orgistry-connfail-images-before.txt
  [[ -s "${before}" ]] || { echo 'FATAL: no BEFORE baseline' >&2; exit 1; }
  rm -f /tmp/orgistry-connfail-images-after.txt
  tmp="$(mktemp /tmp/.orgistry-connfail-after.XXXXXX)"
  trap 'rm -f "${tmp}"' EXIT
  orgistry_image_evidence api  >"${tmp}"
  orgistry_image_evidence web >>"${tmp}"
  echo '--- identities after ---'; cat "${tmp}"
  mv -f "${tmp}" /tmp/orgistry-connfail-images-after.txt
  trap - EXIT
  diff -u "${before}" /tmp/orgistry-connfail-images-after.txt \
    || { echo 'FATAL: identity CHANGED' >&2; exit 1; }
  echo 'IMAGE IDENTITY UNCHANGED for BOTH api and web'
  orgistry_assert_live_port 465
  sudo node tooling/deploy-evidence.mjs current \
    --dir /opt/orgistry/evidence --environment staging-like
)

orgistry_phase_d_trigger() (
  set -euo pipefail
  umask 077
  BODY=''
  cleanup() {
    rc=$?; trap - EXIT INT TERM
    if [[ -n "${BODY:-}" && -e "${BODY:-}" ]]; then shred -u "${BODY}" 2>/dev/null || rm -f "${BODY}"; fi
    unset TEST_EMAIL TEST_PASSWORD
    exit "${rc}"
  }
  trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

  read -rs -p 'EXISTING-ACCOUNT recipient mailbox (hidden): ' TEST_EMAIL; echo
  [[ -n "${TEST_EMAIL}" ]] || { echo 'ABORT: empty recipient' >&2; exit 1; }
  TEST_PASSWORD="$(openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-32)"
  REQ_ID="sprint29-connfail-$(date -u +%Y%m%dT%H%M%SZ)"
  printf '%s\n' "${REQ_ID}" >"${REQFILE}"; chmod 600 "${REQFILE}"
  echo "correlation request id: ${REQ_ID}"
  echo '(expect ~10s: MAIL_TIMEOUT_MS bounds the connect/greeting)'

  BODY="$(mktemp)"; chmod 600 "${BODY}"
  jq -n --arg e "${TEST_EMAIL}" --arg p "${TEST_PASSWORD}" \
        '{email:$e, password:$p, displayName:"Sprint 29 SMTP Connection Failure Test"}' >"${BODY}"
  hdr="$(mktemp)"; chmod 600 "${hdr}"
  curl -sS -o /tmp/orgistry-connfail-body.json \
    -w 'http_status=%{http_code}\ncontent_type=%{content_type}\ntime_total=%{time_total}\n' -D "${hdr}" \
    -X POST 'https://api-staging.drsvp.com/v1/auth/register' \
    -H 'content-type: application/json' -H "x-request-id: ${REQ_ID}" \
    --data-binary "@${BODY}"
  grep -i '^x-request-id:' "${hdr}" || true
  echo '--- response body ---'; cat /tmp/orgistry-connfail-body.json; echo
  rm -f "${hdr}" /tmp/orgistry-connfail-body.json
)

orgistry_phase_d_evidence() (
  set -euo pipefail
  [[ -s "${REQFILE}" ]] || { echo "FATAL: ${REQFILE} missing" >&2; exit 1; }
  REQ_ID="$(cat "${REQFILE}")"
  [[ "${REQ_ID}" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo 'FATAL: unsafe request id' >&2; exit 1; }
  PGCID="$(docker ps -q --filter 'label=com.docker.compose.project=orgistry-infra' \
                        --filter 'label=com.docker.compose.service=postgres')"
  [[ -n "${PGCID}" ]] || { echo 'FATAL: postgres container not found' >&2; exit 1; }
  echo '--- security_events row ---'
  sudo docker exec -i "${PGCID}" psql -U orgistry -d orgistry -x -c \
    "SELECT id, event_type, actor_type, metadata, request_id, created_at
       FROM security_events
      WHERE event_type='auth.registration_requested' AND request_id='${REQ_ID}'
      ORDER BY created_at DESC LIMIT 1;"
  v="$(sudo docker exec -i "${PGCID}" psql -U orgistry -d orgistry -tA -c \
    "SELECT coalesce(metadata->>'outcome','<none>')||'|'||coalesce(metadata->>'delivered','<none>')
       FROM security_events
      WHERE event_type='auth.registration_requested' AND request_id='${REQ_ID}'
      ORDER BY created_at DESC LIMIT 1;")"
  echo "verdict=${v}"
  case "${v}" in
    'existing_account_notice_failed|false')
      echo 'PHASE D: EXPECTED CONNECTION FAILURE CONFIRMED' ;;
    'existing_account_notice_throttled|false')
      echo 'THROTTLED — no send was attempted (no-op, not a failed test).' >&2
      echo 'Wait out the 60s notice window and repeat the Phase D trigger ONCE.' >&2
      exit 1 ;;
    *)
      echo "UNEXPECTED verdict '${v}' — RESTORING, no retry" >&2; exit 1 ;;
  esac
)

orgistry_phase_e_local() (
  set -euo pipefail
  umask 077
  LOGF=''
  cleanup() {
    rc=$?; trap - EXIT INT TERM
    if [[ -n "${LOGF:-}" && -e "${LOGF:-}" ]]; then shred -u "${LOGF}" 2>/dev/null || rm -f "${LOGF}"; fi
    exit "${rc}"
  }
  trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
  CID="$(docker ps -q --filter 'label=com.docker.compose.project=orgistry' \
                      --filter 'label=com.docker.compose.service=api')"
  [[ -n "${CID}" ]] || { echo 'api container not found' >&2; exit 1; }
  LOGF="$(mktemp)"; chmod 600 "${LOGF}"
  docker logs --since 15m "${CID}" >"${LOGF}" 2>&1
  grep -qE 'token=[A-Za-z0-9_%.-]{8,}' "${LOGF}" \
    && echo 'registration token present in logs: yes' \
    || echo 'registration token present in logs: no'
  # The known-good credential must never surface. Compare without printing.
  if sudo grep -E '^SMTP_PASSWORD=' /opt/orgistry/config/runtime.env \
       | sed 's/^SMTP_PASSWORD=//' \
       | grep -Ff - "${LOGF}" >/dev/null 2>&1; then
    echo 'SMTP password present in logs: YES — INVESTIGATE' >&2
  else
    echo 'SMTP password present in logs: no'
  fi
)

orgistry_restore_runtime() (
  set -euo pipefail
  [[ -s "${STATE}" ]] || { echo "FATAL: ${STATE} missing" >&2; exit 1; }
  ROLLBACK="$(cat "${STATE}")"
  [[ "${ROLLBACK}" == /opt/orgistry/config/.runtime.env.sprint29-connfail-rollback.* ]] \
    || { echo 'FATAL: rollback path fails the pattern' >&2; exit 1; }
  sudo test -f "${ROLLBACK}" || { echo "FATAL: rollback missing: ${ROLLBACK}" >&2; exit 1; }
  sudo mv -f "${ROLLBACK}" "${RUNTIME}" || { echo 'FATAL: mv failed' >&2; exit 1; }
  echo 'rollback consumed into runtime.env'
)

orgistry_restore_deploy() (
  set -euo pipefail
  umask 077
  rm -f /tmp/orgistry-connrestore-images-before.txt
  tmp="$(mktemp /tmp/.orgistry-connrestore-before.XXXXXX)"
  trap 'rm -f "${tmp}"' EXIT
  orgistry_image_evidence api  >"${tmp}"
  orgistry_image_evidence web >>"${tmp}"
  orgistry_assert_identities "${tmp}"
  mv -f "${tmp}" /tmp/orgistry-connrestore-images-before.txt
  trap - EXIT
  if ! sudo bash tooling/deploy.sh --manifest "${MANIFEST}" --config "${DEPLOYCFG}"; then
    echo 'FATAL: restoration deploy FAILED — live container is NOT RESTORED' >&2
    return 1
  fi
  rm -f /tmp/orgistry-connrestore-images-after.txt
  tmp2="$(mktemp /tmp/.orgistry-connrestore-after.XXXXXX)"
  orgistry_image_evidence api  >"${tmp2}"
  orgistry_image_evidence web >>"${tmp2}"
  mv -f "${tmp2}" /tmp/orgistry-connrestore-images-after.txt
  echo '--- identities after restoration ---'; cat /tmp/orgistry-connrestore-images-after.txt
  diff -u /tmp/orgistry-connrestore-images-before.txt /tmp/orgistry-connrestore-images-after.txt \
    || { echo 'FATAL: identity changed during restoration' >&2; return 1; }
  echo 'IMAGE IDENTITY UNCHANGED for BOTH api and web'
  sudo node tooling/deploy-evidence.mjs current \
    --dir /opt/orgistry/evidence --environment staging-like
)

# ================= DRIVER: short-circuit, always restores =================
RC=0
orgistry_phase_b                             || RC=$?
(( RC == 0 )) && { orgistry_phase_c_deploy   || RC=$?; }
(( RC == 0 )) && { orgistry_phase_c_verify   || RC=$?; }
(( RC == 0 )) && { orgistry_phase_d_trigger  || RC=$?; }
(( RC == 0 )) && { orgistry_phase_d_evidence || RC=$?; }
(( RC == 0 )) && { orgistry_phase_e_local    || echo 'local negative-log evidence unavailable'; }

echo "=== failure-test phase status: ${RC} (0 = expected failure confirmed) ==="
echo '=== ENTERING MANDATORY RESTORATION ==='

if ! orgistry_restore_runtime; then
  echo 'FATAL: RUNTIME RESTORATION FAILED — NO DEPLOY ATTEMPTED.' >&2
  echo '       Use EMERGENCY RESTORE (rollback-present path).' >&2
elif ! orgistry_assert_known_good_runtime; then
  echo 'FATAL: RESTORED RUNTIME FAILED ASSERTIONS — NO DEPLOY ATTEMPTED.' >&2
elif ! orgistry_restore_deploy; then
  echo 'KNOWN-GOOD RUNTIME RESTORED ON DISK, BUT RESTORATION DEPLOY FAILED' >&2
  echo 'Retry the SAME deployment (rollback already consumed — do not look for it):' >&2
  echo "  cd /opt/orgistry/deploy && sudo bash tooling/deploy.sh --manifest ${MANIFEST} --config ${DEPLOYCFG}" >&2
else
  orgistry_assert_known_good_runtime \
    && orgistry_assert_live_port 2465 \
    && echo 'DANGER INTERVAL CLOSED — KNOWN-GOOD STAGING RESTORED'
fi

set -o history
```

### Phase E2 — manual Resend lookup (AFTER restoration only)

```bash
cat /tmp/orgistry-sprint29-connfail-request-id
```

Check the Resend dashboard around that timestamp. Expected
**`matching accepted/delivered message: NO`** — the connection times out before
provider acceptance. Report **yes/no** only; do not record the recipient.
**Absence does not prove *why* the connection failed** — the §9 real transport
evidence plus the application failure supply that.

### Phase G — restored-success proof

Wait **≥60 s** after the Phase D trigger (notice throttle 1/60 s; registration
3/60 s per email). **Same recipient.** Identical to the Phase D trigger block
except: `REQFILE=/tmp/orgistry-sprint29-connfail-restored-request-id`, request id
`sprint29-connfail-restored-$(date -u +%Y%m%dT%H%M%SZ)`, displayName
`Sprint 29 SMTP Connection Failure Restoration Test`, and the evidence `case`
expecting **`existing_account_notice_sent|false`**.

Then confirm manually: **Resend `delivered`** and **real mailbox receipt**.
`delivered=false` in the DB is the branch's known semantic, **not** a delivery
failure. Do not paste mailbox content, links, headers, or the EML.

### Phase H — cleanup

Identical in shape to the wrong-credential Phase H, with the connfail namespace:

```bash
(
  set -euo pipefail
  PATTERN='.runtime.env.sprint29-connfail-rollback.*'
  mapfile -t LEFT < <( sudo find /opt/orgistry/config -maxdepth 1 -type f -name "${PATTERN}" -print | sort )
  printf 'connfail rollback copies remaining: %s\n' "${#LEFT[@]}"
  printf '  %s\n' "${LEFT[@]:-<none>}"
  if   [[ "${#LEFT[@]}" -eq 0 ]]; then echo 'expected — Phase F consumed it'
  elif [[ "${#LEFT[@]}" -eq 1 ]]; then
    sudo shred -u -- "${LEFT[0]}" 2>/dev/null || sudo rm -f -- "${LEFT[0]}"; echo "removed ${LEFT[0]}"
  else echo 'ABORT: more than one rollback copy' >&2; exit 1; fi

  for f in /tmp/orgistry-sprint29-connfail-rollback-path \
           /tmp/orgistry-sprint29-connfail-request-id \
           /tmp/orgistry-sprint29-connfail-restored-request-id \
           /tmp/orgistry-connfail-images-before.txt /tmp/orgistry-connfail-images-after.txt \
           /tmp/orgistry-connrestore-images-before.txt /tmp/orgistry-connrestore-images-after.txt; do
    [[ -e "${f}" ]] && { rm -f "${f}"; echo "removed ${f}"; } || true
  done

  sudo find /opt/orgistry/config -maxdepth 1 -type f -name "${PATTERN}" -print | grep -q . \
    && { echo 'STILL PRESENT: connfail rollback' >&2; exit 1; } || echo 'ABSENT: connfail rollback'
  sudo grep -Fxq -- 'SMTP_HOST=smtp.resend.com' /opt/orgistry/config/runtime.env || exit 1
  sudo grep -Fxq -- 'SMTP_PORT=2465'            /opt/orgistry/config/runtime.env || exit 1
  printf 'SMTP_PASSWORD count=%s (never printed)\n' \
    "$(sudo grep -cE '^SMTP_PASSWORD=' /opt/orgistry/config/runtime.env || true)"
  printf 'SMTP_PASSWORD_FILE count=%s\n' \
    "$(sudo grep -cE '^SMTP_PASSWORD_FILE=' /opt/orgistry/config/runtime.env || true)"
  CID="$(docker ps -q --filter 'label=com.docker.compose.project=orgistry' \
                      --filter 'label=com.docker.compose.service=api')"
  echo "live_api_smtp_port=$(docker exec "${CID}" printenv SMTP_PORT)"
  echo 'PHASE H: PASS'
)
```

### EMERGENCY RESTORE

**Rollback still present:** read `/tmp/orgistry-sprint29-connfail-rollback-path`
(or constrained discovery over
`/opt/orgistry/config/.runtime.env.sprint29-connfail-rollback.*`, requiring
exactly one match and refusing to guess), `mv` it onto `runtime.env`, assert
`600 daniel:daniel`, `SMTP_PASSWORD` count 1, `SMTP_PASSWORD_FILE` count 0, and
the six known-good values including `SMTP_PORT=2465`, then run the same
manifest deployment and `orgistry_assert_live_port 2465`.

**Rollback already consumed, restoration deploy failed:** do **not** search for
it. Assert the known-good values on `runtime.env` as above, then re-run:

```bash
cd /opt/orgistry/deploy && sudo bash tooling/deploy.sh \
  --manifest /opt/orgistry/evidence/staging-like/releases/91664d0fd639ca6ca8b5681317757bbcf0f0209b-9b79d72c045f.json \
  --config   /opt/orgistry/config/deploy.env
```

and finish with `orgistry_assert_live_port 2465`. Never reconstruct or request
the Resend credential.

## 15. Account Flow Failure Semantics

Read from the implementation. **No outbox or retry queue was added.**

| Family | DB vs send ordering | API behaviour on send failure | Token state | Retry | Limitation |
|---|---|---|---|---|---|
| Registration completion | persist → send | generic acceptance (unchanged) | staged, unknown to anyone, expires | user registers again | silent loss |
| Existing-account guidance | no DB write | generic acceptance | no token minted | none | courtesy mail lost |
| Password recovery | persist → send | `{ accepted: true }` (no enumeration) | persisted, expires, retired by next generation | user requests again | silent loss |
| Email verification (explicit) | **send → persist** | **fails closed**, error surfaced | previous generation stays usable | repeat request | non-atomic window: accepted-then-persist-failure kills the emailed link |
| Email-change verification | commit → send (best effort) | never throws; change stands | as above | authenticated resend | account usable but unverified |
| Organization invitation | **send → persist** | **fails closed**; nothing written | no orphan invitation, no event | repeat create | accepted-then-persist-failure leaves a dead emailed link |

Operator intervention is **not** required for any of these; every case is
user-recoverable by repeating the request. A durable outbox with retry is the
correct production fix and is tracked separately (ORG-PR-016) — deliberately
**not** built here.

## 16. Bounce / Complaint / Suppression Posture

**Orgistry side — verified from the code:** no bounce ingestion, no complaint
ingestion, no suppression list, no undeliverable marking. Orgistry will resend
to a hard-bounced address every time a flow asks it to. No webhook ingestion was
built this sprint (explicitly out of scope).

**Provider side — `PENDING_OPERATOR`.** Bounce support, complaint support,
suppression-list behaviour, hard-bounce consequences, and complaint
consequences are provider facts and none is recorded until externally verified.
Whether the deployment currently *relies* on provider suppression cannot be
answered before a provider exists.

## 17. Provider Quotas and Rate Limits

**Status: `UNVERIFIED`.** No provider or account limits are known, and none is
guessed.

Known repository-side: Orgistry applies **no send-side throttle, concurrency
cap, or quota tracking**. Outbound volume is bounded only incidentally by the
per-endpoint abuse limits on the triggering surfaces (`config.rateLimit.*`) —
an abuse control, not a quota control.

Burst compatibility cannot be assessed against `UNVERIFIED` limits, and no
production-scale claim is made.

## 18. SMTP Credential: Design, Installation Boundary, and Rotation

### 18.1 Least-privilege credential design (prepared, NOT created)

| Property | Value |
|---|---|
| Provider key type | **Sending access** — **not** Full Access |
| Domain restriction | **`mail.drsvp.com`** only |
| Non-secret key name | `orgistry-staging-smtp` |
| `SMTP_USERNAME` | `resend` — a **public provider constant**, not secret material |
| `SMTP_PASSWORD` | the Resend sending-access API key — **secret** |

Rationale: a sending-access key restricted to the one verified sending domain
is the smallest capability that can satisfy the Sprint 29 evidence matrix. A
Full Access key would additionally permit domain, key, and account
administration from the staging host — capability the deployment never needs.

The API key must **never** be pasted into chat, model output, Git,
documentation, a command-line argument, or any evidence artifact.

### 18.2 The runtime-secret boundary — derived from the repository

Established by `infra/deploy.env.example`, `infra/compose.deploy.yml`,
`tooling/deploy.sh`, `tooling/lib/deploy-common.sh`, and confirmed on the real
host by the Sprint 27 evidence:

> **Host layout note (corrected 2026-08-30).** `infra/deploy.env.example` ships
> `/etc/orgistry/…` and `/var/lib/orgistry/deployments` as *repository
> defaults*. The **real** `orgistry-staging-01` layout, established empirically
> during this installation, is different — see §19.1. Every path below is the
> observed host path, not the template default.

| Fact | Source |
|---|---|
| Runtime configuration + **every runtime secret** live in one operator file — observed at `/opt/orgistry/config/runtime.env` | `ORGISTRY_RUNTIME_ENV_FILE` in `/opt/orgistry/config/deploy.env` |
| That file must be mode **0600**; the deployment **aborts** on a group- or world-readable file | `deploy_assert_runtime_env_protected` (`tooling/lib/deploy-common.sh:143`) |
| Sprint 27 observed it on the real host at mode 600, owner-only | [sprint-27-artifact-package.md](sprint-27-artifact-package.md) |
| The API container receives it via Compose **`env_file:`** — values become container environment | `infra/compose.deploy.yml` (`api.env_file`) |
| Deploy preflight requires `SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_DRIVER`, `MAIL_FROM_EMAIL` (accepting either `KEY=` **or** `KEY_FILE=`) | `deploy_assert_runtime_env_complete` (`tooling/lib/deploy-common.sh:158`) |
| `docker compose config` is **never** run by any script — it would expand `env_file` into plaintext | [../deployment.md](../deployment.md) |

### 18.3 Installation boundary — Option A is BINDING for Sprint 29

**Decision (operator, 2026-08-30): Option A.** The Resend sending-access API key
will live as `SMTP_PASSWORD=` inside the existing **0600** staging runtime
environment file `/opt/orgistry/config/runtime.env`.

- This is **consistent with the existing staging trust boundary**: `JWT_SECRET`
  and `DATABASE_URL` are already supplied exactly this way on this host, under
  the same mode-0600 invariant the deployment enforces.
- **No secret mount is added and `infra/compose.deploy.yml` is not modified in
  Sprint 29.**
- **It does not close ORG-PR-006.** The env file is a secret *handling*
  boundary — no secret store, no access control, no audit of secret reads, no
  automated rotation.
- **`_FILE` application support remains fully intact** (`secret-source.ts`,
  `FILE_BACKED_SECRET_NAMES`, `secret-source.test.ts`, and the
  `tooling/artifact-smoke.sh` `_FILE` proofs are untouched).

**The documented limitation stands and is not worked around.** The deployment
topology still lacks the read-only volume required for the API container to
consume a host `_FILE` secret: `infra/compose.deploy.yml` declares no
`volumes:` and no `secrets:` on the `api` service, so a host path named by
`SMTP_PASSWORD_FILE` would not exist inside the container and the loader would
fail closed at boot. This matches [../deployment.md](../deployment.md)
("…by adding a read-only volume to the deployment topology"), and `_FILE` is
proven end to end only by `tooling/artifact-smoke.sh`, which supplies its own
bind mount against the **validation** topology. Fixing the generic deployment
topology belongs with the broader **ORG-PR-006** secrets work unless
independently required.

### 18.5 Runtime file preflight — metadata and key names only

Run **before** any modification. Prints no secret values.

```bash
# Ownership and mode. The deployment REFUSES a group/world-readable file.
sudo stat -c '%a %U:%G %n' /opt/orgistry/config/runtime.env

# Per-key occurrence COUNTS only — no values are read or printed.
for k in MAIL_DRIVER SMTP_HOST SMTP_PORT SMTP_USERNAME \
         SMTP_PASSWORD SMTP_PASSWORD_FILE MAIL_FROM_EMAIL MAIL_FROM_NAME; do
  printf '%-20s count=%s\n' "$k" \
    "$(sudo grep -cE "^${k}=" /opt/orgistry/config/runtime.env || true)"
done
```

**Stop conditions.** If the mode is not `600` (or otherwise has any group/other
bits), **stop** — the deployment's own gate would refuse it, and silently
choosing new ownership is not this procedure's job. Report the metadata instead.

### 18.6 Atomic, interruption-safe upsert — never append

Blind `tee -a` is **rejected**: the file may already carry any of the mail keys,
and duplicates would make the effective configuration depend on parser
semantics. The procedure removes every managed mail key, rewrites exactly one of
each, and replaces the file atomically.

It is also **interruption-safe**. An earlier draft could leave a secret-bearing
staging file behind if the shell exited or was interrupted after the key was
written but before the atomic `mv`. A cleanup trap is now installed **before any
secret can enter the staging file**.

```bash
set +o history                    # defence in depth; the key never enters a command anyway

(
  set -euo pipefail
  umask 077

  RUNTIME=/opt/orgistry/config/runtime.env
  MAILKEYS='^(MAIL_DRIVER|SMTP_HOST|SMTP_PORT|SMTP_USERNAME|SMTP_PASSWORD|SMTP_PASSWORD_FILE|MAIL_FROM_EMAIL|MAIL_FROM_NAME)='
  TMP=''                          # explicit init: the trap runs under `set -u`
  RESEND_KEY=''

  cleanup() {
    rc=$?
    # Remove ONLY the staging file. Never the live runtime file, and never the
    # deliberate rollback copy (retained until known-good delivery or rollback).
    if [[ -n "${TMP:-}" && "${TMP:-}" != "${RUNTIME}" && -e "${TMP:-}" ]]; then
      sudo shred -u "${TMP}" 2>/dev/null || sudo rm -f "${TMP}"
    fi
    unset RESEND_KEY
    return "${rc}"
  }
  trap cleanup EXIT INT TERM      # installed BEFORE any secret exists

  # Deliberate ROLLBACK copy — protected, same directory, NOT removed by cleanup.
  ROLLBACK="$(sudo mktemp "$(dirname "${RUNTIME}")/.runtime.env.pre-smtp.XXXXXX")"
  sudo cp --preserve=mode,ownership "${RUNTIME}" "${ROLLBACK}"

  # Staging copy on the SAME filesystem so the replace is a rename(2).
  TMP="$(sudo mktemp "$(dirname "${RUNTIME}")/.runtime.env.new.XXXXXX")"
  sudo chown --reference="${RUNTIME}" "${TMP}"   # PRESERVE existing owner/group
  sudo chmod --reference="${RUNTIME}" "${TMP}"   # PRESERVE existing mode

  # 1. Everything that is NOT a managed mail key, verbatim.
  sudo grep -vE "${MAILKEYS}" "${RUNTIME}" | sudo tee "${TMP}" >/dev/null

  # 2. Exactly one of each non-secret mail key.
  sudo tee -a "${TMP}" >/dev/null <<'EOF'
MAIL_DRIVER=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=2465
SMTP_USERNAME=resend
MAIL_FROM_EMAIL=no-reply@mail.drsvp.com
MAIL_FROM_NAME=Orgistry
EOF

  # 3. Hidden input. `|| true` keeps `set -e` from killing the shell on EOF so
  #    the empty-key guard below can produce a clear abort instead.
  read -rs -p 'Resend sending-access API key (input hidden): ' RESEND_KEY || true
  echo
  if [[ -z "${RESEND_KEY}" ]]; then
    echo 'ABORT: empty key. The live runtime.env was NOT modified.' >&2
    exit 1                        # trap removes TMP; mv never ran
  fi

  # 4. Write the secret exactly once, then atomically replace.
  printf 'SMTP_PASSWORD=%s\n' "${RESEND_KEY}" | sudo tee -a "${TMP}" >/dev/null
  unset RESEND_KEY
  sudo mv -f "${TMP}" "${RUNTIME}"
  TMP=''                          # the trap can no longer remove anything

  echo "installed. rollback copy: ${ROLLBACK}"
)
install_rc=$?

set -o history
[[ "${install_rc}" -eq 0 ]] \
  && echo 'OK — proceed to 18.7' \
  || echo 'FAILED — live runtime.env unchanged; no secret-bearing temp file remains'
```

**Safety properties, each deliberate:**

| Property | How |
|---|---|
| No secret-bearing temp survives an exit, `Ctrl-C`, `SIGTERM`, or error | `trap cleanup EXIT INT TERM`, installed before the key is read |
| The trap can never delete the live file | guarded by `"${TMP}" != "${RUNTIME}"`, and `TMP` is always a distinct `mktemp` path |
| The rollback copy is never auto-deleted | `cleanup` does not reference `ROLLBACK`; its lifecycle is §18.8 |
| `set -u` cannot break the trap | `TMP` and `RESEND_KEY` initialised before the trap; `${TMP:-}` used inside it |
| An empty key aborts without touching the live file | explicit `-z` guard **before** the secret write and before `mv` |
| Key never in history, arguments, or output | `read -rs`, `printf | tee`, `set +o history` |
| Owner/group/mode preserved | `chown/chmod --reference` — **no `chown root:root` assumption** |
| Interactive shell unaffected by `set -euo pipefail` | the whole block runs in a `( … )` subshell |

If the operator interrupts *before* the closing `set -o history`, run `set -o history`
manually — the subshell's trap has already removed any staging file.

Guaranteed post-state: exactly one `MAIL_DRIVER`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, and
**zero** `SMTP_PASSWORD_FILE` (so the application's both-set guard cannot fire).

### 18.7 Post-write verification — secret-safe

```bash
# Mode / owner / group.
sudo stat -c '%a %U:%G %n' /opt/orgistry/config/runtime.env

# Exactly-one accounting (expect 1 for each, and 0 for SMTP_PASSWORD_FILE).
for k in MAIL_DRIVER SMTP_HOST SMTP_PORT SMTP_USERNAME \
         SMTP_PASSWORD SMTP_PASSWORD_FILE MAIL_FROM_EMAIL MAIL_FROM_NAME; do
  printf '%-20s count=%s\n' "$k" \
    "$(sudo grep -cE "^${k}=" /opt/orgistry/config/runtime.env || true)"
done

# Non-secret mail values (safe to display).
sudo grep -E '^(MAIL_DRIVER|SMTP_HOST|SMTP_PORT|SMTP_USERNAME|MAIL_FROM_EMAIL|MAIL_FROM_NAME)=' \
  /opt/orgistry/config/runtime.env

# Password LENGTH only. Everything after the FIRST '=' is the value, so a key
# containing '=' is measured correctly. The value is never printed.
sudo awk '/^SMTP_PASSWORD=/ {
            v = substr($0, index($0, "=") + 1)
            print "SMTP_PASSWORD=<set, length " length(v) ">"
          }' /opt/orgistry/config/runtime.env
```

Expected: mode `600`, owner unchanged from 18.5, every count `1`,
`SMTP_PASSWORD_FILE count=0`, and one `SMTP_PASSWORD=<set, length N>` line.

### 18.8 Pre-Resend rollback copy — RETENTION GATE SATISFIED, cleanup prepared

```
/opt/orgistry/config/.runtime.env.pre-resend.J2s0rW      (mode 600, daniel:daniel)
```

It holds the **previous complete runtime-secret set** — not just the old SMTP
credential — so it is a second full copy of every staging secret and should not
outlive its purpose.

**Every retention condition is now met (2026-08-30):**

| # | Condition | State |
|---|---|---|
| 1 | Application send succeeded | **MET** (§11.1) |
| 2 | Resend accepted the message | **MET** (§11.2) |
| 3 | Resend reported `delivered` | **MET** (§11.2) |
| 4 | Real external Gmail receipt observed | **MET** (§11.3) |
| 5 | Runtime stayed healthy | **MET** — `/health`, `/ready` |
| 6 | Immutable API digest preserved | **MET** (§19.4) |
| 7 | Smoke passed 9/9 | **MET** (§19.4) |
| 8 | Exposed first token generation superseded | **MET** (§19.7) |

The copy is therefore **obsolete**. This is **operational secret hygiene after a
completed credential transition — it is not email-delivery evidence** and is
tracked separately from ORG-PR-002.

**DELETED AND VERIFIED ABSENT on 2026-09-02** (§20.5), after the backup-wiring
verification redeploy proved out: `shred -u` with an `rm -f` fallback, followed
by absence verification, and a check that no stray runtime.env/deploy.env copies
remained. No further persistent copy of the old runtime secrets exists — the
live `/opt/orgistry/config/runtime.env` is the single authority.

Note what a rollback would have meant, for the record: the copy restores the
previous mail configuration, which pointed at the **local Mailpit sink**
(`SMTP_HOST=mailpit`, port 1025) — i.e. no external mail.

### 18.9 Restart / redeploy — the repository-proven path

**Use `tooling/deploy.sh`. A targeted `docker compose up api` is NOT a
supported shortcut**, and the command proposed in the previous iteration was
incomplete.

`infra/compose.deploy.yml` interpolates the **whole file** regardless of which
service is targeted, and requires four variables with `:?` (fail-if-unset):
`ORGISTRY_API_IMAGE`, `ORGISTRY_WEB_IMAGE`, `ORGISTRY_RUNTIME_ENV_FILE`, and
`ORGISTRY_PUBLIC_API_BASE_URL`. The two image variables are **not** in
`deploy.env` — `tooling/deploy.sh` resolves them from the **release manifest**
(`tooling/release-manifest.mjs read … images.api.reference`, deploy.sh:191-204)
and exports them. A hand-run compose command would therefore either fail on the
unset variables or, if an operator supplied them by hand, risk deploying a
digest nobody validated — the exact failure the model exists to prevent.

```bash
# On orgistry-staging-01, from the deployment checkout: /opt/orgistry/deploy

# 1. Recover the manifest of the CURRENTLY deployed release from the ledger.
sudo node tooling/deploy-evidence.mjs current \
  --dir /opt/orgistry/evidence --environment staging-like
#    -> read `manifestFile`, e.g. releases/<commit>-<apiDigest12>.json

MANIFEST=/opt/orgistry/evidence/staging-like/releases/<commit>-<apiDigest12>.json

# 2. Redeploy the SAME release with the new runtime configuration.
sudo bash tooling/deploy.sh --manifest "$MANIFEST" --config /opt/orgistry/config/deploy.env
```

Re-deploying the *same* manifest is what preserves the immutable API digest:
image identity comes from the manifest, never from configuration. The run also
re-applies every safety gate — 0600 runtime-file check, `SMTP_*`/`MAIL_*`
completeness (`deploy_assert_runtime_env_complete`), backup preflight,
migrate-once with head verification (idempotent: already at head), readiness
gating, smoke, and a new evidence record. **A full preflight/migrate/smoke cycle
is accepted as the cost of using the proven path.** PostgreSQL and Redis are
operator-provided services outside this compose project and are untouched;
public origins come from `deploy.env` and are unchanged.

### 18.10 API container selection and digest evidence — before and after

**The previous `docker compose -p orgistry ps -q api` command is withdrawn.**
It is inconsistent with §18.9's own finding: `docker compose` resolves a compose
file, and `compose.deploy.yml` fails interpolation without
`ORGISTRY_API_IMAGE`, `ORGISTRY_WEB_IMAGE`, `ORGISTRY_RUNTIME_ENV_FILE`, and
`ORGISTRY_PUBLIC_API_BASE_URL`. A lookup used to *verify* a deployment must not
depend on the file whose variables the deployment supplies.

**Selector: Docker Compose container labels — proven, not assumed.** Compose v2
stamps every container it creates with `com.docker.compose.project` and
`com.docker.compose.service`. Verified empirically against this Docker engine
with a throwaway project: filtering on those two labels returned exactly the
expected container, and `docker inspect` showed both labels present, **with no
compose file read and no variable interpolation**. The deployed containers are
created by `docker compose` in `tooling/deploy.sh`, so they carry the same
labels; the project value is `ORGISTRY_COMPOSE_PROJECT` (`deploy.env`, default
`orgistry`) and the service is `api` (`compose.deploy.yml`).

**Canonical helper: `orgistry_image_evidence`, defined inline in every phase
that uses it** (the backup-wiring procedure and the wrong-credential test alike).
It is parameterised by service so it covers **both `api` and `web`**, requires
exactly one match, and is redefined per phase so no operator shell ever depends
on a helper from an earlier command, an earlier phase, or from this document. Its
three fields:

| Field | `docker inspect --format` | Meaning |
|---|---|---|
| `<svc>.configured_image` | `{{.Config.Image}}` on the container | the digest-pinned reference the container was created from |
| `<svc>.runtime_image_id` | `{{.Image}}` on the container | the running image ID — **the same identity `deploy.sh` Stage 7 compares** via `deploy_container_image_id` |
| `<svc>.repo_digest` | `{{index .RepoDigests 0}}` on that image | the immutable registry digest (supplementary) |

All three format strings were verified empirically against this Docker engine.
None prints container environment, and none prints a secret.

Independently, `tooling/deploy.sh` Stage 7 refuses the deployment outright if a
running container is not the released image, and records `--runtime-api-digest`
/ `--runtime-web-digest` into the ledger — so the redeploy also produces its own
corroborating evidence.

### 18.11 Post-redeploy smoke — the existing checks only

`tooling/deploy.sh` runs these itself; they are listed so the operator knows
what must pass and what to report:

| Check | Source |
|---|---|
| API container running and healthy (Compose `--wait`) | `deploy.sh:486` |
| `GET /health` → 200 | `deploy.sh:494` |
| `GET /ready` → 200 | `deploy.sh:495` |
| Public deployment smoke — Sprint 27 recorded **9/9** | `tooling/deploy-smoke.sh` via `deploy.sh:523` |
| Web smoke (included in the same script's checks) | `tooling/deploy-smoke.sh` |
| New deployment evidence record written | `tooling/deploy-evidence.mjs record` |

**None of this proves SMTP authentication.** SMTP is lazy — nothing connects to
Resend at boot or during readiness — so a green `/health`, `/ready`, and 9/9
smoke are entirely consistent with a wrong credential. **SMTP authentication
remains pending until an application email is actually triggered (§11).**

### 18.4 Rotation — still required, not yet rehearsed

Procedure: [../rotation-runbook.md](../rotation-runbook.md#rotate-smtp-credentials).
**Rehearsal: `PENDING_OPERATOR`** — no credential exists yet.

Once the first credential is successfully used, Sprint 29 still requires:
create a **replacement** sending-access key (add, never replace in place, so
rollback stays possible) → install through the protected boundary → restart →
validation send → revoke the old key → safely verify the old credential now
fails if practical → retain the new key → confirm logs are secret-clean.

This remains **manual** and **does not close ORG-PR-006**: one credential
rotated by hand is not a secrets-management capability, not automated rotation,
and not coverage of the other runtime secrets.

## 19. Credential Installation and Deployment Evidence — VERIFIED 2026-08-30

### 19.1 Real staging host layout (corrected — supersedes repository defaults)

Established empirically on `orgistry-staging-01`. The repository templates ship
different defaults; **these are the observed facts.**

| Purpose | **Real host path / value** | Superseded assumption |
|---|---|---|
| Deployment checkout | `/opt/orgistry/deploy` | `~/Orgistry` |
| Runtime configuration (holds every runtime secret) | `/opt/orgistry/config/runtime.env` | `/etc/orgistry/runtime.env` |
| Deployment configuration | `/opt/orgistry/config/deploy.env` | `/etc/orgistry/deploy.env` |
| Deployment evidence root | `/opt/orgistry/evidence` | `/var/lib/orgistry/deployments` |
| Compose project (application) | `orgistry` | — |
| API container | `orgistry-api-1` | — |
| Infrastructure project (separate) | `orgistry-infra` — PostgreSQL, Redis, Mailpit | assumed same project |

The superseded values came from `infra/deploy.env.example` and earlier
assumptions in this artifact; they were never observed host facts and are no
longer presented as such. Note the **infrastructure services run in a separate
Compose project (`orgistry-infra`)**, which is why the label selector in §18.10
filters on the *application* project and the `api` service specifically.

### 19.2 Credential creation — VERIFIED

| Property | Value |
|---|---|
| Name | `orgistry-staging-smtp` |
| Permission | **Sending access** (not Full Access) |
| Domain restriction | **`mail.drsvp.com`** |
| Secret value | **never returned to any assistant, never recorded** |

### 19.3 Credential installation — VERIFIED

**Before** modification, `/opt/orgistry/config/runtime.env` was mode `600`,
owner/group `daniel:daniel`, and already carried exactly one occurrence of each
mail key — pointed at the **local Mailpit sink**, not a provider:
`MAIL_DRIVER=smtp`, `SMTP_HOST=mailpit`, `SMTP_PORT=1025`,
`SMTP_USERNAME=orgistry-staging`, `SMTP_PASSWORD=<existing secret>`,
`MAIL_FROM_EMAIL=no-reply@drsvp.com`, `MAIL_FROM_NAME=Orgistry Staging`, and
zero `SMTP_PASSWORD_FILE`.

This is exactly the situation the **atomic upsert** was designed for: a blind
append would have produced two of every key. The reviewed Option A procedure
(§18.6) was executed.

**After** the write:

| Check | Result |
|---|---|
| Mode | `600` — unchanged |
| Owner/group | `daniel:daniel` — **preserved**, no `chown` assumption applied |
| `MAIL_DRIVER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME` | exactly **one** occurrence each |
| `SMTP_PASSWORD_FILE` | **zero** — the both-set guard cannot fire |
| `SMTP_PASSWORD` | verified only as `<set, length 36>` — value never read, printed, or inferred |
| `.runtime.env.new.*` staging file | **none remained** — the trap and atomic `mv` behaved as designed |

Effective non-secret mail configuration now in force:

```
MAIL_DRIVER=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=2465
SMTP_USERNAME=resend
MAIL_FROM_EMAIL=no-reply@mail.drsvp.com
MAIL_FROM_NAME=Orgistry
```

A protected rollback copy exists at
`/opt/orgistry/config/.runtime.env.pre-resend.J2s0rW` (mode `600`,
`daniel:daniel`). It holds the **previous complete runtime-secret set** and is
retained deliberately — lifecycle in §18.8.

### 19.4 Same-release redeploy — VERIFIED

| Item | Value |
|---|---|
| Release commit | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` |
| Manifest | `/opt/orgistry/evidence/staging-like/releases/91664d0fd639ca6ca8b5681317757bbcf0f0209b-9b79d72c045f.json` |
| API reference | `ghcr.io/danielrosenberg00/orgistry-api@sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` |
| Web reference | `ghcr.io/danielrosenberg00/orgistry-web@sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` |
| Deploy config used | `/opt/orgistry/config/deploy.env` |
| New evidence record | `/opt/orgistry/evidence/staging-like/records/20260830T125613303Z-91664d0fd639-deploy.json` |

Deployment results, all PASS: manifest validation · images pulled **by digest**
· host architecture verification · pre-deploy recovery-point backup · migration
run (head `0012_shocking_warbound`, 13 applied) · API healthy · web healthy ·
API health/readiness · **running digest verification** · post-deployment smoke
**9/9** · evidence record written.

Post-redeploy API container `/orgistry-api-1`: status `running`, health
`healthy`, configured image digest **unchanged**, runtime image ID
**unchanged**.

Public probes:

```
GET https://api-staging.drsvp.com/health  -> {"ok":true,"data":{"status":"ok"}}
GET https://api-staging.drsvp.com/ready   -> {"ok":true,"data":{"status":"ready"}}
```

**Recorded state:**

| Fact | State |
|---|---|
| Credential created (least-privilege, domain-restricted) | **VERIFIED** |
| Credential installed into the protected runtime boundary | **VERIFIED** |
| Runtime configuration deployed | **VERIFIED** |
| API immutable digest preserved | **VERIFIED** |
| Post-deploy health / readiness | **VERIFIED** |
| Deployment smoke (9/9) | **VERIFIED** |

**None of this is SMTP evidence.** SMTP is lazy — the API opens no connection to
Resend at boot or during readiness — so every result above is fully consistent
with a wrong or revoked credential. **SMTP authentication, provider acceptance,
and delivery all remain unproven** until a real application email is triggered
(§11).

### 19.7 Exposed registration token — CONTAINED, VERIFIED 2026-08-30

The raw evidence message used to collect §11's headers contained the first
registration token outside the intended recipient mailbox, so that generation
was treated as **compromised**. Its value is not reproduced anywhere.

**Containment is complete.** The operator issued one additional registration
request for the **same** recipient address specifically to supersede it:

| Observed | Value |
|---|---|
| HTTP status | `200` |
| Response | `{"ok":true,"data":{"accepted":true}}` |

The mechanism is the repository behaviour already derived, not a new claim:
`registration.repo.ts — issuePendingRegistration` takes a per-normalized-email
advisory lock, sets `invalidatedAt` on **every prior unused generation**, and
inserts the replacement. The exposed token therefore now resolves as superseded.

**`first evidence token generation superseded: VERIFIED`**

**This is no longer an ORG-PR-002 blocker.** The replacement token is not
requested, reproduced, derived, or documented, and no second evidence message
was collected — superseding needed only the request, not its output.

### 19.5 `publicConfig.mailpitUrl` in the evidence record — interpretation

The new record still carries `publicConfig.mailpitUrl=http://localhost:8025`.
**This is not evidence that the deployed API uses Mailpit, and must not be read
that way.**

Derived from the repository:

- It originates from `ORGISTRY_PUBLIC_MAILPIT_URL` (`deploy.sh:160`, defaulted),
  is passed to the **web** container's `environment:` in `compose.deploy.yml`,
  and is recorded as one of the three `PUBLIC_CONFIG_KEYS`
  (`tooling/lib/deploy-evidence.mjs:56`) — `apiBaseUrl`, `csrfHeaderName`,
  `mailpitUrl`. That allowlist exists so **a secret cannot be written into
  evidence even by mistake** (`deployment.md`).
- Its only consumer is the **web demo browser bundle**:
  `apps/web-demo/src/public-config.ts` → `config.ts — MAILPIT_URL` → a
  convenience link rendered on `InvitationsPage.tsx` ("in local development,
  open Mailpit to retrieve the …").
- `docs/deployment.md` already states the crucial property: `localhost` there is
  resolved by the **visitor's browser**, not the server; the staging host binds
  the Mailpit UI to its own loopback and publishes nothing.

**Classification: a web/demo browser convenience recorded as deployment
metadata.** It is *not* an API runtime dependency and has no relationship to
`SMTP_HOST`. The API's mail transport is `smtp.resend.com:2465`; the web
bundle's Mailpit link is a dead local link for any remote visitor.

**Action now: none.** It is stale-but-harmless public configuration. Removing or
repointing it is a web-demo/deployment concern outside the Sprint 29
specification, and is recorded as a candidate cleanup rather than changed here.

## 20. Backup/WAL Posture — programme HEALTHY; deployment preflight wiring gap

**Sprint 29 changed no backup, WAL, restore, or PITR code or configuration.**
The redeploy nonetheless surfaced an evidence difference that must be
reconciled before Sprint 29 closure, and it is recorded rather than explained
away.

### 20.1 The two mechanisms are different — do not conflate them

| Mechanism | 2026-08-30 result | What it means |
|---|---|---|
| **Pre-deploy recovery-point backup** (`ORGISTRY_BACKUP_PREFLIGHT=take`) | **PASS** — `orgistry-20260830T125555Z-pre-deploy.dump`, recovery point `2026-08-30T12:56:00Z` | A restore point exists *for this deployment* |
| **Ongoing backup-protection preflight** (`ORGISTRY_BACKUP_CONFIG`) | **`skipped — no backup programme is configured for this environment (ORG-PR-005)`**, record `protection: not-configured` | The deployment did **not** verify the environment's ongoing backup/WAL programme |

The first succeeding says nothing about the second. The 2026-08-27 record had
`protection: verified`; the 2026-08-30 record has `not-configured`.

### 20.2 What controls it — derived from `tooling/deploy.sh`

```
BACKUP_CONFIG="${ORGISTRY_BACKUP_CONFIG:-}"                                  # :142
BACKUP_PROTECTION_CHECK="${ORGISTRY_BACKUP_PROTECTION_CHECK:-               # :143
    $([[ -n "${ORGISTRY_BACKUP_CONFIG:-}" ]] && printf 'require' || printf 'off')}"
BACKUP_PROTECTION='not-configured'                                           # :349
case "${BACKUP_PROTECTION_CHECK}" in
  off) BACKUP_PROTECTION="$([[ -n "${BACKUP_CONFIG}" ]] && printf 'disabled' \
                                                        || printf 'not-configured')" ;;  # :365
  ...) # require/warn: runs `backup-ops.mjs health` AND `wal-health`; both pass -> 'verified'  # :369-380
esac
```

**Therefore `protection: not-configured` means exactly one thing:
`ORGISTRY_BACKUP_CONFIG` was unset or empty in `/opt/orgistry/config/deploy.env`
at deploy time.** With it unset the check defaults to `off` and records
`not-configured` without running any health probe.

**It is a deployment-configuration regression, not proof of a backup outage.**
The Sprint 28 programme runs as **systemd *user* timers** (`infra/systemd/`,
`infra/systemd/README.md`) entirely independently of `deploy.sh`; the deployment
merely *asks* about it when told where the configuration lives. Equally, this is
**not** evidence the programme is healthy — nothing checked it.

Most likely cause (unverified): `/opt/orgistry/config/deploy.env` no longer
names `ORGISTRY_BACKUP_CONFIG`, e.g. it was edited or replaced between the two
deployments. `infra/backup.env.example` documents the expected companion file
and already uses the real `/opt/orgistry/...` layout.

### 20.3 Programme health — VERIFIED 2026-08-30

The read-only checks established that this was **never a backup outage**.

| Check | Result |
|---|---|
| Sprint 28 systemd **user** timers active | `orgistry-backup`, `orgistry-wal-ship`, `orgistry-backup-health`, `orgistry-backup-prune` — all four |
| Failed user units | **0** |
| `backup-ops.mjs health` | **HEALTHY — 0 warnings**: five off-host recovery points; latest scheduled backup fresh; encryption verified; integrity digest recorded; no interrupted uploads; last scheduled run succeeded |
| `backup-ops.mjs wal-health` | **HEALTHY — 0 warnings**: `archive_mode` on; 44 WAL segments archived; **zero** archiver failures; no WAL pending locally; spool drained; 17 segments off-host and current |
| `backup-ops.mjs catalog` | 5 encrypted logical backups off-host; 1 encrypted PITR base backup; 17 archived WAL segments off-host |

The gap was **deployment evidence wiring**: `ORGISTRY_BACKUP_CONFIG` was absent
from `/opt/orgistry/config/deploy.env`, so `deploy.sh` defaulted the check to
`off`. **ORG-PR-005 stayed CLOSED throughout.**

### 20.4 Wiring reconciliation — VERIFIED 2026-09-02

**`deployment backup-preflight wiring reconciliation: VERIFIED`**

Executed by the operator through the prepared phases A–D.

**Phase A — atomic `deploy.env` update.** Before: `deploy.env` `640
daniel:daniel`, `backup.env` `600 daniel:daniel`, `ORGISTRY_BACKUP_CONFIG
count=0`. Exactly one line added:
`ORGISTRY_BACKUP_CONFIG=/opt/orgistry/config/backup.env`. After: `640
daniel:daniel` preserved, `count=1`, alongside the pre-existing
`ORGISTRY_BACKUP_PREFLIGHT=take` and `ORGISTRY_BACKUP_DIR=/opt/orgistry/backups`.
A temporary rollback copy `.deploy.env.pre-backupwiring.vzRfyX` was created.

**Phases B–C — same-release verification redeploy.** Baseline asserted and
matched exactly before deploying. Manifest
`…/releases/91664d0fd639ca6ca8b5681317757bbcf0f0209b-9b79d72c045f.json`,
commit `91664d0fd639ca6ca8b5681317757bbcf0f0209b` unchanged.

| Observation | Result |
|---|---|
| Release manifest | valid |
| **Backup protection preflight** | **`backup and WAL-archive health verified`** — it now *runs* |
| Pre-deploy recovery backup | `orgistry-20260902T102146Z-pre-deploy.dump`, recovery point `2026-09-02T10:21:51Z` |
| Migration head | `0012_shocking_warbound`, 13 migrations — unchanged |
| API / web running digests | unchanged |
| `/health`, `/ready` | live and ready |
| Smoke | `DEPLOY SMOKE OK: 9 checks passed` |
| Deployment | `DEPLOY OK — staging-like` |
| Identity comparison | `IMAGE IDENTITY UNCHANGED for BOTH api and web` · `PHASE B: PASS` · `PHASE C: PASS` |

New evidence record
`/opt/orgistry/evidence/staging-like/records/20260902T102157727Z-91664d0fd639-deploy.json`
now records **`backupPreflight.result = taken`**, **`backupPreflight.protection
= verified`**, `smoke.result = passed`, `smoke.checks = 9`. **The prior
limitation stating the ongoing backup programme was not verified healthy is
absent from the new record.**

Every subsequent redeploy must now show `protection: verified`, and a genuinely
degraded programme would abort a deployment before migrations.

### 20.5 Obsolete rollback-copy cleanup — VERIFIED 2026-09-02

**Phase D** executed: exactly one `.deploy.env.pre-backupwiring.*` existed and
was removed (final count `0`); `/opt/orgistry/config/.runtime.env.pre-resend.J2s0rW`
was securely removed and verified **ABSENT**; no stray `runtime.env` /
`deploy.env` copies remain. Output: **`PHASE D: PASS`**.

- **`obsolete deploy.env rollback copy cleanup: VERIFIED`**
- **`obsolete pre-Resend runtime secret rollback cleanup: VERIFIED`**

No obsolete rollback-copy blocker remains.

### 20.6 Current binding baseline

The staging environment is now a **clean known-good baseline**:

| Item | Value |
|---|---|
| Checkout | `/opt/orgistry/deploy` |
| Runtime config | `/opt/orgistry/config/runtime.env` (0600 `daniel:daniel`) |
| Deploy config | `/opt/orgistry/config/deploy.env` (640 `daniel:daniel`) |
| Backup config | `/opt/orgistry/config/backup.env` (0600 `daniel:daniel`) |
| Manifest | `…/releases/91664d0fd639ca6ca8b5681317757bbcf0f0209b-9b79d72c045f.json` |
| API identity | `sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` |
| Web identity | `sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` |
| Mail | `MAIL_DRIVER=smtp`, `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=2465`, `SMTP_USERNAME=resend`, `MAIL_FROM_EMAIL=no-reply@mail.drsvp.com`, `MAIL_FROM_NAME=Orgistry`, `SMTP_PASSWORD=<known-good; never printed>` |

### Final self-contained operator procedure — phases A–D

**Copy/paste safe from a fresh shell.** Every helper is defined before use; no
function or variable is assumed to exist from a previous command, session, or
document. Start at `cd /opt/orgistry/deploy`. **Phase D runs only if phase C
proves success.**

---

#### Phase A — preflight + atomic `deploy.env` wiring update

```bash
cd /opt/orgistry/deploy

# ---- A1. Preflight: metadata and key COUNT only (no unrelated values) ----
sudo stat -c '%a %U:%G %n' /opt/orgistry/config/deploy.env
sudo stat -c '%a %U:%G %n' /opt/orgistry/config/backup.env
printf 'ORGISTRY_BACKUP_CONFIG count=%s\n' \
  "$(sudo grep -cE '^ORGISTRY_BACKUP_CONFIG=' /opt/orgistry/config/deploy.env || true)"
# Expect: deploy.env 640 daniel:daniel · backup.env 600 · count=0
# STOP if backup.env is missing — the deployment would then fail closed.

# ---- A2. Atomic upsert (subshell: no option or trap leakage) ----
(
  set -euo pipefail
  umask 077

  CFG=/opt/orgistry/config/deploy.env
  KEY='^ORGISTRY_BACKUP_CONFIG='
  TMP=''
  ROLLBACK=''

  cleanup() {
    rc=$?
    trap - EXIT INT TERM                 # disable traps BEFORE acting
    # Remove ONLY the temporary staging file. Never the live deploy.env, and
    # never the deliberate rollback copy.
    if [[ -n "${TMP:-}" && "${TMP:-}" != "${CFG}" && -e "${TMP:-}" ]]; then
      sudo rm -f "${TMP}"
    fi
    exit "${rc}"                         # terminate with the ORIGINAL status
  }
  trap cleanup EXIT
  trap 'exit 130' INT                    # 128+SIGINT
  trap 'exit 143' TERM                   # 128+SIGTERM

  [[ -f /opt/orgistry/config/backup.env ]] \
    || { echo 'ABORT: backup.env missing; deployment would fail closed' >&2; exit 1; }

  # Deliberate rollback copy (deploy.env holds NO secrets by contract).
  ROLLBACK="$(sudo mktemp "$(dirname "${CFG}")/.deploy.env.pre-backupwiring.XXXXXX")"
  sudo cp --preserve=mode,ownership "${CFG}" "${ROLLBACK}"

  # Staging copy on the SAME filesystem so the replace is a rename(2).
  TMP="$(sudo mktemp "$(dirname "${CFG}")/.deploy.env.new.XXXXXX")"
  sudo chown --reference="${CFG}" "${TMP}"   # preserve daniel:daniel
  sudo chmod --reference="${CFG}" "${TMP}"   # preserve 640

  # Strip-then-write-one: never a blind append.
  sudo grep -vE "${KEY}" "${CFG}" | sudo tee "${TMP}" >/dev/null
  printf 'ORGISTRY_BACKUP_CONFIG=/opt/orgistry/config/backup.env\n' \
    | sudo tee -a "${TMP}" >/dev/null

  # Verify the STAGED file before the live file is touched.
  n="$(sudo grep -cE "${KEY}" "${TMP}" || true)"
  [[ "${n}" -eq 1 ]] \
    || { echo "ABORT: staged file has ${n} ORGISTRY_BACKUP_CONFIG lines; live file untouched" >&2; exit 1; }

  sudo mv -f "${TMP}" "${CFG}"          # atomic
  TMP=''                                # cleanup can no longer remove anything
  echo "deploy.env updated. rollback copy: ${ROLLBACK}"
)

# ---- A3. Post-write verification ----
sudo stat -c '%a %U:%G %n' /opt/orgistry/config/deploy.env          # expect 640 daniel:daniel
printf 'ORGISTRY_BACKUP_CONFIG count=%s\n' \
  "$(sudo grep -cE '^ORGISTRY_BACKUP_CONFIG=' /opt/orgistry/config/deploy.env || true)"   # expect 1
sudo grep -E '^ORGISTRY_BACKUP_(CONFIG|PREFLIGHT|DIR|PROTECTION_CHECK)=' \
  /opt/orgistry/config/deploy.env
```

---

#### Phase B — known-good BEFORE assertion + same-release redeploy

**Control-flow contract:** everything runs inside one subshell with its own
`set -euo pipefail`, so no operator shell option is relied on and nothing leaks
back out. Evidence is written to a temporary file and **`mv`-promoted only after
every assertion passes**, so a partial or stale baseline can never be mistaken
for a valid one. `tooling/deploy.sh` is invoked **inside** that same guarded
scope, after the assertions — a failed capture or a mismatched baseline aborts
before the deployment can start.

```bash
cd /opt/orgistry/deploy

(
  set -euo pipefail
  umask 077

  BEFORE=/tmp/orgistry-images-before.txt
  TMPOUT=''
  trap 'rm -f "${TMPOUT:-}"' EXIT        # image identities only; no secrets

  # Refuse to let a stale file from a prior attempt survive as a "baseline".
  rm -f "${BEFORE}"

  # ---- Self-contained digest helper (Docker LABELS only; no Compose) ----
  orgistry_image_evidence() {
    local service="$1" project='orgistry' ids n cid configured runtime repo_digest
    ids="$(docker ps -q \
             --filter "label=com.docker.compose.project=${project}" \
             --filter "label=com.docker.compose.service=${service}")"
    n="$(printf '%s\n' "${ids}" | grep -c . || true)"
    if [[ "${n}" -ne 1 ]]; then
      echo "FATAL: expected exactly 1 running '${service}' container in project '${project}', found ${n}" >&2
      return 1
    fi
    cid="${ids}"
    configured="$(docker inspect --format '{{.Config.Image}}' "${cid}")"
    runtime="$(docker inspect --format '{{.Image}}' "${cid}")"
    repo_digest="$(docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}<none>{{end}}' "${runtime}")"
    printf '%s.configured_image=%s\n%s.runtime_image_id=%s\n%s.repo_digest=%s\n' \
      "${service}" "${configured}" \
      "${service}" "${runtime}" \
      "${service}" "${repo_digest}"
  }
  # Prints image identity only — never container environment, never secrets.

  # ---- Capture. Separate statements, redirected to a FILE (no pipeline at
  #      all), so a failure cannot be masked by a succeeding `tee`. ----
  TMPOUT="$(mktemp /tmp/.orgistry-images-before.XXXXXX)"
  orgistry_image_evidence api  >"${TMPOUT}"
  orgistry_image_evidence web >>"${TMPOUT}"

  echo '--- observed current identities ---'
  cat "${TMPOUT}"

  # ---- Assert the known-good baseline, field by field ----
  assert_identity() {
    local expected="$1"
    grep -Fxq -- "${expected}" "${TMPOUT}" || {
      echo "FATAL: baseline mismatch — expected line not present:" >&2
      echo "         ${expected}" >&2
      echo "       Observed identities are printed above. ABORTING before deployment." >&2
      echo "       Do NOT attempt to restore this automatically; report the actual identity." >&2
      return 1
    }
  }
  assert_identity 'api.configured_image=ghcr.io/danielrosenberg00/orgistry-api@sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f'
  assert_identity 'api.runtime_image_id=sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f'
  assert_identity 'web.configured_image=ghcr.io/danielrosenberg00/orgistry-web@sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855'
  assert_identity 'web.runtime_image_id=sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855'
  echo 'BASELINE OK — running release matches the known-good identities'

  # Promote the baseline ONLY now that every assertion passed.
  mv -f "${TMPOUT}" "${BEFORE}"
  TMPOUT=''

  # ---- Same-release redeploy, INSIDE the guarded scope ----
  sudo bash tooling/deploy.sh \
    --manifest /opt/orgistry/evidence/staging-like/releases/91664d0fd639ca6ca8b5681317757bbcf0f0209b-9b79d72c045f.json \
    --config   /opt/orgistry/config/deploy.env
)
phase_b_rc=$?
if [[ "${phase_b_rc}" -eq 0 ]]; then
  echo 'PHASE B: PASS'
else
  echo "PHASE B: FAIL (exit ${phase_b_rc}) — do not proceed to phase C" >&2
fi
```

`repo_digest` is captured as supplementary registry evidence; the **four
authoritative equality fields** for this gate are the two `configured_image` and
two `runtime_image_id` lines.

---

#### Phase C — AFTER capture + hard identity comparison + evidence inspection

**Control-flow contract:** its own `set -euo pipefail` subshell; the AFTER file
is removed before writing so no stale file survives; the BEFORE baseline is
validated for completeness before it is trusted; and **a differing identity
exits non-zero** rather than merely printing.

```bash
cd /opt/orgistry/deploy

(
  set -euo pipefail
  umask 077

  BEFORE=/tmp/orgistry-images-before.txt
  AFTER=/tmp/orgistry-images-after.txt
  TMPOUT=''
  trap 'rm -f "${TMPOUT:-}"' EXIT

  # The baseline must exist AND be complete — never compare against a partial
  # or truncated file left by an aborted phase B.
  [[ -s "${BEFORE}" ]] || {
    echo 'FATAL: no BEFORE baseline; re-run phase B' >&2; exit 1; }
  for field in api.configured_image api.runtime_image_id \
               web.configured_image web.runtime_image_id; do
    grep -q "^${field}=" "${BEFORE}" || {
      echo "FATAL: BEFORE baseline is incomplete (missing ${field}); re-run phase B" >&2
      exit 1; }
  done

  rm -f "${AFTER}"

  orgistry_image_evidence() {
    local service="$1" project='orgistry' ids n cid configured runtime repo_digest
    ids="$(docker ps -q \
             --filter "label=com.docker.compose.project=${project}" \
             --filter "label=com.docker.compose.service=${service}")"
    n="$(printf '%s\n' "${ids}" | grep -c . || true)"
    if [[ "${n}" -ne 1 ]]; then
      echo "FATAL: expected exactly 1 running '${service}' container in project '${project}', found ${n}" >&2
      return 1
    fi
    cid="${ids}"
    configured="$(docker inspect --format '{{.Config.Image}}' "${cid}")"
    runtime="$(docker inspect --format '{{.Image}}' "${cid}")"
    repo_digest="$(docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}<none>{{end}}' "${runtime}")"
    printf '%s.configured_image=%s\n%s.runtime_image_id=%s\n%s.repo_digest=%s\n' \
      "${service}" "${configured}" \
      "${service}" "${runtime}" \
      "${service}" "${repo_digest}"
  }

  TMPOUT="$(mktemp /tmp/.orgistry-images-after.XXXXXX)"
  orgistry_image_evidence api  >"${TMPOUT}"
  orgistry_image_evidence web >>"${TMPOUT}"
  mv -f "${TMPOUT}" "${AFTER}"
  TMPOUT=''

  echo '--- observed identities after redeploy ---'
  cat "${AFTER}"

  # HARD comparison: a difference is fatal, not informational.
  if ! diff -u "${BEFORE}" "${AFTER}"; then
    echo 'FATAL: immutable image identity CHANGED for api and/or web.' >&2
    echo '       Phase C has FAILED. Phase D is FORBIDDEN. Investigate before continuing.' >&2
    exit 1
  fi
  echo 'IMAGE IDENTITY UNCHANGED for BOTH api and web'

  # ---- Deployment evidence record ----
  sudo node tooling/deploy-evidence.mjs current \
    --dir /opt/orgistry/evidence --environment staging-like
)
phase_c_rc=$?
if [[ "${phase_c_rc}" -eq 0 ]]; then
  echo 'PHASE C: PASS — review the checklist below before phase D'
else
  echo "PHASE C: FAIL (exit ${phase_c_rc}) — PHASE D IS FORBIDDEN" >&2
fi
```

**Evidence inspection never rescues a failed comparison:** the `diff` failure
exits the subshell before `deploy-evidence.mjs` runs, so a changed identity
cannot be laundered into an apparently successful procedure.

---

#### Phase D — cleanup of the two obsolete rollback copies

**Run ONLY if `PHASE C: PASS` was printed AND every item in the checklist below
was observed.** If phase C exited non-zero for any reason — a failed capture, a
changed identity, an incomplete baseline — **phase D is forbidden.**

```bash
# ---- D1. deploy.env rollback copy: constrained discovery, exactly one ----
mapfile -t ORGISTRY_DEPLOYENV_ROLLBACKS < <(
  sudo find /opt/orgistry/config -maxdepth 1 -type f \
       -name '.deploy.env.pre-backupwiring.*' -print | sort
)
printf 'found %s deploy.env rollback copies:\n' "${#ORGISTRY_DEPLOYENV_ROLLBACKS[@]}"
printf '  %s\n' "${ORGISTRY_DEPLOYENV_ROLLBACKS[@]:-<none>}"

if [[ "${#ORGISTRY_DEPLOYENV_ROLLBACKS[@]}" -eq 1 ]]; then
  # Delete the EXACT discovered path — never a wildcard passed to rm.
  sudo rm -f -- "${ORGISTRY_DEPLOYENV_ROLLBACKS[0]}"
  echo "removed ${ORGISTRY_DEPLOYENV_ROLLBACKS[0]}"
else
  echo 'ABORT: expected exactly 1 deploy.env rollback copy; remove manually after review' >&2
fi

# ---- D2. Pre-Resend runtime rollback copy (contains the old runtime secrets) ----
sudo shred -u /opt/orgistry/config/.runtime.env.pre-resend.J2s0rW \
  2>/dev/null || sudo rm -f /opt/orgistry/config/.runtime.env.pre-resend.J2s0rW

# ---- D3. Absence verification for BOTH ----
sudo find /opt/orgistry/config -maxdepth 1 -type f \
     -name '.deploy.env.pre-backupwiring.*' -print \
  | grep -q . && echo 'STILL PRESENT: deploy.env rollback copy' \
              || echo 'ABSENT: deploy.env rollback copy'

ls -l /opt/orgistry/config/.runtime.env.pre-resend.J2s0rW 2>/dev/null \
  && echo 'STILL PRESENT: pre-Resend runtime rollback copy' \
  || echo 'ABSENT: pre-Resend runtime rollback copy'

# ---- D4. No other persistent copy of either file ----
sudo ls -la /opt/orgistry/config/ \
  | grep -E '\.runtime\.env|runtime\.env\.|\.deploy\.env' \
  || echo 'no stray runtime.env or deploy.env copies in /opt/orgistry/config'
```

**No additional persistent backup of either file is created.** The live
`/opt/orgistry/config/runtime.env` and `/opt/orgistry/config/deploy.env` are the
single authorities.

---

### Phase D gate — what must be observed in phase C first

**Nothing below is claimed; each must be OBSERVED.** If any item fails, stop and
report the actual result — do not proceed to phase D.

| # | Required observation |
|---|---|
| 1 | Backup protection preflight **actually ran** (no longer "skipped — no backup programme is configured") |
| 2 | `backup-ops.mjs health` **PASS** within the deployment |
| 3 | `backup-ops.mjs wal-health` **PASS** within the deployment |
| 4 | Evidence record shows **`protection: verified`** (`deploy.sh:380`) |
| 5 | Pre-deploy recovery-point backup **PASS** (separate mechanism) |
| 6 | Migration head unchanged: `0012_shocking_warbound` |
| 7 | **API** configured image and runtime image ID unchanged |
| 8 | **Web** configured image and runtime image ID unchanged |
| 9 | `/health` and `/ready` **PASS** |
| 10 | Post-deployment smoke **9/9 PASS** |
| 11 | New deployment evidence record written |
| 12 | The record no longer carries the "ongoing backup programme was not verified healthy" limitation |

Under `require`, a failing probe aborts the deployment **before migrations** and
leaves the target unchanged — the intended safe outcome, and a reason to stop
rather than continue.

## 21. Local Validation Evidence

See §5 of the refinement report for the executed command list and results. All
gates were run unmodified; none was weakened.

## 22. Remote Workflow Evidence

**Status: `PENDING_OPERATOR`.** No remote workflow run is claimed for Sprint 29.

Constraints for when remote evidence is collected: **provider secrets are never
exposed to pull-request workflows**, and no live-provider, secret-backed test is
added to untrusted PR execution.

## 23. Finding Reconciliation

| Finding | State | Basis |
|---|---|---|
| **ORG-PR-002** | **OPEN** | **The success half is complete and verified (§11):** SMTP authentication, provider acceptance, provider-reported delivery, real external mailbox receipt, observed `Return-Path` (`send.mail.drsvp.com`), `spf=pass` with relaxed alignment, `dkim=pass` with **exact** alignment (`d=mail.drsvp.com`, `s=resend`), `dmarc=pass` on `header.from=mail.drsvp.com`, and no provider link rewriting. **It remains OPEN solely because the mandatory real-provider FAILURE evidence (§14) has not been collected.** The exposed-token safety action is **closed** — the generation was superseded and verified (§19.7). |
| **ORG-PR-006** | **OPEN** — untouched | Sprint 29 used the existing runtime secret boundary and added no secrets platform, no rotation automation, and rehearsed no rotation. |
| **ORG-PR-007** | **OPEN** — untouched | No metrics, tracing, dashboards, or alerting. Email validation is not observability. |
| **ORG-PR-009** | **OPEN** — untouched | Rate-limiter failure mode unchanged. Its residual alerting dependency still sits with ORG-PR-007. |

## 24. Staging Readiness Reassessment

**NO — unchanged, assessed conservatively.**

**This assessment changed materially on 2026-08-30 and is stated precisely.**
Account email **now works end to end on the staging target**: the registration
flow was triggered against the deployed application and a real external mailbox
received a DMARC-passing message (§11). The former blocker — a plaintext Mailpit
sink incompatible with the implicit-TLS driver — is gone; staging now sends
through `smtp.resend.com:2465`.

Staging readiness nonetheless stays **NO**, conservatively:

- the mandatory real-provider **failure** behaviour is unproven (§14) — a
  staging environment whose failure modes are unverified is not ready;
- the deployment's ongoing-protection preflight is not wired (§§20.4–20.5), so
  future deployments will not verify backup health before migrating;
- ORG-PR-007 (observability) remains open — there is still no alerting on the
  target.

## 25. Production Readiness Assessment

**NO.**

Production readiness remains false and will remain false while any independent
production blocker is open. **ORG-PR-002 is now CLOSED**, but **ORG-PR-006
(secrets management and rotation) remains an open P1 blocker**, and ORG-PR-007
and ORG-PR-009 remain open P2. Under the register's blocker-semantics rule, any
unresolved P0 or P1 prevents a production-ready result regardless of how mature
other domains are. **Closing Sprint 29 closes an email finding — it does not
make the system production-ready**, and no amount of email evidence may be read
that way.

## 26. ORG-PR-002 closure decision

**`ORG-PR-002: CLOSED`** (2026-09-02)

The binding Sprint 29 specification states ORG-PR-002 may close only if actual
evidence proves each of the following. Every item is now evidenced:

| Binding closure requirement | Evidence |
|---|---|
| Real external provider | Resend, `smtp.resend.com:2465`, account provisioned |
| Verified sender/domain | `mail.drsvp.com` verified at provider, `eu-west-1` |
| SPF/DKIM/DMARC posture | Received message: `spf=pass` (relaxed alignment via org domain `drsvp.com`), `dkim=pass` with `d=mail.drsvp.com` (**exact** alignment), `dmarc=pass` on `header.from=mail.drsvp.com`, policy `p=none` |
| Staging-like provider configuration | `MAIL_DRIVER=smtp` deployed on the staging-like target through the immutable release |
| Provider acceptance | Message `be88bafc-6cd7-4370-b248-e6854848766a`, final event `delivered` |
| Real inbox receipt | Real external Gmail mailbox — **VERIFIED** |
| Implemented account-email-family validation | All six families enumerated with triggers and a per-family evidence matrix; **two** delivered end to end to a real inbox (registration completion; existing-account guidance) |
| Required failure behaviour | **Both** mandatory classes satisfied on the real path — wrong credential and connection/provider failure — each with successful known-good restoration and a proven real delivery afterwards |

The specification's **REAL INBOX REQUIREMENT** sets the bar explicitly: *"At
least one real external mailbox must receive a message before ORG-PR-002 closes."*
Two families cleared it. The **ACCOUNT EMAIL FAMILY MATRIX** requirement is
phrased as *"prepare a repeatable deployed-application validation path"* and
*"the final matrix must be capable of recording"* — a preparation and capability
requirement, both met. Requiring all six families to be externally delivered
would **expand the requirement beyond its binding wording**, which the sprint
explicitly forbids, just as accepting less than one inbox receipt would weaken
it.

### Recorded residual — not a blocker, carried forward

**Four of six families have no external delivery evidence:** password recovery,
email verification, email-change verification, and organization invitation. Each
has an enumerated trigger and a prepared validation path, and all six share the
one `AccountMailer.deliver` seam, transport, sender identity, and header-safety
guard that were externally proven — so the *transport* is validated for all six.
What is unvalidated per-family is the rendered message and its link as a
recipient sees it. This is recorded in
[../known-limitations.md](../known-limitations.md) as a residual limitation and
is **not** an ORG-PR-002 blocker under the binding wording.

Also carried forward, unrelated to closure: inbox-vs-spam **placement** was never
evidenced (receipt ≠ placement); DMARC policy remains `p=none` by deliberate
choice, now supported by real alignment evidence should tightening be desired.

## 26b. Remaining work — none inside Sprint 29

Sprint 29's binding scope is complete. What remains is independent of it:

| Item | Finding | Nature |
|---|---|---|
| Secrets management / rotation platform | **ORG-PR-006** (P1) | Production blocker; the runtime env file is a secret *handling* boundary only |
| Observability — metrics, tracing, dashboards, alerting | **ORG-PR-007** (P2) | Blocks staging readiness; nothing pages anyone |
| Rate-limiter failure-mode alerting residual | **ORG-PR-009** (P2) | Depends on ORG-PR-007 |
| Durable outbox / retry queue | ORG-PR-016 | Deliberately out of Sprint 29 scope |
| Bounce / complaint / suppression ingestion | — | Deliberately out of scope; provider-side only |
| Four families' per-family external delivery | — | Residual above; not a blocker |
| WAL health-policy low-write refinement | — | Candidate refinement; ORG-PR-005 stays CLOSED |

## 27. Recommended Next Sprint

Do not open a new sprint. **Finish Sprint 29.** Provider selection is now
resolved (Resend, §2) and the credential-free transport check has **passed**
from the real staging host (§9).

The immediate next step is **provider provisioning**, in this order: resolve
the operator's actual controlled root domain (§3 — never invented), choose the
dedicated transactional sending subdomain, create the Resend account, add the
sending domain, capture and publish the provider-generated DNS records, keep
open/click tracking disabled, and wait for Resend to report the domain
verified. The SMTP credential (API key) is created only **after** the sending
domain is configured far enough to proceed safely — not before.

If Sprint 29 completes, the natural successor is **ORG-PR-006 (secrets
management and rotation)**, which the SMTP credential work has repeatedly
touched without advancing.
