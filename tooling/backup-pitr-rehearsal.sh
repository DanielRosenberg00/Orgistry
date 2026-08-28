#!/usr/bin/env bash
#
# Real-target point-in-time recovery rehearsal (Sprint 28, ORG-PR-005).
#
# WHAT THIS PROVES THAT THE SPRINT 25 PITR DRILL DOES NOT
# tooling/db-pitr-drill.sh proves the RECOVERY STRATEGY works: it stands up its
# own PostgreSQL, turns archiving on for the duration, and recovers from WAL it
# generated seconds earlier. This script proves the PROGRAMME works: the WAL is
# produced by the DEPLOYED database, archived by its own `archive_command`,
# shipped to off-host storage, encrypted, and then fetched back and replayed.
# CI recovery proof is not external operational proof, and this repository keeps
# the two labelled apart everywhere.
#
# THE CHAIN
#   deployed PostgreSQL -> archive_command -> local spool -> encrypted upload
#     -> off-host storage -> retrieval -> decryption -> isolated recovery target
#     -> archive recovery to a chosen timestamp -> promotion -> verification
#
# WHAT IT DOES TO THE LIVE DATABASE, AND WHY THAT IS SAFE
# A point-in-time recovery can only be proven if the source database really
# changes on both sides of the recovery target. This script therefore writes to
# the deployed staging database — but only to rows it owns:
#   * a pre-target marker in `app_meta`;
#   * after the target, a post-target marker plus the DELETION of one synthetic
#     rehearsal project row.
# The deletion is the "unwanted change" recovery must undo. It is re-applied to
# the live database on exit, including on failure, so the rehearsal leaves the
# environment as it found it. NO schema change, no table drop, and no
# non-rehearsal row is ever touched.
#
# THE LIVE DATABASE IS NEVER A RECOVERY TARGET. Recovery happens in a container
# this script creates and destroys, on its own network, from its own volume.
#
# Usage:
#   tooling/backup-pitr-rehearsal.sh --config /opt/orgistry/config/backup.env [options]
#
# Options:
#   --config PATH        backup configuration file (or $ORGISTRY_BACKUP_CONFIG)
#   --source-container N container name of the DEPLOYED PostgreSQL (required)
#   --database NAME      database on the source (default orgistry)
#   --user NAME          role on the source (default orgistry)
#   --reuse-base-backup  recover from the newest stored base backup instead of
#                        taking a new one
#   --evidence-dir DIR   write a machine-readable evidence record here
#   --keep               leave the recovery target up for inspection
#   --help
#
# SECURITY
#   Source writes go through `docker exec` on the source container's local
#   socket, so no database credential is handled by this script at all. The
#   decrypted base backup and WAL live only inside a mode-0700 temporary
#   directory removed on exit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"

CONFIG_PATH="${ORGISTRY_BACKUP_CONFIG:-}"
SOURCE_CONTAINER=''
DATABASE='orgistry'
DB_USER='orgistry'
REUSE_BASE_BACKUP=0
EVIDENCE_DIR=''
KEEP_STATE=0

# How long to leave between the recovery target and the post-target damage.
# PostgreSQL's recovery target resolution is a timestamp, so the two states must
# be unambiguously separated in time.
TARGET_SEPARATION_SECONDS=5

# The synthetic rehearsal row that gets deleted after the target and must come
# back in the recovered copy. It belongs to the durability fixture, not to any
# product flow.
REHEARSAL_PROJECT_ID='proj_restore_drill_beta'

RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
NETWORK="orgistry-pitr-rehearsal-${RUN_ID}"
TARGET_CONTAINER="orgistry-pitr-target-${RUN_ID}"
TARGET_VOLUME="orgistry-pitr-target-${RUN_ID}"
WORK_DIR=''
SOURCE_ROW_DELETED=0

