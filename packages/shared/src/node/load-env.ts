import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

/**
 * Workspace `.env` loading for process/CLI entry points.
 *
 * Node-only (uses `fs`/`path`/`dotenv`), which is why it lives under the
 * `@orgistry/shared/node` subpath rather than the general entrypoint. It is
 * called EXPLICITLY from entry points (API server, DB scripts, integration
 * tests) — never as an import side effect — so libraries and unit tests are
 * never surprised by file I/O.
 *
 * `dotenv` is used (rather than Node's `process.loadEnvFile`) so loading works
 * deterministically across the entire declared Node engine range; the built-in
 * is not present in every allowed Node 20 release. Existing environment
 * variables always take precedence over file values (`dotenv` does not override
 * by default), so CI and explicit exports win.
 */

/** Walk up from `startDir` to the directory containing `pnpm-workspace.yaml`. */
export function findWorkspaceRoot(startDir = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Load the workspace-root `.env` into `process.env` when it exists. No-op if
 * the workspace root or the `.env` file cannot be found (e.g. CI, where
 * variables are provided directly). `startDir` overrides the search origin for
 * tests.
 */
export function loadWorkspaceEnv(startDir = process.cwd()): void {
  const root = findWorkspaceRoot(startDir);
  if (!root) {
    return;
  }
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}
