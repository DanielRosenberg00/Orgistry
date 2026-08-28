#!/usr/bin/env bash
#
# Real-target logical restore rehearsal (Sprint 28, ORG-PR-005).
#
# WHAT THIS PROVES THAT THE SPRINT 25 DRILL DOES NOT
# tooling/db-restore-drill.sh proves the repository's backup CODE can restore a
# database it created moments earlier in a throwaway container. This script
# proves something else and stronger: that a backup genuinely taken from the
# DEPLOYED database, encrypted, uploaded to off-host storage, and later
# retrieved from that storage, still restores into a working Orgistry database.
# Those are different claims and this repository never conflates them.
#
# THE CHAIN
#   deployed PostgreSQL -> logical backup -> client-side encryption
#     -> off-host upload -> off-host RETRIEVAL -> decryption
#     -> checksum verification -> clean isolated PostgreSQL
#     -> pg_restore -> schema + migration + data verification
#     -> packaged migration compatibility
#
# RESTORE SAFETY — the rule that matters most here
# A recovery rehearsal that can touch the live database is a production
# incident waiting for a typo. Every safeguard below is deliberate:
#   * the restore target is a container THIS SCRIPT creates, with a name it
#     generates; it is never named by the caller and never an existing one;
#   * the target's connection URL is built from the drill credentials in
#     tooling/lib/pg-tools.sh and is never read from the environment, so an
#     exported DATABASE_URL cannot redirect the restore;
#   * the sanitized identity of both the source backup and the restore target
#     is printed BEFORE anything destructive runs;
#   * the target is asserted EMPTY before the restore;
#   * everything is destroyed on exit, including the decrypted artifact.
#
# Usage:
#   tooling/backup-restore-rehearsal.sh --config /opt/orgistry/config/backup.env [options]
#
# Options:
#   --config PATH        backup configuration file (or $ORGISTRY_BACKUP_CONFIG)
#   --recovery-point ID  artifact name to restore (default: the newest one)
#   --api-image REF      also boot this packaged API image against the restored
#                        database and check /health and /ready
#   --evidence-dir DIR   write a machine-readable evidence record here
#   --keep               leave the target container up for inspection
#   --help
#
# SECURITY
#   The decrypted backup exists only inside a mode-0700 temporary directory that
#   is removed on exit, including on failure. No backup CONTENT reaches stdout
#   or the evidence record — only counts, digests, and timings.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"
# shellcheck source=tooling/lib/restore-drill-fixture.sh
source "${REPO_ROOT}/tooling/lib/restore-drill-fixture.sh"

CONFIG_PATH="${ORGISTRY_BACKUP_CONFIG:-}"
RECOVERY_POINT=''
API_IMAGE=''
EVIDENCE_DIR=''
KEEP_STATE=0

RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
NETWORK="orgistry-restore-rehearsal-${RUN_ID}"
TARGET_CONTAINER="orgistry-restore-target-${RUN_ID}"
TARGET_VOLUME="orgistry-restore-target-${RUN_ID}"
REDIS_CONTAINER="orgistry-restore-redis-${RUN_ID}"
API_CONTAINER="orgistry-restore-api-${RUN_ID}"
REDIS_IMAGE='redis:7.4.10-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2'
WORK_DIR=''

step() { printf '\n== %s\n' "$1"; }
note() { printf '  ok  %s\n' "$1"; }
fail() { printf 'RESTORE REHEARSAL FAIL: %s\n' "$1" >&2; exit 1; }
usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --recovery-point) RECOVERY_POINT="${2:-}"; shift 2 ;;
    --api-image) API_IMAGE="${2:-}"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
    --keep) KEEP_STATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument \"$1\" (try --help)" ;;
  esac
done

