#!/usr/bin/env bash
#
# Artifact smoke test (Sprint 23, ORG-PR-001; extended in Sprint 24 for
# ORG-PR-006).
#
# Builds the production-shaped artifacts and validates them END TO END against
# the production-like runtime reference (infra/compose.production-like.yml):
#
#    1. both images build;
#    2. migrations apply as an explicit one-shot step (never at API boot);
#    3. the API boots under NODE_ENV=production with fake, guard-passing
#       runtime configuration;
#    4. /health and /ready succeed; the production /ready body stays coarse
#       (no dependency inventory — Sprint 19 disclosure policy);
#    5. readiness fails closed (503) when Redis stops, and recovers;
#    6. the web artifact serves the built assets, the SPA fallback works, and
#       the configured public API base URL is baked into the bundle;
#    7. both runtimes execute as non-root;
#    8. no .env files, git metadata, or TypeScript source reach the API image;
#    9. the fake runtime secrets never appear in API logs;
#   10. the production config guard still REJECTS unsafe values;
#   11. the API stops cleanly on SIGTERM (exit 0);
#   12. runtime secrets can be MOUNTED AS FILES (`<NAME>_FILE`): the artifact
#       boots from them, an unsafe file-loaded secret is still rejected, an
#       ambiguous env+file pair is rejected, and the file's contents never
#       reach the logs;
#   13. the images declare no build-time or baked-in secret;
#   14. every container/network/volume (and every temporary secret file) is
#       removed afterwards.
#
# Deterministic and self-contained: needs docker (compose v2) + curl, no
# workspace install, no real secrets, no published images, and no real SMTP or
# email-provider credentials. Every secret below is a fake value created by
# this script or checked into the compose reference. Run locally via
# `pnpm artifact:smoke`; CI runs it in the `artifacts` job (.github/workflows/ci.yml).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/compose.production-like.yml"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

API_URL='http://localhost:3000'
WEB_URL='http://localhost:8080'
# Must match infra/compose.production-like.yml (fake, checked-in values).
FAKE_JWT_SECRET='orgistry-smoke-jwt-not-a-real-secret-orgistry-smoke-jwt'
FAKE_SMTP_PASSWORD='orgistry-smoke-smtp-not-a-real-credential'
FAKE_DB_PASSWORD='orgistry-smoke-db-not-a-real-credential'
EXPECTED_WEB_API_BASE_URL='http://localhost:3000'

# Sprint 24: fake secrets written to TEMPORARY files (never to the repository)
# to exercise the `<NAME>_FILE` mounted-secret path. Distinct from the direct
# env values above so a leak can be attributed to the file path specifically.
FAKE_FILE_JWT_SECRET='orgistry-smoke-file-jwt-not-a-real-secret-orgistry-file'
FAKE_FILE_SMTP_PASSWORD='orgistry-smoke-file-smtp-not-a-real-credential'
SECRET_DIR=''
FILE_SECRET_CONTAINER='orgistry-smoke-file-secrets'
FILE_SECRET_API_URL='http://localhost:3010'

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'SMOKE FAIL: %s\n' "$1" >&2; exit 1; }

cleanup() {
  step 'Cleanup: removing containers, networks, volumes, and temp secret files'
  docker rm -f "${FILE_SECRET_CONTAINER}" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  # Temporary secret material never outlives the run.
  if [[ -n "${SECRET_DIR}" && -d "${SECRET_DIR}" ]]; then
    rm -rf "${SECRET_DIR}"
  fi
  return 0
}
trap cleanup EXIT

