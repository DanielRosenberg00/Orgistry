#!/usr/bin/env bash
#
# Shared deployment helpers (Sprint 26, ORG-PR-001). Sourced by
# tooling/deploy.sh, tooling/deploy-smoke.sh, tooling/deploy-rollback.sh, and
# tooling/deploy-rehearsal.sh.
#
# Three responsibilities, and nothing else:
#   * uniform stage/failure reporting, so a failed deployment names the STAGE
#     that failed rather than only the command;
#   * a strict, non-executing parser for the deployment configuration file;
#   * the small set of docker/HTTP primitives every deployment stage needs.
#
# SECRET HYGIENE
# Nothing here prints a configuration VALUE. Failures name variables, paths,
# URLs, and image references — all non-secret — and never the runtime env file's
# contents. The one function that touches a secret (`deploy_read_secret_value`)
# returns it on stdout to a caller that keeps it in a variable; it never logs.

set -euo pipefail

# ---- Reporting ------------------------------------------------------------

# The stage currently executing. `deploy_die` names it, so every failure
# message answers "which part of the deployment failed?".
DEPLOY_CURRENT_STAGE='startup'

deploy_stage() {
  DEPLOY_CURRENT_STAGE="$1"
  printf '\n== [%s] %s\n' "${DEPLOY_LOG_PREFIX:-deploy}" "$1"
}

deploy_info() {
  printf '   %s\n' "$1"
}

deploy_die() {
  printf '\n%s FAILED during stage "%s": %s\n' \
    "${DEPLOY_LOG_PREFIX:-deploy}" "${DEPLOY_CURRENT_STAGE}" "$1" >&2
  exit 1
}

# ---- Preconditions --------------------------------------------------------

deploy_require_command() {
  local command_name="$1" reason="$2"
  command -v "${command_name}" >/dev/null 2>&1 \
    || deploy_die "required command \"${command_name}\" is not available (${reason})"
}

deploy_require_var() {
  local name="$1" hint="$2"
  [[ -n "${!name:-}" ]] || deploy_die "${name} is not set (${hint})"
}

deploy_require_file() {
  local path="$1" description="$2"
  [[ -f "${path}" ]] || deploy_die "${description} not found at ${path}"
  [[ -r "${path}" ]] || deploy_die "${description} at ${path} is not readable"
}

# ---- Deployment configuration file ---------------------------------------

