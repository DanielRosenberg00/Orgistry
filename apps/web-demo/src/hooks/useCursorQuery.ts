import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';

/** The shared shape of every cursor-paginated list response in the API. */
export interface CursorPageResult<TItem> {
  items: TItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Wrap a cursor-paginated endpoint as a load-more query.
 *
 * The platform standardizes list endpoints on opaque-cursor pagination
 * (`{ items, nextCursor, hasMore }`). This helper drives that uniformly:
 * `items` is the flattened result across loaded pages, and `pages` is kept for
 * callers that need per-page metadata (e.g. the audit retention window). Every
 * list hook builds on this so no page re-implements pagination.
 */
export function useCursorQuery<
  TItem,
  TPage extends CursorPageResult<TItem> = CursorPageResult<TItem>,
>(opts: {
  queryKey: QueryKey;
  fetchPage: (cursor: string | null) => Promise<TPage>;
  enabled?: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey: opts.queryKey,
    queryFn: ({ pageParam }) => opts.fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    enabled: opts.enabled,
  });

  const pages = query.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);

  return { query, items, pages };
}