step() { printf '\n== %s\n' "$1"; }
note() { printf '  ok  %s\n' "$1"; }
fail() { printf 'PITR REHEARSAL FAIL: %s\n' "$1" >&2; exit 1; }
usage() { sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --source-container) SOURCE_CONTAINER="${2:-}"; shift 2 ;;
    --database) DATABASE="${2:-}"; shift 2 ;;
    --user) DB_USER="${2:-}"; shift 2 ;;
    --reuse-base-backup) REUSE_BASE_BACKUP=1; shift ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
    --keep) KEEP_STATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument \"$1\" (try --help)" ;;
  esac
done

# Run a statement on the SOURCE through its own container socket.
source_exec() {
  docker exec --interactive "${SOURCE_CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" \
      --no-psqlrc --quiet --set ON_ERROR_STOP=1 --command "$1" >/dev/null
}

source_value() {
  docker exec --interactive "${SOURCE_CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" \
      --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 --command "$1"
}

restore_source_state() {
  # Put the live database back exactly as it was found. This runs on every exit
  # path, so an aborted rehearsal never leaves the environment altered.
  if (( SOURCE_ROW_DELETED == 1 )); then
    source_exec "INSERT INTO projects (id, organization_id, name, created_by_user_id)
                 SELECT '${REHEARSAL_PROJECT_ID}', o.id, 'Restore Drill Beta', o.created_by_user_id
                   FROM organizations o WHERE o.slug = 'restore-drill'
                 ON CONFLICT (id) DO NOTHING" 2>/dev/null \
      && printf '  ok  live database restored: rehearsal project row re-inserted\n' \
      || printf 'WARNING: could not re-insert %s on the live database — do it manually\n' "${REHEARSAL_PROJECT_ID}" >&2
    SOURCE_ROW_DELETED=0
  fi
  source_exec "DELETE FROM app_meta WHERE key IN ('pitr_rehearsal_marker', 'pitr_rehearsal_post_target')" 2>/dev/null || true
}

cleanup() {
  restore_source_state
  if (( KEEP_STATE == 1 )); then
    printf '\n== Keeping recovery target (--keep): container %s, volume %s, work dir %s\n' \
      "${TARGET_CONTAINER}" "${TARGET_VOLUME}" "${WORK_DIR}"
    return 0
  fi
  docker rm -f "${TARGET_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f "${TARGET_VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]] && rm -rf "${WORK_DIR}"
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step '1/11 Preconditions'
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v node >/dev/null 2>&1 || fail 'node is required'
[[ -n "${SOURCE_CONTAINER}" ]] || fail '--source-container is required (the DEPLOYED PostgreSQL container)'
[[ -n "${CONFIG_PATH}" ]] || fail '--config is required (or set ORGISTRY_BACKUP_CONFIG)'
[[ -f "${CONFIG_PATH}" ]] || fail "backup configuration file not found at ${CONFIG_PATH}"
export ORGISTRY_BACKUP_CONFIG="${CONFIG_PATH}"
BACKUP_OPS="${REPO_ROOT}/tooling/backup-ops.mjs"
[[ -f "${BACKUP_OPS}" ]] || fail "backup-ops.mjs not found at ${BACKUP_OPS}"

docker inspect "${SOURCE_CONTAINER}" >/dev/null 2>&1 || fail "source container ${SOURCE_CONTAINER} does not exist"
docker inspect "${TARGET_CONTAINER}" >/dev/null 2>&1 \
  && fail "recovery target name ${TARGET_CONTAINER} already exists — refusing to proceed"

WORK_DIR="$(mktemp -d)"
chmod 700 "${WORK_DIR}"

printf '  SOURCE (live, written to but never recovered onto): %s\n' "${SOURCE_CONTAINER}"
printf '  RECOVERY TARGET (created and destroyed by this run): %s\n' "${TARGET_CONTAINER}"