cleanup() {
  if (( KEEP_STATE == 1 )); then
    printf '\n== Keeping rehearsal state (--keep): container %s, volume %s, work dir %s\n' \
      "${TARGET_CONTAINER}" "${TARGET_VOLUME}" "${WORK_DIR}"
    return 0
  fi
  docker rm -f "${API_CONTAINER}" "${REDIS_CONTAINER}" "${TARGET_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f "${TARGET_VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  # The decrypted backup is the most sensitive object this script handles; it
  # never outlives the run, including on failure.
  [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]] && rm -rf "${WORK_DIR}"
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step 'Preconditions'
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v node >/dev/null 2>&1 || fail 'node is required (the store client is a Node program)'
[[ -n "${CONFIG_PATH}" ]] || fail '--config is required (or set ORGISTRY_BACKUP_CONFIG)'
[[ -f "${CONFIG_PATH}" ]] || fail "backup configuration file not found at ${CONFIG_PATH}"
export ORGISTRY_BACKUP_CONFIG="${CONFIG_PATH}"

BACKUP_OPS="${REPO_ROOT}/tooling/backup-ops.mjs"
[[ -f "${BACKUP_OPS}" ]] || fail "backup-ops.mjs not found at ${BACKUP_OPS}"

WORK_DIR="$(mktemp -d)"
chmod 700 "${WORK_DIR}"
note "isolated work directory created (mode 700)"

# ---------------------------------------------------------------------------
step 'Selecting a recovery point from off-host storage'
# ---------------------------------------------------------------------------
CATALOG_JSON="${WORK_DIR}/catalog.json"
node "${BACKUP_OPS}" catalog --json >"${CATALOG_JSON}" || fail 'could not read the backup catalog'

read_catalog_field() {
  node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const catalog = JSON.parse(readFileSync('${CATALOG_JSON}', 'utf8'));
    const wanted = '${RECOVERY_POINT}';
    const uploaded = catalog.logical.filter((point) => point.uploadState === 'uploaded');
    const point = wanted ? uploaded.find((entry) => entry.id === wanted) : uploaded[0];
    if (!point) { process.stderr.write('no matching uploaded recovery point\n'); process.exit(1); }
    process.stdout.write(String(point['$1'] ?? ''));
  "
}

POINT_ID="$(read_catalog_field id)" || fail 'no uploaded logical recovery point is available off-host'
POINT_TAKEN_AT="$(read_catalog_field takenAt)"
POINT_SHA256="$(read_catalog_field plaintextSha256)"
POINT_OBJECT_KEY="$(read_catalog_field objectKey)"
POINT_KEY_ID="$(read_catalog_field encryptionKeyId)"
POINT_SOURCE_HOST="$(read_catalog_field sourceHost)"
POINT_SOURCE_ENVIRONMENT="$(read_catalog_field sourceEnvironment)"
POINT_MIGRATIONS="$(read_catalog_field appliedMigrations)"

# ---------------------------------------------------------------------------
step 'Rehearsal identity — read this before the restore runs'
# ---------------------------------------------------------------------------
printf '  SOURCE BACKUP  %s\n' "${POINT_ID}"
printf '                 taken %s from %s/%s\n' "${POINT_TAKEN_AT}" "${POINT_SOURCE_ENVIRONMENT}" "${POINT_SOURCE_HOST}"
printf '                 object %s (encrypted, key %s)\n' "${POINT_OBJECT_KEY}" "${POINT_KEY_ID}"
printf '  RESTORE TARGET container %s (created by this run, destroyed on exit)\n' "${TARGET_CONTAINER}"
printf '                 volume    %s\n' "${TARGET_VOLUME}"
printf '                 network   %s\n' "${NETWORK}"
printf '  THE LIVE STAGING DATABASE IS NOT A TARGET OF THIS REHEARSAL.\n'

# A name collision would mean restoring over something that already exists.
docker inspect "${TARGET_CONTAINER}" >/dev/null 2>&1 \
  && fail "restore target name ${TARGET_CONTAINER} already exists — refusing to proceed"

REHEARSAL_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
RESTORE_START_SECONDS=${SECONDS}

# ---------------------------------------------------------------------------
step 'Retrieving and decrypting the backup from off-host storage'
# ---------------------------------------------------------------------------
RESTORED_DUMP="${WORK_DIR}/${POINT_ID}"
FETCH_START=${SECONDS}
node "${BACKUP_OPS}" fetch --key "logical/${POINT_ID}.enc" --output "${RESTORED_DUMP}" \
  || fail 'retrieval or decryption from off-host storage failed'
FETCH_SECONDS=$((SECONDS - FETCH_START))
note "retrieved and decrypted in ${FETCH_SECONDS}s"

# ---------------------------------------------------------------------------
step 'Verifying the retrieved artifact against the digest recorded at backup time'
# ---------------------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "${RESTORED_DUMP}" | cut -d' ' -f1)"
else
  ACTUAL_SHA256="$(shasum -a 256 "${RESTORED_DUMP}" | cut -d' ' -f1)"
fi
[[ "${ACTUAL_SHA256}" == "${POINT_SHA256}" ]] \
  || fail "retrieved artifact digest ${ACTUAL_SHA256} does not match the catalog digest ${POINT_SHA256}"
note "sha256 matches the catalog (${ACTUAL_SHA256:0:12}…)"

DUMP_BYTES="$(wc -c <"${RESTORED_DUMP}" | tr -d '[:space:]')"
(( DUMP_BYTES > 0 )) || fail 'retrieved artifact is empty'
note "artifact is ${DUMP_BYTES} bytes"

# ---------------------------------------------------------------------------
step 'Creating a clean, isolated PostgreSQL restore target'
# ---------------------------------------------------------------------------
docker network create "${NETWORK}" >/dev/null
docker volume create "${TARGET_VOLUME}" >/dev/null
pg_start_server "${TARGET_CONTAINER}" "${NETWORK}" "${TARGET_VOLUME}"

TARGET_URL="$(pg_drill_url "${TARGET_CONTAINER}")"
pg_client_init "${TARGET_URL}" "${NETWORK}"
pg_wait_ready 90 'restore target'
note 'restore target is accepting connections'

# Fail closed: restoring into a database that already has content would produce
# a mixture of two datasets that passes every count check by accident.
EXISTING_TABLES="$(pg_query "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]')"
[[ "${EXISTING_TABLES}" == '0' ]] \
  || fail "restore target already has ${EXISTING_TABLES} public table(s); refusing to restore over existing data"
