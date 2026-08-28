#!/usr/bin/env bash
#
# Seed synthetic Orgistry data into a DEPLOYED database for durability
# rehearsals (Sprint 28, ORG-PR-005).
#
# WHY THIS EXISTS
# A restore rehearsal against a database containing only the migration
# baseline's reference rows proves the schema came back. It does not prove
# tenant DATA came back — and "the backup restored an empty schema" is a
# failure mode that passes every table-existence check. This seeds one row per
# entity class the recovery contract must preserve, so the rehearsals can
# assert real rows survived a real backup/restore cycle.
#
# It reuses the Sprint 25 fixture (tooling/fixtures/restore-drill-seed.sql and
# tooling/lib/restore-drill-fixture.sh) rather than inventing a second synthetic
# dataset, so the repository has exactly one definition of what "representative
# Orgistry data" means and the rehearsal assertions cannot drift from it.
#
# WHAT IT IS SAFE TO RUN AGAINST
# A staging-like environment holding SYNTHETIC data only. It refuses to run
# against a database that already contains users it did not create, because
# that is the signature of a database with real tenants in it.
#
# Every identifier, hash, and address below is fake and local-only: the email
# addresses are in the reserved `.invalid` TLD and the password hashes are not
# real Argon2id output, so nothing here authenticates against anything.
#
# Usage:
#   tooling/seed-durability-rehearsal-data.sh --container NAME [options]
#
# Options:
#   --container NAME   PostgreSQL container to seed (required)
#   --database NAME    default orgistry
#   --user NAME        default orgistry
#   --remove           delete the fixture rows instead of creating them
#   --help
#
# No credential is handled here: statements run through `docker exec` on the
# container's own local socket.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tooling/lib/restore-drill-fixture.sh
source "${REPO_ROOT}/tooling/lib/restore-drill-fixture.sh"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"

CONTAINER=''
DATABASE='orgistry'
DB_USER='orgistry'
REMOVE=0

die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
note() { printf '  ok  %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }
usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --database) DATABASE="${2:-}"; shift 2 ;;
    --user) DB_USER="${2:-}"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown argument \"$1\" (try --help)" ;;
  esac
done

[[ -n "${CONTAINER}" ]] || die '--container is required'
command -v docker >/dev/null 2>&1 || die 'docker is required'
docker inspect "${CONTAINER}" >/dev/null 2>&1 || die "container ${CONTAINER} does not exist"

psql_value() {
  docker exec --interactive "${CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" \
      --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 --command "$1"
}

FIXTURE_USER_IDS="'${DRILL_OWNER_USER_ID}', '${DRILL_MEMBER_USER_ID}'"

if (( REMOVE == 1 )); then
  step 'Removing the durability rehearsal fixture'
  # Ordered so foreign keys are satisfied without relying on cascade behaviour.
  docker exec --interactive "${CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" --no-psqlrc --quiet --set ON_ERROR_STOP=1 <<SQL >/dev/null
BEGIN;
DELETE FROM security_events WHERE id LIKE 'sevt_restore_drill%';
DELETE FROM invitations WHERE id = 'inv_restore_drill';
DELETE FROM api_keys WHERE id = 'key_restore_drill';
DELETE FROM projects WHERE organization_id = '${DRILL_ORG_ID}';
DELETE FROM organization_plans WHERE organization_id = '${DRILL_ORG_ID}';
DELETE FROM memberships WHERE organization_id = '${DRILL_ORG_ID}';
DELETE FROM organizations WHERE id = '${DRILL_ORG_ID}';
DELETE FROM users WHERE id IN (${FIXTURE_USER_IDS});
DELETE FROM app_meta WHERE key IN ('restore_drill_marker', 'pitr_rehearsal_marker', 'pitr_rehearsal_post_target');
COMMIT;
SQL
  note 'fixture rows removed'
  exit 0
fi

step 'Checking that this database holds only synthetic data'
FOREIGN_USERS="$(psql_value "SELECT count(*) FROM users WHERE id NOT IN (${FIXTURE_USER_IDS})" | tr -d '[:space:]')"
[[ "${FOREIGN_USERS}" == '0' ]] \
  || die "this database has ${FOREIGN_USERS} user(s) this fixture did not create — refusing to seed a database that may hold real tenants"
note 'no foreign user rows; the database is synthetic'

step 'Seeding the durability rehearsal fixture'
if [[ "$(psql_value "SELECT count(*) FROM organizations WHERE id = '${DRILL_ORG_ID}'" | tr -d '[:space:]')" != '0' ]]; then
  note 'fixture is already present; nothing to do'
else
  # The API-key hash is DERIVED here rather than committed: a 64-hex literal in
  # the repository is indistinguishable from a real credential to a scanner.
  API_KEY_SECRET_HASH="$(sha256_hex "${DRILL_API_KEY_SECRET}")"
  docker exec --interactive "${CONTAINER}" \
    psql --username "${DB_USER}" --dbname "${DATABASE}" --no-psqlrc --quiet \
      --set "owner_user_id=${DRILL_OWNER_USER_ID}" \
      --set "member_user_id=${DRILL_MEMBER_USER_ID}" \
      --set "org_id=${DRILL_ORG_ID}" \
      --set "org_slug=${DRILL_ORG_SLUG}" \
      --set "project_alpha=${DRILL_PROJECT_NAMES[0]}" \
      --set "project_beta=${DRILL_PROJECT_NAMES[1]}" \
      --set "api_key_display_prefix=${DRILL_API_KEY_DISPLAY_PREFIX}" \
      --set "api_key_secret_hash=${API_KEY_SECRET_HASH}" \
      <"${REPO_ROOT}/tooling/fixtures/restore-drill-seed.sql" >/dev/null
  note 'fixture seeded'
fi

step 'Verifying the seeded fixture'
for check in \
  "users|SELECT count(*) FROM users WHERE id IN (${FIXTURE_USER_IDS})|${DRILL_EXPECTED_USERS}" \
  "organizations|SELECT count(*) FROM organizations WHERE id = '${DRILL_ORG_ID}'|${DRILL_EXPECTED_ORGANIZATIONS}" \
  "memberships|SELECT count(*) FROM memberships WHERE organization_id = '${DRILL_ORG_ID}'|${DRILL_EXPECTED_MEMBERSHIPS}" \
  "projects|SELECT count(*) FROM projects WHERE organization_id = '${DRILL_ORG_ID}'|${DRILL_EXPECTED_PROJECTS}" \
  "api keys|SELECT count(*) FROM api_keys WHERE id = 'key_restore_drill'|${DRILL_EXPECTED_API_KEYS}" \
  "invitations|SELECT count(*) FROM invitations WHERE id = 'inv_restore_drill'|${DRILL_EXPECTED_INVITATIONS}" \
  ; do
  IFS='|' read -r label statement expected <<<"${check}"
  actual="$(psql_value "${statement}" | tr -d '[:space:]')"
  [[ "${actual}" == "${expected}" ]] || die "${label}: expected ${expected}, got ${actual}"
  note "${label} = ${actual}"
done

printf '\nDurability rehearsal fixture is in place.\n'
