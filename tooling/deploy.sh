#!/usr/bin/env bash
#
# Orgistry deployment executor (Sprint 26, ORG-PR-001).
#
# Deploys ONE release manifest to ONE single-host Docker Compose environment,
# in a fixed order, failing the deployment at the first stage that does not
# hold:
#
#   validate inputs
#     -> pre-deployment validation (config, runtime env file, image pull)
#     -> backup / recovery-point preflight
#     -> migrations, exactly once, from the release's own API image
#     -> verify the applied migration head against the manifest
#     -> deploy the API, wait for health
#     -> deploy the web artifact
#     -> wait for readiness
#     -> verify the RUNNING container digests are the manifest digests
#     -> post-deployment smoke (tooling/deploy-smoke.sh)
#     -> write deployment evidence
#
# CONTRACTS THIS SCRIPT ENFORCES (do not weaken):
#   * Deployment is BY DIGEST. Image references come from the release manifest,
#     never from the configuration file, a tag, or a local build; a reference
#     without `@sha256:` is refused.
#   * The target never rebuilds source. infra/compose.deploy.yml contains no
#     build section and this script asserts that before running compose.
#   * Migrations run exactly once per deployment, as their own container, from
#     the same image digest the API will run. A migration failure aborts the
#     deployment before any new application container starts.
#   * Only an AUTHORISED release reaches a real environment. The manifest must
#     declare itself deployable, which the manifest schema only permits for a
#     published release with clean commit provenance whose required checks
#     succeeded for that exact commit. A rehearsal manifest is accepted only by
#     an environment that declares itself a rehearsal.
#   * The browser's PUBLIC configuration is applied by the deployment, not baked
#     into the web image, so the same web digest is promotable between
#     environments. Its identity is recorded in the deployment evidence.
#   * Smoke failure fails the deployment. There is no --skip-smoke.
#   * Every deployment that reached the target is recorded, including failed
#     ones.
#
# WHAT THIS SCRIPT IS NOT: it is not a rollback of the DATABASE. Redeploying an
# earlier release restores earlier CODE only; migrations are forward-only. See
# docs/deployment.md ("Rollback model") before rolling back across a migration.
#
# SECRET HANDLING: runtime secrets live only in the operator's runtime env
# file, which is handed to containers by Compose and read by this script only
# for the two values a deployment itself needs (the database URL for the backup
# preflight and the migration-head verification). No secret is printed, passed
# as a command argument, written into evidence, or exported into the compose
# invocation. `docker compose config` is deliberately never run: it expands
# env_file entries into plaintext.
#
# Usage:
#   tooling/deploy.sh --manifest PATH --config PATH [--no-migrate] [--mode MODE]
#
# Requires: docker (compose v2), curl, node.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG_PREFIX='deploy'
# shellcheck source=tooling/lib/deploy-common.sh
source "${REPO_ROOT}/tooling/lib/deploy-common.sh"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"

COMPOSE_FILE="${REPO_ROOT}/infra/compose.deploy.yml"

MANIFEST_PATH=''
CONFIG_PATH="${ORGISTRY_DEPLOY_CONFIG:-}"
DEPLOY_MODE='deploy'
RUN_MIGRATIONS=1
ACTOR="${ORGISTRY_DEPLOY_ACTOR:-}"

usage() {
  cat <<'USAGE'
Usage: tooling/deploy.sh --manifest PATH --config PATH [options]

  --manifest PATH   Release manifest to deploy (required). Produced by the
                    release workflow or tooling/release-manifest.mjs.
  --config PATH     Deployment configuration file (required, or set
                    ORGISTRY_DEPLOY_CONFIG). Template:
                    infra/deploy.env.example.
  --mode MODE       `deploy` (default) or `rollback`. Recorded in evidence;
                    `rollback` is what tooling/deploy-rollback.sh passes.
  --no-migrate      Do not run migrations. Use ONLY when redeploying a release
                    whose schema is already applied — i.e. an application
                    rollback to an earlier, schema-compatible release.
  --actor NAME      Recorded as the deploying actor (default: the local user).
  --help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    # `pnpm deploy -- --flag` forwards a bare `--`; treat it as the
    # conventional end-of-options marker rather than an unknown argument.
    --) shift ;;
    --manifest) MANIFEST_PATH="${2:-}"; shift 2 ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --mode) DEPLOY_MODE="${2:-}"; shift 2 ;;
    --no-migrate) RUN_MIGRATIONS=0; shift ;;
    --actor) ACTOR="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) deploy_die "unknown argument \"$1\" (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Stage 1 — validate inputs and load the deployment configuration
