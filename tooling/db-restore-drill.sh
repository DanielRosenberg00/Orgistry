#!/usr/bin/env bash
#
# Logical restore drill (Sprint 25, ORG-PR-005).
#
# Proves that the backup this repository takes can actually be restored and
# that the restored database is usable by the production-shaped API artifact.
# A backup with no tested restore is not a backup, so this is the evidence that
# matters — not the dump script.
#
# WHAT IT DOES
#   1. creates a throwaway SOURCE PostgreSQL container and migrates it with the
#      repository's own migration entrypoint;
#   2. seeds deterministic synthetic Orgistry data
#      (tooling/fixtures/restore-drill-seed.sql);
#   3. takes a backup with tooling/db-backup.sh — the real backup path, not a
#      drill-only copy of it;
#   4. verifies the artifact exists, is non-empty, and matches its checksum,
#      and proves that BOTH a corrupted and a MISSING artifact fail loudly
#      without leaving a partially restored target;
#   5. restores into a genuinely FRESH, empty TARGET container — never over the
#      source;
#   6. asserts the Orgistry schema, the Drizzle migration metadata, and every
#      seeded entity survived;
#   7. re-runs migrations against the RESTORED database and requires a no-op —
#      the restored database must be compatible with current migration handling;
#   8. with --with-artifact: runs the packaged API artifact against the
#      restored database and reads restored data back through the real
#      API-key-authenticated HTTP surface;
#   9. destroys every container, volume, network, and temporary file.
#
# Usage:
#   tooling/db-restore-drill.sh [--with-artifact] [--keep] [--help]
#
#   --with-artifact  Also exercise the production API artifact
#                    (orgistry-api:production-like — build it with
#                    `pnpm artifact:build`). In this mode migrations run
#                    through the artifact's own `dist/migrate.mjs` entrypoint
#                    and NO pnpm workspace install is required.
#   --keep           Leave the containers, volumes, and backup directory in
#                    place for debugging. Off by default: a drill that leaves
#                    state behind can pass on the previous run's data.
#
# REQUIREMENTS
#   docker (compose not needed), curl for the artifact stage, and — unless
#   --with-artifact is used — a pnpm workspace install for the migration step.
#
# SECURITY
#   Every credential here is a fake, local-only drill value. The backup is
#   written to a temporary directory that is removed on exit, never to the
#   repository. No real database is contacted and no real secret is read.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"
# shellcheck source=tooling/lib/restore-drill-fixture.sh
source "${REPO_ROOT}/tooling/lib/restore-drill-fixture.sh"

WITH_ARTIFACT=0
KEEP_STATE=0

NETWORK='orgistry-restore-drill'
SOURCE_CONTAINER='orgistry-drill-source'
TARGET_CONTAINER='orgistry-drill-target'
REDIS_CONTAINER='orgistry-drill-redis'
API_CONTAINER='orgistry-drill-api'
SOURCE_VOLUME='orgistry-drill-source-data'
TARGET_VOLUME='orgistry-drill-target-data'
API_IMAGE='orgistry-api:production-like'
REDIS_IMAGE='redis:7.4.10-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2'

# Fake, guard-passing runtime configuration for the artifact stage. Mirrors
# infra/compose.production-like.yml; none of it is a real credential.
DRILL_JWT_SECRET='orgistry-drill-jwt-not-a-real-secret-orgistry-drill-jwt'
DRILL_SMTP_PASSWORD='orgistry-drill-smtp-not-a-real-credential'

WORK_DIR=''

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'RESTORE DRILL FAIL: %s\n' "$1" >&2; exit 1; }

usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    # `pnpm run <script> -- --flag` forwards a bare `--`. Treat it as the
    # conventional end-of-options marker, matching the retention CLI.
    --) shift ;;
    --with-artifact) WITH_ARTIFACT=1; shift ;;
    --keep) KEEP_STATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument \"$1\" (try --help)" ;;
  esac
done

