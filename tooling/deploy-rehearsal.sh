#!/usr/bin/env bash
#
# Deployment rehearsal (Sprint 26, ORG-PR-001).
#
# Executes the ENTIRE promotion and deployment lifecycle end to end, on one
# machine, against a throwaway OCI registry and throwaway backing services:
#
#   build once -> push -> capture digests -> release manifest -> deploy by
#   digest -> migrate once -> health/readiness -> post-deployment smoke ->
#   deployment evidence -> deploy a SECOND release -> roll back to the previous
#   known-good digests -> verify what is actually running
#
# WHY THIS EXISTS
# Orgistry has no staging environment and no reachable deployment target (see
# docs/deployment.md, "Deployment target decision"). Every repository-controlled
# deployment invariant is nevertheless testable, and an untested deployment
# script is not a deployment capability. This rehearsal is the evidence that the
# mechanics work; it is NOT evidence that Orgistry has an environment.
#
# WHAT THIS IS NOT
#   * Not staging, and not a staging-like environment. It is a local rehearsal
#     on a workstation or CI runner: throwaway database, throwaway registry,
#     fake credentials, no TLS, no reverse proxy, no persistence, no real users.
#   * Not a release. Every manifest it produces is `release.type: rehearsal`,
#     `deployable: false`, and carries NO gate evidence — a real environment
#     refuses it. When the working tree is dirty the manifest also records
#     `provenance: working-tree` plus a fingerprint of that tree, because the
#     images are then NOT the bytes of the recorded commit. Nothing here may be
#     cited as evidence about a commit.
#   * Not evidence about GitHub Container Registry. The publishing MECHANICS are
#     the same; GHCR authentication, package visibility, and retention are not
#     exercised here (.github/workflows/release.yml owns those).
#   * Not a performance or capacity rehearsal.
#
# THE TWO REHEARSAL RELEASES
# Both are built from the same source, differing only by an image LABEL. That is
# deliberate: the point is to prove the deployment switches between two distinct
# DIGESTS and can return to the earlier one — not to test application behavior,
# which the artifact smoke test and the test suites already cover. Both releases
# are pushed under the SAME tag, which also demonstrates why a tag is never
# authoritative here: the tag moves, and both digests stay independently
# deployable.
#
# Requires: docker (compose v2), node, curl. Uses host ports 5001, 3100, 8180.
# Everything it creates is removed on exit, including the temporary runtime
# configuration file holding the fake credentials.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG_PREFIX='deploy-rehearsal'
# shellcheck source=tooling/lib/deploy-common.sh
source "${REPO_ROOT}/tooling/lib/deploy-common.sh"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"

# ---- Fixed rehearsal topology --------------------------------------------

# Image policy (ORG-PR-042): exact patch tag + manifest-list digest, like every
# other image reference in this repository.
REGISTRY_IMAGE='registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e'
REDIS_IMAGE='redis:7.4.10-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2'

ENVIRONMENT_NAME='rehearsal-local'
COMPOSE_PROJECT='orgistry-rehearsal'
NETWORK_NAME='orgistry-rehearsal'
REGISTRY_CONTAINER='orgistry-rehearsal-registry'
POSTGRES_CONTAINER='orgistry-rehearsal-postgres'
REDIS_CONTAINER='orgistry-rehearsal-redis'
POSTGRES_VOLUME='orgistry-rehearsal-pgdata'

REGISTRY_HOST_PORT=5001
REGISTRY_HOST="127.0.0.1:${REGISTRY_HOST_PORT}"
API_HOST_PORT=3100
WEB_HOST_PORT=8180
API_URL="http://127.0.0.1:${API_HOST_PORT}"
WEB_URL="http://127.0.0.1:${WEB_HOST_PORT}"

API_REPOSITORY="${REGISTRY_HOST}/orgistry-api"
WEB_REPOSITORY="${REGISTRY_HOST}/orgistry-web"

# A second public API origin, used to prove that the SAME release digests are
# promotable to an environment with different public configuration. It is never
# contacted — only the browser configuration the deployment serves is checked.
PROMOTED_API_ORIGIN='https://api.promoted.rehearsal.orgistry.dev'

# Fake, throwaway credentials. They follow the repository's placeholder
# convention (docs/runtime-secrets.md): shaped like real values so the
# production config guard treats them realistically, with an unmistakable
# non-secret marker. They exist only inside this run's temporary files.
FAKE_JWT_SECRET='orgistry-rehearsal-jwt-not-a-real-secret-orgistry-rehearsal'
FAKE_SMTP_PASSWORD='orgistry-rehearsal-smtp-not-a-real-credential'