# ---------------------------------------------------------------------------

deploy_stage 'Validate deployment inputs'
deploy_require_command docker 'the deployment runs containers'
deploy_require_command curl 'health, readiness, and smoke are probed over HTTP'
deploy_require_command node 'the release manifest and the evidence ledger are JSON tools'

[[ -n "${MANIFEST_PATH}" ]] || deploy_die '--manifest is required'
[[ -n "${CONFIG_PATH}" ]] || deploy_die '--config is required (or set ORGISTRY_DEPLOY_CONFIG)'
[[ "${DEPLOY_MODE}" == 'deploy' || "${DEPLOY_MODE}" == 'rollback' ]] \
  || deploy_die "--mode must be deploy or rollback (got \"${DEPLOY_MODE}\")"
deploy_require_file "${MANIFEST_PATH}" 'release manifest'

deploy_load_config "${CONFIG_PATH}"
deploy_require_var ORGISTRY_ENVIRONMENT 'name the environment being deployed to, e.g. staging-like'
deploy_require_var ORGISTRY_RUNTIME_ENV_FILE 'absolute path to the operator runtime configuration file'
deploy_require_var ORGISTRY_EVIDENCE_DIR 'directory holding the deployment evidence ledger'

export ORGISTRY_COMPOSE_PROJECT="${ORGISTRY_COMPOSE_PROJECT:-orgistry}"
export ORGISTRY_DEPLOY_NETWORK="${ORGISTRY_DEPLOY_NETWORK:-orgistry-deploy}"
export ORGISTRY_API_HOST_PORT="${ORGISTRY_API_HOST_PORT:-3000}"
export ORGISTRY_WEB_HOST_PORT="${ORGISTRY_WEB_HOST_PORT:-8080}"
SMOKE_API_URL="${ORGISTRY_SMOKE_API_URL:-http://127.0.0.1:${ORGISTRY_API_HOST_PORT}}"
SMOKE_WEB_URL="${ORGISTRY_SMOKE_WEB_URL:-http://127.0.0.1:${ORGISTRY_WEB_HOST_PORT}}"
BACKUP_PREFLIGHT="${ORGISTRY_BACKUP_PREFLIGHT:-take}"
MIGRATION_VERIFY="${ORGISTRY_MIGRATION_VERIFY:-on}"
ACTOR="${ACTOR:-operator:$(id -un)}"

# `deployment` (the default) accepts only a deployable, published release.
# `rehearsal` is the explicit opt-in that lets a local rehearsal deploy its own
# non-deployable manifest — an environment must ask for that, never inherit it.
ENVIRONMENT_CLASS="${ORGISTRY_ENVIRONMENT_CLASS:-deployment}"
[[ "${ENVIRONMENT_CLASS}" == 'deployment' || "${ENVIRONMENT_CLASS}" == 'rehearsal' ]] \
  || deploy_die "ORGISTRY_ENVIRONMENT_CLASS must be deployment or rehearsal (got \"${ENVIRONMENT_CLASS}\")"

# PUBLIC browser configuration for this environment. It is deployment state, not
# artifact identity: the web image is environment-neutral and reads these at
# runtime, which is what makes one web digest promotable (docs/deployment.md).
deploy_require_var ORGISTRY_PUBLIC_API_BASE_URL 'the browser-facing API origin this environment serves'
export ORGISTRY_PUBLIC_API_BASE_URL
export ORGISTRY_PUBLIC_CSRF_HEADER_NAME="${ORGISTRY_PUBLIC_CSRF_HEADER_NAME:-x-orgistry-csrf}"
export ORGISTRY_PUBLIC_MAILPIT_URL="${ORGISTRY_PUBLIC_MAILPIT_URL:-http://localhost:8025}"

# Smoke checks the origin a BROWSER will use, which is the value the deployment
# just applied — not the address the deploying host happens to reach.
SMOKE_EXPECTED_API_ORIGIN="${ORGISTRY_SMOKE_EXPECTED_API_ORIGIN:-${ORGISTRY_PUBLIC_API_BASE_URL}}"

COMPOSE=(docker compose --file "${COMPOSE_FILE}")