cleanup() {
  if (( KEEP_STATE == 1 )); then
    printf '\n== Keeping drill state (--keep): containers %s/%s/%s/%s, volumes %s/%s, backups in %s\n' \
      "${SOURCE_CONTAINER}" "${TARGET_CONTAINER}" "${REDIS_CONTAINER}" "${API_CONTAINER}" \
      "${SOURCE_VOLUME}" "${TARGET_VOLUME}" "${WORK_DIR}"
    return 0
  fi
  step 'Cleanup: removing drill containers, volumes, network, and backup files'
  docker rm -f "${API_CONTAINER}" "${REDIS_CONTAINER}" "${TARGET_CONTAINER}" "${SOURCE_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f "${SOURCE_VOLUME}" "${TARGET_VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  # Backup artifacts are sensitive; they never outlive the drill.
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
  return 0
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail 'docker is required.'
if (( WITH_ARTIFACT == 1 )); then
  command -v curl >/dev/null 2>&1 || fail 'curl is required for --with-artifact.'
  docker image inspect "${API_IMAGE}" >/dev/null 2>&1 \
    || fail "Image ${API_IMAGE} not found. Build it first: pnpm artifact:build"
else
  command -v pnpm >/dev/null 2>&1 \
    || fail 'pnpm is required for the migration step (or use --with-artifact to migrate through the packaged artifact).'
fi

WORK_DIR="$(mktemp -d)"
chmod 700 "${WORK_DIR}"

# Derived, never committed: the value the fixture stores in `api_keys.secret_hash`.
DRILL_API_KEY_SECRET_HASH="$(sha256_hex "${DRILL_API_KEY_SECRET}")"

# The published host port of a drill container's PostgreSQL.
published_port() {
  docker port "$1" 5432/tcp | head -n 1 | sed 's/.*://'
}

# Apply the migration baseline to a database.
#   $1 — in-network URL   $2 — host-published URL   $3 — label for messages
migrate_database() {
  local network_url="$1" host_url="$2" label="$3"
  if (( WITH_ARTIFACT == 1 )); then
    # The production recovery path: the artifact's own migration entrypoint.
    docker run --rm --network "${NETWORK}" \
      --env "DATABASE_URL=${network_url}" \
      "${API_IMAGE}" node dist/migrate.mjs >/dev/null \
      || fail "Migration of ${label} failed (artifact entrypoint)."
  else
    DATABASE_URL="${host_url}" pnpm --filter @orgistry/db run migrate >/dev/null \
      || fail "Migration of ${label} failed (pnpm db:migrate)."
  fi
}

# Run a single-value query against a drill container and echo the trimmed result.
query_container() {
  local container="$1" statement="$2"
  pg_client_init "$(pg_drill_url "${container}")" "${NETWORK}"
  pg_query "${statement}" | tr -d '[:space:]'
}

# Assert a single-value query returns exactly `expected`.
assert_query() {
  local container="$1" statement="$2" expected="$3" description="$4"
  local actual
  actual="$(query_container "${container}" "${statement}")"
  if [[ "${actual}" != "${expected}" ]]; then
    fail "${description}: expected \"${expected}\", got \"${actual}\""
  fi
  printf '  ok  %s = %s\n' "${description}" "${actual}"
}

# ---------------------------------------------------------------------------
step 'Creating drill network and SOURCE PostgreSQL'
# ---------------------------------------------------------------------------
docker network create "${NETWORK}" >/dev/null
pg_start_server "${SOURCE_CONTAINER}" "${NETWORK}" "${SOURCE_VOLUME}" \
  --publish '127.0.0.1::5432'

SOURCE_NETWORK_URL="$(pg_drill_url "${SOURCE_CONTAINER}")"
SOURCE_HOST_URL="$(pg_drill_url '127.0.0.1' "$(published_port "${SOURCE_CONTAINER}")")"

pg_client_init "${SOURCE_NETWORK_URL}" "${NETWORK}"
pg_wait_ready 60 'source PostgreSQL'

# ---------------------------------------------------------------------------
step 'Migrating the SOURCE database'
# ---------------------------------------------------------------------------
migrate_database "${SOURCE_NETWORK_URL}" "${SOURCE_HOST_URL}" 'the source database'
SOURCE_MIGRATIONS="$(query_container "${SOURCE_CONTAINER}" 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
printf '  applied migrations: %s\n' "${SOURCE_MIGRATIONS}"
[[ "${SOURCE_MIGRATIONS}" =~ ^[0-9]+$ && "${SOURCE_MIGRATIONS}" -gt 0 ]] \
  || fail 'The source database has no recorded migrations.'

# ---------------------------------------------------------------------------
step 'Seeding deterministic Orgistry data'
# ---------------------------------------------------------------------------
pg_client_init "${SOURCE_NETWORK_URL}" "${NETWORK}"
pg_client_add_docker_args --volume "${REPO_ROOT}/tooling/fixtures:/fixtures:ro"
pg_client "psql \"\$ORGISTRY_PG_URL\" --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --set owner_user_id='${DRILL_OWNER_USER_ID}' \
  --set member_user_id='${DRILL_MEMBER_USER_ID}' \
  --set org_id='${DRILL_ORG_ID}' \
  --set org_slug='${DRILL_ORG_SLUG}' \
  --set project_alpha='${DRILL_PROJECT_NAMES[0]}' \
  --set project_beta='${DRILL_PROJECT_NAMES[1]}' \
  --set api_key_display_prefix='${DRILL_API_KEY_DISPLAY_PREFIX}' \
  --set api_key_secret_hash='${DRILL_API_KEY_SECRET_HASH}' \
  --file /fixtures/restore-drill-seed.sql" >/dev/null \
  || fail 'Seeding the source database failed.'
printf '  seeded users, organization, memberships, plan state, projects, API key, invitation, security events\n'

# ---------------------------------------------------------------------------
step 'Taking a logical backup (tooling/db-backup.sh)'
# ---------------------------------------------------------------------------
BACKUP_PATH="$(
  ORGISTRY_BACKUP_DIR="${WORK_DIR}/backups" \
  bash "${REPO_ROOT}/tooling/db-backup.sh" \
    --database-url "${SOURCE_NETWORK_URL}" \
    --docker-network "${NETWORK}" \
    --label 'restore-drill' | tail -n 1
)" || fail 'tooling/db-backup.sh failed.'

[[ -f "${BACKUP_PATH}" ]] || fail "Backup artifact not found at ${BACKUP_PATH}"
BACKUP_BYTES="$(wc -c <"${BACKUP_PATH}" | tr -d '[:space:]')"
(( BACKUP_BYTES > 0 )) || fail 'Backup artifact is empty.'
printf '  ok  artifact present, %s bytes\n' "${BACKUP_BYTES}"

# ---------------------------------------------------------------------------
step 'Verifying the backup checksum'
# ---------------------------------------------------------------------------
(
  cd "$(dirname "${BACKUP_PATH}")"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check --status "$(basename "${BACKUP_PATH}").sha256"
  else
    shasum -a 256 --check --status "$(basename "${BACKUP_PATH}").sha256"
  fi
) || fail 'Backup checksum verification failed — the artifact is corrupt.'
printf '  ok  sha256 matches the recorded checksum\n'

# A corrupted artifact must fail loudly, not restore partially. Prove it on a
# COPY so the real artifact is untouched.
CORRUPT_COPY="${WORK_DIR}/corrupt.dump"
head -c 512 "${BACKUP_PATH}" >"${CORRUPT_COPY}"
if pg_client_init "$(pg_drill_url "${SOURCE_CONTAINER}")" "${NETWORK}" \
  && pg_client_add_docker_args --volume "${WORK_DIR}:/work:ro" \
  && pg_client 'pg_restore --list /work/corrupt.dump' >/dev/null 2>&1; then
  fail 'A truncated backup was accepted by pg_restore; corruption would go undetected.'
fi
printf '  ok  a truncated artifact is rejected by pg_restore\n'

# ---------------------------------------------------------------------------
step 'Restoring into a FRESH TARGET PostgreSQL'
# ---------------------------------------------------------------------------
pg_start_server "${TARGET_CONTAINER}" "${NETWORK}" "${TARGET_VOLUME}" \
  --publish '127.0.0.1::5432'

TARGET_NETWORK_URL="$(pg_drill_url "${TARGET_CONTAINER}")"
TARGET_HOST_URL="$(pg_drill_url '127.0.0.1' "$(published_port "${TARGET_CONTAINER}")")"

pg_client_init "${TARGET_NETWORK_URL}" "${NETWORK}"
pg_wait_ready 60 'target PostgreSQL'

# The target must start EMPTY — otherwise a "successful" restore could be
# reporting the target's pre-existing state.
assert_query "${TARGET_CONTAINER}" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" \
  '0' 'target public tables before restore'

# A MISSING artifact must fail loudly and leave the target untouched — the
# other half of the corrupted-input requirement. Probed on the real target
# BEFORE the real restore, so "the target is still empty" is a meaningful
# assertion rather than a vacuous one.
pg_client_init "${TARGET_NETWORK_URL}" "${NETWORK}"
pg_client_add_docker_args --volume "$(dirname "${BACKUP_PATH}"):/backups:ro"
set +e
MISSING_ARTIFACT_OUTPUT="$(
  pg_client 'pg_restore --dbname "$ORGISTRY_PG_URL" --no-owner --no-acl --exit-on-error /backups/orgistry-no-such-artifact.dump' 2>&1
)"
MISSING_ARTIFACT_STATUS=$?
set -e
(( MISSING_ARTIFACT_STATUS != 0 )) \
  || fail 'A MISSING backup artifact was accepted by pg_restore.'
