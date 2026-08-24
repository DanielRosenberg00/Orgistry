#!/usr/bin/env bash
#
# PostgreSQL logical backup (Sprint 25, ORG-PR-005).
#
# Takes a `pg_dump` custom-format backup of an Orgistry database, writes a
# SHA-256 checksum and a metadata sidecar next to it, and prints the artifact
# path. It is the ONLY backup mechanism in this repository, and it is what
# tooling/db-restore-drill.sh exercises — the backup path and the tested
# restore path are the same code.
#
# Usage:
#   tooling/db-backup.sh [options]
#
# Options:
#   --database-url URL   Database to back up. Defaults to $BACKUP_DATABASE_URL,
#                        then $DATABASE_URL.
#   --output-dir DIR     Destination directory. Defaults to $ORGISTRY_BACKUP_DIR,
#                        then <repo>/backups.
#   --docker-network NET Attach the client container to this Docker network
#                        (use when the database is itself a container).
#   --label LABEL        Extra filename component ([A-Za-z0-9._-] only).
#   --help
#
# WHAT THIS PRODUCES
#   <dir>/orgistry-<UTC timestamp>[-<label>].dump         custom-format dump
#   <dir>/orgistry-<UTC timestamp>[-<label>].dump.sha256  checksum
#   <dir>/orgistry-<UTC timestamp>[-<label>].meta.json    provenance metadata
#
# SECURITY — READ BEFORE USING THIS ON REAL DATA
#   * The dump contains every user, organization, and audit row, plus password
#     hashes, token hashes, and API-key secret hashes. Treat it exactly like a
#     credential store.
#   * Backups must NEVER be committed. The default output directory is
#     git-ignored, and this script refuses to write inside .git.
#   * Nothing here encrypts the artifact. The checksum proves INTEGRITY only —
#     it is not encryption and not access control. Encryption at rest and
#     least-privilege access are deployment responsibilities (ORG-PR-001,
#     ORG-PR-006 — both open). See docs/backup-and-restore.md.
#   * The connection URL is passed to the client through an environment
#     variable, never as an argument and never into a filename or log line.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tooling/lib/pg-tools.sh
source "${REPO_ROOT}/tooling/lib/pg-tools.sh"

DATABASE_URL_ARG=''
OUTPUT_DIR=''
DOCKER_NETWORK=''
LABEL=''

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DATABASE_URL_ARG="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --docker-network) DOCKER_NETWORK="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) pg_tools_die "Unknown argument \"$1\" (try --help)" ;;
  esac
done

# ---- Resolve inputs -------------------------------------------------------

