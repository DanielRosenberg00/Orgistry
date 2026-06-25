import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DemoPlanChangeResponse,
  EntitlementsResponse,
  OrganizationPlanResponse,
  PlanKey,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';

/** The selected organization's current (internal demo) plan. */
export function usePlan() {
  const organizationId = useSelectedOrganizationId();
  return useQuery({
    queryKey: ['plan', organizationId],
    queryFn: () =>
      api.get<OrganizationPlanResponse>(
        `/v1/organizations/${organizationId}/plan`,
      ),
  });
}

/** The selected organization's resolved entitlements + quotas. */
export function useEntitlements() {
  const organizationId = useSelectedOrganizationId();
  return useQuery({
    queryKey: ['entitlements', organizationId],
    queryFn: () =>
      api.get<EntitlementsResponse>(
        `/v1/organizations/${organizationId}/entitlements`,
      ),
  });
}

/**
 * Change the internal demo plan. This is a demo control only: it switches plan
 * state and re-resolves entitlements — it triggers NO billing, checkout, or
 * subscription. Refreshes plan + entitlements (and anything quota-gated) on
 * success.
 */
export function useChangeDemoPlan() {
  const organizationId = useSelectedOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { planKey: PlanKey }) =>
      api.patch<DemoPlanChangeResponse>(
        `/v1/organizations/${organizationId}/plan/demo`,
        { planKey: vars.planKey },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['plan', organizationId] });
      void queryClient.invalidateQueries({
        queryKey: ['entitlements', organizationId],
      });
    },
  });
}
