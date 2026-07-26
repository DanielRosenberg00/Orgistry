import { describe, expect, it } from 'vitest';
import { isUniqueViolation, uniqueViolationConstraint } from './pg-errors';

/** Shape postgres-js gives a unique-violation `PostgresError`. */
function driverUniqueViolation(constraint?: string): Error {
  const error = new Error('duplicate key value violates unique constraint');
  Object.assign(error, {
    code: '23505',
    ...(constraint === undefined ? {} : { constraint_name: constraint }),
  });
  return error;
}

/** Shape drizzle-orm >= 0.44 throws: DrizzleQueryError with driver cause. */
function drizzleWrapped(cause: unknown): Error {
  const error = new Error('Failed query: insert into ...');
  (error as { cause?: unknown }).cause = cause;
  return error;
}

describe('isUniqueViolation', () => {
  it('matches a bare driver unique violation', () => {
    expect(isUniqueViolation(driverUniqueViolation())).toBe(true);
  });

  it('matches a drizzle-wrapped driver unique violation via the cause chain', () => {
    expect(isUniqueViolation(drizzleWrapped(driverUniqueViolation()))).toBe(
      true,
    );
  });

  it('matches a doubly wrapped violation (transaction wrapping)', () => {
    expect(
      isUniqueViolation(drizzleWrapped(drizzleWrapped(driverUniqueViolation()))),
    ).toBe(true);
  });

  it('rejects other SQLSTATEs, plain errors, and non-errors', () => {
    const fkViolation = Object.assign(new Error('fk'), { code: '23503' });
    expect(isUniqueViolation(fkViolation)).toBe(false);
    expect(isUniqueViolation(drizzleWrapped(fkViolation))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const cyclic = new Error('cyclic');
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });
});

describe('uniqueViolationConstraint', () => {
  it('returns the constraint name through the cause chain', () => {
    expect(
      uniqueViolationConstraint(
        drizzleWrapped(driverUniqueViolation('uq_users_normalized_email')),
      ),
    ).toBe('uq_users_normalized_email');
  });

  it('returns empty string when the driver omits the constraint name', () => {
    expect(uniqueViolationConstraint(driverUniqueViolation())).toBe('');
  });

  it('returns null for non-unique-violation errors', () => {
    expect(uniqueViolationConstraint(new Error('boom'))).toBeNull();
  });
});