WORK_DIR=''

cleanup() {
  deploy_stage 'Cleanup'
  # Application containers first, then the backing services, then the network.
  # The name filter also catches the one-shot migration container, whose name
  # Compose generates per run.
  local project_containers
  project_containers="$(docker ps --all --quiet --filter "name=^${COMPOSE_PROJECT}-" 2>/dev/null || true)"
  if [[ -n "${project_containers}" ]]; then
    # shellcheck disable=SC2086 # container IDs are whitespace-separated by design
    docker rm --force ${project_containers} >/dev/null 2>&1 || true
  fi
  docker rm --force "${POSTGRES_CONTAINER}" "${REDIS_CONTAINER}" "${REGISTRY_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm --force "${POSTGRES_VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true
  # The temporary tree holds the fake runtime credentials and every backup the
  # preflight took; neither outlives the run.
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
  return 0
}
trap cleanup EXIT

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "${actual}" == "${expected}" ]] \
    || deploy_die "${label}: expected \"${expected}\", observed \"${actual}\""
  printf '   ok  %s\n' "${label}"
}

# Port conflicts are the most common local failure in this repository (see
# docs/runbook.md), so they are diagnosed up front rather than as a confusing
# container bind error twenty steps later.
require_free_port() {
  local port="$1" purpose="$2"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    exec 3>&-
    deploy_die "port ${port} is already in use; the rehearsal needs it for ${purpose} (stop the other process first)"
  fi
}

# ---------------------------------------------------------------------------

deploy_stage 'Preflight'
deploy_require_command docker 'the rehearsal builds, publishes, and runs containers'
deploy_require_command node 'the release manifest and evidence ledger are JSON tools'
deploy_require_command curl 'health, readiness, and smoke are probed over HTTP'
deploy_require_command git 'the release identity is the current commit'
require_free_port "${REGISTRY_HOST_PORT}" 'the throwaway registry'
require_free_port "${API_HOST_PORT}" 'the deployed API'
require_free_port "${WEB_HOST_PORT}" 'the deployed web artifact'

RELEASE_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
RELEASE_REF="$(git -C "${REPO_ROOT}" symbolic-ref --quiet HEAD || printf 'detached')"

