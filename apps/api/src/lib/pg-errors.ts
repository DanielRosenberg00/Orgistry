/**
 * PostgreSQL error classification for Drizzle-executed queries.
 *
 * drizzle-orm >= 0.44 wraps every failed query in `DrizzleQueryError` and
 * attaches the underlying postgres-js `PostgresError` as `cause`, so SQLSTATE
 * fields are no longer on the thrown error itself. These helpers walk the
 * `cause` chain to find the driver error, and still match a bare driver error
 * (or a test double shaped like one) thrown without the wrapper.
 */

/** PostgreSQL unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/** Bounded `cause`-chain walk; defends against accidental cycles. */
const MAX_CAUSE_DEPTH = 5;

function findUniqueViolation(
  error: unknown,
): { constraint_name?: unknown } | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return current as { constraint_name?: unknown };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Whether the error (or its cause chain) is a PostgreSQL unique violation. */
export function isUniqueViolation(error: unknown): boolean {
  return findUniqueViolation(error) !== null;
}

/**
 * The violated constraint name for a unique violation, `''` when the driver
 * did not report one, or `null` when the error is not a unique violation.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  const violation = findUniqueViolation(error);
  if (violation === null) return null;
  return typeof violation.constraint_name === 'string'
    ? violation.constraint_name
    : '';
}
