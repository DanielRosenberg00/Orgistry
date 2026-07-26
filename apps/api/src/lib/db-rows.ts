/**
 * Row-unwrapping invariants for Drizzle result arrays.
 *
 * With `noUncheckedIndexedAccess`, `rows[0]` is `T | undefined` even where
 * PostgreSQL guarantees a row (e.g. `INSERT ... RETURNING` returns exactly one
 * row per inserted row). These helpers encode that guarantee once instead of
 * scattering non-null assertions; a miss is an internal invariant failure and
 * throws with enough context to locate the query.
 */

/**
 * The single row a query is guaranteed to produce (INSERT/UPDATE ...
 * RETURNING on a row known to exist, or a lookup the caller has already
 * verified). Throws when the guarantee does not hold.
 */
export function requireRow<T>(rows: readonly T[], context: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected a row from ${context}, got none`);
  }
  return row;
}