case "${MISSING_ARTIFACT_OUTPUT}" in
  *'orgistry-no-such-artifact.dump'*) : ;;
  *) printf '%s\n' "${MISSING_ARTIFACT_OUTPUT}" >&2
     fail 'The missing-artifact failure did not name the path it could not open.' ;;
esac
case "${MISSING_ARTIFACT_OUTPUT}" in
  *"${ORGISTRY_DRILL_PG_PASSWORD}"*)
    fail 'The missing-artifact failure echoed the database password.' ;;
esac
printf '  ok  a missing artifact fails (exit %s), names the path, and echoes no credential\n' \
  "${MISSING_ARTIFACT_STATUS}"
assert_query "${TARGET_CONTAINER}" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" \
  '0' 'target public tables after the missing-artifact attempt'

pg_client_init "${TARGET_NETWORK_URL}" "${NETWORK}"
pg_client_add_docker_args --volume "$(dirname "${BACKUP_PATH}"):/backups:ro"
pg_client "pg_restore --dbname \"\$ORGISTRY_PG_URL\" --no-owner --no-acl --exit-on-error /backups/$(basename "${BACKUP_PATH}")" >/dev/null \
  || fail 'pg_restore failed — the backup is not restorable.'
printf '  ok  pg_restore completed\n'

