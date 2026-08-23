# Production web-demo artifact (Sprint 23, ORG-PR-001).
#
# Stage 1 runs the existing Vite production build from the workspace; stage 2
# serves the static output with non-root nginx. The runtime contains no Node,
# no source, and no workspace — only built assets and the nginx config.
#
# The VITE_* build arguments are PUBLIC frontend configuration, compiled into
# the browser bundle by definition. They are never secrets; server secrets
# must never be passed here (docs/deployment-artifacts.md, "Secret boundary").
#
# Image policy (ORG-PR-042): exact patch tag + manifest-list digest.
# Update procedure: docs/validation.md ("Image pinning policy").

# ---- Build stage: workspace install + Vite production build ----
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile

# Public frontend configuration (defaults mirror apps/web-demo/src/config.ts).
ARG VITE_API_BASE_URL=http://localhost:3000
ARG VITE_CSRF_HEADER_NAME=x-orgistry-csrf
ARG VITE_MAILPIT_URL=http://localhost:8025
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CSRF_HEADER_NAME=${VITE_CSRF_HEADER_NAME} \
    VITE_MAILPIT_URL=${VITE_MAILPIT_URL}

RUN pnpm --filter @orgistry/web-demo run build

# ---- Runtime stage: non-root static nginx (uid 101, listens on 8080) ----
FROM nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:c3fed6436b61d2bf2201ec032c35c000871f7ed062dea5d586bc6bf4d0fdd140

COPY apps/web-demo/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web-demo/dist /usr/share/nginx/html

EXPOSE 8080
