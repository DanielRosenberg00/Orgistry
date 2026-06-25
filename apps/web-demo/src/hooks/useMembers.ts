import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  MemberListResponse,
  MemberRemovalResponse,
  MemberRoleChangeResponse,
  RoleKey,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';
import { useCursorQuery } from './useCursorQuery';

/** List the selected organization's members (load-more paginated). */
export function useMembers() {
  const organizationId = useSelectedOrganizationId();
  return useCursorQuery<MemberListResponse['items'][number]>({
    queryKey: ['members', organizationId],
    fetchPage: (cursor) =>
      api.get<MemberListResponse>(
        `/v1/organizations/${organizationId}/members`,
        { query: { cursor } },
      ),
  });
}

/** Change a member's role. Last Owner protection is enforced by the backend. */
export function useChangeMemberRole() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { membershipId: string; role: RoleKey }) =>
      api.patch<MemberRoleChangeResponse>(
        `/v1/organizations/${organizationId}/members/${vars.membershipId}/role`,
        { role: vars.role },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['members', organizationId] }),
  });
}

/** Remove a member. Last Owner protection is enforced by the backend. */
export function useRemoveMember() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { membershipId: string }) =>
      api.del<MemberRemovalResponse>(
        `/v1/organizations/${organizationId}/members/${vars.membershipId}`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['members', organizationId] }),
  });
}
