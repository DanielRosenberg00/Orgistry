#!/usr/bin/env bash
#
# Enable continuous WAL archiving on a deployed Orgistry PostgreSQL
# (Sprint 28, ORG-PR-005).
#
# WHAT CONTINUOUS ARCHIVING BUYS
# A logical backup gives you the database as it was at ONE moment. Continuous
# WAL archiving gives you every moment since: recovery to any point between the
# base backup and the newest archived segment. That is the difference between
# "we lost a day" and "we lost the last few minutes".
#
# THE ARCHITECTURE THIS CONFIGURES
#
#   PostgreSQL  --archive_command-->  local spool directory
#                                          |
#                          orgistry-wal-ship.timer (every 2 minutes)
#                                          |
#                                          v
#                          encrypted, off-host object storage
#
# The spool exists so `archive_command` NEVER depends on the network. If
# archiving had to reach object storage synchronously, a transient provider
# outage would stall WAL recycling and eventually fill the data volume — a
# backup feature taking the database down. A local copy cannot fail that way,
# and the shipper retries on its own schedule.
#
# Usage:
#   tooling/pg-enable-wal-archiving.sh --container NAME [options]
#
# Options:
#   --container NAME       PostgreSQL container to configure (required)
#   --archive-dir PATH     Archive directory INSIDE the container
#                          (default /wal-archive)
#   --database NAME        Database to connect to (default orgistry)
#   --user NAME            Superuser role (default orgistry)
#   --archive-timeout SEC  Force a segment switch after this long (default 300)
#   --host-uid UID         Host account that must be able to drain the spool
#                          (default: the current user's uid)
#   --confirm              Actually apply the changes. Without it this script
#                          reports what it would do and changes nothing.
#   --verify-only          Report current archiving state and exit
#   --help
#
# REQUIREMENTS
#   docker access to the container, and a role with permission to ALTER SYSTEM.
#
# WHAT IT DOES NOT DO
#   * It does not restart the container. `archive_mode` requires a restart and
#     restarting an operator's database is the operator's decision — this script
#     tells you exactly when a restart is still needed.
#   * It does not edit any compose file. If the archive directory is not mounted
#     it prints the exact snippet to add and stops.
#   * It never prints a password. The connection is made through `docker exec`
#     using the container's own trusted local socket, so no credential is
#     handled here at all.

set -euo pipefail

CONTAINER=''
ARCHIVE_DIR='/wal-archive'
DATABASE='orgistry'
DB_USER='orgistry'
ARCHIVE_TIMEOUT='300'
HOST_UID="$(id -u)"
CONFIRM=0
VERIFY_ONLY=0

die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
info() { printf '   %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }
usage() { sed -n '2,55p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --archive-dir) ARCHIVE_DIR="${2:-}"; shift 2 ;;
    --database) DATABASE="${2:-}"; shift 2 ;;
    --user) DB_USER="${2:-}"; shift 2 ;;
    --archive-timeout) ARCHIVE_TIMEOUT="${2:-}"; shift 2 ;;
    --host-uid) HOST_UID="${2:-}"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown argument \"$1\" (try --help)" ;;
  esac
done

[[ -n "${CONTAINER}" ]] || die '--container is required'
[[ "${ARCHIVE_TIMEOUT}" =~ ^[0-9]+$ ]] || die '--archive-timeout must be a whole number of seconds'
[[ "${HOST_UID}" =~ ^[0-9]+$ ]] || die '--host-uid must be numeric'
command -v docker >/dev/null 2>&1 || die 'docker is required'

# Run a single-value query inside the container over its local socket.
pg() {
  docker exec --interactive "${CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" \
      --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 --command "$1"
}

report_state() {
  step 'Current archiving state'
  info "archive_mode      = $(pg 'SHOW archive_mode' | tr -d '[:space:]')"
  info "archive_timeout   = $(pg 'SHOW archive_timeout' | tr -d '[:space:]')"
  info "wal_level         = $(pg 'SHOW wal_level' | tr -d '[:space:]')"
  info "wal_compression   = $(pg 'SHOW wal_compression' | tr -d '[:space:]')"
  info "archive_command   = $(pg 'SHOW archive_command')"
  info "archived_count    = $(pg 'SELECT archived_count FROM pg_stat_archiver' | tr -d '[:space:]')"
  info "failed_count      = $(pg 'SELECT failed_count FROM pg_stat_archiver' | tr -d '[:space:]')"
  info "last_archived_wal = $(pg "SELECT coalesce(last_archived_wal, '(none)') FROM pg_stat_archiver" | tr -d '[:space:]')"
  info "last_failed_wal   = $(pg "SELECT coalesce(last_failed_wal, '(none)') FROM pg_stat_archiver" | tr -d '[:space:]')"
}

step "Inspecting ${CONTAINER}"
docker inspect --format '{{.State.Status}}' "${CONTAINER}" >/dev/null 2>&1 \
  || die "container ${CONTAINER} does not exist"
[[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}")" == 'true' ]] \
  || die "container ${CONTAINER} is not running"
info "server version $(pg 'SHOW server_version' | tr -d '[:space:]')"

if (( VERIFY_ONLY == 1 )); then
  report_state
  exit 0
fi

# ---- The archive directory must be a real mount ---------------------------
#
# A directory that merely exists inside the container's writable layer would be
# destroyed by the next `docker compose up`, taking the recovery window with it
# — and it would not be reachable by the host-side shipper at all.