note 'restore target is empty (0 public tables)'

# ---------------------------------------------------------------------------
step 'Restoring'
# ---------------------------------------------------------------------------
pg_client_add_docker_args --volume "${WORK_DIR}:/restore:ro"
PG_RESTORE_START=${SECONDS}
pg_client "pg_restore --dbname \"\$ORGISTRY_PG_URL\" --no-owner --no-acl --exit-on-error /restore/${POINT_ID}" >/dev/null \
  || fail 'pg_restore failed — the retrieved backup is not restorable'
PG_RESTORE_SECONDS=$((SECONDS - PG_RESTORE_START))
note "pg_restore completed in ${PG_RESTORE_SECONDS}s"

assert_query() {
  local statement="$1" expected="$2" description="$3" actual
  actual="$(pg_query "${statement}" | tr -d '[:space:]')"
  [[ "${actual}" == "${expected}" ]] \
    || fail "${description}: expected \"${expected}\", got \"${actual}\""
  note "${description} = ${actual}"
}

# ---------------------------------------------------------------------------
step 'Verifying the restored schema and migration metadata'
# ---------------------------------------------------------------------------
SCHEMA_START=${SECONDS}
for table in users organizations memberships roles permissions role_permissions \
  plans organization_plans projects api_keys invitations sessions refresh_tokens \
  email_verification_tokens password_reset_tokens pending_registrations \
  security_events app_meta; do
  assert_query "SELECT to_regclass('public.${table}') IS NOT NULL" 't' "table ${table} exists"
done
assert_query 'SELECT count(*) FROM drizzle.__drizzle_migrations' "${POINT_MIGRATIONS}" \
  'restored migration ledger rows'
SCHEMA_SECONDS=$((SECONDS - SCHEMA_START))

# ---------------------------------------------------------------------------
step 'Verifying representative Orgistry data'
# ---------------------------------------------------------------------------
# Reference data comes from the migration baseline and must always be present.
assert_query 'SELECT count(*) FROM roles' '4' 'roles'
assert_query 'SELECT count(*) FROM plans' '3' 'plans'
assert_query 'SELECT count(*) FROM permissions' '23' 'permissions'
assert_query 'SELECT count(*) FROM role_permissions' '56' 'role/permission grants'

# Tenant data seeded into the deployed database for durability rehearsals. Its
# presence proves the restore carried real ROWS, not just an empty schema.
DRILL_API_KEY_SECRET_HASH="$(sha256_hex "${DRILL_API_KEY_SECRET}")"
assert_query "SELECT count(*) FROM organizations WHERE slug = '${DRILL_ORG_SLUG}'" '1' 'rehearsal organization'
assert_query "SELECT count(*) FROM users WHERE id IN ('${DRILL_OWNER_USER_ID}', '${DRILL_MEMBER_USER_ID}')" '2' \
  'rehearsal users'
assert_query \
  "SELECT count(*) FROM projects p
     JOIN organizations o ON o.id = p.organization_id
     JOIN organization_plans op ON op.organization_id = o.id
     JOIN memberships m ON m.organization_id = o.id AND m.role_id = 'role_owner'
     JOIN users u ON u.id = m.user_id
    WHERE o.slug = '${DRILL_ORG_SLUG}' AND op.plan_key = 'pro' AND m.status = 'active'" \
  "${DRILL_EXPECTED_PROJECTS}" 'owner/organization/plan/project join'
