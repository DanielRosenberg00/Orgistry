#!/usr/bin/env bash
#
# Shared PostgreSQL client helpers for the data-durability tooling
# (Sprint 25, ORG-PR-005). Sourced by tooling/db-backup.sh,
# tooling/db-restore-drill.sh, and tooling/db-pitr-drill.sh.
#
# WHY EVERY CLIENT TOOL RUNS IN A CONTAINER
# -----------------------------------------
# `pg_dump`/`pg_restore`/`pg_basebackup` are version-sensitive: a dump taken by
# a client newer than the server, or restored by an older one, can fail in ways
# that only surface during a real recovery. Rather than depend on whatever
# PostgreSQL happens to be installed on a developer laptop or a CI runner, every
# client invocation here runs from the SAME pinned image the repository already
# runs its servers from (infra/docker-compose.yml,
# infra/compose.production-like.yml, .github/workflows/ci.yml). Docker is the
# only host prerequisite.
#
# NETWORK REACHABILITY
# --------------------
# The client runs inside a container, so `localhost` in a connection URL means
# the CONTAINER, not the host. Two modes:
#
#   * `--docker-network NET` — attach the client to a Docker network and use
#     the container hostnames on it. The drills always use this.
#   * no network — the client gets `host.docker.internal` mapped to the host
#     gateway, and a loopback host in the URL is rewritten to it. This is the
#     mode an operator uses when backing up a database published on the host.
#
# CREDENTIAL HANDLING
# -------------------
# The connection URL is handed to the container through an environment
# variable and is never passed as a command argument, never printed, and never
# used to build a filename. Helpers here print host-free progress only.

set -euo pipefail

# The pinned PostgreSQL image. Keep in exact sync with infra/docker-compose.yml
# and infra/compose.production-like.yml (image policy: ORG-PR-042).
ORGISTRY_PG_IMAGE='postgres:16.14-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'

# Docker arguments common to every client invocation. Assembled by
# `pg_client_init`; read by `pg_client`.
PG_CLIENT_DOCKER_ARGS=()

# The connection URL as seen FROM INSIDE the client container. Set by
# `pg_client_init`. Deliberately not exported anywhere that prints it.
PG_CLIENT_URL=''

pg_tools_die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

# Rewrite a loopback host so a containerized client can reach a database
# published on the host. Only the `@host:` segment is substituted; nothing is
# printed, so the URL never reaches a log.
pg_host_gateway_url() {
  local url="$1"
  url="${url//@localhost:/@host.docker.internal:}"
  url="${url//@127.0.0.1:/@host.docker.internal:}"
  printf '%s' "${url}"
}

# Prepare the client runtime.
#   $1 — connection URL (host's point of view)
#   $2 — Docker network to attach, or '' for host-gateway mode
pg_client_init() {
  local url="$1" network="${2:-}"

  [[ -n "${url}" ]] || pg_tools_die 'pg_client_init: a connection URL is required'

  PG_CLIENT_DOCKER_ARGS=(--rm --interactive)
  if [[ -n "${network}" ]]; then
    PG_CLIENT_DOCKER_ARGS+=(--network "${network}")
    PG_CLIENT_URL="${url}"
  else
    PG_CLIENT_DOCKER_ARGS+=(--add-host 'host.docker.internal:host-gateway')
    PG_CLIENT_URL="$(pg_host_gateway_url "${url}")"
  fi
}

# Add extra `docker run` arguments (volume mounts, user, ...) to every
# subsequent `pg_client` invocation.
pg_client_add_docker_args() {
  PG_CLIENT_DOCKER_ARGS+=("$@")
}

# Run a PostgreSQL client program from the pinned image.
#
# The connection URL is exposed inside the container as ORGISTRY_PG_URL. Client
# programs are invoked through `sh -c` so they can expand it; callers therefore
# pass a command STRING, and any caller-supplied value must be quoted inside it
# by the caller. Every call site in this repository passes a literal command
# with no interpolation of untrusted input.
pg_client() {
  local command="$1"
  docker run \
    "${PG_CLIENT_DOCKER_ARGS[@]}" \
    --env "ORGISTRY_PG_URL=${PG_CLIENT_URL}" \
    --entrypoint sh \
    "${ORGISTRY_PG_IMAGE}" \
    -c "${command}"
}

# Run a single-value psql query against the configured URL and echo the result.
pg_query() {
  local statement="$1"
  pg_client "psql \"\$ORGISTRY_PG_URL\" --no-psqlrc --tuples-only --no-align --quiet \
    --set ON_ERROR_STOP=1 --command \"${statement}\""
}

# Wait until the configured URL accepts a trivial query. Fails after the
# timeout with an actionable message instead of hanging.
pg_wait_ready() {
  local timeout_seconds="${1:-60}" label="${2:-database}"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if pg_query 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  pg_tools_die "${label} did not become ready within ${timeout_seconds}s"
}

# Start a throwaway PostgreSQL server container on a Docker network.
#
#   pg_start_server <name> <network> <data-volume> [docker args...] [-- postgres args...]
#
# Arguments before `--` are passed to `docker run` (extra volumes, published
# ports); arguments after `--` are passed to the `postgres` server itself
# (e.g. `-c archive_mode=on`).
#
# Credentials are the fixed LOCAL-ONLY drill values below: these servers live
# and die with the drill and are never reachable from outside the drill
# network unless the caller publishes a port.
ORGISTRY_DRILL_PG_USER='orgistry'
ORGISTRY_DRILL_PG_PASSWORD='orgistry-drill-not-a-real-credential'
ORGISTRY_DRILL_PG_DB='orgistry'

pg_start_server() {
  local name="$1" network="$2" volume="$3"
  shift 3

  local docker_args=() server_args=() seen_separator=0
  local argument
  for argument in "$@"; do
    if [[ "${argument}" == '--' && ${seen_separator} -eq 0 ]]; then
      seen_separator=1
      continue
    fi
    if (( seen_separator == 1 )); then
      server_args+=("${argument}")
    else
      docker_args+=("${argument}")
    fi
  done

  docker run --detach \
    --name "${name}" \
    --network "${network}" \
    --volume "${volume}:/var/lib/postgresql/data" \
    --env "POSTGRES_USER=${ORGISTRY_DRILL_PG_USER}" \
    --env "POSTGRES_PASSWORD=${ORGISTRY_DRILL_PG_PASSWORD}" \
    --env "POSTGRES_DB=${ORGISTRY_DRILL_PG_DB}" \
    "${docker_args[@]}" \
    "${ORGISTRY_PG_IMAGE}" \
    "${server_args[@]+"${server_args[@]}"}" >/dev/null
}

# SHA-256 hex digest of a string, using whichever tool the host provides
# (`sha256sum` on Linux, `shasum` on macOS). Used by the restore drill to
# derive its fixture API-key hash at run time rather than committing one.
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  fi
}

# A connection URL for a drill server.
#   $1 — host        $2 — port (default 5432)      $3 — database (default drill db)
# Used both for in-network container hostnames and for host-published ports.
pg_drill_url() {
  local host="$1" port="${2:-5432}" database="${3:-${ORGISTRY_DRILL_PG_DB}}"
  printf 'postgres://%s:%s@%s:%s/%s' \
    "${ORGISTRY_DRILL_PG_USER}" "${ORGISTRY_DRILL_PG_PASSWORD}" \
    "${host}" "${port}" "${database}"
}
