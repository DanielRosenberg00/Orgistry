import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OrganizationCreateResponse,
  OrganizationListResponse,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { useAuth } from '../auth/useAuth';
import {
  OrganizationContext,
  SELECTED_ORG_STORAGE_KEY,
} from './org-context';

/**
 * Owns the organization list and the selected-organization context.
 *
 * The organization list is fetched once the user is authenticated. The selected
 * id is persisted to localStorage (it is plain client context, never a token or
 * authority) and validated against the freshly fetched list: if the previously
 * selected organization is no longer accessible, the selection falls back to the
 * first available organization, and the UI surfaces that nothing is selected
 * when the user belongs to none.
 */
export function OrganizationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<
    string | null
  >(() => readStoredSelection());

  const query = useQuery({
    queryKey: ['organizations'],
    queryFn: () => api.get<OrganizationListResponse>('/v1/organizations'),
    enabled: status === 'authenticated',
  });

  const organizations = useMemo(
    () => query.data?.items ?? [],
    [query.data],
  );

  // Reconcile the selection whenever the list changes: keep a still-valid
  // selection, otherwise fall back to the first organization (or null).
  useEffect(() => {
    if (!query.isSuccess) return;
    const stillValid =
      selectedOrganizationId !== null &&
      organizations.some((o) => o.organization.id === selectedOrganizationId);
    if (stillValid) return;
    const fallback = organizations[0]?.organization.id ?? null;
    setSelectedOrganizationId(fallback);
    writeStoredSelection(fallback);
  }, [query.isSuccess, organizations, selectedOrganizationId]);

  const selectOrganization = useCallback(
    (organizationId: string) => {
      if (!organizations.some((o) => o.organization.id === organizationId)) {
        return;
      }
      setSelectedOrganizationId(organizationId);
      writeStoredSelection(organizationId);
    },
    [organizations],
  );

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<OrganizationCreateResponse>('/v1/organizations', { name }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setSelectedOrganizationId(created.organization.id);
      writeStoredSelection(created.organization.id);
    },
  });

  const createTeamOrganization = useCallback(
    (name: string) => createMutation.mutateAsync(name),
    [createMutation],
  );

  const selected = useMemo(
    () =>
      organizations.find(
        (o) => o.organization.id === selectedOrganizationId,
      ) ?? null,
    [organizations, selectedOrganizationId],
  );

  const value = {
    organizations,
    selectedOrganizationId,
    selected,
    isLoading: query.isLoading,
    error: query.isError ? toApiError(query.error) : null,
    selectOrganization,
    createTeamOrganization,
    refresh: () => {
      void query.refetch();
    },
  };

  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}

function readStoredSelection(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSelection(organizationId: string | null): void {
  try {
    if (organizationId) {
      window.localStorage.setItem(SELECTED_ORG_STORAGE_KEY, organizationId);
    } else {
      window.localStorage.removeItem(SELECTED_ORG_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (private mode / tests) — selection stays in memory.
  }
}
