import { createContext } from 'react';
import type { OrganizationWithMembership } from '@orgistry/contracts';
import type { ApiError } from '../api/errors';

/**
 * Organization-selection state.
 *
 * The selected organization is CLIENT CONTEXT — it decides which org-scoped API
 * calls the UI makes. It is NOT tenant authority: the backend independently
 * re-resolves the caller's membership for the route organization id on every
 * request, so a stale or tampered selection can never grant access. The slug is
 * never used as an identifier; the opaque organization id is the only authority.
 */
export interface OrganizationContextValue {
  /** Organizations the current user actively belongs to (with their membership). */
  organizations: OrganizationWithMembership[];
  /** The currently selected organization id, or null when none is selectable. */
  selectedOrganizationId: string | null;
  /** The selected org + membership, resolved from the list. */
  selected: OrganizationWithMembership | null;
  isLoading: boolean;
  error: ApiError | null;
  /** Switch the active organization. Ignored if the id is not in the list. */
  selectOrganization: (organizationId: string) => void;
  /** Create a team organization and switch to it. */
  createTeamOrganization: (name: string) => Promise<OrganizationWithMembership>;
  /** Refetch the organization list (e.g. after creating or losing access). */
  refresh: () => void;
}

export const OrganizationContext =
  createContext<OrganizationContextValue | null>(null);

/** localStorage key for the selected org id. Safe to persist (NOT a token). */
export const SELECTED_ORG_STORAGE_KEY = 'orgistry.selectedOrganizationId';
