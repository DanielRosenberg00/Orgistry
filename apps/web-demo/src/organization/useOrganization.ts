import { useContext } from 'react';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from './org-context';

/** Access organization-selection state. Must be used within an `OrganizationProvider`. */
export function useOrganization(): OrganizationContextValue {
  const value = useContext(OrganizationContext);
  if (!value) {
    throw new Error(
      'useOrganization must be used within an OrganizationProvider',
    );
  }
  return value;
}

/**
 * The selected organization id, asserted non-null. Use inside org-scoped pages,
 * which only render when an organization is selected (the app shell guarantees
 * this). Throws if misused outside that guarantee, surfacing the bug loudly.
 */
export function useSelectedOrganizationId(): string {
  const { selectedOrganizationId } = useOrganization();
  if (!selectedOrganizationId) {
    throw new Error('No organization is selected');
  }
  return selectedOrganizationId;
}
