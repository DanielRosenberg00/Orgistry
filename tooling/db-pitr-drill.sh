#!/usr/bin/env bash
#
# Point-in-time recovery (PITR) drill (Sprint 25, ORG-PR-005).
#
# Proves REAL point-in-time recovery on the PostgreSQL version this repository
# runs: base backup + archived WAL + a recovery target time. It is deliberately
# NOT a logical restore — a `pg_dump`/`pg_restore` cycle recovers a snapshot,
# never an arbitrary instant, and calling that PITR would be false evidence.
#
# THE PROOF THIS DRILL CONSTRUCTS
#   1. a SOURCE PostgreSQL runs with wal_level=replica and archive_mode=on;
#   2. WAL archival is verified to be WORKING (pg_stat_archiver + files on disk),
#      not merely configured;
#   3. a base backup is taken with pg_basebackup;
#   4. PRE-TARGET application state is written AFTER the base backup, so it
#      exists ONLY in archived WAL — recovering it is only possible by replaying
#      the archive;
#   5. an unambiguous recovery target time is recorded;
#   6. destructive POST-TARGET state is written (rows deleted, a table dropped);
#   7. a fresh, independent TARGET server is initialized from the base backup;
#   8. it recovers using restore_command against the WAL archive;
#   9. recovery stops at the target and promotes;
#  10. pre-target state is present;
#  11. post-target destruction is absent;
#  12. the Orgistry schema and migration metadata are intact and queryable.
#
# Usage:
#   tooling/db-pitr-drill.sh [--keep] [--help]
#
#   --keep  Leave the containers and volumes in place for debugging.
#
# REQUIREMENTS
#   docker, and a pnpm workspace install (the drill applies the real Orgistry
#   migration baseline so the recovered database is a real Orgistry database).
#
# COST
#   The drill starts two PostgreSQL servers, takes a base backup, and waits on
#   WAL archiving and recovery. It runs for roughly a minute and is therefore a
#   MANUAL / SCHEDULED check rather than a per-pull-request one — see
#   .github/workflows/data-durability.yml and docs/pitr.md.
#
# SECURITY
#   Every credential is a fake, local-only drill value; the servers live and
#   die inside this script. No real database is contacted.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"

KEEP_STATE=0

NETWORK='orgistry-pitr-drill'
SOURCE_CONTAINER='orgistry-pitr-source'
TARGET_CONTAINER='orgistry-pitr-target'
SOURCE_VOLUME='orgistry-pitr-source-data'
TARGET_VOLUME='orgistry-pitr-target-data'
ARCHIVE_VOLUME='orgistry-pitr-wal-archive'
BASE_VOLUME='orgistry-pitr-basebackup'

# Separation between the pre-target commit, the recovery target, and the
# destructive writes. Two seconds is far above PostgreSQL's commit-timestamp
# resolution and keeps the boundary unambiguous without slowing the drill.
TARGET_SEPARATION_SECONDS=2

WORK_DIR=''

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'PITR DRILL FAIL: %s\n' "$1" >&2; exit 1; }
usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP_STATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument \"$1\" (try --help)" ;;
  esac
done

cleanup() {
  if (( KEEP_STATE == 1 )); then
    printf '\n== Keeping PITR state (--keep): containers %s/%s, volumes %s/%s/%s/%s\n' \
      "${SOURCE_CONTAINER}" "${TARGET_CONTAINER}" \
      "${SOURCE_VOLUME}" "${TARGET_VOLUME}" "${ARCHIVE_VOLUME}" "${BASE_VOLUME}"
    return 0
  fi
  step 'Cleanup: removing PITR containers, volumes, and network'
  docker rm -f "${TARGET_CONTAINER}" "${SOURCE_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f "${SOURCE_VOLUME}" "${TARGET_VOLUME}" "${ARCHIVE_VOLUME}" "${BASE_VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
  return 0
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail 'docker is required.'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm is required (the drill applies the Orgistry migration baseline).'

WORK_DIR="$(mktemp -d)"
chmod 700 "${WORK_DIR}"

# Run a shell inside the pinned PostgreSQL image with no database connection.
# Used for volume preparation (ownership, copying the base backup).
pg_volume_shell() {
  local script="$1"
  shift
  docker run --rm "$@" --entrypoint sh "${ORGISTRY_PG_IMAGE}" -c "${script}"
}

source_query() {
  pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}"
  pg_query "$1" | tr -d '[:space:]'
}

# A single value with INTERNAL whitespace preserved (e.g. a timestamp, whose
# date and time are separated by a space). `source_query` collapses all
# whitespace and would corrupt such values.
source_value() {
  pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}"
  pg_query "$1" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

source_exec() {
  pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}"
  pg_client "psql \"\$ORGISTRY_PG_URL\" --no-psqlrc --quiet --set ON_ERROR_STOP=1 --command \"$1\"" >/dev/null \
    || fail "Statement failed on the source: $1"
}

