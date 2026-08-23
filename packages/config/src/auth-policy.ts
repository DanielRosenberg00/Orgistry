import { z } from 'zod';

/**
 * Access-token signing key configuration rules (Sprint 24, ORG-PR-006).
 *
 * `JWT_SECRET` is the CURRENT signing key: every token Orgistry issues is
 * signed with it, and it is always accepted at verification.
 * `JWT_PREVIOUS_SECRET` is an OPTIONAL second key that verification also
 * accepts, so a secret rotation does not invalidate tokens already in flight
 * (see docs/rotation-runbook.md — "Rotate the access-token signing secret").
 * Nothing is ever signed with the previous key.
 *
 * These rules apply in EVERY runtime mode. Production-only strength rules for
 * both keys live in `production-policy.ts`.
 */

interface JwtRotationEnvFields {
  JWT_SECRET: string;
  JWT_PREVIOUS_SECRET?: string;
}

export function enforceJwtRotationConfig(
  env: JwtRotationEnvFields,
  ctx: z.RefinementCtx,
): void {
  if (env.JWT_PREVIOUS_SECRET === undefined) {
    return;
  }
  if (env.JWT_PREVIOUS_SECRET === env.JWT_SECRET) {
    // Equal keys mean the rotation never happened: the "previous" key would
    // widen nothing and the operator would believe a cutover window is open
    // when it is not. Refuse rather than accept a no-op rotation state.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PREVIOUS_SECRET'],
      message:
        'JWT_PREVIOUS_SECRET must not equal JWT_SECRET; set it to the key being retired, or unset it once the rotation window has closed',
    });
  }
}
