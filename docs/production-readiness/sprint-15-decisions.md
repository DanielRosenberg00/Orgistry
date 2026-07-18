# Sprint 15 — Decision Record (DG-1 … DG-5)

Status of the five decision gates defined in
[production-target.md](production-target.md), as of Sprint 15 closure
(2026-07-18).

**Summary: DG-1, DG-2, and DG-5 are RATIFIED by the Project Owner
(2026-07-18). DG-3 and DG-4 remain open, as the Sprint 15 specification
permits; their open status does not block Sprint 15 completion.**

## Authority history

The values behind DG-1 and DG-5 were previously engineering proposals awaiting
confirmation: [production-target.md](production-target.md) (Sprint 14) labeled
its profile and objectives "assumption-derived … a proposed target to confirm,
not an established requirement", and no owner-approval act existed in the
repository. An interim Sprint 15 draft marked DG-1/DG-5 "Ratified" on that
basis alone; a refinement pass corrected them to pending because a proposal is
not approval. **The Project Owner explicitly approved DG-1, DG-2, and DG-5 on
2026-07-18. They are now authoritative project decisions**, recorded below.
Ratification is a product decision only — none of the downstream
implementation it scopes (infrastructure, backups, role-transition
enforcement) was implemented in Sprint 15.

---

## DG-1 — Distribution model confirmation

- **Status:** **RATIFIED**
- **Approval date:** 2026-07-18
- **Decision owner:** Project Owner
- **Selected decision:**
  - *Primary distribution model:* self-hosted, single-region, low-scale
    multi-tenant B2B identity foundation, operated by a single operator or
    small team.
  - *Secondary distribution model:* low-scale managed or hosted evaluation.
  - The current production target is explicitly **not** a large public SaaS.
- **Rationale:** matches Orgistry's role as an open-source,
  production-oriented SaaS identity and access foundation; keeps
  infrastructure and operational requirements proportional to the intended
  scale while preserving the option to evaluate a low-scale hosted offering
  later. Large-scale public-SaaS requirements must not be assumed unless the
  Project Owner explicitly changes this decision.
- **Affected findings:** ORG-PR-001, ORG-PR-003, ORG-PR-006, ORG-PR-007,
  ORG-PR-008, ORG-PR-009, ORG-PR-012, ORG-PR-013, ORG-PR-027.
- **Affected future sprints:** Sprint 21, Sprint 23.
- **Open follow-up:** reassess infrastructure, operational, abuse-protection,
  and launch requirements if a hosted public offering becomes the primary
  distribution model.
- **Ratification vs. implementation:** this ratifies the target only; no
  infrastructure was implemented in Sprint 15 (deployment remains open under
  ORG-PR-001).

## DG-2 — Role-transition policy (Admin → Owner)

- **Status:** **RATIFIED**
- **Approval date:** 2026-07-18
- **Decision owner:** Project Owner
- **Selected decision:**
  - Only an active Owner may grant the Owner role to another member.
  - Only an active Owner may remove the Owner role from another member.
  - An Admin may not grant the Owner role to themselves.
  - An Admin may not grant the Owner role to another member.
  - An Admin may not remove the Owner role from another member.
  - Every Owner transition remains subject to the existing last-owner
    protection: an organization must always retain at least one active Owner.
- **Rationale:** the Owner role is the highest organization-level authority;
  allowing an Admin to confer Owner would let a lower-privileged role cross
  its own authorization boundary and gain or distribute unrestricted
  organization control. Restricting Owner transitions to existing active
  Owners preserves least privilege, makes ownership delegation explicit,
  prevents privilege self-escalation, keeps the authorization hierarchy
  coherent, and remains consistent with the last-owner invariant.
- **Affected finding:** ORG-PR-017 (remains **open** — the policy is decided;
  enforcement is not implemented).
- **Affected future sprint:** Sprint 19, which must implement and test:
  only active Owners may grant Owner; only active Owners may remove Owner;
  Admin-to-Owner self-promotion is forbidden; Admin promotion of another
  member to Owner is forbidden; Admin removal of an Owner is forbidden;
  last-owner protection remains mandatory; authorization failures are
  audit-logged where the established architecture requires it.
- **Open follow-up:** Sprint 19 enforcement and negative tests.
- **Ratification vs. implementation:** no enforcement code was written during
  Sprint 15 closure; current code still permits Admin→Owner promotion until
  Sprint 19 lands.

## DG-3 — Compliance regime

- **Status:** **OPEN**
- **Required decision:** legal/privacy review.
- **Required authority:** Project Owner + Legal.
- **Affected findings:** ORG-PR-025, ORG-PR-043.
- **Affected future sprints:** Sprint 22; Phase 5 privacy scope.
- **Note:** the Sprint 15 specification explicitly permits DG-3 to remain
  open; it does not block Sprint 15 completion.

## DG-4 — Quota and billing semantics

- **Status:** **OPEN**
- **Required decision:** product and billing-semantics decision.
- **Required authority:** Project Owner.
- **Affected finding:** ORG-PR-029 (rises P3→P2 if quotas become
  billing-enforced).
- **Affected future sprint:** Sprint 19 (quota concurrency priority).
- **Note:** the Sprint 15 specification explicitly permits DG-4 to remain
  open; it does not block Sprint 15 completion.

## DG-5 — Target RPO/RTO

- **Status:** **RATIFIED**
- **Approval date:** 2026-07-18
- **Decision owner:** Project Owner
- **Selected decision:**
  - *Production RPO:* no more than one hour of accepted production data may
    be lost. Point-in-time recovery must be available **before** the system
    accepts production data.
  - *Controlled non-production evaluation:* daily snapshots may be accepted
    only where the environment contains no production data and is explicitly
    classified as evaluation-only.
  - *Production RTO:* service and data recovery must be achievable within
    four hours through a documented and rehearsed restore process.
- **Rationale:** establishes a meaningful recovery boundary without imposing
  infrastructure intended for a much larger or higher-criticality public
  SaaS. PITR provides a practical production data-loss boundary; a four-hour
  rehearsed restore target fits the approved small-operator, single-region
  profile. A backup mechanism is not considered production-ready until
  restore behavior has been exercised and demonstrated.
- **Affected findings:** ORG-PR-005 (remains **open** — targets decided,
  backup/PITR/restore unimplemented), ORG-PR-028.
- **Affected future sprints:** Sprint 21 (select a PostgreSQL deployment
  model capable of the approved RPO); Sprint 22 (automated backups, PITR
  configuration, backup monitoring, retention policy, documented restore
  procedures, and a restore drill proving the approved RTO).
- **Open follow-up:** Sprint 21/22 implementation as above.
- **Ratification vs. implementation:** no backup, PITR, or restore behavior
  was implemented during Sprint 15 closure.
