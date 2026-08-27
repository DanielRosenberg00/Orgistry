#!/usr/bin/env bash
#
# Deployment target preflight (Sprint 27, ORG-PR-001).
#
# Qualifies a CANDIDATE HOST before anything is deployed to it, and prints a
# sanitized baseline for that host. It answers one question:
#
#   "Would tooling/deploy.sh succeed here, and what exactly is 'here'?"
#
# WHY THIS EXISTS
# Sprint 26 built the deployment mechanism but nothing that inspects a target.
# The first thing an actual target inspection found was a defect that no local
# rehearsal could ever surface: the published images are single-architecture
# `linux/amd64`, so a perfectly healthy arm64 host pulls them and then fails to
# start them. Every check below is a precondition that, unmet, produces a
# deployment failure LATE — after the backup preflight, after migrations, or
# after an operator has already pointed DNS at the host.
#
# READ-ONLY CONTRACT (do not weaken)
# This script is read-only with respect to application, database, host, and
# remote state. It MAY:
#   * inspect host, daemon, and tool versions;
#   * inspect file modes and directory writability (stat only — it never reads
#     the runtime configuration file's contents);
#   * pull and inspect IMMUTABLE, digest-pinned images (content-addressed, so a
#     pull adds to the local image cache and changes nothing else);
#   * inspect image and host CPU architecture;
#   * parse and structurally validate NON-SECRET configuration.
# It MUST NOT:
#   * run migrations or touch the application database in any way;
#   * start, stop, or reconfigure the Orgistry deployment;
#   * change firewall, network, or host configuration;
#   * write or persist any secret;
#   * mutate GitHub settings, package visibility, or any remote state.
# A future check that needs any of the second list belongs in tooling/deploy.sh,
# not here.
#
# WHAT THIS IS NOT
#   * Not a deployment, and not evidence that anything was deployed. It starts
#     no Orgistry container, runs no migration, and writes nothing to the
#     evidence ledger.
#   * Not a security audit of the host. It checks the small set of properties
#     the deployment itself depends on (docs/deployment.md, "Host baseline").
#     Patch level, intrusion detection, and account hygiene are the operator's.
#   * Not a substitute for the post-deployment smoke test, which validates a
#     RUNNING deployment through its public origins.
#
# EXIT CODES: 0 when every check passed or only warned; 1 when any check FAILED.
#
# OUTPUT SAFETY: paths, modes, versions, counts, and image references only.
# The runtime configuration file is stat'ed, never read; no configuration VALUE
# from it is printed.
#
# Usage:
#   tooling/deploy-target-preflight.sh [--config PATH] [--manifest PATH] [--json]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG_PREFIX='deploy-preflight'
# shellcheck source=tooling/lib/deploy-common.sh
source "${REPO_ROOT}/tooling/lib/deploy-common.sh"

CONFIG_PATH="${ORGISTRY_DEPLOY_CONFIG:-}"
MANIFEST_PATH=''
EMIT_JSON=0

FAILURE_COUNT=0
WARNING_COUNT=0
# Sanitized host facts, collected as `key=value` lines and emitted by --json.
BASELINE_FACTS=()

usage() {
  cat <<'USAGE'
Usage: tooling/deploy-target-preflight.sh [options]

  --config PATH     Deployment configuration file to validate against this
                    host (infra/deploy.env.example is the template). Optional:
                    without it only host-level checks run, which is what you
                    want when qualifying a host that is not configured yet.
  --manifest PATH   Release manifest whose images should be proven pullable and
                    runnable on this host. Optional; strongly recommended
                    before the first deployment.
  --json            Also print the sanitized baseline as a JSON object on
                    stdout, for pasting into deployment documentation.
  --help
USAGE
}

while [[ $# -gt 0 ]]; do
  # `pnpm deploy:preflight -- --flag` forwards a bare `--`; treat it as the
  # conventional end-of-options marker rather than an unknown argument.
  case "$1" in
    --) shift ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --manifest) MANIFEST_PATH="${2:-}"; shift 2 ;;
    --json) EMIT_JSON=1; shift ;;
    --help | -h) usage; exit 0 ;;
    *) deploy_die "unknown argument \"$1\" (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Result reporting
