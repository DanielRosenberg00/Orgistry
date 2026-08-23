import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Production build for the API artifact (Sprint 23, ORG-PR-001).
 *
 * Bundles the EXISTING entry points — no second implementation path:
 *
 *   src/server.ts                     -> dist/server.mjs   (API process)
 *   packages/db/scripts/migrate.ts    -> dist/migrate.mjs  (operator-run migrations)
 *
 * Strategy: workspace `@orgistry/*` packages are consumed as TypeScript source
 * (their package.json `exports` point at `./src/index.ts`), so they cannot be
 * resolved by Node at runtime. This build inlines the workspace source into
 * the bundle while leaving every npm dependency external — the runtime
 * executes the exact dependency code the test suites exercised, installed
 * from pnpm-lock.yaml. The migrator resolves its SQL folder via
 * `new URL('../migrations', import.meta.url)`, so the runtime image must
 * place `packages/db/migrations` next to `dist/` as `./migrations`
 * (see apps/api/Dockerfile).
 */

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiDir = join(workspaceRoot, 'apps/api');
const packagesDir = join(workspaceRoot, 'packages');

/**
 * Map an `@orgistry/<pkg>[/<subpath>]` import to the TypeScript source file
 * declared in that package's `exports` map. Fails loudly on anything the
 * package does not export, so a bad import breaks the build instead of the
 * runtime.
 */
function resolveWorkspaceImport(specifier) {
  const [, packageName, ...subpathParts] = specifier.split('/');
  const packageDir = join(packagesDir, packageName);
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  );
  const exportKey = subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.';
  const target = manifest.exports?.[exportKey];
  if (typeof target !== 'string') {
    throw new Error(
      `Cannot bundle "${specifier}": ${manifest.name} does not export "${exportKey}"`,
    );
  }
  return join(packageDir, target);
}

/** Inline `@orgistry/*` workspace TypeScript source into the bundle. */
const workspaceSourcePlugin = {
  name: 'orgistry-workspace-source',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@orgistry\// }, (args) => ({
      path: resolveWorkspaceImport(args.path),
    }));
  },
};

const entryPoints = [
  { in: join(apiDir, 'src/server.ts'), out: 'server' },
  { in: join(workspaceRoot, 'packages/db/scripts/migrate.ts'), out: 'migrate' },
];

await build({
  entryPoints,
  outdir: join(apiDir, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // Every bare import that is not `@orgistry/*` stays external and resolves
  // from node_modules at runtime (installed from the lockfile).
  packages: 'external',
  plugins: [workspaceSourcePlugin],
  logLevel: 'info',
});