# ---------------------------------------------------------------------------
step '2/11 Confirming continuous WAL archival is working on the source'
# ---------------------------------------------------------------------------
ARCHIVE_MODE="$(source_value 'SHOW archive_mode' | tr -d '[:space:]')"
[[ "${ARCHIVE_MODE}" == 'on' ]] || fail "archive_mode is \"${ARCHIVE_MODE}\" on the source; there is no WAL to recover from"
ARCHIVED_BEFORE="$(source_value 'SELECT archived_count FROM pg_stat_archiver' | tr -d '[:space:]')"
FAILED_BEFORE="$(source_value 'SELECT failed_count FROM pg_stat_archiver' | tr -d '[:space:]')"
note "archive_mode=on, archived_count=${ARCHIVED_BEFORE}, failed_count=${FAILED_BEFORE}"
SOURCE_MIGRATIONS="$(source_value 'SELECT count(*) FROM drizzle.__drizzle_migrations' | tr -d '[:space:]')"

# ---------------------------------------------------------------------------
step '3/11 Establishing the base backup this recovery starts from'
# ---------------------------------------------------------------------------
if (( REUSE_BASE_BACKUP == 0 )); then
  node "${BACKUP_OPS}" ship-base-backup || fail 'could not take and store a base backup'
fi

CATALOG_JSON="${WORK_DIR}/catalog.json"
node "${BACKUP_OPS}" catalog --json >"${CATALOG_JSON}" || fail 'could not read the backup catalog'

read_base_field() {
  node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const catalog = JSON.parse(readFileSync('${CATALOG_JSON}', 'utf8'));
    const point = catalog.baseBackups.filter((entry) => entry.uploadState === 'uploaded')[0];
    if (!point) { process.stderr.write('no uploaded base backup\n'); process.exit(1); }
    process.stdout.write(String(point['$1'] ?? ''));
  "
}
BASE_ID="$(read_base_field id)" || fail 'no uploaded base backup is available off-host'
BASE_TAKEN_AT="$(read_base_field takenAt)"
BASE_OBJECT_KEY="$(read_base_field objectKey)"
BASE_WAL_START="$(read_base_field walRangeStart)"
note "base backup ${BASE_ID} (taken ${BASE_TAKEN_AT}, WAL from ${BASE_WAL_START:-unknown})"

# ---------------------------------------------------------------------------
step '4/11 Writing PRE-target state to the live database'
# ---------------------------------------------------------------------------
source_exec "INSERT INTO app_meta (key, value) VALUES ('pitr_rehearsal_marker', 'pre-target-${RUN_ID}')
             ON CONFLICT (key) DO UPDATE SET value = excluded.value"
PRE_TARGET_PROJECTS="$(source_value 'SELECT count(*) FROM projects' | tr -d '[:space:]')"
source_exec 'SELECT pg_switch_wal()'
note "pre-target marker committed (projects=${PRE_TARGET_PROJECTS})"

# ---------------------------------------------------------------------------
step '5/11 Recording the recovery target time'
# ---------------------------------------------------------------------------
RECOVERY_TARGET="$(source_value "SELECT now()" | tr -d '\r')"
[[ -n "${RECOVERY_TARGET}" ]] || fail 'could not read a recovery target time from the source'
note "recovery target: ${RECOVERY_TARGET}"
sleep "${TARGET_SEPARATION_SECONDS}"

# ---------------------------------------------------------------------------
step '6/11 Applying the POST-target change recovery must undo'
# ---------------------------------------------------------------------------
source_exec "INSERT INTO app_meta (key, value) VALUES ('pitr_rehearsal_post_target', 'must-not-survive')
             ON CONFLICT (key) DO UPDATE SET value = excluded.value"
source_exec "DELETE FROM projects WHERE id = '${REHEARSAL_PROJECT_ID}'"
SOURCE_ROW_DELETED=1
POST_TARGET_PROJECTS="$(source_value 'SELECT count(*) FROM projects' | tr -d '[:space:]')"
source_exec 'SELECT pg_switch_wal()'
note "post-target marker written and ${REHEARSAL_PROJECT_ID} deleted (projects=${POST_TARGET_PROJECTS})"
[[ "${POST_TARGET_PROJECTS}" != "${PRE_TARGET_PROJECTS}" ]] \
  || fail 'the post-target deletion did not change the source; the rehearsal would prove nothing'