MIGRATION_NOTE=''
if (( RUN_MIGRATIONS == 0 )); then
  MIGRATION_NOTE=' (migrations skipped)'
fi

deploy_info "environment ${ORGISTRY_ENVIRONMENT}"
deploy_info "manifest    ${MANIFEST_PATH}"
deploy_info "mode        ${DEPLOY_MODE}${MIGRATION_NOTE}"

# ---------------------------------------------------------------------------
# Stage 2 — release identity
# ---------------------------------------------------------------------------

deploy_stage 'Validate the release manifest'
node "${REPO_ROOT}/tooling/release-manifest.mjs" validate "${MANIFEST_PATH}" \
  || deploy_die 'the release manifest is invalid; refusing to deploy'

manifest_field() {
  node "${REPO_ROOT}/tooling/release-manifest.mjs" read "${MANIFEST_PATH}" --field "$1"
}

RELEASE_COMMIT="$(manifest_field source.commit)"
API_IMAGE="$(manifest_field images.api.reference)"
WEB_IMAGE="$(manifest_field images.web.reference)"
API_DIGEST="$(manifest_field images.api.digest)"
WEB_DIGEST="$(manifest_field images.web.digest)"
RELEASE_TYPE="$(manifest_field release.type)"
RELEASE_DEPLOYABLE="$(manifest_field release.deployable)"
SOURCE_PROVENANCE="$(manifest_field source.provenance)"
MIGRATION_HEAD="$(manifest_field migrations.head)"
MIGRATION_COUNT="$(manifest_field migrations.count)"
MIGRATION_APPLIED_AT_MS="$(manifest_field migrations.appliedAtMs)"

deploy_require_digest_reference "${API_IMAGE}" 'the API image reference'
deploy_require_digest_reference "${WEB_IMAGE}" 'the web image reference'
export ORGISTRY_API_IMAGE="${API_IMAGE}"
export ORGISTRY_WEB_IMAGE="${WEB_IMAGE}"

deploy_info "release        ${RELEASE_TYPE} (deployable: ${RELEASE_DEPLOYABLE}, ${SOURCE_PROVENANCE} provenance)"
deploy_info "commit         ${RELEASE_COMMIT}"
deploy_info "API image      ${API_IMAGE}"
deploy_info "web image      ${WEB_IMAGE}"
deploy_info "migration head ${MIGRATION_HEAD} (${MIGRATION_COUNT} migrations)"
deploy_info "public API URL ${ORGISTRY_PUBLIC_API_BASE_URL}"

# ---------------------------------------------------------------------------
# Stage 3 — pre-deployment validation
# ---------------------------------------------------------------------------

deploy_stage 'Pre-deployment validation'

# The deployment topology must be incapable of building. This is the static
# half of the build-once invariant; the digest assertions above are the
# dynamic half.
if grep -nE '^[[:space:]]*build:' "${COMPOSE_FILE}" >/dev/null; then
  deploy_die "${COMPOSE_FILE} declares a build section — a deployment target must never rebuild source"
fi

# Release eligibility. A manifest states its own deployability, and the schema
# only grants that to a published release with clean commit provenance whose
# required checks succeeded for that exact commit (tooling/lib/release-manifest.mjs).
# A real environment therefore never needs to re-derive authorization from
# mutable branch state — it reads what was authorised when the release was made.
if [[ "${ENVIRONMENT_CLASS}" == 'deployment' && "${RELEASE_DEPLOYABLE}" != 'true' ]]; then
  deploy_die "this is a ${RELEASE_TYPE} release with ${SOURCE_PROVENANCE} provenance and is NOT deployable; environment \"${ORGISTRY_ENVIRONMENT}\" accepts only a published release authorised by its required checks"
fi
if [[ "${ENVIRONMENT_CLASS}" == 'rehearsal' && "${RELEASE_DEPLOYABLE}" == 'true' ]]; then
  deploy_info 'note: deploying a published release into a rehearsal environment'
fi

deploy_require_file "${ORGISTRY_RUNTIME_ENV_FILE}" 'runtime configuration file'
deploy_assert_runtime_env_protected "${ORGISTRY_RUNTIME_ENV_FILE}"
deploy_assert_runtime_env_complete "${ORGISTRY_RUNTIME_ENV_FILE}" \
  NODE_ENV DATABASE_URL REDIS_URL JWT_SECRET COOKIE_SECURE MAIL_DRIVER \
  SMTP_HOST SMTP_USERNAME SMTP_PASSWORD MAIL_FROM_EMAIL WEB_DEMO_URL CORS_ORIGINS

