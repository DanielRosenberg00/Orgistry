#!/usr/bin/env bash
#
# Install the Orgistry backup scheduler (Sprint 28, ORG-PR-005).
#
# Renders the versioned unit templates in infra/systemd/ into the CURRENT
# USER's systemd instance and enables the timers. It needs no root: the target
# host's operator account has no passwordless sudo, and a backup schedule that
# cannot be reinstalled without an administrator will eventually not be
# reinstalled at all.
#
# Usage:
#   tooling/backup-install-systemd.sh --config /opt/orgistry/config/backup.env \
#                                     [--tooling-dir /opt/orgistry/deploy/tooling] \
#                                     [--dry-run] [--uninstall]
#
# WHAT IT DOES
#   1. checks the prerequisites (systemd user instance, lingering, node);
#   2. renders each unit with the real tooling and configuration paths;
#   3. installs them under ~/.config/systemd/user/;
#   4. reloads systemd and enables + starts the timers;
#   5. prints the timer schedule it just created.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   * It does not create, read, or write any credential.
#   * It does not run a backup. Installing a schedule and proving the schedule
#     works are separate acts, and conflating them hides which one failed.
#   * It does not enable lingering for you. That is a persistent change to the
#     account and the operator should make it deliberately; this script checks
#     it and tells you the exact command.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SOURCE_DIR="${REPO_ROOT}/infra/systemd"
UNIT_TARGET_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"

TIMERS=(
  orgistry-backup.timer
  orgistry-wal-ship.timer
  orgistry-backup-health.timer
  orgistry-backup-prune.timer
)
SERVICES=(
  orgistry-backup.service
  orgistry-wal-ship.service
  orgistry-backup-health.service
  orgistry-backup-prune.service
)

CONFIG_PATH=''
TOOLING_DIR="${REPO_ROOT}/tooling"
DRY_RUN=0
UNINSTALL=0

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

info() { printf '   %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }

usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --tooling-dir) TOOLING_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown argument \"$1\" (try --help)" ;;
  esac
done

# ---- Uninstall -------------------------------------------------------------

if (( UNINSTALL == 1 )); then
  step 'Removing the Orgistry backup schedule'
  for timer in "${TIMERS[@]}"; do
    systemctl --user disable --now "${timer}" 2>/dev/null || true
    rm -f "${UNIT_TARGET_DIR}/${timer}"
    info "removed ${timer}"
  done
  for service in "${SERVICES[@]}"; do
    rm -f "${UNIT_TARGET_DIR}/${service}"
  done
  systemctl --user daemon-reload
  info 'Backup artifacts already stored off-host are untouched.'
  exit 0
fi

# ---- Preconditions ---------------------------------------------------------

step 'Checking prerequisites'

[[ -n "${CONFIG_PATH}" ]] || die '--config is required (the backup configuration file this schedule will use)'
CONFIG_PATH="$(cd "$(dirname "${CONFIG_PATH}")" && pwd)/$(basename "${CONFIG_PATH}")"
[[ -f "${CONFIG_PATH}" ]] || die "backup configuration file not found at ${CONFIG_PATH}"

TOOLING_DIR="$(cd "${TOOLING_DIR}" && pwd)"
[[ -f "${TOOLING_DIR}/backup-ops.mjs" ]] \
  || die "backup-ops.mjs not found in ${TOOLING_DIR} (pass --tooling-dir)"

command -v systemctl >/dev/null 2>&1 || die 'systemctl is required'
command -v node >/dev/null 2>&1 || die 'node is required (the backup tooling is a Node program)'
systemctl --user show-environment >/dev/null 2>&1 \
  || die 'no systemd user instance is reachable for this account'
info "systemd user instance reachable, node $(node --version)"

# Without lingering, user units stop when the last session ends and do NOT
# start at boot — which would silently turn a daily backup into a
# "while-someone-is-logged-in" backup.
LINGER="$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || echo 'unknown')"
if [[ "${LINGER}" != 'yes' ]]; then
  die "lingering is not enabled for $(id -un); the schedule would not survive logout or reboot.
       Enable it first:  loginctl enable-linger $(id -un)"
fi
info 'lingering is enabled — timers survive logout and reboot'

# A systemd USER unit does not inherit the groups of your interactive shell: the
# user manager captured them when it started. If the account joined the `docker`
# group after that, `docker` works when you type it and fails at 02:30 with
# "permission denied ... /var/run/docker.sock" — and the logical backup runs
# PostgreSQL's client tools in a container. Catch it now, not then.
if ! systemd-run --user --wait --pipe --quiet --collect \
     /usr/bin/env docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  die "a systemd user unit cannot reach the Docker daemon, although your shell can.
       The user manager was started before this account joined the docker group.
       Restart it, then re-run this installer:

         sudo loginctl terminate-user $(id -un)      # or reboot the host

       Verify with:  systemd-run --user --wait --pipe /usr/bin/id"
fi
info 'systemd user units can reach the Docker daemon'

# ---- Render and install ----------------------------------------------------

step 'Rendering units'
info "tooling directory: ${TOOLING_DIR}"
info "configuration:     ${CONFIG_PATH}"

if (( DRY_RUN == 1 )); then
  info '(dry run — nothing will be written)'
else
  mkdir -p "${UNIT_TARGET_DIR}"
fi

for unit in "${SERVICES[@]}" "${TIMERS[@]}"; do
  source_path="${UNIT_SOURCE_DIR}/${unit}"
  [[ -f "${source_path}" ]] || die "unit template missing: ${source_path}"
  rendered="$(sed \
    -e "s#@ORGISTRY_TOOLING_DIR@#${TOOLING_DIR}#g" \
    -e "s#@ORGISTRY_BACKUP_CONFIG@#${CONFIG_PATH}#g" \
    "${source_path}")"

  # A leftover placeholder means a template gained a variable the installer does
  # not know about. Refuse rather than install a unit that would fail at 02:30.
  if grep -q '@ORGISTRY_[A-Z_]*@' <<<"${rendered}"; then
    die "unit ${unit} still contains an unsubstituted placeholder"
  fi

  if (( DRY_RUN == 1 )); then
    info "would install ${unit}"
  else
    printf '%s\n' "${rendered}" >"${UNIT_TARGET_DIR}/${unit}"
    info "installed ${unit}"
  fi
done

if (( DRY_RUN == 1 )); then
  printf '\nDry run complete. Nothing was installed.\n'
  exit 0
fi

# ---- Enable ---------------------------------------------------------------

step 'Enabling timers'
systemctl --user daemon-reload
for timer in "${TIMERS[@]}"; do
  systemctl --user enable --now "${timer}" >/dev/null
  info "enabled ${timer}"
done

step 'Schedule'
systemctl --user list-timers --all --no-pager 'orgistry-*'

printf '\nInstalled. Verify protection with:\n'
printf '  node %s/backup-ops.mjs health\n' "${TOOLING_DIR}"
printf '  node %s/backup-ops.mjs wal-health\n' "${TOOLING_DIR}"
printf 'Failed jobs appear in: systemctl --user list-units --failed\n'