#
# A preflight collects every problem rather than stopping at the first one:
# an operator qualifying a host wants the whole list, not one round trip per
# defect. Only a usage error uses deploy_die.
# ---------------------------------------------------------------------------

check_ok() { printf '   ok    %s\n' "$1"; }

check_warn() {
  WARNING_COUNT=$((WARNING_COUNT + 1))
  printf '   warn  %s\n' "$1"
}

check_fail() {
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  printf '   FAIL  %s\n' "$1"
}

record_fact() { BASELINE_FACTS+=("$1=$2"); }

# ---------------------------------------------------------------------------
# Stage 1 — the commands tooling/deploy.sh invokes on the host
# ---------------------------------------------------------------------------

deploy_stage 'Deployment toolchain'
for required in docker curl node; do
  if command -v "${required}" >/dev/null 2>&1; then
    check_ok "${required} is available"
  else
    check_fail "${required} is not installed; tooling/deploy.sh cannot run here"
  fi
done

if docker compose version >/dev/null 2>&1; then
  check_ok "docker compose v2 is available ($(docker compose version --short 2>/dev/null || echo 'version unknown'))"
  record_fact composeVersion "$(docker compose version --short 2>/dev/null || echo 'unknown')"
else
  check_fail 'docker compose v2 is not available; the deployment topology cannot be applied'
fi

# The deployment executes FROM a checkout: deploy.sh, the compose topology, and
# the Node tools all resolve relative to the repository root.
for required_file in tooling/deploy.sh infra/compose.deploy.yml tooling/deploy-evidence.mjs; do
  if [[ -f "${REPO_ROOT}/${required_file}" ]]; then
    check_ok "${required_file} is present in this checkout"
  else
    check_fail "${required_file} is missing; this is not a complete Orgistry checkout"
  fi
done

# ---------------------------------------------------------------------------
# Stage 2 — host baseline
#
# Recorded rather than judged, except the architecture, which decides whether
# the published images can run at all.
# ---------------------------------------------------------------------------

deploy_stage 'Host baseline'
HOST_PLATFORM=''
if docker info --format '{{.OSType}}' >/dev/null 2>&1; then
  HOST_PLATFORM="$(deploy_host_platform)"
  check_ok "Docker daemon reachable, platform ${HOST_PLATFORM}"
  record_fact hostPlatform "${HOST_PLATFORM}"
  record_fact dockerVersion "$(docker info --format '{{.ServerVersion}}')"
  record_fact cpuCount "$(docker info --format '{{.NCPU}}')"
  record_fact memoryBytes "$(docker info --format '{{.MemTotal}}')"
  record_fact storageDriver "$(docker info --format '{{.Driver}}')"
else
  check_fail 'the Docker daemon is not reachable; nothing can be deployed here'
fi
record_fact kernel "$(uname -sr)"

# A staging-like target must survive a host reboot (docs/deployment.md, "Target
# requirements"). The containers already declare `restart: unless-stopped`, so
# what remains is whether the Docker service itself starts at boot. Only
# systemd hosts can answer that here; elsewhere it is an operator assertion.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled docker >/dev/null 2>&1; then
    check_ok 'the Docker service is enabled at boot, so the deployment survives a host restart'
    record_fact dockerEnabledAtBoot true
  else
    check_warn 'the Docker service is NOT enabled at boot; the deployment will not come back after a host restart (systemctl enable docker)'
    record_fact dockerEnabledAtBoot false
  fi
else
  check_warn 'boot persistence could not be verified on this host (no systemctl); confirm the Docker service starts at boot before treating this target as durable'
  record_fact dockerEnabledAtBoot unverified
fi

# ---------------------------------------------------------------------------
# Stage 3 — the release this host is expected to run
#
# The pull is the registry boundary; the platform comparison is the one this
# repository's own release pipeline can violate.
# ---------------------------------------------------------------------------

