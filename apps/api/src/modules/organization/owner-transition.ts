import { ROLE_IDS } from '@orgistry/db';
import { permissionDeniedError } from './member.errors';

/**
 * DG-2 Owner role-transition policy (ratified 2026-07-18; Sprint 20,
 * ORG-PR-017) — the SINGLE definition both the database and the in-memory
 * organization repositories enforce inside the member-mutation transaction:
 *
 *   Only an active Owner may grant the Owner role.
 *   Only an active Owner may remove the Owner role (including by removing an
 *   Owner member).
 *   An Admin may not grant Owner to themselves or anyone else, and may not
 *   demote or remove an Owner.
 *
 * The check runs AFTER the target membership is resolved (so cross-tenant and
 * unknown targets keep their uniform 404) and BEFORE the Last Owner invariant
 * (an actor without Owner authority is rejected regardless of how many Owners
 * remain). It intentionally covers the Owner→Owner no-op as well: assigning
 * the Owner role is an Owner-only act even when the target already holds it.
 *
 * `actorIsActiveOwner` must be derived from state read INSIDE the same
 * transaction/atomic section as the mutation (the DB repository checks the
 * actor's membership against the locked active-owner set), so a concurrently
 * demoted actor cannot slip an Owner grant through.
 */

/** True when a role change grants or removes the Owner role. */
export function roleChangeTouchesOwner(
  targetRoleId: string,
  newRoleId: string,
): boolean {
  return targetRoleId === ROLE_IDS.owner || newRoleId === ROLE_IDS.owner;
}

/**
 * Require Owner authority for an Owner-touching mutation, or reject with the
 * standard safe 403 (the same error every missing permission produces — it
 * discloses nothing about the target).
 */
export function assertOwnerChangeAuthority(actorIsActiveOwner: boolean): void {
  if (!actorIsActiveOwner) {
    throw permissionDeniedError();
  }
}
