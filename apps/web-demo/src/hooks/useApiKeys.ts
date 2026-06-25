import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ApiKey,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  ApiKeyScope,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';
import { useCursorQuery } from './useCursorQuery';

/** List the selected organization's API keys (active and revoked). */
export function useApiKeys() {
  const organizationId = useSelectedOrganizationId();
  return useCursorQuery<ApiKey>({
    queryKey: ['api-keys', organizationId],
    fetchPage: (cursor) =>
      api.get<ApiKeyListResponse>(
        `/v1/organizations/${organizationId}/api-keys`,
        { query: { cursor } },
      ),
  });
}

/**
 * Create an API key. The response carries the raw secret EXACTLY ONCE — the
 * caller must surface it immediately and never persist it. It is unrecoverable
 * afterwards (the backend stores only a hash).
 */
export function useCreateApiKey() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; scopes: ApiKeyScope[] }) =>
      api.post<ApiKeyCreateResponse>(
        `/v1/organizations/${organizationId}/api-keys`,
        { name: vars.name, scopes: vars.scopes },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['api-keys', organizationId] }),
  });
}

export function useRevokeApiKey() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { apiKeyId: string }) =>
      api.del<ApiKeyRevokeResponse>(
        `/v1/organizations/${organizationId}/api-keys/${vars.apiKeyId}`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['api-keys', organizationId] }),
  });
}
