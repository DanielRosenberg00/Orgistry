#!/usr/bin/env bash
#
# Artifact smoke test (Sprint 23, ORG-PR-001).
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
#   12. every container/network/volume is removed afterwards.
#
# Deterministic and self-contained: needs docker (compose v2) + curl, no
# workspace install, no real secrets, no published images. Run locally via
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

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'SMOKE FAIL: %s\n' "$1" >&2; exit 1; }

cleanup() {
  step 'Cleanup: removing containers, networks, and volumes'
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Poll a URL until it returns the expected HTTP status or the timeout elapses.
wait_for_status() {
  local url="$1" expected="$2" timeout_seconds="$3" status
  for _ in $(seq 1 "${timeout_seconds}"); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "${url}" || true)"
    if [[ "${status}" == "${expected}" ]]; then
      return 0
    fi
    sleep 1
  done
  fail "${url} did not return ${expected} within ${timeout_seconds}s (last: ${status})"
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

step 'API stops cleanly on SIGTERM (exit 0, shutdown logged)'
"${COMPOSE[@]}" stop api >/dev/null
api_exit="$("${COMPOSE[@]}" ps -a api --format '{{.ExitCode}}')"
[[ "${api_exit}" == '0' ]] || fail "API exited with ${api_exit} on SIGTERM"
api_logs="$("${COMPOSE[@]}" logs --no-color api)"
grep -q 'Shutting down' <<<"${api_logs}" || fail 'graceful shutdown was not logged'

printf '\nSMOKE OK: all artifact checks passed.\n'
