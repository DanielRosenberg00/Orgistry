import type { ReactNode } from 'react';
import { ErrorBanner } from './ErrorBanner';

/** Centered "loading…" placeholder for a query in flight. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="state">{label}</div>;
}

/** Centered empty-list placeholder. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="state">{children}</div>;
}

/**
 * Standard wrapper for an async list/detail surface: shows a loading state, then
 * a consistently rendered error (with request id), then the children. Keeps the
 * loading/error/success branching identical across every page.
 */
export function QueryBoundary({
  isLoading,
  error,
  loadingLabel,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  loadingLabel?: string;
  children: ReactNode;
}) {
  if (isLoading) {
    return <LoadingState label={loadingLabel} />;
  }
  if (error) {
    return <ErrorBanner error={error} />;
  }
  return <>{children}</>;
}

/** A "Load more" button shown when a cursor list has further pages. */
export function LoadMore({
  hasNextPage,
  isFetchingNextPage,
  onClick,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onClick: () => void;
}) {
  if (!hasNextPage) return null;
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <button
        className="btn btn-sm"
        onClick={onClick}
        disabled={isFetchingNextPage}
      >
        {isFetchingNextPage ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}