assert_query \
  "SELECT count(*) FROM api_keys WHERE secret_hash = '${DRILL_API_KEY_SECRET_HASH}' AND display_prefix = '${DRILL_API_KEY_DISPLAY_PREFIX}'" \
  '1' 'API-key hash metadata preserved byte for byte'

RESTORE_TOTAL_SECONDS=$((SECONDS - RESTORE_START_SECONDS))

# ---------------------------------------------------------------------------
step 'Packaged migration compatibility against the restored database'
# ---------------------------------------------------------------------------
MIGRATION_RESULT='not-run'
MIGRATION_SECONDS=0
if [[ -n "${API_IMAGE}" ]]; then
  docker image inspect "${API_IMAGE}" >/dev/null 2>&1 || fail "API image ${API_IMAGE} is not present locally"
  MIGRATION_START=${SECONDS}
  docker run --rm --network "${NETWORK}" \
    --env "DATABASE_URL=$(pg_drill_url "${TARGET_CONTAINER}")" \
    --entrypoint node "${API_IMAGE}" dist/migrate.mjs \
    || fail 'the packaged migration entrypoint failed against the restored database'
  MIGRATION_SECONDS=$((SECONDS - MIGRATION_START))
  assert_query 'SELECT count(*) FROM drizzle.__drizzle_migrations' "${POINT_MIGRATIONS}" \
    'migration ledger after re-running the packaged migrations (must be a no-op)'
  MIGRATION_RESULT='no-op'
  note "packaged migrations were a no-op (${MIGRATION_SECONDS}s)"
else
  printf '  --  skipped (pass --api-image to exercise the packaged migration entrypoint)\n'
fi

# ---------------------------------------------------------------------------
step 'API compatibility against the restored database'
# ---------------------------------------------------------------------------
API_RESULT='not-run'
API_SECONDS=0
if [[ -n "${API_IMAGE}" ]] && command -v curl >/dev/null 2>&1; then
  API_START=${SECONDS}
  docker run --detach --name "${REDIS_CONTAINER}" --network "${NETWORK}" "${REDIS_IMAGE}" >/dev/null

  # Fake, guard-passing runtime configuration, mirroring the Sprint 25 drill.
  # None of it is a real credential and none of it reaches the live
  # environment: the API talks only to the throwaway restore target on the
  # throwaway network. The mail domain is deliberately NOT `.invalid` — the
  # production configuration guard refuses that suffix, which is correct
  # behaviour and would abort the rehearsal at the API stage.
  docker run --detach --name "${API_CONTAINER}" --network "${NETWORK}" \
    --publish '127.0.0.1::3000' \
    --env NODE_ENV=production --env LOG_LEVEL=info \
    --env API_HOST=0.0.0.0 --env API_PORT=3000 \
    --env "DATABASE_URL=$(pg_drill_url "${TARGET_CONTAINER}")" \
    --env "REDIS_URL=redis://${REDIS_CONTAINER}:6379" \
    --env 'JWT_SECRET=orgistry-rehearsal-jwt-not-a-real-secret-orgistry-rehearsal' \
    --env COOKIE_SECURE=true \
    --env MAIL_DRIVER=smtp --env SMTP_HOST=mail.invalid --env SMTP_PORT=465 \
    --env SMTP_USERNAME=orgistry-rehearsal-mailer \
    --env 'SMTP_PASSWORD=orgistry-rehearsal-smtp-not-a-real-credential' \
    --env MAIL_FROM_EMAIL=no-reply@rehearsal.orgistry.dev \
    --env WEB_DEMO_URL=https://web.rehearsal.orgistry.dev \
    --env CORS_ORIGINS=https://web.rehearsal.orgistry.dev \
    --env TRUST_PROXY=false \
    "${API_IMAGE}" >/dev/null

  API_PORT="$(docker port "${API_CONTAINER}" 3000/tcp | head -n 1 | sed 's/.*://')"
  API_URL="http://127.0.0.1:${API_PORT}"

  wait_for_status() {
    local url="$1" expected="$2" timeout_seconds="$3" description="$4"
    local deadline=$((SECONDS + timeout_seconds)) status=''
    while (( SECONDS < deadline )); do
      status="$(curl -s -o /dev/null -w '%{http_code}' "${url}" || true)"
      if [[ "${status}" == "${expected}" ]]; then
        note "${description} -> ${status}"
        return 0
      fi
      sleep 1
    done
    docker logs "${API_CONTAINER}" 2>&1 | tail -n 20 >&2
    fail "${description}: expected HTTP ${expected}, last saw \"${status}\""
  }

  wait_for_status "${API_URL}/health" '200' 90 'packaged API /health'
  wait_for_status "${API_URL}/ready" '200' 60 'packaged API /ready against the restored database'
  API_SECONDS=$((SECONDS - API_START))
  API_RESULT='healthy'