# A fingerprint of the UNCOMMITTED tree: the base commit, the porcelain status,
# the diff against HEAD, and the contents of untracked files. It is an identity
# for "these exact working-tree bytes", not a reproducible build identifier —
# its only job is to stop a dirty rehearsal from being described by a commit SHA
# that does not contain the code that was built.
working_tree_digest() {
  # A subshell so the directory change cannot leak into the rest of the run;
  # untracked paths are then readable exactly as git reports them.
  (
    cd "${REPO_ROOT}" || exit 1
    git rev-parse HEAD
    git status --porcelain
    git diff HEAD
    local untracked
    while IFS= read -r -d '' untracked; do
      printf '%s\n' "${untracked}"
      cat "${untracked}"
    done < <(git ls-files --others --exclude-standard -z)
  ) | sha256_stream
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# Provenance is decided here, once, and every manifest in this run inherits it.
SOURCE_PROVENANCE='commit'
WORKING_TREE_DIGEST=''
if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
  SOURCE_PROVENANCE='working-tree'
  WORKING_TREE_DIGEST="sha256:$(working_tree_digest)"
fi

deploy_info "base commit    ${RELEASE_COMMIT}"
deploy_info "provenance     ${SOURCE_PROVENANCE}"
if [[ "${SOURCE_PROVENANCE}" == 'working-tree' ]]; then
  deploy_info "working tree   ${WORKING_TREE_DIGEST}"
  deploy_info 'the images below are built from the WORKING TREE, not from the commit above;'
  deploy_info 'every manifest records that, and no real environment will deploy them'
fi

WORK_DIR="$(mktemp -d)"
RUNTIME_ENV_FILE="${WORK_DIR}/runtime.env"
DEPLOY_CONFIG_FILE="${WORK_DIR}/deploy.env"
EVIDENCE_DIR="${WORK_DIR}/deployments"
BACKUP_DIR="${WORK_DIR}/backups"
mkdir -p "${EVIDENCE_DIR}" "${BACKUP_DIR}"

deploy_stage 'Start the throwaway registry and backing services'
docker network create "${NETWORK_NAME}" >/dev/null
docker run --detach --name "${REGISTRY_CONTAINER}" \
  --publish "127.0.0.1:${REGISTRY_HOST_PORT}:5000" \
  "${REGISTRY_IMAGE}" >/dev/null
# PostgreSQL and Redis stand in for the operator-provided managed services a
# real deployment uses. They are NOT part of the deployment topology
# (infra/compose.deploy.yml deploys only Orgistry's own artifacts).
pg_start_server "${POSTGRES_CONTAINER}" "${NETWORK_NAME}" "${POSTGRES_VOLUME}"
docker run --detach --name "${REDIS_CONTAINER}" --network "${NETWORK_NAME}" \
  "${REDIS_IMAGE}" >/dev/null
DATABASE_URL_VALUE="$(pg_drill_url "${POSTGRES_CONTAINER}")"
pg_client_init "${DATABASE_URL_VALUE}" "${NETWORK_NAME}"
pg_wait_ready 60 'rehearsal PostgreSQL'
deploy_info 'registry, PostgreSQL, and Redis are up'

deploy_stage 'Write the rehearsal deployment configuration'
# The runtime configuration file carries every runtime secret, so it is created
# with 0600 from the start — the same rule tooling/deploy.sh enforces on a real
# deployment host.
umask 077
cat >"${RUNTIME_ENV_FILE}" <<RUNTIME_ENV
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=3000
LOG_LEVEL=info
DATABASE_URL=${DATABASE_URL_VALUE}
REDIS_URL=redis://${REDIS_CONTAINER}:6379
JWT_SECRET=${FAKE_JWT_SECRET}
COOKIE_SECURE=true
MAIL_DRIVER=smtp
SMTP_HOST=smtp.invalid
SMTP_PORT=465
SMTP_USERNAME=orgistry-rehearsal-mailer
SMTP_PASSWORD=${FAKE_SMTP_PASSWORD}
MAIL_FROM_EMAIL=no-reply@rehearsal.orgistry.dev
MAIL_FROM_NAME=Orgistry
WEB_DEMO_URL=https://web.rehearsal.orgistry.dev
CORS_ORIGINS=https://web.rehearsal.orgistry.dev
TRUST_PROXY=false
RUNTIME_ENV
umask 022

cat >"${DEPLOY_CONFIG_FILE}" <<DEPLOY_CONFIG
ORGISTRY_ENVIRONMENT=${ENVIRONMENT_NAME}
ORGISTRY_COMPOSE_PROJECT=${COMPOSE_PROJECT}
ORGISTRY_RUNTIME_ENV_FILE=${RUNTIME_ENV_FILE}
ORGISTRY_EVIDENCE_DIR=${EVIDENCE_DIR}
ORGISTRY_DEPLOY_NETWORK=${NETWORK_NAME}
ORGISTRY_API_BIND=127.0.0.1
ORGISTRY_API_HOST_PORT=${API_HOST_PORT}
ORGISTRY_WEB_BIND=127.0.0.1
ORGISTRY_WEB_HOST_PORT=${WEB_HOST_PORT}
ORGISTRY_SMOKE_API_URL=${API_URL}
ORGISTRY_SMOKE_WEB_URL=${WEB_URL}
ORGISTRY_PUBLIC_API_BASE_URL=${API_URL}
ORGISTRY_ENVIRONMENT_CLASS=rehearsal
ORGISTRY_BACKUP_PREFLIGHT=take
ORGISTRY_BACKUP_DIR=${BACKUP_DIR}
ORGISTRY_DATABASE_DOCKER_NETWORK=${NETWORK_NAME}
ORGISTRY_MIGRATION_VERIFY=on
DEPLOY_CONFIG
deploy_info "configuration written under ${WORK_DIR}"

# ---- Release construction -------------------------------------------------

# Build, publish, and describe one release. The label is the ONLY difference
# between the two rehearsal releases (see the header), which is what gives them
# distinct digests from identical source.
build_and_publish_release() {
  local release_name="$1" manifest_path="$2"

  deploy_stage "Build release ${release_name} (build once)"
  docker build \
    --file "${REPO_ROOT}/apps/api/Dockerfile" \
    --tag "${API_REPOSITORY}:${RELEASE_COMMIT}" \
    --label "org.orgistry.rehearsal-release=${release_name}" \
    "${REPO_ROOT}" >/dev/null
  # No build argument carries environment identity: the deployed API origin is
  # applied at container start, which is what makes this digest promotable.
  docker build \
    --file "${REPO_ROOT}/apps/web-demo/Dockerfile" \
    --tag "${WEB_REPOSITORY}:${RELEASE_COMMIT}" \
    --label "org.orgistry.rehearsal-release=${release_name}" \
    "${REPO_ROOT}" >/dev/null

  deploy_stage "Publish release ${release_name} and capture digests"
  docker push --quiet "${API_REPOSITORY}:${RELEASE_COMMIT}" >/dev/null
  docker push --quiet "${WEB_REPOSITORY}:${RELEASE_COMMIT}" >/dev/null

  local api_digest web_digest
  api_digest="$(published_digest "${API_REPOSITORY}")"
  web_digest="$(published_digest "${WEB_REPOSITORY}")"

  local provenance_arguments=(--provenance "${SOURCE_PROVENANCE}")
  if [[ "${SOURCE_PROVENANCE}" == 'working-tree' ]]; then
    provenance_arguments+=(--working-tree-digest "${WORKING_TREE_DIGEST}")
  fi

  # `--release-type rehearsal` is not a label: the schema makes such a manifest
  # non-deployable and forbids it from carrying gate evidence, so it can never
  # be mistaken for — or used as — a real release.
  node "${REPO_ROOT}/tooling/release-manifest.mjs" generate \
    --output "${manifest_path}" \
    --release-type rehearsal \
    "${provenance_arguments[@]}" \
    --commit "${RELEASE_COMMIT}" \
    --ref "${RELEASE_REF}" \
    --api-repository "${API_REPOSITORY}" \
    --api-digest "${api_digest}" \
    --web-repository "${WEB_REPOSITORY}" \
    --web-digest "${web_digest}" \
    --artifact-smoke not-run >/dev/null
  deploy_info "manifest ${manifest_path}"
  deploy_info "api ${api_digest}"
  deploy_info "web ${web_digest}"
}

# The registry digest of the image currently tagged with the release commit.
# `RepoDigests` can hold entries for several repositories, so the one for this
# repository is selected explicitly rather than by position.
published_digest() {
  local repository="$1" entry
  entry="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "${repository}:${RELEASE_COMMIT}" | grep "^${repository}@" | head -n 1 || true)"
  [[ -n "${entry}" ]] || deploy_die "no published digest for ${repository}:${RELEASE_COMMIT} — did the push succeed?"
  printf '%s' "${entry#*@}"
}

manifest_field() {
  node "${REPO_ROOT}/tooling/release-manifest.mjs" read "$1" --field "$2"
}

evidence_field() {
  node "${REPO_ROOT}/tooling/deploy-evidence.mjs" current \
    --dir "${EVIDENCE_DIR}" --environment "${ENVIRONMENT_NAME}" --field "$1"
}

# The digest the deployed container is ACTUALLY running, read from Docker
# rather than from our own records.
running_digest_matches() {
  local service="$1" expected_reference="$2" container_id running_image_id
  container_id="$(docker ps --quiet --filter "name=^${COMPOSE_PROJECT}-${service}-1$")"
  [[ -n "${container_id}" ]] || deploy_die "no running container for ${service}"
  running_image_id="$(deploy_container_image_id "${container_id}")"
  assert_equals "${running_image_id}" "$(deploy_image_id "${expected_reference}")" \
    "running ${service} container is the released image"
}

# ---- Negative checks ------------------------------------------------------

MANIFEST_A="${WORK_DIR}/release-a.json"
MANIFEST_B="${WORK_DIR}/release-b.json"

build_and_publish_release a "${MANIFEST_A}"

deploy_stage 'A tag-pinned manifest is refused'
# Promotion by tag is the failure mode this whole model exists to prevent, so
# the guard is exercised rather than assumed.
TAG_MANIFEST="${WORK_DIR}/release-tag-pinned.json"
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  manifest.images.api.reference = `${manifest.images.api.repository}:${manifest.images.api.tag}`;
  writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2));
