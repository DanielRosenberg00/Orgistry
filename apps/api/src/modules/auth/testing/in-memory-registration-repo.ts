import {
  ROLE_IDS,
  type MembershipRow,
  type OrganizationRow,
  type PendingRegistrationRow,
  type RefreshTokenRow,
  type SessionRow,
  type UserRow,
} from '@orgistry/db';
import { createId } from '@orgistry/shared';
import {
  createInMemoryOrgStore,
  provisionDefaultOrganizationPlan,
  type InMemoryOrgStore,
} from '../../organization/testing/in-memory-org-store';
import {
  applyInvitationAcceptanceInStore,
  validateInvitationForAcceptanceInStore,
} from '../../invitations/testing/invitation-store-acceptance';
import { personalWorkspaceName } from '../../organization/organization.provisioning';
import { isInvitationUnavailableError } from '../registration.repo';
import type { NewSecurityEvent } from '../auth.types';
import type {
  CompleteRegistrationParams,
  CompleteRegistrationResult,
  CompletionInvitationOutcome,
  IssuePendingRegistrationParams,
  RegistrationRepository,
} from '../registration.types';

/**
 * In-memory `RegistrationRepository` for unit tests.
 *
 * Mirrors the database repository's observable behavior — the
 * one-usable-generation issuance invariant, the completion lifecycle
 * classification, atomic account provisioning, and the
 * invitation-unavailable policy — so the registration workflows can be
 * exercised end-to-end through the HTTP layer with no PostgreSQL. Persisted
 * state is exposed for assertions.
 *
 * Atomicity: `issuePendingRegistration` and `completeRegistration` run their
 * validate-then-apply bodies with NO intervening `await`, so under Node's
 * single-threaded model concurrent calls serialize exactly as the advisory
 * lock / `FOR UPDATE` row lock would.
 */
export interface InMemoryRegistrationRepository extends RegistrationRepository {
  readonly users: UserRow[];
  readonly sessions: SessionRow[];
  readonly refreshTokens: RefreshTokenRow[];
  readonly pendingRegistrations: PendingRegistrationRow[];
  readonly securityEvents: NewSecurityEvent[];
  readonly orgStore: InMemoryOrgStore;
}