# Load a deployment configuration file into the environment.
#
# The format is deliberately a strict subset of shell: `KEY=VALUE` lines,
# `#` comments, blank lines, and optional surrounding single or double quotes.
# The file is PARSED, never sourced — an operator config file must not be able
# to execute commands as a side effect of a deployment, and command
# substitution in a config value is a mistake we would rather refuse than run.
deploy_load_config() {
  local config_path="$1"
  deploy_require_file "${config_path}" 'deployment configuration file'

  local line_number=0 line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line_number=$((line_number + 1))
    # Strip a trailing carriage return so a CRLF file behaves identically.
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == '#'* ]] && continue

    if [[ "${line}" != *'='* ]]; then
      deploy_die "${config_path}:${line_number} is not a KEY=VALUE line"
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ ! "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      deploy_die "${config_path}:${line_number} has an invalid key \"${key}\" (expected UPPER_SNAKE_CASE)"
    fi
    # Exactly one layer of matching quotes is removed; nothing is expanded.
    if [[ "${value}" == '"'*'"' || "${value}" == "'"*"'" ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "${key}=${value}"
  done <"${config_path}"
}

# Read one variable out of a runtime env file WITHOUT exporting the file.
#
# Used for the two values a deployment itself needs (the database URL for the
# backup preflight and the migration-head verification). The value is echoed to
# the caller's command substitution and never logged. `<NAME>_FILE` is honored
# so a deployment that mounts secrets as files keeps working
# (docs/runtime-secrets.md).
deploy_read_secret_value() {
  local env_file="$1" name="$2" raw=''

  raw="$(grep -E "^${name}=" "${env_file}" | tail -n 1 || true)"
  if [[ -n "${raw}" ]]; then
    raw="${raw#*=}"
    raw="${raw%$'\r'}"
    if [[ "${raw}" == '"'*'"' || "${raw}" == "'"*"'" ]]; then
      raw="${raw:1:${#raw}-2}"
    fi
    printf '%s' "${raw}"
    return 0
  fi

  local file_path
  file_path="$(grep -E "^${name}_FILE=" "${env_file}" | tail -n 1 || true)"
  if [[ -n "${file_path}" ]]; then
    file_path="${file_path#*=}"
    file_path="${file_path%$'\r'}"
    [[ -r "${file_path}" ]] || deploy_die "${name}_FILE points at ${file_path}, which is not readable"
    # One terminal newline is stripped, matching the runtime's own resolver.
    printf '%s' "$(cat "${file_path}")"
    return 0
  fi

  return 1
}

# ---- Runtime configuration file checks ------------------------------------

# The runtime configuration file's mode, as an octal string, on Linux or macOS.
deploy_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# Refuse a runtime configuration file that anyone but its owner can read.
#
# The file holds every runtime secret in plaintext, so a group- or
# world-readable mode is a finding on the host, not a warning to print.
deploy_assert_runtime_env_protected() {
  local env_file="$1" mode
  mode="$(deploy_file_mode "${env_file}")"
  if (( 8#${mode} & 8#077 )); then
    deploy_die "runtime configuration file ${env_file} has mode ${mode}; it holds runtime secrets and must be 0600 (chmod 600 it)"
  fi
}

# Assert the runtime configuration declares every variable a deployment cannot
# start without, accepting either the direct or the `<NAME>_FILE` form.
#
# PRESENCE ONLY. Values are validated by the API's own production config guard
# at boot (packages/config); a second policy here would drift from the one that
# actually gates the process. The single exception is NODE_ENV, whose value is
# what activates that guard in the first place.
deploy_assert_runtime_env_complete() {
  local env_file="$1"
  shift
  local missing=() key
  for key in "$@"; do
    if ! grep -qE "^${key}=|^${key}_FILE=" "${env_file}"; then
      missing+=("${key}")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    deploy_die "runtime configuration is missing required keys: ${missing[*]} (see docs/deployment.md, \"Deployment configuration contract\")"
  fi
  grep -qE '^NODE_ENV=production$' "${env_file}" \
    || deploy_die 'runtime configuration must set NODE_ENV=production — the production config guard is what makes the deployment refuse development secrets'
}

# ---- HTTP probing ---------------------------------------------------------

# Last status observed by `deploy_poll_status`, so a caller can report it.
DEPLOY_LAST_STATUS=''

deploy_poll_status() {
  local url="$1" expected="$2" timeout_seconds="$3" attempt
  for ((attempt = 0; attempt < timeout_seconds; attempt++)); do
    DEPLOY_LAST_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${url}" 2>/dev/null || true)"
    if [[ "${DEPLOY_LAST_STATUS}" == "${expected}" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

deploy_wait_for_status() {
  local url="$1" expected="$2" timeout_seconds="$3" description="$4"
  deploy_poll_status "${url}" "${expected}" "${timeout_seconds}" && return 0
  deploy_die "${description}: ${url} did not return ${expected} within ${timeout_seconds}s (last status: ${DEPLOY_LAST_STATUS:-none})"
}

# ---- Image identity -------------------------------------------------------

# Refuse anything that is not digest-pinned.
#
# This is the enforcement point for the build-once/promote-by-digest invariant:
# a tag can be re-pushed, so a deployment that resolves `:latest` or even
# `:<commit-sha>` is not guaranteed to run the image CI validated.
deploy_require_digest_reference() {
  local reference="$1" label="$2"
  [[ "${reference}" == *'@sha256:'* ]] \
    || deploy_die "${label} must be digest-pinned (<repository>@sha256:...), got \"${reference}\""
}

# The local image ID a digest reference resolves to. Comparing this against a
# running container's image ID proves the container is that exact digest.
deploy_image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null \
    || deploy_die "image ${1} is not present locally — pull it before comparing digests"
}

deploy_container_image_id() {
  docker inspect --format '{{.Image}}' "$1" 2>/dev/null \
    || deploy_die "container ${1} does not exist"
}

# ---- Host / image platform compatibility ----------------------------------

# Set by deploy_assert_image_runs_on_host when a mismatch was explicitly
# allowed, so the deployment can record emulation as a limitation instead of
# letting it disappear into a log line. Its only reader is tooling/deploy.sh, so
# a linter looking at this file alone cannot see the use.
DEPLOY_EMULATED_PLATFORM=''

# One canonical token per CPU architecture.
#
# The Docker daemon reports the HOST architecture the way the kernel names it
# (`x86_64`, `aarch64`); an image's own configuration records the OCI name
# (`amd64`, `arm64`). Comparing the two spellings directly would report a
# mismatch on every host, so both sides are normalised through here first.
deploy_normalize_architecture() {
  case "$1" in
    x86_64 | amd64) printf 'amd64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    armv7l | armv7 | arm) printf 'arm' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Refuse a platform string that is not fully determined.
#
# `docker image inspect` and `docker info` exit 0 even when a template field
# renders empty, so a missing component would produce the string "/" — and if it
# happened on BOTH sides, the comparison below would MATCH and the gate would
# pass by accident. A gate that fails open is worse than no gate, so an
# incompletely determined platform is a refusal, not a warning.
deploy_require_determined_platform() {
  local platform="$1" source_description="$2"
  [[ "${platform}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] \
    || deploy_die "could not determine a complete os/architecture from ${source_description} (got \"${platform}\"); refusing to compare architectures on incomplete information"
}

# The `os/architecture` a locally present image declares it was built for.
deploy_image_platform() {
  local reference="$1" inspected os architecture platform
  inspected="$(docker image inspect --format '{{.Os}} {{.Architecture}}' "${reference}" 2>/dev/null)" \
    || deploy_die "image ${reference} is not present locally — pull it before inspecting its platform"
  os="${inspected%% *}"
  architecture="${inspected##* }"
  platform="${os}/$(deploy_normalize_architecture "${architecture}")"
  deploy_require_determined_platform "${platform}" "image ${reference}"
  printf '%s' "${platform}"
}

# The `os/architecture` of the Docker daemon this deployment drives.
#
# Deliberately the DAEMON's view rather than `uname -m`: a deployment may be
# driving a remote or virtualised Docker host whose architecture is not the
# calling shell's.
deploy_host_platform() {
  local inspected os architecture platform
  inspected="$(docker info --format '{{.OSType}} {{.Architecture}}' 2>/dev/null)" \
    || deploy_die 'cannot read the Docker daemon platform — is the daemon running and reachable?'
  os="${inspected%% *}"
  architecture="${inspected##* }"
  platform="${os}/$(deploy_normalize_architecture "${architecture}")"
  deploy_require_determined_platform "${platform}" 'the Docker daemon'
  printf '%s' "${platform}"
}

# Refuse an image this host cannot execute natively.
#
# Orgistry publishes SINGLE-architecture images: the release workflow builds on
# a GitHub-hosted `linux/amd64` runner and pushes one manifest, not a manifest
# list. Pulling is architecture-agnostic, so an arm64 host (Graviton, Ampere,
# Apple Silicon) pulls those images successfully and only fails when the
# container starts, with `exec format error`. Without this check that failure
# surfaces much later as "the API container did not become healthy", which
# sends the operator debugging the application instead of the platform — and it
# surfaces AFTER the backup preflight and the migration have already run.
#
# Emulation (Docker Desktop, or binfmt_misc + QEMU on Linux) can make a
# mismatched container run anyway: slowly, and on a syscall surface nothing in
# CI validated. That is not a supported deployment mode, so it must be opted
# into per deployment and is recorded on the deployment evidence rather than
# silently accepted.
deploy_assert_image_runs_on_host() {
  local reference="$1" label="$2" host_platform="$3" image_platform
  image_platform="$(deploy_image_platform "${reference}")"
  # Re-checked here, in the CALLER's shell. The getters validate too, but they
  # run inside a command substitution, so their refusal would surface as an
  # empty value plus a non-zero status rather than as this function's own
  # failure. The decision point must never compare two unusable strings.
  deploy_require_determined_platform "${image_platform}" "image ${reference}"
  deploy_require_determined_platform "${host_platform}" 'the Docker host'
  if [[ "${image_platform}" == "${host_platform}" ]]; then
    return 0
  fi

  if [[ "${ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH:-}" != 'yes' ]]; then
    deploy_die "the ${label} is built for ${image_platform} but this Docker host is ${host_platform}, so it cannot start here. Deploy from a ${image_platform} host, publish a multi-architecture image, or — only if this host really emulates ${image_platform} — set ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH=yes to accept emulation for this deployment."
  fi

  # Read by tooling/deploy.sh, which turns it into a limitation on the
  # deployment record; not read anywhere in this file.
  # shellcheck disable=SC2034
  DEPLOY_EMULATED_PLATFORM="${image_platform} images on a ${host_platform} host"
  deploy_info "WARNING: the ${label} is ${image_platform} on a ${host_platform} host; running under emulation because ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH=yes"
}