if [[ -n "${MANIFEST_PATH}" ]]; then
  deploy_stage 'Release pullability and platform'
  deploy_require_file "${MANIFEST_PATH}" 'release manifest'
  if node "${REPO_ROOT}/tooling/release-manifest.mjs" validate "${MANIFEST_PATH}" >/dev/null; then
    check_ok 'the release manifest is valid'
  else
    check_fail 'the release manifest is invalid; deployment would be refused'
  fi

  for image_name in api web; do
    reference="$(node "${REPO_ROOT}/tooling/release-manifest.mjs" read "${MANIFEST_PATH}" --field "images.${image_name}.reference")"
    # The manifest schema already guarantees digest-pinned references, but this
    # stage collects failures rather than exiting, so an invalid manifest could
    # otherwise reach the pull below. Never let a preflight be the thing that
    # resolves a mutable tag.
    if [[ "${reference}" != *'@sha256:'* ]]; then
      check_fail "the ${image_name} image reference is not digest-pinned (${reference}); a deployment would refuse it and this preflight will not resolve it"
      continue
    fi
    if ! docker pull --quiet "${reference}" >/dev/null 2>&1; then
      check_fail "cannot pull the ${image_name} image (${reference}) from this host — check outbound access to the registry, and whether the package requires a pull credential (docker login ghcr.io)"
      continue
    fi
    check_ok "pulled the ${image_name} image ${reference}"
    image_platform="$(deploy_image_platform "${reference}")"
    record_fact "${image_name}ImagePlatform" "${image_platform}"
    if [[ -z "${HOST_PLATFORM}" ]]; then
      check_warn "the ${image_name} image is ${image_platform}, but this host's platform is unknown so the two could not be compared"
    elif [[ "${image_platform}" == "${HOST_PLATFORM}" ]]; then
      check_ok "the ${image_name} image platform ${image_platform} matches this host"
    else
      check_fail "the ${image_name} image is ${image_platform} but this host is ${HOST_PLATFORM}, so it cannot start here without emulation. Provision a host whose platform is ${image_platform}, or publish a multi-architecture image."
    fi
  done
fi

# ---------------------------------------------------------------------------
# Stage 4 — the deployment configuration, against this host
# ---------------------------------------------------------------------------