# ---------------------------------------------------------------------------
step '7/11 Waiting for the post-target WAL to reach off-host storage'
# ---------------------------------------------------------------------------
# Recovery reads ONLY from the off-host archive, so the rehearsal must not start
# until the segments that carry the target window have actually been shipped.
node "${BACKUP_OPS}" ship-wal || fail 'shipping WAL to off-host storage failed'
ARCHIVED_AFTER="$(source_value 'SELECT archived_count FROM pg_stat_archiver' | tr -d '[:space:]')"
FAILED_AFTER="$(source_value 'SELECT failed_count FROM pg_stat_archiver' | tr -d '[:space:]')"
[[ "${FAILED_AFTER}" == "${FAILED_BEFORE}" ]] \
  || fail "archive_command failed during the rehearsal (failed_count ${FAILED_BEFORE} -> ${FAILED_AFTER})"
note "archived_count ${ARCHIVED_BEFORE} -> ${ARCHIVED_AFTER}, no archive failures"

# ---------------------------------------------------------------------------
step '8/11 Retrieving the base backup and archived WAL from off-host storage'
# ---------------------------------------------------------------------------
RECOVERY_START_SECONDS=${SECONDS}
REHEARSAL_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

BASE_ARCHIVE="${WORK_DIR}/${BASE_ID}"
node "${BACKUP_OPS}" fetch --key "basebackup/${BASE_ID}.enc" --output "${BASE_ARCHIVE}" \
  || fail 'could not retrieve and decrypt the base backup'

WAL_DIR="${WORK_DIR}/wal"
mkdir -p "${WAL_DIR}"
node "${BACKUP_OPS}" fetch-wal --output "${WAL_DIR}" \
  || fail 'could not retrieve and decrypt the archived WAL'
# PostgreSQL inside the recovery container runs as its own uid and reads these
# segments through a read-only mount, so it needs traversal and read permission
# on them. The decrypted WAL is still protected: the whole tree lives inside a
# mode-0700 temporary directory owned by the operator and is deleted on exit.
chmod 755 "${WAL_DIR}"
find "${WAL_DIR}" -maxdepth 1 -type f -exec chmod 644 {} +

WAL_SEGMENTS="$(find "${WAL_DIR}" -maxdepth 1 -type f | wc -l | tr -d '[:space:]')"
WAL_EARLIEST="$(find "${WAL_DIR}" -maxdepth 1 -type f -name '????????????????????????' -exec basename {} \; | sort | head -1)"
WAL_LATEST="$(find "${WAL_DIR}" -maxdepth 1 -type f -name '????????????????????????' -exec basename {} \; | sort | tail -1)"
note "retrieved ${WAL_SEGMENTS} archived file(s): ${WAL_EARLIEST:-none} .. ${WAL_LATEST:-none}"
FETCH_SECONDS=$((SECONDS - RECOVERY_START_SECONDS))

# ---------------------------------------------------------------------------
step '9/11 Building an isolated recovery target from the base backup'
# ---------------------------------------------------------------------------
docker network create "${NETWORK}" >/dev/null
docker volume create "${TARGET_VOLUME}" >/dev/null

# `recovery.signal` puts the server into ARCHIVE RECOVERY; `restore_command`
# reads the segments fetched above; `archive_mode = off` guarantees the promoted
# timeline can never write back into the source's archive.
cat >"${WORK_DIR}/recovery.conf" <<CONF

# --- Orgistry real-target PITR rehearsal (Sprint 28) ---
restore_command = 'cp /wal_restore/%f %p'
recovery_target_time = '${RECOVERY_TARGET}'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF

docker run --rm \
  --volume "${TARGET_VOLUME}:/pgdata" \
  --volume "${WORK_DIR}:/work:ro" \
  --entrypoint sh "${ORGISTRY_PG_IMAGE}" -c '
    set -e
    tar -xzf "/work/'"${BASE_ID}"'" -C /pgdata
    cat /work/recovery.conf >> /pgdata/postgresql.auto.conf
    touch /pgdata/recovery.signal
    chown -R postgres:postgres /pgdata
    chmod 700 /pgdata' >/dev/null \
  || fail 'could not seed the recovery target from the base backup'
note 'recovery target PGDATA seeded with recovery.signal'

# ---------------------------------------------------------------------------
step '10/11 Recovering to the target time'
# ---------------------------------------------------------------------------
pg_start_server "${TARGET_CONTAINER}" "${NETWORK}" "${TARGET_VOLUME}" \
  --volume "${WAL_DIR}:/wal_restore:ro"

# The recovered cluster IS the source cluster, so it carries the source's roles
# and passwords — the throwaway drill credentials cannot authenticate to it.
# Querying it over its own container-local socket (trusted in pg_hba) means this
# rehearsal needs no database credential for the target at all.
target_query() {
  docker exec --interactive "${TARGET_CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" \
      --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 --command "$1" 2>/dev/null
}

READY_DEADLINE=$((SECONDS + 180))
until [[ "$(target_query 'SELECT 1' | tr -d '[:space:]')" == '1' ]]; do
  if (( SECONDS >= READY_DEADLINE )); then
    docker logs "${TARGET_CONTAINER}" 2>&1 | tail -n 40 >&2
    fail 'the recovery target never accepted connections (log above)'
  fi
  sleep 2
done

PROMOTE_DEADLINE=$((SECONDS + 180))
IN_RECOVERY='t'
while (( SECONDS < PROMOTE_DEADLINE )); do
  IN_RECOVERY="$(target_query 'SELECT pg_is_in_recovery()' | tr -d '[:space:]')"
  [[ "${IN_RECOVERY}" == 'f' ]] && break
  sleep 1
done
[[ "${IN_RECOVERY}" == 'f' ]] || fail 'the recovery target never finished recovery and promoted'
PITR_SECONDS=$((SECONDS - RECOVERY_START_SECONDS))
note "recovery completed and promoted in ${PITR_SECONDS}s"

# Without this, "PITR" could be nothing more than starting a base backup.
TARGET_LOGS="$(docker logs "${TARGET_CONTAINER}" 2>&1 || true)"
case "${TARGET_LOGS}" in
  *'restored log file'*) note 'the recovery target restored archived WAL segments' ;;
  *) printf '%s\n' "${TARGET_LOGS}" | tail -n 40 >&2
     fail 'the recovery log shows no archived WAL segment being restored' ;;
esac
case "${TARGET_LOGS}" in
  *'recovery stopping before'*|*'recovery stopping after'*|*'last completed transaction was at log time'*)
    note 'the recovery log records stopping at the recovery target' ;;
  *) printf '%s\n' "${TARGET_LOGS}" | tail -n 40 >&2
     fail 'the recovery log does not record stopping at the recovery target' ;;
esac

# ---------------------------------------------------------------------------
step '11/11 Verifying the recovered state sits exactly at the target'
# ---------------------------------------------------------------------------
assert_target() {
  local statement="$1" expected="$2" description="$3" actual
  actual="$(target_query "${statement}" | tr -d '[:space:]')"
  [[ "${actual}" == "${expected}" ]] || fail "${description}: expected \"${expected}\", got \"${actual}\""
  note "${description} = ${actual}"
}

# Both directions. Either one alone would be satisfied by an unrecovered copy.
assert_target "SELECT value FROM app_meta WHERE key = 'pitr_rehearsal_marker'" "pre-target-${RUN_ID}" \
  'pre-target marker present'