deploy_info 'runtime configuration present and permission-checked'

# Attaching the network before compose runs lets operator-provided services (a
# database container, a reverse proxy) join the same network independently of
# this project's lifecycle.
if ! docker network inspect "${ORGISTRY_DEPLOY_NETWORK}" >/dev/null 2>&1; then
  docker network create "${ORGISTRY_DEPLOY_NETWORK}" >/dev/null
  deploy_info "created Docker network ${ORGISTRY_DEPLOY_NETWORK}"
fi

deploy_stage 'Pull the released images by digest'
for image in "${API_IMAGE}" "${WEB_IMAGE}"; do
  docker pull --quiet "${image}" >/dev/null \
    || deploy_die "cannot pull ${image} — the release is not available from the registry this host can reach"
done
API_IMAGE_ID="$(deploy_image_id "${API_IMAGE}")"
WEB_IMAGE_ID="$(deploy_image_id "${WEB_IMAGE}")"
deploy_info 'both images resolved from their digests'

# A pull is architecture-agnostic; execution is not. Orgistry publishes
# single-architecture images, so this is the stage that turns "the API
# container did not become healthy" four stages from now into an accurate
# message here — before the backup preflight or a migration has touched the
# database.
deploy_stage 'Verify the images can run on this host'
HOST_PLATFORM="$(deploy_host_platform)"
deploy_assert_image_runs_on_host "${API_IMAGE}" 'API image' "${HOST_PLATFORM}"
deploy_assert_image_runs_on_host "${WEB_IMAGE}" 'web image' "${HOST_PLATFORM}"
if [[ -n "${DEPLOY_EMULATED_PLATFORM}" ]]; then
  deploy_info "proceeding under emulation: ${DEPLOY_EMULATED_PLATFORM}"
else
  deploy_info "both images are native to this host (${HOST_PLATFORM})"
fi

# ---------------------------------------------------------------------------
# Evidence helper — used by every failure path from here on
# ---------------------------------------------------------------------------

# Record a deployment attempt. Called on the success path and on every failure
# path that reached the target, so the ledger reflects what actually happened.
record_deployment() {
  local migration_result="$1" migration_reason="$2" verified_head="$3" applied_count="$4"
  local backup_result="$5" backup_reason="$6" backup_artifact="$7" backup_recovery_point="$8"
  local smoke_result="$9" smoke_checks="${10}"
  local runtime_api_digest="${11}" runtime_web_digest="${12}"

  local arguments=(
    record
    --dir "${ORGISTRY_EVIDENCE_DIR}"
    --environment "${ORGISTRY_ENVIRONMENT}"
    --mode "${DEPLOY_MODE}"
    --actor "${ACTOR}"
    --manifest "${MANIFEST_PATH}"
    --migration-result "${migration_result}"
    --backup-result "${backup_result}"
    --smoke-result "${smoke_result}"
    --runtime-api-digest "${runtime_api_digest}"
    --runtime-web-digest "${runtime_web_digest}"
    --public-api-base-url "${ORGISTRY_PUBLIC_API_BASE_URL}"
    --public-csrf-header-name "${ORGISTRY_PUBLIC_CSRF_HEADER_NAME}"
    --public-mailpit-url "${ORGISTRY_PUBLIC_MAILPIT_URL}"
  )
  # Optional facts are passed only when they exist: an absent value must be
  # absent from the record, never an empty string that reads like a fact.
  if [[ -n "${migration_reason}" ]]; then arguments+=(--migration-reason "${migration_reason}"); fi
  if [[ -n "${verified_head}" ]]; then arguments+=(--migration-verified-head "${verified_head}"); fi
  if [[ -n "${applied_count}" ]]; then arguments+=(--migration-applied-count "${applied_count}"); fi
  if [[ -n "${backup_reason}" ]]; then arguments+=(--backup-reason "${backup_reason}"); fi
  if [[ -n "${backup_artifact}" ]]; then arguments+=(--backup-artifact "${backup_artifact}"); fi
  if [[ -n "${backup_recovery_point}" ]]; then arguments+=(--backup-recovery-point "${backup_recovery_point}"); fi
  if [[ -n "${smoke_checks}" ]]; then arguments+=(--smoke-checks "${smoke_checks}"); fi

  # Limitations travel WITH the evidence so a reader of a single record cannot
  # mistake it for a production-grade deployment guarantee.
  arguments+=(--limitation 'Application rollback restores container digests and redeploys them under the environment CURRENT public configuration; migrations are forward-only and this record is not evidence of database rollback capability.')
  if [[ "${backup_result}" != 'taken' ]]; then
    arguments+=(--limitation 'No pre-deployment backup was taken for this deployment; there is no recovery point associated with it.')
  fi
  if [[ -n "${DEPLOY_EMULATED_PLATFORM}" ]]; then
    arguments+=(--limitation "This deployment runs ${DEPLOY_EMULATED_PLATFORM} under CPU emulation, which no Orgistry validation exercises. Its runtime behaviour and performance are unproven, and this record is NOT evidence that a supported configuration was validated on this host.")
  fi

  node "${REPO_ROOT}/tooling/deploy-evidence.mjs" "${arguments[@]}"
}