# `.env` is the repository's local configuration convention; read DATABASE_URL
# from it only when the caller supplied neither an argument nor an environment
# value. The file is never printed.
if [[ -z "${DATABASE_URL_ARG}" && -z "${BACKUP_DATABASE_URL:-}" && -z "${DATABASE_URL:-}" && -f "${REPO_ROOT}/.env" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "${REPO_ROOT}/.env" | tail -n 1 | cut -d= -f2-)"
fi

SOURCE_URL="${DATABASE_URL_ARG:-${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}}"
[[ -n "${SOURCE_URL}" ]] || pg_tools_die \
  'No database URL. Pass --database-url, or set BACKUP_DATABASE_URL or DATABASE_URL.'

OUTPUT_DIR="${OUTPUT_DIR:-${ORGISTRY_BACKUP_DIR:-${REPO_ROOT}/backups}}"
case "${OUTPUT_DIR}" in
  *.git|*.git/*) pg_tools_die "Refusing to write backups inside a git directory: ${OUTPUT_DIR}" ;;
esac

if [[ -n "${LABEL}" && ! "${LABEL}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  pg_tools_die 'A --label may contain only letters, digits, dot, underscore, and hyphen.'
fi

command -v docker >/dev/null 2>&1 || pg_tools_die 'docker is required (the PostgreSQL client tools run in a pinned container).'

# ---- Prepare the destination ---------------------------------------------

# Backups are owner-readable only, from the moment the directory is created.
(umask 077 && mkdir -p "${OUTPUT_DIR}")

TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BASENAME="orgistry-${TIMESTAMP}${LABEL:+-${LABEL}}"
DUMP_PATH="${OUTPUT_DIR}/${BASENAME}.dump"
CHECKSUM_PATH="${DUMP_PATH}.sha256"
META_PATH="${OUTPUT_DIR}/${BASENAME}.meta.json"

[[ ! -e "${DUMP_PATH}" ]] || pg_tools_die "Refusing to overwrite an existing backup: ${DUMP_PATH}"

pg_client_init "${SOURCE_URL}" "${DOCKER_NETWORK}"

printf 'Backing up to %s\n' "${DUMP_PATH}"

# ---- Collect provenance BEFORE dumping ------------------------------------
# A failure here fails the whole run: a backup whose source cannot even be
# queried is not a backup worth keeping.

SERVER_VERSION="$(pg_query 'SHOW server_version' | tr -d '[:space:]')"
DATABASE_NAME="$(pg_query 'SELECT current_database()' | tr -d '[:space:]')"
# Drizzle records applied migrations in `drizzle.__drizzle_migrations`. A
# database with no such table is not an Orgistry database (or has never been
# migrated) — recorded as `null` rather than guessed.
MIGRATION_COUNT="$(pg_query "SELECT coalesce((SELECT count(*)::text FROM drizzle.__drizzle_migrations), 'null')" | tr -d '[:space:]')"
CLIENT_VERSION="$(pg_client 'pg_dump --version' | tr -d '\r')"

# ---- Dump -----------------------------------------------------------------
#
# `--format=custom` is chosen deliberately: it is compressed, restorable with
# `pg_restore` into a fresh database, and supports selective restore during an
# incident. `--no-owner`/`--no-acl` keep the artifact restorable under whatever
# role performs the recovery.
#
# The dump streams to stdout and is captured here, so a failure mid-dump leaves
# a partial file that the exit check below deletes.
set +e
pg_client 'pg_dump "$ORGISTRY_PG_URL" --format=custom --compress=9 --no-owner --no-acl' \
  >"${DUMP_PATH}"
DUMP_STATUS=$?
set -e

if (( DUMP_STATUS != 0 )); then
  rm -f "${DUMP_PATH}"
  pg_tools_die "pg_dump failed (exit ${DUMP_STATUS}); no backup was written."
fi

chmod 600 "${DUMP_PATH}"

DUMP_BYTES="$(wc -c <"${DUMP_PATH}" | tr -d '[:space:]')"
if (( DUMP_BYTES == 0 )); then
  rm -f "${DUMP_PATH}"
  pg_tools_die 'pg_dump produced an empty file; no backup was written.'
fi

# ---- Checksum + metadata --------------------------------------------------

# `shasum` on macOS, `sha256sum` on Linux — both emit "<hex>  <path>".
if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "${DUMP_PATH}" | cut -d' ' -f1)"
else
  SHA256="$(shasum -a 256 "${DUMP_PATH}" | cut -d' ' -f1)"
fi
printf '%s  %s\n' "${SHA256}" "$(basename "${DUMP_PATH}")" >"${CHECKSUM_PATH}"
chmod 600 "${CHECKSUM_PATH}"

# Metadata records provenance only. No credential, host, or connection string
# is written — the artifact must be safe to list in a directory listing.
cat >"${META_PATH}" <<JSON
{
  "artifact": "$(basename "${DUMP_PATH}")",
  "created_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "database": "${DATABASE_NAME}",
  "format": "pg_dump custom (-Fc, compress=9, --no-owner --no-acl)",
  "postgres_server_version": "${SERVER_VERSION}",
  "pg_dump_client": "${CLIENT_VERSION}",
  "client_image": "${ORGISTRY_PG_IMAGE}",
  "applied_migrations": ${MIGRATION_COUNT},
  "bytes": ${DUMP_BYTES},
  "sha256": "${SHA256}",
  "encrypted": false,
  "note": "Contains user, organization, audit, password-hash, and token-hash data. Never commit. Encryption at rest is a deployment responsibility (ORG-PR-001)."
}
JSON
chmod 600 "${META_PATH}"

printf 'Backup complete: %s bytes, %s applied migrations, server %s\n' \
  "${DUMP_BYTES}" "${MIGRATION_COUNT}" "${SERVER_VERSION}"
printf '%s\n' "${DUMP_PATH}"