step "Checking that ${ARCHIVE_DIR} is a persistent mount"
if ! docker exec "${CONTAINER}" test -d "${ARCHIVE_DIR}" 2>/dev/null; then
  cat >&2 <<EOF
ERROR: ${ARCHIVE_DIR} is not present inside ${CONTAINER}.

Add a bind mount to the PostgreSQL service in the host's backing-services
compose file, then recreate the container:

  services:
    postgres:
      volumes:
        - postgres_data:/var/lib/postgresql/data
        - /opt/orgistry/wal-archive:${ARCHIVE_DIR}

  docker compose -f <backing-services compose file> up -d postgres

The data volume is untouched by that recreate. Re-run this script afterwards.
EOF
  exit 1
fi

MOUNTED="$(docker inspect --format \
  "{{range .Mounts}}{{if eq .Destination \"${ARCHIVE_DIR}\"}}{{.Source}}{{end}}{{end}}" "${CONTAINER}")"
[[ -n "${MOUNTED}" ]] \
  || die "${ARCHIVE_DIR} exists inside the container but is not a mount; it would not survive a container recreate"
info "mounted from host path ${MOUNTED}"

# ---- Permissions ----------------------------------------------------------
#
# Two accounts share the spool: PostgreSQL inside the container writes segments,
# and the host account running the shipper must read and DELETE them. Files are
# made group-readable by the archive command; deletion needs write on the
# DIRECTORY, which is what the group bit below grants.

PG_UID="$(docker exec "${CONTAINER}" id -u postgres)"
step 'Preparing spool ownership'
info "postgres runs as uid ${PG_UID} inside the container; the host shipper runs as uid ${HOST_UID}"

if (( CONFIRM == 0 )); then
  info "would run: chown ${PG_UID}:${HOST_UID} ${ARCHIVE_DIR} && chmod 2770 ${ARCHIVE_DIR}"
else
  # `docker exec -u 0` needs no host sudo, and a bind mount shares inodes with
  # the host, so this sets the real host directory's ownership.
  docker exec --user 0 "${CONTAINER}" chown "${PG_UID}:${HOST_UID}" "${ARCHIVE_DIR}"
  # setgid (2xxx) makes every archived segment inherit the shipper's group.
  docker exec --user 0 "${CONTAINER}" chmod 2770 "${ARCHIVE_DIR}"
  info "spool owned by ${PG_UID}:${HOST_UID}, mode 2770 (setgid)"
fi

# ---- Settings -------------------------------------------------------------
#
# `test ! -f DEST && cp` is PostgreSQL's own documented archive_command idiom:
# refusing to overwrite an existing segment is what makes a repeated archive
# attempt safe. The chmod makes the segment readable by the shipper's group.

ARCHIVE_COMMAND="test ! -f ${ARCHIVE_DIR}/%f && cp %p ${ARCHIVE_DIR}/%f && chmod 640 ${ARCHIVE_DIR}/%f"

step 'Applying archive settings'
info "archive_command  = ${ARCHIVE_COMMAND}"
info "archive_timeout  = ${ARCHIVE_TIMEOUT}s"
info 'wal_compression  = on   (smaller segments; less to encrypt, ship, and store)'
info 'archive_mode     = on'

if (( CONFIRM == 0 )); then
  printf '\nDry run. Re-run with --confirm to apply.\n'
  report_state
  exit 0
fi

CURRENT_ARCHIVE_MODE="$(pg 'SHOW archive_mode' | tr -d '[:space:]')"

# ALTER SYSTEM writes postgresql.auto.conf INSIDE the data volume, so these
# settings survive a container recreate — unlike a command-line flag on the
# service definition.
pg "ALTER SYSTEM SET archive_mode = 'on'" >/dev/null
pg "ALTER SYSTEM SET archive_command = '${ARCHIVE_COMMAND}'" >/dev/null
pg "ALTER SYSTEM SET archive_timeout = '${ARCHIVE_TIMEOUT}s'" >/dev/null
pg "ALTER SYSTEM SET wal_compression = 'on'" >/dev/null
pg 'SELECT pg_reload_conf()' >/dev/null
info 'settings written to postgresql.auto.conf and reloaded'

if [[ "${CURRENT_ARCHIVE_MODE}" != 'on' ]]; then
  cat <<EOF

archive_mode was "${CURRENT_ARCHIVE_MODE}" and CANNOT be changed by a reload.
Restart the database to start archiving:

  docker restart ${CONTAINER}

Then verify:

  $0 --container ${CONTAINER} --verify-only

EOF
  exit 0
fi

# ---- Verify ---------------------------------------------------------------

step 'Verifying that a segment actually reaches the spool'
BEFORE="$(pg 'SELECT archived_count FROM pg_stat_archiver' | tr -d '[:space:]')"
pg 'SELECT pg_switch_wal()' >/dev/null

for _ in $(seq 1 30); do
  AFTER="$(pg 'SELECT archived_count FROM pg_stat_archiver' | tr -d '[:space:]')"
  if (( AFTER > BEFORE )); then
    info "archived_count ${BEFORE} -> ${AFTER}"
    info "spool now holds $(docker exec "${CONTAINER}" sh -c "ls -1 ${ARCHIVE_DIR} | wc -l" | tr -d '[:space:]') file(s)"
    report_state
    printf '\nContinuous WAL archiving is ACTIVE.\n'
    exit 0
  fi
  sleep 1
done

report_state
die 'a forced WAL switch did not produce an archived segment within 30s — check last_failed_wal above'