# Record a failed attempt without letting an evidence-writing problem mask the
# deployment failure that is about to be reported.
record_failed_deployment() {
  record_deployment "$@" >/dev/null \
    || printf 'WARNING: the deployment evidence record could not be written\n' >&2
}

# ---------------------------------------------------------------------------
# Stage 4 — backup / recovery-point preflight
# ---------------------------------------------------------------------------

BACKUP_RESULT='skipped'
BACKUP_REASON=''
BACKUP_ARTIFACT=''
BACKUP_RECOVERY_POINT=''
DATABASE_URL_VALUE=''

# Read the database URL once, from the runtime env file, for the preflight and
# the migration-head verification. Never printed, never passed as an argument
# to anything but the backup tool's own --database-url (which forwards it to a
# container environment variable, not a command line). A non-zero result means
# the runtime configuration supplies no readable database URL; the stages below
# decide whether that is fatal.
if ! DATABASE_URL_VALUE="$(deploy_read_secret_value "${ORGISTRY_RUNTIME_ENV_FILE}" DATABASE_URL)"; then
  DATABASE_URL_VALUE=''
fi

deploy_stage 'Backup / recovery-point preflight'
if (( RUN_MIGRATIONS == 0 )); then
  BACKUP_RESULT='skipped'
  BACKUP_REASON='This deployment runs no migrations, so it creates no new recovery-point requirement.'
  deploy_info 'skipped — no migrations in this deployment'
elif [[ "${BACKUP_PREFLIGHT}" == 'skip' ]]; then
  # An operator may legitimately rely on provider-managed backups, but the
  # reason has to be recorded — an unexplained skip is indistinguishable from
  # an oversight when someone reads the ledger during an incident.
  BACKUP_RESULT='skipped'
  BACKUP_REASON="${ORGISTRY_BACKUP_SKIP_REASON:-}"
  [[ -n "${BACKUP_REASON}" ]] \
    || deploy_die 'ORGISTRY_BACKUP_PREFLIGHT=skip requires ORGISTRY_BACKUP_SKIP_REASON — an unexplained skip is not acceptable evidence'
  deploy_info "skipped — ${BACKUP_REASON}"
elif [[ "${BACKUP_PREFLIGHT}" != 'take' ]]; then
  deploy_die "ORGISTRY_BACKUP_PREFLIGHT must be \"take\" or \"skip\" (got \"${BACKUP_PREFLIGHT}\")"
elif [[ -z "${DATABASE_URL_VALUE}" ]]; then
  deploy_die 'ORGISTRY_BACKUP_PREFLIGHT=take but no DATABASE_URL (or DATABASE_URL_FILE) is readable from the runtime configuration'