target_query() {
  pg_client_init "$(pg_drill_url "${TARGET_CONTAINER}")" "${NETWORK}"
  pg_query "$1" | tr -d '[:space:]'
}

assert_target() {
  local statement="$1" expected="$2" description="$3" actual
  actual="$(target_query "${statement}")"
  [[ "${actual}" == "${expected}" ]] \
    || fail "${description}: expected \"${expected}\", got \"${actual}\""
  printf '  ok  %s = %s\n' "${description}" "${actual}"
}

# ---------------------------------------------------------------------------
step '1/12 Starting the SOURCE PostgreSQL with WAL archiving enabled'
# ---------------------------------------------------------------------------
docker network create "${NETWORK}" >/dev/null
docker volume create "${ARCHIVE_VOLUME}" >/dev/null
docker volume create "${BASE_VOLUME}" >/dev/null

# The archive directory must be writable by the server's `postgres` user.
pg_volume_shell 'chown postgres:postgres /wal_archive && chmod 750 /wal_archive' \
  --volume "${ARCHIVE_VOLUME}:/wal_archive"

# `archive_command` refuses to overwrite an existing segment (the documented
# safe form) and returns non-zero on failure, so a broken archive shows up in
# pg_stat_archiver instead of silently losing WAL.
pg_start_server "${SOURCE_CONTAINER}" "${NETWORK}" "${SOURCE_VOLUME}" \
  --publish '127.0.0.1::5432' \
  --volume "${ARCHIVE_VOLUME}:/wal_archive" \
  -- \
  -c wal_level=replica \
  -c archive_mode=on \
  -c "archive_command=test ! -f /wal_archive/%f && cp %p /wal_archive/%f" \
  -c max_wal_senders=4 \
  -c wal_keep_size=64MB

pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}"
pg_wait_ready 90 'source PostgreSQL'

# A base backup uses a REPLICATION connection, which needs its own pg_hba
# entry — the image's generated rules cover normal connections only. Added
# after init (the file is created by initdb) and applied with a config reload.
docker exec "${SOURCE_CONTAINER}" sh -c \
  "printf 'host replication all all scram-sha-256\n' >> /var/lib/postgresql/data/pg_hba.conf" \
  || fail 'Could not authorize replication connections on the source.'
pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}"
pg_query 'SELECT pg_reload_conf()' >/dev/null || fail 'Could not reload the source configuration.'

WAL_LEVEL="$(source_query 'SHOW wal_level')"
ARCHIVE_MODE="$(source_query 'SHOW archive_mode')"
[[ "${WAL_LEVEL}" == 'replica' ]] || fail "wal_level is \"${WAL_LEVEL}\", expected replica."
[[ "${ARCHIVE_MODE}" == 'on' ]] || fail "archive_mode is \"${ARCHIVE_MODE}\", expected on."
printf '  ok  wal_level=%s archive_mode=%s\n' "${WAL_LEVEL}" "${ARCHIVE_MODE}"

SOURCE_HOST_URL="$(pg_drill_url '127.0.0.1' "$(docker port "${SOURCE_CONTAINER}" 5432/tcp | head -n 1 | sed 's/.*://')")"

# ---------------------------------------------------------------------------
step '2/12 Applying the Orgistry migration baseline to the source'
# ---------------------------------------------------------------------------
DATABASE_URL="${SOURCE_HOST_URL}" pnpm --filter @orgistry/db run migrate >/dev/null \
  || fail 'Migration of the source database failed.'
SOURCE_MIGRATIONS="$(source_query 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
printf '  ok  applied migrations: %s\n' "${SOURCE_MIGRATIONS}"

# ---------------------------------------------------------------------------
step '3/12 Verifying WAL archival is actually working'
# ---------------------------------------------------------------------------
source_exec 'SELECT pg_switch_wal()'
ARCHIVE_DEADLINE=$((SECONDS + 60))
while (( SECONDS < ARCHIVE_DEADLINE )); do
  ARCHIVED_COUNT="$(source_query 'SELECT archived_count FROM pg_stat_archiver')"
  [[ "${ARCHIVED_COUNT}" =~ ^[0-9]+$ ]] && (( ARCHIVED_COUNT > 0 )) && break
  sleep 1
done
[[ "${ARCHIVED_COUNT:-0}" =~ ^[0-9]+$ ]] && (( ARCHIVED_COUNT > 0 )) \
  || fail 'No WAL segment was archived; archiving is not working.'