# Poll a URL until it returns the expected HTTP status. Returns non-zero on
# timeout and reports the last observed status through LAST_POLLED_STATUS, so a
# caller can attach its own diagnostics before failing.
LAST_POLLED_STATUS=''
poll_status() {
  local url="$1" expected="$2" timeout_seconds="$3"
  for _ in $(seq 1 "${timeout_seconds}"); do
    LAST_POLLED_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${url}" || true)"
    if [[ "${LAST_POLLED_STATUS}" == "${expected}" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Poll a URL until it returns the expected HTTP status or fail the smoke run.
wait_for_status() {
  local url="$1" expected="$2" timeout_seconds="$3"
  poll_status "${url}" "${expected}" "${timeout_seconds}" && return 0
  fail "${url} did not return ${expected} within ${timeout_seconds}s (last: ${LAST_POLLED_STATUS})"
}

step 'Build production artifacts (API + web)'
"${COMPOSE[@]}" build

step 'Start the production-like stack (postgres -> migrate -> api, web)'
# --wait honors depends_on + healthchecks: it only returns 0 once migrate has
# exited successfully and the api/web healthchecks pass.
"${COMPOSE[@]}" up -d --wait

step 'Migration step ran as an explicit one-shot (exit 0)'
migrate_exit="$("${COMPOSE[@]}" ps -a migrate --format '{{.ExitCode}}')"
[[ "${migrate_exit}" == '0' ]] || fail "migrate exited with ${migrate_exit}"

step 'API /health responds 200 from the packaged artifact'
wait_for_status "${API_URL}/health" 200 30

step 'API /ready responds 200 with dependencies available'
wait_for_status "${API_URL}/ready" 200 30

step 'Production /ready body is coarse (no dependency inventory)'
ready_body="$(curl -s "${API_URL}/ready")"
echo "${ready_body}" | grep -q '"status":"ready"' || fail "unexpected /ready body: ${ready_body}"
if echo "${ready_body}" | grep -Eq 'postgres|redis|latency'; then
  fail "/ready leaks dependency details in production: ${ready_body}"
fi

step 'Readiness fails closed when Redis is stopped, then recovers'
"${COMPOSE[@]}" stop redis >/dev/null
wait_for_status "${API_URL}/ready" 503 30
not_ready_body="$(curl -s "${API_URL}/ready")"
if echo "${not_ready_body}" | grep -Eq 'postgres|redis|latency'; then
  fail "failing /ready leaks dependency details in production: ${not_ready_body}"
fi
"${COMPOSE[@]}" start redis >/dev/null
wait_for_status "${API_URL}/ready" 200 30

step 'Web artifact serves the production build'
index_html="$(curl -s "${WEB_URL}/")"
echo "${index_html}" | grep -q '<div id="root">' || fail 'web index.html missing app mount point'
echo "${index_html}" | grep -q '/assets/' || fail 'web index.html references no built assets'
if echo "${index_html}" | grep -Eq '@vite/client|src/main\.tsx'; then
  fail 'web artifact is serving Vite dev-server output, not a production build'
fi

step 'Web SPA history fallback serves index.html for client routes'
spa_body="$(curl -s "${WEB_URL}/organizations/some-client-route")"
echo "${spa_body}" | grep -q '<div id="root">' || fail 'SPA fallback did not serve index.html'

step 'Configured public API base URL is baked into the web bundle'
"${COMPOSE[@]}" exec -T web sh -c \
  "grep -rq '${EXPECTED_WEB_API_BASE_URL}' /usr/share/nginx/html/assets" \
  || fail "web bundle does not contain ${EXPECTED_WEB_API_BASE_URL}"

step 'Server secrets are absent from the web bundle'
if "${COMPOSE[@]}" exec -T web sh -c \
  "grep -rq -e '${FAKE_JWT_SECRET}' -e '${FAKE_SMTP_PASSWORD}' /usr/share/nginx/html"; then
  fail 'a server-only secret leaked into the static web assets'
fi

step 'API runtime is non-root'
api_uid="$("${COMPOSE[@]}" exec -T api id -u)"
[[ "${api_uid}" != '0' ]] || fail 'API container runs as root'

step 'Web runtime is non-root'
web_uid="$("${COMPOSE[@]}" exec -T web id -u)"
[[ "${web_uid}" != '0' ]] || fail 'web container runs as root'

step 'API application tree is not writable by the runtime user'
if "${COMPOSE[@]}" exec -T api sh -c 'touch /app/dist/write-probe 2>/dev/null'; then
  fail '/app/dist is writable by the runtime user'
fi

step 'API image hygiene: expected layout only; no .env, git metadata, or source'
# The runtime tree is exactly the three directories the Dockerfile copies.
app_layout="$("${COMPOSE[@]}" exec -T api sh -c 'ls /app' | sort | tr '\n' ' ')"
[[ "${app_layout}" == 'dist migrations node_modules ' ]] \
  || fail "unexpected /app layout: ${app_layout}"
# Outside node_modules (whose content comes from registry tarballs, not our
# build context), nothing from the local checkout may leak: no env files, no
# git metadata, no TypeScript source, no local databases or tooling state.
leaked="$("${COMPOSE[@]}" exec -T api sh -c \
  "find /app -path /app/node_modules -prune -o \\( -name '.env' -o -name '.env.*' -o -name '.git' -o -name '*.ts' -o -name '*.sqlite' -o -name '.tokensave' -o -name '.claude' \\) -print | head -5")"
[[ -z "${leaked}" ]] || fail "unexpected content in API image: ${leaked}"

step 'Fake runtime secrets do not appear in API logs'
api_logs="$("${COMPOSE[@]}" logs --no-color api migrate)"
for secret in "${FAKE_JWT_SECRET}" "${FAKE_SMTP_PASSWORD}" "${FAKE_DB_PASSWORD}"; do
  if grep -qF "${secret}" <<<"${api_logs}"; then
    fail 'a runtime secret value appeared in the API logs'
  fi
done

step 'API logs are structured JSON with request ids'
grep -qE '\{"level":[0-9]+' <<<"${api_logs}" || fail 'no structured JSON log lines found'
curl -s -o /dev/null "${API_URL}/nonexistent-smoke-path"
sleep 1
# Capture-then-grep (never `compose logs | grep -q`: with pipefail, grep -q
# exiting early SIGPIPEs docker compose and fails the pipeline spuriously).
# `requestIdLogLabel: 'requestId'` in apps/api/src/app.ts.
api_logs="$("${COMPOSE[@]}" logs --no-color api)"
grep -q '"requestId"' <<<"${api_logs}" || fail 'request logs missing requestId'

step 'Production config guard rejects a known development secret at boot'
guard_output=''
if guard_output="$(docker run --rm --entrypoint node \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgres://guard:guard@localhost:5432/guard' \
  -e REDIS_URL='redis://localhost:6379' \
  -e JWT_SECRET='dev-only-jwt-secret-change-me' \
  -e COOKIE_SECURE=true \
  -e MAIL_DRIVER=smtp \
  -e SMTP_HOST=localhost -e SMTP_USERNAME=guard -e SMTP_PASSWORD='guard-fake-1' \
  -e MAIL_FROM_EMAIL='no-reply@smoke.orgistry.dev' \
  -e WEB_DEMO_URL='https://web.production-like.orgistry.dev' \
  orgistry-api:production-like dist/server.mjs 2>&1)"; then
  fail 'API booted with a known development JWT_SECRET under NODE_ENV=production'
fi
grep -q 'JWT_SECRET' <<<"${guard_output}" || fail 'guard rejection did not name JWT_SECRET'
grep -qF 'dev-only-jwt-secret-change-me' <<<"${guard_output}" \
  && fail 'guard error echoed the rejected secret value' || true

# ---- Sprint 24 (ORG-PR-006): mounted-secret file runtime source ----
#
# Runtime secrets may be supplied as `<NAME>_FILE` paths instead of direct
# environment values. The checks below prove the artifact resolves them at
# process start, that resolution happens BEFORE the production guard (an
# unsafe file value is still refused), that an ambiguous env+file pair fails
# closed, and that a file-loaded secret never reaches the logs.

SECRET_DIR="$(mktemp -d)"
printf '%s\n' "${FAKE_FILE_JWT_SECRET}" >"${SECRET_DIR}/jwt_secret"
printf '%s\n' "${FAKE_FILE_SMTP_PASSWORD}" >"${SECRET_DIR}/smtp_password"
printf '%s\n' 'dev-only-jwt-secret-change-me' >"${SECRET_DIR}/unsafe_jwt_secret"

# DO NOT REMOVE THESE chmods — they are what makes this check work on Linux.
#
# The API artifact runs as the non-root `node` user (uid 1000). On Linux a bind
# mount passes the HOST inode through unchanged, so the container sees the real
# owner and mode: `mktemp -d` creates the directory 0700, owned by the invoking
# user (uid 1001 on a GitHub Actions runner). uid 1000 then cannot even
# TRAVERSE the directory, the secret file is unreadable, config validation
# fails, and the container exits before serving `/health`.
#
# Docker Desktop on macOS hides this: its file-sharing layer remaps ownership
# to the requesting container user, so a 0700 host directory reads fine there.
# A change tested only on macOS will therefore look correct and still fail on
# Linux CI — which is exactly how this was first found (CI run 32656512688).
#
# `chown` is not an option: the harness runs as an unprivileged user, so it
# cannot give the files away to uid 1000. Widening the mode is the portable
# mechanism. These are FAKE, throwaway values in a per-run temporary directory
# that cleanup deletes, so world-readable is appropriate here — 0755 grants
# only the traversal the runtime needs, and 0444 keeps the files read-only for
# everyone, mirroring how a real orchestrator presents a mounted secret.
chmod 0755 "${SECRET_DIR}"
chmod 0444 "${SECRET_DIR}/jwt_secret" \
           "${SECRET_DIR}/smtp_password" \
           "${SECRET_DIR}/unsafe_jwt_secret"

# Common runtime configuration for the standalone file-secret runs. `/health`
# is liveness-only, so no database or Redis is contacted by these checks.
file_secret_env=(
  -e NODE_ENV=production
  -e DATABASE_URL="postgres://smoke:${FAKE_DB_PASSWORD}@127.0.0.1:5432/smoke"
  -e REDIS_URL='redis://127.0.0.1:6379'
  -e COOKIE_SECURE=true
  -e MAIL_DRIVER=smtp
  -e SMTP_HOST=smtp.invalid
  -e SMTP_USERNAME=orgistry-smoke-mailer
  -e MAIL_FROM_EMAIL='no-reply@smoke.orgistry.dev'
  -e WEB_DEMO_URL='https://web.production-like.orgistry.dev'
)

# Replace every fake secret value with a mask. Diagnostics are only printed on
# failure, but the sprint's secret-hygiene discipline applies to them too: the
# harness must never be the thing that prints a credential-shaped value.
redact_fake_secrets() {
  sed -e "s|${FAKE_FILE_JWT_SECRET}|[REDACTED]|g" \
      -e "s|${FAKE_FILE_SMTP_PASSWORD}|[REDACTED]|g" \
      -e "s|${FAKE_JWT_SECRET}|[REDACTED]|g" \
      -e "s|${FAKE_SMTP_PASSWORD}|[REDACTED]|g" \
      -e "s|${FAKE_DB_PASSWORD}|[REDACTED]|g"
}

# The standalone file-secret container dies at boot when the mount is wrong, so
# a bare "no 200 within 30s" hides the actual cause. Print the container state,
# its exit code, the host-side fixture modes (the usual culprit), and its
# redacted logs, then fail.
diagnose_file_secret_boot_failure() {
  local reason="$1"
  {
    printf '\n-- file-secret boot diagnostics --\n'
    if docker inspect --format \
      'container: status={{.State.Status}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}}' \
      "${FILE_SECRET_CONTAINER}" 2>/dev/null; then
      :
    else
      printf 'container: %s is already gone (it exited and --rm removed it)\n' \
        "${FILE_SECRET_CONTAINER}"
    fi
    # Mode/ownership of the bind-mount source: on Linux the container sees
    # these verbatim, and a non-traversable directory is the common failure.
    printf 'host fixture (must be traversable by the non-root runtime uid):\n'
    ls -ld "${SECRET_DIR}" 2>/dev/null || true
    ls -l "${SECRET_DIR}" 2>/dev/null || true
    printf -- '-- container logs (fake secret values masked) --\n'
    docker logs "${FILE_SECRET_CONTAINER}" 2>&1 | redact_fake_secrets || true
    printf -- '-- end diagnostics --\n'
  } >&2
  fail "${reason}"
}

step 'Artifact boots with runtime secrets mounted as files (_FILE)'
# `--rm` is deliberately omitted: if the process dies at boot, the container
# must survive long enough for the diagnostics above to read its state and
# logs. Cleanup removes it on every path.
docker run -d --name "${FILE_SECRET_CONTAINER}" \
  -p 3010:3000 \
  -v "${SECRET_DIR}:/run/orgistry-secrets:ro" \
  "${file_secret_env[@]}" \
  -e JWT_SECRET_FILE=/run/orgistry-secrets/jwt_secret \
  -e SMTP_PASSWORD_FILE=/run/orgistry-secrets/smtp_password \
  orgistry-api:production-like >/dev/null
poll_status "${FILE_SECRET_API_URL}/health" 200 30 \
  || diagnose_file_secret_boot_failure \
    "${FILE_SECRET_API_URL}/health did not return 200 within 30s (last: ${LAST_POLLED_STATUS})"

step 'File-loaded secrets do not appear in the artifact logs'
file_secret_logs="$(docker logs "${FILE_SECRET_CONTAINER}" 2>&1)"
for secret in "${FAKE_FILE_JWT_SECRET}" "${FAKE_FILE_SMTP_PASSWORD}"; do
  if grep -qF "${secret}" <<<"${file_secret_logs}"; then
    fail 'a file-loaded runtime secret value appeared in the API logs'
  fi
done
docker rm -f "${FILE_SECRET_CONTAINER}" >/dev/null

step 'Production config guard rejects an UNSAFE file-loaded secret'
file_guard_output=''
if file_guard_output="$(docker run --rm \
  -v "${SECRET_DIR}:/run/orgistry-secrets:ro" \
  "${file_secret_env[@]}" \
  -e JWT_SECRET_FILE=/run/orgistry-secrets/unsafe_jwt_secret \
  -e SMTP_PASSWORD_FILE=/run/orgistry-secrets/smtp_password \
  orgistry-api:production-like 2>&1)"; then
  fail 'API booted with a known development JWT_SECRET loaded from a file'
fi
# Assert the PRODUCTION GUARD's own message, not merely the string
# "JWT_SECRET": an unreadable mount also fails the boot and also mentions
# `JWT_SECRET_FILE`, so a loose match would let a permission problem pass
# itself off as a guard rejection (that is precisely what this check exists to
# distinguish — resolution happened, THEN validation refused the value).
grep -qF 'JWT_SECRET is a known development-only default' <<<"${file_guard_output}" \
  || fail 'file-loaded secret was not rejected by the production guard (did the file even resolve?)'
grep -qF 'dev-only-jwt-secret-change-me' <<<"${file_guard_output}" \
  && fail 'file-secret guard error echoed the rejected secret value' || true

step 'Ambiguous env + file configuration for one secret is refused'
ambiguous_output=''
if ambiguous_output="$(docker run --rm \
  -v "${SECRET_DIR}:/run/orgistry-secrets:ro" \
  "${file_secret_env[@]}" \
  -e JWT_SECRET="${FAKE_JWT_SECRET}" \
  -e JWT_SECRET_FILE=/run/orgistry-secrets/jwt_secret \
  -e SMTP_PASSWORD="${FAKE_SMTP_PASSWORD}" \
  orgistry-api:production-like 2>&1)"; then
  fail 'API booted with both JWT_SECRET and JWT_SECRET_FILE set'
fi
grep -q 'both JWT_SECRET and JWT_SECRET_FILE are set' <<<"${ambiguous_output}" \
  || fail 'ambiguous secret-source rejection did not explain the conflict'
for secret in "${FAKE_JWT_SECRET}" "${FAKE_FILE_JWT_SECRET}"; do
  if grep -qF "${secret}" <<<"${ambiguous_output}"; then
    fail 'ambiguous-source error echoed a secret value'
  fi
done

step 'A missing secret file fails closed with the path but not the contents'
missing_file_output=''
if missing_file_output="$(docker run --rm \
  "${file_secret_env[@]}" \
  -e JWT_SECRET_FILE=/run/orgistry-secrets/not-mounted \
  -e SMTP_PASSWORD="${FAKE_SMTP_PASSWORD}" \
  orgistry-api:production-like 2>&1)"; then
  fail 'API booted with an unreadable JWT_SECRET_FILE'
fi
grep -q '/run/orgistry-secrets/not-mounted' <<<"${missing_file_output}" \
  || fail 'missing-secret-file error did not name the configured path'

rm -rf "${SECRET_DIR}"
SECRET_DIR=''

step 'Images declare no build-time or baked-in secret'
for image in orgistry-api:production-like orgistry-web:production-like; do
  image_env="$(docker image inspect --format '{{json .Config.Env}}' "${image}")"
  if grep -Eq 'JWT_SECRET|SMTP_PASSWORD|DATABASE_URL|_FILE' <<<"${image_env}"; then
    fail "${image} bakes a secret-bearing variable into its image config: ${image_env}"
  fi
done

step 'API stops cleanly on SIGTERM (exit 0, shutdown logged)'
"${COMPOSE[@]}" stop api >/dev/null
api_exit="$("${COMPOSE[@]}" ps -a api --format '{{.ExitCode}}')"
[[ "${api_exit}" == '0' ]] || fail "API exited with ${api_exit} on SIGTERM"
api_logs="$("${COMPOSE[@]}" logs --no-color api)"
grep -q 'Shutting down' <<<"${api_logs}" || fail 'graceful shutdown was not logged'

printf '\nSMOKE OK: all artifact checks passed.\n'