else
  deploy_require_var ORGISTRY_BACKUP_DIR 'ORGISTRY_BACKUP_PREFLIGHT=take needs a destination directory for the pre-deployment backup'
  backup_arguments=(
    --database-url "${DATABASE_URL_VALUE}"
    --output-dir "${ORGISTRY_BACKUP_DIR}"
    --label 'pre-deploy'
  )
  if [[ -n "${ORGISTRY_DATABASE_DOCKER_NETWORK:-}" ]]; then
    backup_arguments+=(--docker-network "${ORGISTRY_DATABASE_DOCKER_NETWORK}")
  fi
  backup_output=''
  if ! backup_output="$(bash "${REPO_ROOT}/tooling/db-backup.sh" "${backup_arguments[@]}")"; then
    # Nothing has been deployed yet, so there is no deployment to record: the
    # target is untouched and the operator must resolve the backup first.
    deploy_die 'the pre-deployment backup failed; the deployment was ABORTED before migrations and the target is unchanged'
  fi
  BACKUP_ARTIFACT="$(basename "$(tail -n 1 <<<"${backup_output}")")"
  BACKUP_RECOVERY_POINT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  BACKUP_RESULT='taken'
  deploy_info "backup ${BACKUP_ARTIFACT} taken; recovery point ${BACKUP_RECOVERY_POINT}"
fi

# ---------------------------------------------------------------------------
# Stage 5 — migrations, exactly once
# ---------------------------------------------------------------------------

MIGRATION_RESULT='skipped'
MIGRATION_REASON=''
VERIFIED_HEAD=''
APPLIED_COUNT=''

deploy_stage 'Database migrations'
if (( RUN_MIGRATIONS == 0 )); then
  MIGRATION_REASON='Migrations were explicitly skipped (--no-migrate): this deployment redeploys a release whose schema is already applied.'
  deploy_info 'skipped by --no-migrate'
else
  # One container, one run, from the release's own API image. The API service
  # never migrates at boot, so no replica can race this.
  if ! "${COMPOSE[@]}" run --rm --no-deps migrate; then
    record_failed_deployment \
      'failed' 'The migration container exited non-zero; no application container was started.' '' '' \
      "${BACKUP_RESULT}" "${BACKUP_REASON}" "${BACKUP_ARTIFACT}" "${BACKUP_RECOVERY_POINT}" \
      'not-run' '' 'none' 'none'
    deploy_die 'migrations failed; the deployment was aborted and the previously running release (if any) is untouched'
  fi
  MIGRATION_RESULT='applied'
  deploy_info 'migration container exited 0'
fi

if [[ "${MIGRATION_VERIFY}" == 'on' && -n "${DATABASE_URL_VALUE}" ]]; then
  deploy_stage 'Verify the applied migration head'
  # Drizzle records one ledger row per applied migration, with `created_at` set
  # to the journal entry's timestamp — so the ledger's row count and newest
  # timestamp identify the applied head exactly, without parsing SQL.
  pg_client_init "${DATABASE_URL_VALUE}" "${ORGISTRY_DATABASE_DOCKER_NETWORK:-}"
  APPLIED_COUNT="$(pg_query 'SELECT count(*) FROM drizzle.__drizzle_migrations' | tr -d '[:space:]')"
  applied_at_ms="$(pg_query "SELECT coalesce(max(created_at)::text, '0') FROM drizzle.__drizzle_migrations" | tr -d '[:space:]')"
  [[ "${APPLIED_COUNT}" == "${MIGRATION_COUNT}" ]] \
    || deploy_die "the database has ${APPLIED_COUNT} applied migrations but the release declares ${MIGRATION_COUNT}"
  [[ "${applied_at_ms}" == "${MIGRATION_APPLIED_AT_MS}" ]] \
    || deploy_die "the database's newest migration timestamp (${applied_at_ms}) does not match the release's head ${MIGRATION_HEAD}"
  VERIFIED_HEAD="${MIGRATION_HEAD}"
  deploy_info "database is at ${MIGRATION_HEAD} (${APPLIED_COUNT} migrations)"
else
  deploy_info 'migration-head verification skipped (ORGISTRY_MIGRATION_VERIFY=off or no reachable database URL)'
fi

# ---------------------------------------------------------------------------
# Stage 6 — deploy the application, in order
# ---------------------------------------------------------------------------

deploy_stage 'Deploy the API'
"${COMPOSE[@]}" up --detach --wait api \
  || deploy_die 'the API container did not become healthy; the deployment is incomplete'

deploy_stage 'Deploy the web artifact'
"${COMPOSE[@]}" up --detach --wait web \
  || deploy_die 'the web container did not start'

deploy_stage 'Wait for health and readiness'
deploy_wait_for_status "${SMOKE_API_URL}/health" 200 60 'API liveness after deployment'
deploy_wait_for_status "${SMOKE_API_URL}/ready" 200 120 'API readiness after deployment'
deploy_info 'API is live and ready'

