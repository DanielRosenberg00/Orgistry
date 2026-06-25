import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './api/errors';

/**
 * Shared TanStack Query client.
 *
 * Retry policy is deliberately conservative: a 4xx from the backend (validation,
 * forbidden, not-found, quota, entitlement, …) is a deterministic answer, not a
 * transient fault, so it is never retried — the UI should show it immediately.
 * Only genuinely unexpected/transport failures get a single retry.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 1;
        },
        staleTime: 10_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
