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
