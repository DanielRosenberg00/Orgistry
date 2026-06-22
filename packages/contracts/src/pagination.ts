import { z } from 'zod';

/**
 * Cursor pagination baseline.
 *
 * Orgistry standardizes on opaque-cursor pagination (not offset/limit) so list
 * endpoints stay stable as data changes. This defines the request params and
 * page shape; the cursor itself is an opaque string produced/consumed by
 * `@orgistry/shared` cursor helpers. No domain list endpoints exist yet.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const cursorPageParamsSchema = z.object({
  /** Opaque cursor from a previous page's `nextCursor`. Absent for page one. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
});

export type CursorPageParams = z.infer<typeof cursorPageParamsSchema>;

/** A single page of results. `nextCursor` is null when there are no more. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function makeCursorPage<T>(
  items: T[],
  nextCursor: string | null,
): CursorPage<T> {
  return { items, nextCursor, hasMore: nextCursor !== null };
}
