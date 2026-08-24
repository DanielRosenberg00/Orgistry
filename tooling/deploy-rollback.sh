#!/usr/bin/env bash
#
# Application rollback (Sprint 26, ORG-PR-001).
#
# Redeploys the previous KNOWN-GOOD release into an environment: the most
# recent recorded deployment, other than the one currently deployed, whose
# post-deployment smoke passed. The digests come from that deployment's own
# release manifest, which tooling/deploy.sh copied onto this host when it was
# deployed — so a rollback needs no registry API, no expired workflow artifact,
# and no operator remembering a commit SHA.
#
# SCOPE: this restores IMAGE DIGESTS. The environment's public browser
# configuration is applied fresh from the deployment configuration file, so a
# rollback across a configuration change restores the old code under the new
# configuration; the resolved target's recorded configuration is printed so that
# is a visible decision rather than a silent one. Rolling configuration back is
# a separate operation (docs/deployment.md, "Rollback model").
#
# THIS IS AN APPLICATION ROLLBACK. IT IS NOT A DATABASE ROLLBACK.
# Migrations are forward-only; there are no down migrations. Redeploying older
# containers restores older CODE against the CURRENT schema. That is safe only
# when the older code tolerates the newer schema — normally true for additive
# migrations, and false the moment a migration drops or rewrites something the
# old code reads. Undoing a schema change is a RECOVERY operation (restore or
# PITR), not a rollback. Read docs/deployment.md ("Rollback model") before
# rolling back across a migration boundary.
#
# Because of that, this script deliberately runs the deployment with
# --no-migrate: rolling back must never re-run a migration step, and it can
# never un-run one.
#
# Usage:
#   tooling/deploy-rollback.sh --config PATH [--dry-run] [--actor NAME]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG_PREFIX='deploy-rollback'
# shellcheck source=tooling/lib/deploy-common.sh
source "${REPO_ROOT}/tooling/lib/deploy-common.sh"

CONFIG_PATH="${ORGISTRY_DEPLOY_CONFIG:-}"
DRY_RUN=0
ACTOR_ARGUMENTS=()

usage() {
  cat <<'USAGE'
Usage: tooling/deploy-rollback.sh --config PATH [options]

  --config PATH   Deployment configuration file (required, or set
                  ORGISTRY_DEPLOY_CONFIG). Must be the same file used for the
                  deployment being rolled back.
  --dry-run       Print the resolved rollback target and exit without
                  deploying anything.
  --actor NAME    Recorded as the deploying actor.
  --help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    # `pnpm deploy -- --flag` forwards a bare `--`; treat it as the
    # conventional end-of-options marker rather than an unknown argument.
    --) shift ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --actor) ACTOR_ARGUMENTS=(--actor "${2:-}"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) deploy_die "unknown argument \"$1\" (try --help)" ;;
  esac
done

deploy_stage 'Resolve the rollback target'
[[ -n "${CONFIG_PATH}" ]] || deploy_die '--config is required (or set ORGISTRY_DEPLOY_CONFIG)'
deploy_require_command node 'the deployment evidence ledger is a JSON tool'
deploy_load_config "${CONFIG_PATH}"
deploy_require_var ORGISTRY_ENVIRONMENT 'the environment whose ledger holds the rollback target'
deploy_require_var ORGISTRY_EVIDENCE_DIR 'the deployment evidence ledger directory'

if ! current_commit="$(node "${REPO_ROOT}/tooling/deploy-evidence.mjs" current \
  --dir "${ORGISTRY_EVIDENCE_DIR}" --environment "${ORGISTRY_ENVIRONMENT}" --field release.commit 2>/dev/null)"; then
  deploy_die "no deployment has been recorded for environment \"${ORGISTRY_ENVIRONMENT}\"; there is nothing to roll back"
fi

# The resolution logic lives in one place (tooling/lib/deploy-evidence.mjs) and
# is read one named field at a time. Nothing is `eval`ed: a value from the
# ledger can never be interpreted as a command.
rollback_field() {
  node "${REPO_ROOT}/tooling/deploy-evidence.mjs" rollback-target \
    --dir "${ORGISTRY_EVIDENCE_DIR}" --environment "${ORGISTRY_ENVIRONMENT}" --field "$1"
}

rollback_commit="$(rollback_field commit)"
rollback_manifest="$(rollback_field manifestPath)"
rollback_api_image="$(rollback_field apiImage)"
rollback_web_image="$(rollback_field webImage)"
rollback_deployed_at="$(rollback_field deployedAt)"
rollback_public_api_url="$(rollback_field publicApiBaseUrl)"

deploy_info "environment      ${ORGISTRY_ENVIRONMENT}"
deploy_info "currently deployed commit ${current_commit}"
deploy_info "rollback target  ${rollback_commit} (deployed ${rollback_deployed_at})"
deploy_info "api              ${rollback_api_image}"
deploy_info "web              ${rollback_web_image}"
deploy_info "manifest         ${rollback_manifest}"
deploy_info "public API URL when that release ran: ${rollback_public_api_url}"

# An application rollback restores IMAGE DIGESTS. It redeploys them under the
# environment's CURRENT public configuration, which may differ from the
# configuration that release originally ran with. Saying so is the difference
# between an intentional rollback and two simultaneous changes.
current_public_api_url="${ORGISTRY_PUBLIC_API_BASE_URL:-}"
if [[ -n "${current_public_api_url}" && "${current_public_api_url}" != "${rollback_public_api_url}" ]]; then
  deploy_info "NOTE: the environment's public API origin is now ${current_public_api_url}; the rollback will apply the CURRENT configuration, not the one recorded above"
fi

if (( DRY_RUN == 1 )); then
  printf '\nDry run: nothing was deployed.\n'
  exit 0
fi

cat <<'WARNING'

  ROLLBACK SCOPE: this restores APPLICATION containers only.
  Migrations are forward-only. If any migration applied since the target
  release removed or rewrote something the target release reads, this rollback
  will not fix the incident — recovery from a schema change is a restore or a
  point-in-time recovery (docs/backup-and-restore.md, docs/pitr.md).

WARNING

deploy_stage 'Redeploy the previous known-good release'
exec bash "${REPO_ROOT}/tooling/deploy.sh" \
  --manifest "${rollback_manifest}" \
  --config "${CONFIG_PATH}" \
  --mode rollback \
  --no-migrate \
  ${ACTOR_ARGUMENTS[@]+"${ACTOR_ARGUMENTS[@]}"}
