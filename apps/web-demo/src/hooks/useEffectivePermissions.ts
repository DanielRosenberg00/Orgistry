import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  EffectivePermissionsResponse,
  PermissionKey,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';

/**
 * The current user's effective permissions in the selected organization.
 *
 * IMPORTANT: these power UX HINTS ONLY — hiding or disabling actions the user
 * almost certainly cannot perform. They are never an authorization boundary.
 * The backend independently enforces every permission and will still return
 * FORBIDDEN if the client guesses wrong, so pages must handle that regardless of
 * what `has()` reports.
 */
export function useEffectivePermissions() {
  const organizationId = useSelectedOrganizationId();

  const query = useQuery({
    queryKey: ['effective-permissions', organizationId],
    queryFn: () =>
      api.get<EffectivePermissionsResponse>(
        `/v1/organizations/${organizationId}/permissions/effective`,
      ),
  });

  const granted = useMemo(
    () => new Set<PermissionKey>(query.data?.permissions ?? []),
    [query.data],
  );

  return {
    query,
    role: query.data?.role ?? null,
    permissions: query.data?.permissions ?? [],
    /** UX-only check: does the user appear to hold this permission? */
    has: (permission: PermissionKey) => granted.has(permission),
  };
}