# ---------------------------------------------------------------------------
step 'Verifying the restored schema and migration metadata'
# ---------------------------------------------------------------------------
for table in users organizations memberships roles permissions role_permissions \
  plans organization_plans projects api_keys invitations sessions refresh_tokens \
  email_verification_tokens password_reset_tokens pending_registrations \
  security_events app_meta; do
  assert_query "${TARGET_CONTAINER}" \
    "SELECT to_regclass('public.${table}') IS NOT NULL" 't' "table ${table} exists"
done

assert_query "${TARGET_CONTAINER}" \
  'SELECT count(*) FROM drizzle.__drizzle_migrations' "${SOURCE_MIGRATIONS}" \
  'restored migration metadata rows'

# ---------------------------------------------------------------------------
step 'Verifying restored Orgistry data'
# ---------------------------------------------------------------------------
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM users' "${DRILL_EXPECTED_USERS}" 'users'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM organizations' "${DRILL_EXPECTED_ORGANIZATIONS}" 'organizations'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM memberships' "${DRILL_EXPECTED_MEMBERSHIPS}" 'memberships'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM projects' "${DRILL_EXPECTED_PROJECTS}" 'projects'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM api_keys' "${DRILL_EXPECTED_API_KEYS}" 'api keys'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM invitations' "${DRILL_EXPECTED_INVITATIONS}" 'invitations'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM security_events' "${DRILL_EXPECTED_SECURITY_EVENTS}" 'security events'
assert_query "${TARGET_CONTAINER}" \
  "SELECT value FROM app_meta WHERE key = 'restore_drill_marker'" 'sprint-25' 'app_meta marker'

# The relational shape must survive, not just the row counts: this is the
# owner -> membership -> organization -> plan -> project chain the product
# depends on.
assert_query "${TARGET_CONTAINER}" \
  "SELECT count(*) FROM projects p
     JOIN organizations o ON o.id = p.organization_id
     JOIN organization_plans op ON op.organization_id = o.id
     JOIN memberships m ON m.organization_id = o.id AND m.role_id = 'role_owner'
     JOIN users u ON u.id = m.user_id
    WHERE o.slug = '${DRILL_ORG_SLUG}' AND op.plan_key = 'pro' AND m.status = 'active'" \
  "${DRILL_EXPECTED_PROJECTS}" 'owner/organization/plan/project join'