if [[ -n "${CONFIG_PATH}" ]]; then
  deploy_stage 'Deployment configuration'
  deploy_load_config "${CONFIG_PATH}"
  check_ok "parsed ${CONFIG_PATH}"
  record_fact environment "${ORGISTRY_ENVIRONMENT:-unset}"

  # A real target must never accept a rehearsal manifest.
  if [[ "${ORGISTRY_ENVIRONMENT_CLASS:-deployment}" == 'deployment' ]]; then
    check_ok 'ORGISTRY_ENVIRONMENT_CLASS=deployment — only a gate-authorised published release is accepted'
  else
    check_fail "ORGISTRY_ENVIRONMENT_CLASS=${ORGISTRY_ENVIRONMENT_CLASS}; a durable target must be \"deployment\", or it will accept a rehearsal release"
  fi

  # The runtime configuration file holds every runtime secret. It is stat'ed,
  # never read: this script must never be the thing that prints a secret.
  runtime_env_file="${ORGISTRY_RUNTIME_ENV_FILE:-}"
  if [[ -z "${runtime_env_file}" ]]; then
    check_fail 'ORGISTRY_RUNTIME_ENV_FILE is not set; the deployment has no runtime configuration'
  elif [[ ! -f "${runtime_env_file}" ]]; then
    check_fail "the runtime configuration file ${runtime_env_file} does not exist yet"
  elif (( 8#$(deploy_file_mode "${runtime_env_file}") & 8#077 )); then
    # The same rule tooling/deploy.sh enforces at deployment time: any group or
    # other permission bit on a file holding every runtime secret is a finding.
    check_fail "${runtime_env_file} is mode $(deploy_file_mode "${runtime_env_file}"); it holds every runtime secret and must be readable only by its owner (chmod 600)"
  else
    check_ok "${runtime_env_file} exists and is readable only by its owner"
  fi

  # Loopback binds are what keeps the API and web ports private behind the
  # operator's TLS-terminating reverse proxy.
  for bind_variable in ORGISTRY_API_BIND ORGISTRY_WEB_BIND; do
    bind_address="${!bind_variable:-127.0.0.1}"
    if [[ "${bind_address}" == '127.0.0.1' || "${bind_address}" == '::1' ]]; then
      check_ok "${bind_variable}=${bind_address} — the port is not published to the network"
    else
      check_warn "${bind_variable}=${bind_address} publishes the port beyond loopback; this is only safe behind a host firewall, and TLS must terminate in front of it"
    fi
  done

  # The browser-facing origin is what users' credentials travel over.
  public_api_url="${ORGISTRY_PUBLIC_API_BASE_URL:-}"
  if [[ -z "${public_api_url}" ]]; then
    check_fail 'ORGISTRY_PUBLIC_API_BASE_URL is not set; the deployment cannot configure the browser'
  elif [[ "${public_api_url}" == https://* ]]; then
    check_ok "the browser-facing API origin is HTTPS (${public_api_url})"
  else
    check_fail "the browser-facing API origin ${public_api_url} is not HTTPS; session cookies require COOKIE_SECURE=true, which needs a TLS origin"
  fi
  record_fact publicApiOrigin "${public_api_url:-unset}"

  # Evidence and backups are host-side state that must survive, and must not be
  # readable by every account on the host.
  for directory_variable in ORGISTRY_EVIDENCE_DIR ORGISTRY_BACKUP_DIR; do
    directory="${!directory_variable:-}"
    if [[ -z "${directory}" ]]; then
      check_warn "${directory_variable} is not set"
      continue
    fi
    if [[ ! -d "${directory}" ]]; then
      check_warn "${directory_variable}=${directory} does not exist yet; the deployment creates it, but confirm the filesystem is persistent"
      continue
    fi
    if [[ ! -w "${directory}" ]]; then
      check_fail "${directory_variable}=${directory} is not writable by $(id -un)"
    elif [[ "$(deploy_file_mode "${directory}")" == *[2367] ]]; then
      check_fail "${directory_variable}=${directory} is world-writable (mode $(deploy_file_mode "${directory}"))"
    else
      check_ok "${directory_variable}=${directory} is writable and not world-writable"
      record_fact "${directory_variable}FreeKb" "$(df -Pk "${directory}" | awk 'NR == 2 { print $4 }')"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

deploy_stage 'Preflight result'
printf '   %s failed, %s warned\n' "${FAILURE_COUNT}" "${WARNING_COUNT}"
cat <<'CLASSIFICATION'
   A staging-like target carries SYNTHETIC data only. Deploying real user data
   to a target qualified by this script is out of scope for every Orgistry
   staging claim (docs/deployment.md, "Environment taxonomy").
CLASSIFICATION

if (( EMIT_JSON == 1 )); then
  # Emitted through node so quoting is correct for any value, and so the
  # object is safe to paste into documentation or an operator's own records.
  printf '%s\n' "${BASELINE_FACTS[@]+"${BASELINE_FACTS[@]}"}" | node -e '
    const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const baseline = {};
    for (const line of lines) {
      const separator = line.indexOf("=");
      baseline[line.slice(0, separator)] = line.slice(separator + 1);
    }
    process.stdout.write(JSON.stringify(baseline, null, 2) + "\n");
  '
fi

if (( FAILURE_COUNT > 0 )); then
  printf '\nTARGET PREFLIGHT FAILED: %s check(s) must be resolved before deploying here.\n' "${FAILURE_COUNT}" >&2
  exit 1
fi
printf '\nTARGET PREFLIGHT OK: this host satisfies the checks this script can make.\n'
printf 'It is not evidence that a deployment succeeded — run tooling/deploy.sh for that.\n'
