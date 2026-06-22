/**
 * Clock abstraction.
 *
 * Code that needs the current time depends on a `Clock` rather than calling
 * `Date.now()` directly, so time can be controlled in tests. `systemClock` is
 * the real implementation used in production paths.
 */
export interface Clock {
  now(): Date;
  epochMillis(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  epochMillis: () => Date.now(),
};