' "${MANIFEST_A}" "${TAG_MANIFEST}"
if node "${REPO_ROOT}/tooling/release-manifest.mjs" validate "${TAG_MANIFEST}" >/dev/null 2>&1; then
  deploy_die 'a manifest whose image reference is tag-pinned was accepted as valid'
fi
printf '   ok  %s\n' 'manifest validation rejects a tag-pinned image reference'

deploy_stage 'A rehearsal release is refused by a real deployment environment'
# The provenance boundary. This same manifest deploys fine into this rehearsal
# environment; a `deployment`-class environment must refuse it, because it is
# not a published release authorised by the required checks.
DEPLOYMENT_CLASS_CONFIG="${WORK_DIR}/deploy-as-real-environment.env"
sed 's/^ORGISTRY_ENVIRONMENT_CLASS=.*/ORGISTRY_ENVIRONMENT_CLASS=deployment/' \
  "${DEPLOY_CONFIG_FILE}" >"${DEPLOYMENT_CLASS_CONFIG}"
refusal_output=''
if refusal_output="$(bash "${REPO_ROOT}/tooling/deploy.sh" \
  --manifest "${MANIFEST_A}" --config "${DEPLOYMENT_CLASS_CONFIG}" 2>&1)"; then
  deploy_die 'a non-deployable rehearsal release was accepted by a deployment-class environment'
