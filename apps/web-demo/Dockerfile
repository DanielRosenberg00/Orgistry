# Production web-demo artifact (Sprint 23, ORG-PR-001; made environment-neutral
# in the Sprint 26 refinement).
#
# Stage 1 runs the existing Vite production build from the workspace; stage 2
# serves the static output with non-root nginx. The runtime contains no Node,
# no source, and no workspace — only built assets and the nginx template.
#
# NO ENVIRONMENT IDENTITY IS BUILT IN. The build takes no `VITE_*` arguments:
# the browser's public configuration (API origin, CSRF header name, Mailpit UI)
# is rendered at CONTAINER START from the ORGISTRY_PUBLIC_* variables below.
# That is what makes one web digest promotable between environments instead of
# rebuildable per environment (docs/deployment.md, "Runtime public
# configuration"). These values are PUBLIC browser configuration; a secret must
# never be passed here, and the application refuses to start if it receives a
# credential-shaped key.
#
# Image policy (ORG-PR-042): exact patch tag + manifest-list digest.
# Update procedure: docs/validation.md ("Image pinning policy").

# ---- Build stage: workspace install + Vite production build ----
FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @orgistry/web-demo run build

# ---- Runtime stage: non-root static nginx (uid 101, listens on 8080) ----
FROM nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:c3fed6436b61d2bf2201ec032c35c000871f7ed062dea5d586bc6bf4d0fdd140

# The base image's entrypoint renders /etc/nginx/templates/*.template into
# /etc/nginx/conf.d/ before nginx starts. The filter restricts substitution to
# this project's public configuration variables, so nginx's own `$uri`/`$host`
# variables in the template are left untouched.
ENV NGINX_ENVSUBST_FILTER=^ORGISTRY_PUBLIC_

# Defaults for a zero-configuration local run. A real deployment overrides the
# API origin; if it forgets to, the deployment's post-deploy smoke fails on the
# origin mismatch rather than silently serving a frontend that calls localhost.
ENV ORGISTRY_PUBLIC_API_BASE_URL=http://localhost:3000 \
    ORGISTRY_PUBLIC_CSRF_HEADER_NAME=x-orgistry-csrf \
    ORGISTRY_PUBLIC_MAILPIT_URL=http://localhost:8025

COPY apps/web-demo/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/apps/web-demo/dist /usr/share/nginx/html

EXPOSE 8080