export function createInMemoryRegistrationRepository(options?: {
  /** Share these with an in-memory auth repo so both see the same accounts. */
  orgStore?: InMemoryOrgStore;
  sessions?: SessionRow[];
  refreshTokens?: RefreshTokenRow[];
  securityEvents?: NewSecurityEvent[];
}): InMemoryRegistrationRepository {
  const orgStore = options?.orgStore ?? createInMemoryOrgStore();
  const users = orgStore.users;
  const sessions = options?.sessions ?? [];
  const refreshTokens = options?.refreshTokens ?? [];
  const securityEvents = options?.securityEvents ?? [];
  const pendingRegistrations: PendingRegistrationRow[] = [];

  return {
    users,
    sessions,
    refreshTokens,
    pendingRegistrations,
    securityEvents,
    orgStore,

    async findUserByNormalizedEmail(normalizedEmail) {
      return (
        users.find((user) => user.normalizedEmail === normalizedEmail) ?? null
      );
    },

    // Synchronous body (no await) -> atomic under the single-threaded loop,
    // mirroring the advisory-lock-serialized DB transaction: every prior
    // unused generation is retired in the same step that stages the new one.
    async issuePendingRegistration(params: IssuePendingRegistrationParams) {
      for (const pending of pendingRegistrations) {
        if (
          pending.normalizedEmail === params.normalizedEmail &&
          pending.usedAt === null &&
          pending.invalidatedAt === null
        ) {
          pending.invalidatedAt = params.now;
        }
      }
      pendingRegistrations.push({
        id: createId('preg'),
        email: params.email,
        normalizedEmail: params.normalizedEmail,
        passwordHash: params.passwordHash,
        displayName: params.displayName,
        tokenHash: params.tokenHash,
        invitationId: params.invitationId,
        expiresAt: params.expiresAt,
        usedAt: null,
        invalidatedAt: null,
        createdAt: new Date(),
      });
    },

    async findPendingRegistrationByTokenHash(tokenHash) {
      return (
        pendingRegistrations.find((row) => row.tokenHash === tokenHash) ?? null
      );
    },

    // Synchronous validate-then-apply (no await between) -> atomic under
    // Node's single-threaded loop, mirroring the DB completion transaction.
    async completeRegistration(
      params: CompleteRegistrationParams,
    ): Promise<CompleteRegistrationResult> {
      const pending = pendingRegistrations.find(
        (row) => row.tokenHash === params.tokenHash,
      );
      if (!pending) {
        return { status: 'not_found' };
      }
      if (pending.usedAt !== null || pending.invalidatedAt !== null) {
        return { status: 'already_used' };
      }
      if (pending.expiresAt.getTime() <= params.now.getTime()) {
        return { status: 'expired' };
      }
      if (
        users.some((user) => user.normalizedEmail === pending.normalizedEmail)
      ) {
        return { status: 'email_taken' };
      }

      const now = new Date();
      const user: UserRow = {
        id: createId('user'),
        email: pending.email,
        normalizedEmail: pending.normalizedEmail,
        passwordHash: pending.passwordHash,
        displayName: pending.displayName,
        status: 'active',
        // Verification-first invariant: a completed account is email-verified.
        emailVerifiedAt: params.now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      // Invitation settle — VALIDATE before mutating anything (the in-memory
      // mirror of the savepoint): a validation failure yields 'unavailable'
      // and no invitation state is touched, while the account still commits.
      let invitationOutcome: CompletionInvitationOutcome = 'none';
      let invitationToAccept = null;
      if (pending.invitationId !== null) {
        const context = params.invitation;
        if (context === null || context.invitationId !== pending.invitationId) {
          invitationOutcome = 'unavailable';
        } else {
          try {
            invitationToAccept = validateInvitationForAcceptanceInStore(
              orgStore,
              {
                selector: { invitationId: pending.invitationId },
                acceptingUserId: user.id,
                acceptingUserNormalizedEmail: pending.normalizedEmail,
                maxMembers: context.maxMembers,
              },
            );
            invitationOutcome = 'accepted';
          } catch (error) {
            if (!isInvitationUnavailableError(error)) {
              throw error;
            }
            invitationOutcome = 'unavailable';
          }
        }
      }

      // Personal workspace with a unique slug, exactly as the DB seam does.
      const slugBase = `${pending.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')}`;
      let slug = slugBase.length > 0 ? slugBase : 'workspace';
      for (
        let suffix = 2;
        orgStore.organizations.some((org) => org.slug === slug);
        suffix += 1
      ) {
        slug = `${slugBase}-${suffix}`;
      }
      const organization: OrganizationRow = {
        id: createId('org'),
        name: personalWorkspaceName(pending.displayName),
        slug,
        type: 'personal',
        status: 'active',
        createdByUserId: user.id,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      const membership: MembershipRow = {
        id: createId('mem'),
        userId: user.id,
        organizationId: organization.id,
        roleId: ROLE_IDS.owner,
        status: 'active',
        invitedByUserId: null,
        joinedAt: now,
        removedAt: null,
        removedByUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      const session: SessionRow = {
        id: createId('sess'),
        userId: user.id,
        ipAddress: params.session.ipAddress,
        userAgent: params.session.userAgent,
        clientName: null,
        expiresAt: params.session.expiresAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: now,
        updatedAt: now,
      };
      const refreshToken: RefreshTokenRow = {
        id: createId('rtok'),
        sessionId: session.id,
        tokenHash: params.refreshToken.tokenHash,
        familyId: params.refreshToken.familyId,
        parentTokenId: null,
        replacementTokenId: null,
        usedAt: null,
        expiresAt: params.refreshToken.expiresAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: now,
      };

      // Commit: all validations passed, so apply every row together.
      users.push(user);
      orgStore.organizations.push(organization);
      orgStore.memberships.push(membership);
      provisionDefaultOrganizationPlan(orgStore, organization.id, user.id);
      sessions.push(session);
      refreshTokens.push(refreshToken);
      if (invitationToAccept) {
        applyInvitationAcceptanceInStore(orgStore, invitationToAccept, {
          acceptingUserId: user.id,
          requestId: params.invitation?.eventContext.requestId ?? null,
        });
      }

      pending.usedAt = params.now;
      for (const sibling of pendingRegistrations) {
        if (
          sibling.id !== pending.id &&
          sibling.normalizedEmail === pending.normalizedEmail &&
          sibling.usedAt === null &&
          sibling.invalidatedAt === null
        ) {
          sibling.invalidatedAt = params.now;
        }
      }

      return {
        status: 'completed',
        user,
        organization,
        membership,
        session,
        refreshToken,
        invitation: invitationOutcome,
      };
    },

    async insertSecurityEvent(values: NewSecurityEvent) {
      securityEvents.push(values);
    },
  };
}