fi
grep -q 'NOT deployable' <<<"${refusal_output}" \
  || deploy_die "the refusal did not name the deployability reason: ${refusal_output}"
printf '   ok  %s\n' 'a rehearsal release cannot be deployed to a real environment'

deploy_stage 'A published release cannot claim working-tree provenance'
# The other half of the boundary, checked at the schema level: no manifest may
# be simultaneously deployable and built from uncommitted bytes.
FORGED_RELEASE_MANIFEST="${WORK_DIR}/release-forged-published.json"
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  manifest.release = { type: "published", deployable: true };
  writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2));
' "${MANIFEST_A}" "${FORGED_RELEASE_MANIFEST}"
if node "${REPO_ROOT}/tooling/release-manifest.mjs" validate "${FORGED_RELEASE_MANIFEST}" >/dev/null 2>&1; then
  deploy_die 'a rehearsal manifest relabelled as a published release was accepted as valid'
fi
printf '   ok  %s\n' 'a rehearsal manifest relabelled as published is refused by validation'

deploy_stage 'A group-readable runtime configuration file is refused'
chmod 0644 "${RUNTIME_ENV_FILE}"
if bash "${REPO_ROOT}/tooling/deploy.sh" --manifest "${MANIFEST_A}" --config "${DEPLOY_CONFIG_FILE}" >/dev/null 2>&1; then
  deploy_die 'the deployment proceeded with a group-readable runtime configuration file'
fi
chmod 0600 "${RUNTIME_ENV_FILE}"
printf '   ok  %s\n' 'deployment refuses a runtime configuration file that is not 0600'

# ---- Deployment 1: release A ---------------------------------------------

deploy_stage 'Deploy release A'
bash "${REPO_ROOT}/tooling/deploy.sh" \
  --manifest "${MANIFEST_A}" \
  --config "${DEPLOY_CONFIG_FILE}" \
  --actor 'rehearsal'

API_DIGEST_A="$(manifest_field "${MANIFEST_A}" images.api.digest)"
WEB_DIGEST_A="$(manifest_field "${MANIFEST_A}" images.web.digest)"

deploy_stage 'Verify release A is what is deployed'
assert_equals "$(evidence_field smoke.result)" 'passed' 'evidence records a passed smoke'
assert_equals "$(evidence_field migration.result)" 'applied' 'evidence records applied migrations'
assert_equals "$(evidence_field migration.verifiedHead)" \
  "$(manifest_field "${MANIFEST_A}" migrations.head)" 'evidence records the verified migration head'
assert_equals "$(evidence_field backupPreflight.result)" 'taken' 'evidence records a pre-deployment backup'
assert_equals "$(evidence_field runtimeDigests.api)" "${API_DIGEST_A}" 'evidence records the running API digest'
assert_equals "$(evidence_field runtimeDigests.web)" "${WEB_DIGEST_A}" 'evidence records the running web digest'
running_digest_matches api "$(manifest_field "${MANIFEST_A}" images.api.reference)"
running_digest_matches web "$(manifest_field "${MANIFEST_A}" images.web.reference)"

# ---- Promotion: the SAME digests, a different public configuration --------

deploy_stage 'The same release digests are promotable to a different public API origin'
# The correction this rehearsal exists to prove: no rebuild, no new digest —
# only deployment configuration changes between "environments".
PROMOTED_CONFIG_FILE="${WORK_DIR}/deploy-promoted.env"
sed "s|^ORGISTRY_PUBLIC_API_BASE_URL=.*|ORGISTRY_PUBLIC_API_BASE_URL=${PROMOTED_API_ORIGIN}|" \
  "${DEPLOY_CONFIG_FILE}" >"${PROMOTED_CONFIG_FILE}"
