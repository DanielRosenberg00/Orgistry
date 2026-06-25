import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Project,
  ProjectCreateResponse,
  ProjectDeleteResponse,
  ProjectListResponse,
  ProjectUpdateResponse,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';
import { useCursorQuery } from './useCursorQuery';

/**
 * List the selected organization's active projects (load-more paginated).
 * Soft-deleted projects are omitted by the backend — the client never filters.
 */
export function useProjects() {
  const organizationId = useSelectedOrganizationId();
  return useCursorQuery<Project>({
    queryKey: ['projects', organizationId],
    fetchPage: (cursor) =>
      api.get<ProjectListResponse>(
        `/v1/organizations/${organizationId}/projects`,
        { query: { cursor } },
      ),
  });
}

export function useCreateProject() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string }) =>
      api.post<ProjectCreateResponse>(
        `/v1/organizations/${organizationId}/projects`,
        { name: vars.name },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['projects', organizationId] }),
  });
}

export function useUpdateProject() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { projectId: string; name: string }) =>
      api.patch<ProjectUpdateResponse>(
        `/v1/organizations/${organizationId}/projects/${vars.projectId}`,
        { name: vars.name },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['projects', organizationId] }),
  });
}

export function useDeleteProject() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { projectId: string }) =>
      api.del<ProjectDeleteResponse>(
        `/v1/organizations/${organizationId}/projects/${vars.projectId}`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['projects', organizationId] }),
  });
}