# ---------------------------------------------------------------------------
# Stage 7 — prove the running containers are the released digests
# ---------------------------------------------------------------------------

deploy_stage 'Verify the running container digests'
verify_running_image() {
  local service="$1" expected_image_id="$2" container_id
  container_id="$("${COMPOSE[@]}" ps --quiet "${service}")"
  [[ -n "${container_id}" ]] || deploy_die "no running container for service \"${service}\""
  local running_image_id
  running_image_id="$(deploy_container_image_id "${container_id}")"
  [[ "${running_image_id}" == "${expected_image_id}" ]] \
    || deploy_die "the running ${service} container is not the released image — expected ${expected_image_id}, found ${running_image_id}"
}
verify_running_image api "${API_IMAGE_ID}"
verify_running_image web "${WEB_IMAGE_ID}"
deploy_info "api runs ${API_DIGEST}"
deploy_info "web runs ${WEB_DIGEST}"

# ---------------------------------------------------------------------------
# Stage 8 — post-deployment smoke
# ---------------------------------------------------------------------------

deploy_stage 'Post-deployment smoke'
smoke_output=''
if ! smoke_output="$(bash "${REPO_ROOT}/tooling/deploy-smoke.sh" \
  --api-url "${SMOKE_API_URL}" \
  --web-url "${SMOKE_WEB_URL}" \
  --expected-api-origin "${SMOKE_EXPECTED_API_ORIGIN}" 2>&1)"; then
  printf '%s\n' "${smoke_output}" >&2
  record_failed_deployment \
    "${MIGRATION_RESULT}" "${MIGRATION_REASON}" "${VERIFIED_HEAD}" "${APPLIED_COUNT}" \
    "${BACKUP_RESULT}" "${BACKUP_REASON}" "${BACKUP_ARTIFACT}" "${BACKUP_RECOVERY_POINT}" \
    'failed' '' "${API_DIGEST}" "${WEB_DIGEST}"
  deploy_die 'post-deployment smoke failed; the deployment is recorded as failed and must be rolled back or fixed forward'
fi
printf '%s\n' "${smoke_output}"
SMOKE_CHECKS="$(grep -oE 'DEPLOY SMOKE OK: [0-9]+' <<<"${smoke_output}" | grep -oE '[0-9]+' || true)"

# ---------------------------------------------------------------------------
# Stage 9 — evidence
# ---------------------------------------------------------------------------

deploy_stage 'Record deployment evidence'
RECORD_PATH="$(record_deployment \
  "${MIGRATION_RESULT}" "${MIGRATION_REASON}" "${VERIFIED_HEAD}" "${APPLIED_COUNT}" \
  "${BACKUP_RESULT}" "${BACKUP_REASON}" "${BACKUP_ARTIFACT}" "${BACKUP_RECOVERY_POINT}" \
  'passed' "${SMOKE_CHECKS}" "${API_DIGEST}" "${WEB_DIGEST}")"
deploy_info "evidence ${RECORD_PATH}"

# No rollback target is a legitimate state with two causes: this is the first
# known-good deployment here, or every earlier release has already been rolled
# away from. Either way the operator's next option is fix-forward or recovery,
# so say that rather than implying a rollback is available.
rollback_summary='NONE AVAILABLE — fix forward or recover (docs/deployment.md, "Rollback model")'
if resolved_rollback_image="$(node "${REPO_ROOT}/tooling/deploy-evidence.mjs" rollback-target \
  --dir "${ORGISTRY_EVIDENCE_DIR}" --environment "${ORGISTRY_ENVIRONMENT}" --field apiImage 2>/dev/null)"; then
  rollback_summary="${resolved_rollback_image}"
fi

cat <<SUMMARY

DEPLOY OK — ${ORGISTRY_ENVIRONMENT}
  commit          ${RELEASE_COMMIT}
  api             ${API_IMAGE}
  web             ${WEB_IMAGE}
  migrations      ${MIGRATION_RESULT}${VERIFIED_HEAD:+ (verified head ${VERIFIED_HEAD})}
  backup          ${BACKUP_RESULT}${BACKUP_RECOVERY_POINT:+ at ${BACKUP_RECOVERY_POINT}}
  public config   ${ORGISTRY_PUBLIC_API_BASE_URL}
  smoke           passed (${SMOKE_CHECKS:-0} checks)
  evidence        ${RECORD_PATH}
  rollback target ${rollback_summary}
SUMMARY
