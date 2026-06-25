import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Invitation,
  InvitationCreateResponse,
  InvitationListResponse,
  InvitationRevokeResponse,
  RoleKey,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';
import { useCursorQuery } from './useCursorQuery';

/** List the selected organization's invitations (load-more paginated). */
export function useInvitations() {
  const organizationId = useSelectedOrganizationId();
  return useCursorQuery<Invitation>({
    queryKey: ['invitations', organizationId],
    fetchPage: (cursor) =>
      api.get<InvitationListResponse>(
        `/v1/organizations/${organizationId}/invitations`,
        { query: { cursor } },
      ),
  });
}

/**
 * Create an invitation. The raw token is delivered out-of-band by email
 * (Mailpit in local dev) and is intentionally NOT returned here — the create
 * response carries only the public invitation record.
 */
export function useCreateInvitation() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; role: RoleKey }) =>
      api.post<InvitationCreateResponse>(
        `/v1/organizations/${organizationId}/invitations`,
        { email: vars.email, role: vars.role },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['invitations', organizationId],
      }),
  });
}

export function useRevokeInvitation() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invitationId: string }) =>
      api.del<InvitationRevokeResponse>(
        `/v1/organizations/${organizationId}/invitations/${vars.invitationId}`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['invitations', organizationId],
      }),
  });
}