FAILED_WAL="$(source_query "SELECT coalesce(last_failed_wal, 'none') FROM pg_stat_archiver")"
[[ "${FAILED_WAL}" == 'none' ]] || fail "WAL archiving reported a failure on ${FAILED_WAL}."

ARCHIVE_FILES="$(pg_volume_shell 'ls -1 /wal_archive | wc -l' --volume "${ARCHIVE_VOLUME}:/wal_archive:ro" | tr -d '[:space:]')"
(( ARCHIVE_FILES > 0 )) || fail 'The WAL archive directory is empty.'
printf '  ok  archived_count=%s, %s file(s) on the archive volume, no archive failures\n' \
  "${ARCHIVED_COUNT}" "${ARCHIVE_FILES}"

# ---------------------------------------------------------------------------
step '4/12 Taking a base backup (pg_basebackup)'
# ---------------------------------------------------------------------------
pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}"
pg_client_add_docker_args --volume "${BASE_VOLUME}:/basebackup"
pg_client 'pg_basebackup --dbname="$ORGISTRY_PG_URL" --pgdata=/basebackup --format=plain --wal-method=stream --checkpoint=fast' \
  || fail 'pg_basebackup failed.'
BASE_VERSION="$(pg_volume_shell 'cat /basebackup/PG_VERSION' --volume "${BASE_VOLUME}:/basebackup:ro" | tr -d '[:space:]')"
printf '  ok  base backup taken (PG_VERSION %s)\n' "${BASE_VERSION}"

# ---------------------------------------------------------------------------
step '5/12 Writing PRE-TARGET state (exists only in archived WAL)'
# ---------------------------------------------------------------------------
# Written AFTER the base backup on purpose: recovering these rows is possible
# only by replaying archived WAL on top of the base backup.
source_exec "INSERT INTO app_meta (key, value) VALUES ('pitr_marker', 'pre-target')"
source_exec "INSERT INTO users (id, email, normalized_email, password_hash, display_name)
  VALUES ('user_pitr_pre_target', 'pre-target@pitr-drill.invalid', 'pre-target@pitr-drill.invalid',
          'fixture-not-a-real-password-hash', 'PITR Pre Target')"
PRE_TARGET_USERS="$(source_query 'SELECT count(*) FROM users')"
printf '  ok  pre-target rows committed (users=%s)\n' "${PRE_TARGET_USERS}"

# ---------------------------------------------------------------------------
step '6/12 Recording the recovery target time'
# ---------------------------------------------------------------------------
RECOVERY_TARGET="$(source_value 'SELECT now()')"
[[ -n "${RECOVERY_TARGET}" ]] || fail 'Could not read a recovery target time from the source.'
printf '  ok  recovery target: %s\n' "${RECOVERY_TARGET}"
sleep "${TARGET_SEPARATION_SECONDS}"

# ---------------------------------------------------------------------------
step '7/12 Writing DESTRUCTIVE post-target state'
# ---------------------------------------------------------------------------
# The kind of damage a real incident causes: rows removed, a table dropped,
# and a marker overwritten. Recovery must undo ALL of it.
source_exec "DELETE FROM users"
source_exec "DROP TABLE projects"
source_exec "UPDATE app_meta SET value = 'post-target' WHERE key = 'pitr_marker'"
source_exec "INSERT INTO app_meta (key, value) VALUES ('pitr_post_target_only', 'must-not-survive')"
printf '  ok  post-target damage applied (users deleted, projects dropped, marker overwritten)\n'

# Flush the damage into an archived segment so the archive covers the whole
# window on both sides of the target.
source_exec 'SELECT pg_switch_wal()'
sleep 2

# ---------------------------------------------------------------------------
step '8/12 Initializing an independent TARGET from the base backup'
# ---------------------------------------------------------------------------
docker volume create "${TARGET_VOLUME}" >/dev/null
pg_volume_shell 'set -e; cp -a /basebackup/. /pgdata/; chown -R postgres:postgres /pgdata; chmod 700 /pgdata' \
  --volume "${BASE_VOLUME}:/basebackup:ro" \
  --volume "${TARGET_VOLUME}:/pgdata"

# Recovery settings. `recovery.signal` puts the server into ARCHIVE RECOVERY;
# `restore_command` pulls segments from the archive; `recovery_target_action`
# promotes once the target is reached. Archiving is disabled on the target so
# a promoted timeline cannot write back into the source's archive.
cat >"${WORK_DIR}/recovery.conf" <<CONF

# --- Orgistry PITR drill (Sprint 25) ---
restore_command = 'cp /wal_archive/%f %p'
recovery_target_time = '${RECOVERY_TARGET}'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF

pg_volume_shell 'set -e
  cat /work/recovery.conf >> /pgdata/postgresql.auto.conf
  touch /pgdata/recovery.signal
  chown postgres:postgres /pgdata/postgresql.auto.conf /pgdata/recovery.signal' \
  --volume "${TARGET_VOLUME}:/pgdata" \
  --volume "${WORK_DIR}:/work:ro"
printf '  ok  target PGDATA seeded from the base backup with recovery.signal\n'

# ---------------------------------------------------------------------------
step '9/12 Recovering to the target time'
# ---------------------------------------------------------------------------
pg_start_server "${TARGET_CONTAINER}" "${NETWORK}" "${TARGET_VOLUME}" \
  --volume "${ARCHIVE_VOLUME}:/wal_archive:ro"

pg_client_init "$(pg_drill_url "${TARGET_CONTAINER}")" "${NETWORK}"
if ! pg_wait_ready 120 'target PostgreSQL (recovery)'; then
  docker logs "${TARGET_CONTAINER}" 2>&1 | tail -n 40 >&2
  fail 'The target server never accepted connections during recovery (log above).'
fi

PROMOTE_DEADLINE=$((SECONDS + 120))
while (( SECONDS < PROMOTE_DEADLINE )); do
  IN_RECOVERY="$(target_query 'SELECT pg_is_in_recovery()')"
  [[ "${IN_RECOVERY}" == 'f' ]] && break
  sleep 1
done
[[ "${IN_RECOVERY:-t}" == 'f' ]] \
  || fail 'The target never finished recovery and promoted; it is still in recovery.'
printf '  ok  recovery completed and the target promoted\n'

# ---------------------------------------------------------------------------
step '10/12 Proving archived WAL was consumed'
# ---------------------------------------------------------------------------
# Without this, "PITR" could be nothing more than starting a base backup.
TARGET_LOGS="$(docker logs "${TARGET_CONTAINER}" 2>&1 || true)"
case "${TARGET_LOGS}" in
  *'restored log file'*) printf '  ok  the target restored WAL segments from the archive\n' ;;
  *) printf '%s\n' "${TARGET_LOGS}" | tail -n 40 >&2
     fail 'The target log shows no archived WAL segment being restored.' ;;
esac
case "${TARGET_LOGS}" in
  *'recovery stopping before'*|*'recovery stopping after'*|*'last completed transaction was at log time'*)
    printf '  ok  the target log records stopping at the recovery target\n' ;;
  *) printf '%s\n' "${TARGET_LOGS}" | tail -n 40 >&2
     fail 'The target log does not record stopping at the recovery target.' ;;
esac

# ---------------------------------------------------------------------------
step '11/12 Verifying the recovered state sits exactly at the target'
# ---------------------------------------------------------------------------
assert_target "SELECT value FROM app_meta WHERE key = 'pitr_marker'" 'pre-target' \
  'pre-target marker recovered'
assert_target "SELECT count(*) FROM users WHERE id = 'user_pitr_pre_target'" '1' \
  'pre-target user recovered'
assert_target 'SELECT count(*) FROM users' "${PRE_TARGET_USERS}" \
  'user rows at the target time (post-target DELETE undone)'
assert_target "SELECT count(*) FROM app_meta WHERE key = 'pitr_post_target_only'" '0' \
  'post-target-only row absent'
assert_target "SELECT to_regclass('public.projects') IS NOT NULL" 't' \
  'post-target DROP TABLE undone'

# ---------------------------------------------------------------------------
step '12/12 Verifying the recovered Orgistry schema is intact and usable'
# ---------------------------------------------------------------------------
for table in users organizations memberships roles permissions role_permissions \
  plans organization_plans projects api_keys invitations sessions refresh_tokens \
  email_verification_tokens password_reset_tokens pending_registrations \
  security_events app_meta; do
  assert_target "SELECT to_regclass('public.${table}') IS NOT NULL" 't' "table ${table} exists"
done
assert_target 'SELECT count(*) FROM drizzle.__drizzle_migrations' "${SOURCE_MIGRATIONS}" \
  'migration metadata intact'
# The seeded role baseline is a migration-provided invariant; a recovered
# database that lost it would not be a usable Orgistry database.
assert_target "SELECT count(*) FROM roles WHERE key IN ('owner','admin','member','viewer')" '4' \
  'seeded role baseline intact'
# And a real relational read, not just catalog lookups.
assert_target "SELECT count(*) FROM plans p JOIN permissions perm ON true WHERE p.key = 'pro'" \
  "$(target_query "SELECT count(*) FROM permissions")" 'relational read over recovered data'

step 'PITR drill PASSED'
printf 'Recovery target time: %s\n' "${RECOVERY_TARGET}"