# Hash-only secret storage must survive verbatim — a restore that mangled the
# API-key hash would silently break every machine credential.
assert_query "${TARGET_CONTAINER}" \
  "SELECT count(*) FROM api_keys WHERE secret_hash = '${DRILL_API_KEY_SECRET_HASH}' AND display_prefix = '${DRILL_API_KEY_DISPLAY_PREFIX}'" \
  '1' 'API-key hash metadata preserved'

# ---------------------------------------------------------------------------
step 'Re-running migrations against the RESTORED database (must be a no-op)'
# ---------------------------------------------------------------------------
migrate_database "${TARGET_NETWORK_URL}" "${TARGET_HOST_URL}" 'the restored database'
assert_query "${TARGET_CONTAINER}" \
  'SELECT count(*) FROM drizzle.__drizzle_migrations' "${SOURCE_MIGRATIONS}" \
  'migration metadata after re-running migrations'

if (( WITH_ARTIFACT == 0 )); then
  step 'Restore drill PASSED (data-layer verification)'
  printf 'Re-run with --with-artifact to also exercise the packaged API artifact.\n'
  exit 0
fi

# ---------------------------------------------------------------------------
step 'Booting the packaged API artifact against the RESTORED database'
# ---------------------------------------------------------------------------
docker run --detach --name "${REDIS_CONTAINER}" --network "${NETWORK}" "${REDIS_IMAGE}" >/dev/null

# Runtime configuration for every artifact process in this stage. The
# retention command loads the SAME validated configuration as the API (see
# docs/retention.md), so both get the identical environment.
ARTIFACT_ENV=(
  --env NODE_ENV=production
  --env LOG_LEVEL=info
  --env "DATABASE_URL=${TARGET_NETWORK_URL}"
  --env "REDIS_URL=redis://${REDIS_CONTAINER}:6379"
  --env "JWT_SECRET=${DRILL_JWT_SECRET}"
  --env COOKIE_SECURE=true
  --env MAIL_DRIVER=smtp
  --env SMTP_HOST=mail.invalid
  --env SMTP_PORT=465
  --env SMTP_USERNAME=orgistry-drill-mailer
  --env "SMTP_PASSWORD=${DRILL_SMTP_PASSWORD}"
  --env MAIL_FROM_EMAIL=no-reply@drill.orgistry.dev
  --env WEB_DEMO_URL=https://web.drill.orgistry.dev
  --env CORS_ORIGINS=https://web.drill.orgistry.dev
  --env TRUST_PROXY=false
)

docker run --detach --name "${API_CONTAINER}" --network "${NETWORK}" \
  --publish '127.0.0.1::3000' \
  --env API_HOST=0.0.0.0 \
  --env API_PORT=3000 \
  "${ARTIFACT_ENV[@]}" \
  "${API_IMAGE}" >/dev/null

API_PORT="$(docker port "${API_CONTAINER}" 3000/tcp | head -n 1 | sed 's/.*://')"
API_URL="http://127.0.0.1:${API_PORT}"

# Poll a URL until it returns the expected status.
wait_for_status() {
  local url="$1" expected="$2" timeout_seconds="$3" description="$4"
  local deadline=$((SECONDS + timeout_seconds)) status=''
  while (( SECONDS < deadline )); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "${url}" || true)"
    if [[ "${status}" == "${expected}" ]]; then
      printf '  ok  %s -> %s\n' "${description}" "${status}"
      return 0
    fi
    sleep 1
  done
  docker logs "${API_CONTAINER}" 2>&1 | tail -n 30 >&2
  fail "${description}: expected HTTP ${expected}, last saw \"${status}\""
}

wait_for_status "${API_URL}/health" '200' 90 'artifact /health'
wait_for_status "${API_URL}/ready" '200' 60 'artifact /ready against the restored database'

# ---------------------------------------------------------------------------
step 'Reading restored data back through the authenticated API'
# ---------------------------------------------------------------------------
# The external Projects API authenticates with an API key whose SHA-256 hash
# came out of the RESTORED database, derives the tenant from that key's row,
# and returns that organization's projects. A successful read therefore
# exercises restored credential metadata, restored tenant state, and restored
# business rows in one request.
#
# THIS IS ALSO THE FIXTURE/PRODUCT HASH CONTRACT TEST. `DRILL_API_KEY_SECRET_HASH`
# was derived here by `sha256_hex` (tooling/lib/pg-tools.sh) and seeded into
# `api_keys.secret_hash`; the request below succeeds only if the packaged API
# computes the SAME hash from the raw key. If the product ever salted,
# peppered, or changed algorithm, this returns 401 and the drill fails. That is
# why tooling/restore-drill-fixture.test.ts deliberately does NOT re-derive the
# hash in TypeScript — see the header there.
EXTERNAL_RESPONSE="$(
  curl -s -H "Authorization: Bearer ${DRILL_API_KEY_RAW}" \
    "${API_URL}/v1/external/projects"
)"

