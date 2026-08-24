# Production API artifact (Sprint 23, ORG-PR-001).
#
# Build boundary (see docs/deployment-artifacts.md):
#   - built from the repository root context (workspace install needs the
#     lockfile + every package); .dockerignore keeps .env files, git metadata,
#     and local state out of the context;
#   - NO secrets are read at build time; runtime configuration is injected as
#     environment variables when the container starts;
#   - the runtime stage contains only: the esbuild bundles (dist/), the SQL
#     migration baseline (migrations/), and the hoisted production
#     node_modules resolved from pnpm-lock.yaml. No TypeScript source, no
#     pnpm, no tsx, no dev dependencies.
#
# Image policy (ORG-PR-042): exact patch tag + manifest-list digest.
# Update procedure: docs/validation.md ("Image pinning policy").

# ---- Build stage: workspace install + esbuild bundle + pruned prod deps ----
FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS build

# corepack activates the exact pnpm version from the root `packageManager`
# field, keeping the container build on the same package manager as CI.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile

# Bundle src/server.ts -> dist/server.mjs and packages/db/scripts/migrate.ts
# -> dist/migrate.mjs (workspace source inlined; npm deps stay external).
RUN pnpm --filter @orgistry/api run build

# Production-only dependency tree for the API, resolved from the lockfile.
# `node-linker=hoisted` flattens it npm-style so the bundle's external imports
# (including transitive workspace-package deps like `postgres` and `jose`)
# resolve from one top-level node_modules. The `@orgistry/*` workspace sources
# are removed afterwards: the bundle already inlines them, so the runtime
# image ships no TypeScript.
RUN pnpm --filter @orgistry/api deploy --prod --legacy --config.node-linker=hoisted /opt/api \
  && rm -rf /opt/api/node_modules/@orgistry

# ---- Runtime stage: node + bundles + migrations + prod node_modules ----
FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341

ENV NODE_ENV=production
# Map bundled stack traces back to TypeScript locations via the shipped
# sourcemaps (observability aid; no behavior change).
ENV NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Everything under /app is owned by root and read-only for the runtime user:
# the API needs no writable application paths (logs go to stdout/stderr).
COPY --from=build /opt/api/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./dist
# The migrator resolves its SQL folder as `../migrations` relative to
# dist/migrate.mjs (see packages/db/src/migrator.ts).
COPY --from=build /workspace/packages/db/migrations ./migrations

# `node` is the non-root user (uid 1000) shipped by the official Node image.
USER node

EXPOSE 3000

# Migrations are NOT run at boot. Operators run the migration entrypoint as an
# explicit pre-start step:  node dist/migrate.mjs  (see docs/deployment-artifacts.md).
CMD ["node", "dist/server.mjs"]
