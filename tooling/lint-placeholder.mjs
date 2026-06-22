// Lint placeholder (intentionally deferred — see docs/sprint-1-foundation.md).
//
// A full ESLint config is deliberately NOT part of Sprint 1: type safety is
// enforced by strict `tsc` across every package, which covers the highest-value
// checks for a foundation. This placeholder keeps `pnpm lint` / `pnpm validate`
// wired and green so the command exists from day one and the future ESLint
// rollout is a drop-in replacement, not a new script.
//
// Exits 0 by design.
console.log(
  'lint: deferred for Sprint 1 — type checking via `pnpm typecheck` is the active gate. ' +
    'Replace this placeholder with ESLint in a later sprint.',
);
process.exit(0);