for project_name in "${DRILL_PROJECT_NAMES[@]}"; do
  case "${EXTERNAL_RESPONSE}" in
    *"${project_name}"*) printf '  ok  restored project returned by the API: %s\n' "${project_name}" ;;
    *) fail "Restored project \"${project_name}\" was not returned by GET /v1/external/projects." ;;
  esac
done

# An unknown key must still be rejected: the restore must not have widened
# authentication.
UNKNOWN_KEY_STATUS="$(
  curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${DRILL_API_KEY_DISPLAY_PREFIX}_not-the-restored-secret" \
    "${API_URL}/v1/external/projects"
)"
[[ "${UNKNOWN_KEY_STATUS}" == '401' ]] \
  || fail "An unknown API key returned HTTP ${UNKNOWN_KEY_STATUS}; expected 401."
printf '  ok  an unknown API key is still rejected (401)\n'

# ---------------------------------------------------------------------------
step 'Checking artifact logs for secret leakage'
# ---------------------------------------------------------------------------
API_LOGS="$(docker logs "${API_CONTAINER}" 2>&1 || true)"
for secret in "${DRILL_JWT_SECRET}" "${DRILL_SMTP_PASSWORD}" \
  "${ORGISTRY_DRILL_PG_PASSWORD}" "${DRILL_API_KEY_SECRET}"; do
  case "${API_LOGS}" in
    *"${secret}"*) fail 'A drill secret appeared in the API artifact logs.' ;;
  esac
done
printf '  ok  no drill secret appears in the artifact logs\n'

# ---------------------------------------------------------------------------
step 'Running the retention cleanup from the packaged artifact'
# ---------------------------------------------------------------------------
# The retention command ships in the same image as the API. Against the freshly
# restored fixture nothing is old enough to delete, which is exactly the
# property worth proving on real data: a sweep over live-shaped state removes
# NOTHING when nothing has aged past its window.
run_retention() {
  docker run --rm --network "${NETWORK}" "${ARTIFACT_ENV[@]}" \
    --entrypoint node "${API_IMAGE}" dist/retention.mjs "$@"
}

RETENTION_DRY_RUN="$(run_retention --dry-run)" \
  || fail 'The packaged retention command failed in dry-run mode.'
case "${RETENTION_DRY_RUN}" in
  *'no rows deleted (dry run)'*) printf '  ok  artifact retention dry-run reported no deletions\n' ;;
  *) printf '%s\n' "${RETENTION_DRY_RUN}" >&2
     fail 'The retention dry-run summary did not report a no-mutation run.' ;;
esac

RETENTION_APPLY="$(run_retention --apply)" \
  || fail 'The packaged retention command failed in apply mode.'
case "${RETENTION_APPLY}" in
  *'deleted=0 failed_categories=0'*) printf '  ok  artifact retention apply deleted nothing (no row has aged out)\n' ;;
  *) printf '%s\n' "${RETENTION_APPLY}" >&2
     fail 'The retention apply summary reported unexpected deletions.' ;;
esac

# And the restored data is still all there afterwards. The seeded rows are
# matched by id: the API stage above legitimately WROTE a `security_events`
# row (the rejected unknown-key request), so a bare table count would be
# asserting the API did nothing rather than that retention deleted nothing.
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM users' "${DRILL_EXPECTED_USERS}" 'users after retention apply'
assert_query "${TARGET_CONTAINER}" \
  "SELECT count(*) FROM security_events WHERE id LIKE 'sevt_restore_drill_%'" \
  "${DRILL_EXPECTED_SECURITY_EVENTS}" 'seeded security events after retention apply'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM invitations' "${DRILL_EXPECTED_INVITATIONS}" 'invitations after retention apply'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM api_keys' "${DRILL_EXPECTED_API_KEYS}" 'api keys after retention apply'
assert_query "${TARGET_CONTAINER}" 'SELECT count(*) FROM projects' "${DRILL_EXPECTED_PROJECTS}" 'projects after retention apply'

step 'Restore drill PASSED (data-layer + packaged-artifact verification)'