else
  printf '  --  skipped (needs --api-image and curl)\n'
fi

# Two RTO boundaries, reported separately because they answer different
# questions. `logicalRestoreRto` ends at a VERIFIED DATABASE — the point a DBA
# would call the data recovered. `serviceRestoreRto` ends at a packaged API
# answering /ready against it — the point a user would call the service
# recovered. Quoting one when you mean the other is how recovery estimates go
# wrong, so neither is presented alone.
SERVICE_TOTAL_SECONDS=$((SECONDS - RESTORE_START_SECONDS))

REHEARSAL_FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ---------------------------------------------------------------------------
step 'Evidence'
# ---------------------------------------------------------------------------
# Nothing below is secret: identities, digests, counts, and durations only. No
# connection string, no key, and no backup CONTENT.
EVIDENCE_JSON=$(cat <<JSON
{
  "kind": "orgistry.restore-rehearsal",
  "schemaVersion": 1,
  "runId": "${RUN_ID}",
  "startedAt": "${REHEARSAL_STARTED_AT}",
  "finishedAt": "${REHEARSAL_FINISHED_AT}",
  "sourceBackup": {
    "artifact": "${POINT_ID}",
    "takenAt": "${POINT_TAKEN_AT}",
    "objectKey": "${POINT_OBJECT_KEY}",
    "sourceEnvironment": "${POINT_SOURCE_ENVIRONMENT}",
    "sourceHost": "${POINT_SOURCE_HOST}",
    "encryptionKeyId": "${POINT_KEY_ID}",
    "sha256": "${ACTUAL_SHA256}",
    "bytes": ${DUMP_BYTES},
    "appliedMigrations": ${POINT_MIGRATIONS}
  },
  "restoreTarget": {
    "container": "${TARGET_CONTAINER}",
    "volume": "${TARGET_VOLUME}",
    "network": "${NETWORK}",
    "isolation": "created and destroyed by this run; the live database was never a target"
  },
  "durationsSeconds": {
    "offHostRetrievalAndDecrypt": ${FETCH_SECONDS},
    "pgRestore": ${PG_RESTORE_SECONDS},
    "schemaAndDataVerification": ${SCHEMA_SECONDS},
    "packagedMigration": ${MIGRATION_SECONDS},
    "apiBootAndReadiness": ${API_SECONDS},
    "logicalRestoreRto": ${RESTORE_TOTAL_SECONDS},
    "serviceRestoreRto": ${SERVICE_TOTAL_SECONDS}
  },
  "rtoBoundaries": {
    "logicalRestoreRto": "off-host retrieval -> decrypt -> digest verification -> pg_restore -> schema, migration ledger and representative data verified",
    "serviceRestoreRto": "the same, plus the packaged migration entrypoint and the packaged API answering /ready against the restored database"
  },
  "verification": {
    "checksumMatchedCatalog": true,
    "targetWasEmptyBeforeRestore": true,
    "schemaVerified": true,
    "migrationLedgerVerified": true,
    "representativeDataVerified": true,
    "packagedMigration": "${MIGRATION_RESULT}",
    "packagedApi": "${API_RESULT}"
  },
  "classification": "staging-like operational recovery evidence; not a production guarantee"
}
JSON
)
printf '%s\n' "${EVIDENCE_JSON}"

if [[ -n "${EVIDENCE_DIR}" ]]; then
  (umask 077 && mkdir -p "${EVIDENCE_DIR}")
  EVIDENCE_PATH="${EVIDENCE_DIR}/${RUN_ID}-restore-rehearsal.json"
  printf '%s\n' "${EVIDENCE_JSON}" >"${EVIDENCE_PATH}"
  chmod 640 "${EVIDENCE_PATH}"
  note "evidence written to ${EVIDENCE_PATH}"
fi

step "Restore rehearsal PASSED"
printf '  logical restore RTO  %ss  (to a verified restored database)\n' "${RESTORE_TOTAL_SECONDS}"
printf '  service restore RTO  %ss  (through packaged API /ready)\n' "${SERVICE_TOTAL_SECONDS}"
printf '  staging-like operational measurement — not a production guarantee\n'