bash "${REPO_ROOT}/tooling/deploy.sh" \
  --manifest "${MANIFEST_A}" \
  --config "${PROMOTED_CONFIG_FILE}" \
  --no-migrate \
  --actor 'rehearsal'

assert_equals "$(evidence_field publicConfig.values.apiBaseUrl)" "${PROMOTED_API_ORIGIN}" \
  'evidence records the promoted public API origin'
assert_equals "$(evidence_field runtimeDigests.api)" "${API_DIGEST_A}" \
  'the promoted deployment runs the SAME api digest'
assert_equals "$(evidence_field runtimeDigests.web)" "${WEB_DIGEST_A}" \
  'the promoted deployment runs the SAME web digest'
running_digest_matches web "$(manifest_field "${MANIFEST_A}" images.web.reference)"

# ---- Deployment 2: release B ---------------------------------------------

build_and_publish_release b "${MANIFEST_B}"
API_DIGEST_B="$(manifest_field "${MANIFEST_B}" images.api.digest)"
WEB_DIGEST_B="$(manifest_field "${MANIFEST_B}" images.web.digest)"
[[ "${API_DIGEST_B}" != "${API_DIGEST_A}" ]] \
  || deploy_die 'the two rehearsal releases produced the same API digest; the rollback check would prove nothing'

deploy_stage 'Deploy release B over release A'
# Migrations run again deliberately: a repeated deployment must be safe, and an
# already-applied baseline must be a no-op that still verifies the head.
bash "${REPO_ROOT}/tooling/deploy.sh" \
  --manifest "${MANIFEST_B}" \
  --config "${DEPLOY_CONFIG_FILE}" \
  --actor 'rehearsal'

deploy_stage 'Verify release B replaced release A'
assert_equals "$(evidence_field runtimeDigests.api)" "${API_DIGEST_B}" 'evidence records release B (api)'
assert_equals "$(evidence_field runtimeDigests.web)" "${WEB_DIGEST_B}" 'evidence records release B (web)'
assert_equals "$(evidence_field rollbackTarget.apiReference)" \
  "$(manifest_field "${MANIFEST_A}" images.api.reference)" 'evidence names release A as the rollback target'
running_digest_matches api "$(manifest_field "${MANIFEST_B}" images.api.reference)"
running_digest_matches web "$(manifest_field "${MANIFEST_B}" images.web.reference)"

# ---- Rollback to the previous known-good release -------------------------

deploy_stage 'Roll back to the previous known-good release'
bash "${REPO_ROOT}/tooling/deploy-rollback.sh" \
  --config "${DEPLOY_CONFIG_FILE}" \
  --actor 'rehearsal'

deploy_stage 'Verify the rollback restored release A'
assert_equals "$(evidence_field mode)" 'rollback' 'evidence records the deployment mode as rollback'
assert_equals "$(evidence_field migration.result)" 'skipped' 'a rollback runs no migrations'
assert_equals "$(evidence_field smoke.result)" 'passed' 'smoke passed after the rollback'
assert_equals "$(evidence_field runtimeDigests.api)" "${API_DIGEST_A}" 'the API is back on release A'
assert_equals "$(evidence_field runtimeDigests.web)" "${WEB_DIGEST_A}" 'the web artifact is back on release A'
running_digest_matches api "$(manifest_field "${MANIFEST_A}" images.api.reference)"
running_digest_matches web "$(manifest_field "${MANIFEST_A}" images.web.reference)"

deploy_stage 'Verify the evidence ledger is self-contained'
# Every deployed release's manifest must remain on the host, or a future
# rollback would depend on a registry API or an expired workflow artifact.
recorded_manifests="$(find "${EVIDENCE_DIR}/${ENVIRONMENT_NAME}/releases" -name '*.json' | wc -l | tr -d ' ')"
assert_equals "${recorded_manifests}" '2' 'both deployed release manifests are stored in the ledger'

cat <<'SUMMARY'

DEPLOY REHEARSAL OK
  build once -> publish -> digest capture -> release manifest -> deploy by
  digest -> migrate once -> readiness -> smoke -> evidence -> second release ->
  rollback to the previous known-good digests: all verified.

  This rehearsal proves the deployment MECHANICS. It is not a staging
  environment and is not evidence of production readiness.
SUMMARY