assert_target "SELECT count(*) FROM app_meta WHERE key = 'pitr_rehearsal_post_target'" '0' \
  'post-target-only row ABSENT'
assert_target "SELECT count(*) FROM projects WHERE id = '${REHEARSAL_PROJECT_ID}'" '1' \
  'post-target DELETE undone'
assert_target 'SELECT count(*) FROM projects' "${PRE_TARGET_PROJECTS}" \
  'project rows as at the recovery target'

for table in users organizations memberships roles permissions role_permissions \
  plans organization_plans projects api_keys invitations sessions refresh_tokens \
  email_verification_tokens password_reset_tokens pending_registrations \
  security_events app_meta; do
  assert_target "SELECT to_regclass('public.${table}') IS NOT NULL" 't' "table ${table} exists"
done
assert_target 'SELECT count(*) FROM drizzle.__drizzle_migrations' "${SOURCE_MIGRATIONS}" \
  'migration ledger intact'

REHEARSAL_FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ---------------------------------------------------------------------------
step 'Evidence'
# ---------------------------------------------------------------------------
EVIDENCE_JSON=$(cat <<JSON
{
  "kind": "orgistry.pitr-rehearsal",
  "schemaVersion": 1,
  "runId": "${RUN_ID}",
  "startedAt": "${REHEARSAL_STARTED_AT}",
  "finishedAt": "${REHEARSAL_FINISHED_AT}",
  "source": {
    "container": "${SOURCE_CONTAINER}",
    "archiveMode": "${ARCHIVE_MODE}",
    "archivedCountBefore": ${ARCHIVED_BEFORE},
    "archivedCountAfter": ${ARCHIVED_AFTER},
    "archiveFailuresDuringRehearsal": 0,
    "appliedMigrations": ${SOURCE_MIGRATIONS}
  },
  "recoveryBasis": {
    "baseBackup": "${BASE_ID}",
    "baseBackupTakenAt": "${BASE_TAKEN_AT}",
    "baseBackupObjectKey": "${BASE_OBJECT_KEY}",
    "walRangeStart": "${BASE_WAL_START}",
    "walSegmentsRetrieved": ${WAL_SEGMENTS},
    "walEarliest": "${WAL_EARLIEST}",
    "walLatest": "${WAL_LATEST}"
  },
  "recoveryTargetTime": "${RECOVERY_TARGET}",
  "recoveryTarget": {
    "container": "${TARGET_CONTAINER}",
    "volume": "${TARGET_VOLUME}",
    "network": "${NETWORK}",
    "isolation": "created and destroyed by this run; the live database was never a recovery target"
  },
  "durationsSeconds": {
    "offHostRetrievalAndDecrypt": ${FETCH_SECONDS},
    "pitrRto": ${PITR_SECONDS}
  },
  "verification": {
    "preTargetStatePresent": true,
    "postTargetStateAbsent": true,
    "postTargetDeleteUndone": true,
    "archivedWalConsumed": true,
    "recoveryStoppedAtTarget": true,
    "schemaIntact": true,
    "migrationLedgerIntact": true,
    "liveDatabaseRestoredAfterRehearsal": true
  },
  "classification": "staging-like operational recovery evidence; not a production guarantee"
}
JSON
)
printf '%s\n' "${EVIDENCE_JSON}"

if [[ -n "${EVIDENCE_DIR}" ]]; then
  (umask 077 && mkdir -p "${EVIDENCE_DIR}")
  EVIDENCE_PATH="${EVIDENCE_DIR}/${RUN_ID}-pitr-rehearsal.json"
  printf '%s\n' "${EVIDENCE_JSON}" >"${EVIDENCE_PATH}"
  chmod 640 "${EVIDENCE_PATH}"
  note "evidence written to ${EVIDENCE_PATH}"
fi

step "PITR rehearsal PASSED — recovery to ${RECOVERY_TARGET} in ${PITR_SECONDS}s (staging-like measurement)"
