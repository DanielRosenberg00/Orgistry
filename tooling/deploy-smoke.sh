#!/usr/bin/env bash
#
# Post-deployment smoke test (Sprint 26, ORG-PR-001).
#
# Validates a DEPLOYED Orgistry from the outside, over HTTP only. It is the
# gate tooling/deploy.sh runs after the containers are up, and it is equally
# runnable by hand against any reachable deployment:
#
#   tooling/deploy-smoke.sh --api-url https://api.example.test \
#                           --web-url https://app.example.test
#
# WHAT IT PROVES
#   1. the API answers /health (liveness);
#   2. the API answers /ready (dependencies reachable);
#   3. the production readiness body stays coarse — no dependency inventory
#      (Sprint 19 disclosure policy);
#   4. every API response carries the security-header baseline (Sprint 19);
#   5. a client-supplied request ID is echoed back, so log correlation works
#      through whatever proxy sits in front of the deployment;
#   6. the web artifact serves a production build (not a dev server);
#   7. the SPA history fallback works, so deep links resolve;
#   8. the deployment applied the intended PUBLIC browser configuration, and
#      the API origin is NOT baked into the immutable bundle — the property that
#      keeps one web digest promotable between environments.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   * No authenticated request. Doing so needs a credential, and Orgistry has
#     no dedicated safe test tenant or API key in any environment. Creating
#     production credentials to satisfy a checklist would be a worse outcome
#     than an unproven check — see docs/deployment.md ("Post-deployment smoke").
#   * No database access, no secrets, no configuration reading. The migration
#     head is verified by tooling/deploy.sh, which has the database in front of
#     it; this script must stay runnable from anywhere that can reach the URLs.
#   * No mutation of any kind.
#
# OUTPUT SAFETY: only status codes, header names, URLs, and short body markers
# are printed. Response bodies are never dumped wholesale — a failing endpoint
# can echo request context, and this script must never be the thing that prints
# it into a CI log.
#
# Requires: bash + curl. Exits 0 only when every check passed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG_PREFIX='deploy-smoke'
# shellcheck source=tooling/lib/deploy-common.sh
source "${REPO_ROOT}/tooling/lib/deploy-common.sh"

API_URL=''
WEB_URL=''
EXPECTED_API_ORIGIN=''
ALLOW_VERBOSE_READY=0
TIMEOUT_SECONDS=60
CHECKS_PASSED=0
# The zero-configuration default compiled into the web bundle
# (apps/web-demo/src/public-config.ts). Only used to decide whether the
# "no environment identity in the bundle" check can prove anything.
PUBLIC_CONFIG_FALLBACK_ORIGIN='http://localhost:3000'

usage() {
  cat <<'USAGE'
Usage: tooling/deploy-smoke.sh --api-url URL --web-url URL [options]

  --api-url URL              Base URL of the deployed API (required).
  --web-url URL              Base URL of the deployed web artifact (required).
  --expected-api-origin URL  Public API origin the DEPLOYMENT should have
                             configured the browser with. Defaults to
                             --api-url. Pass explicitly when the deployer
                             reaches the API on a different address than the
                             browser does (e.g. loopback vs public hostname).
  --allow-verbose-ready      Permit a detailed /ready body. Only for a
                             deployment deliberately NOT running with
                             NODE_ENV=production.
  --timeout SECONDS          Readiness wait budget (default 60).
  --help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    # `pnpm deploy -- --flag` forwards a bare `--`; treat it as the
    # conventional end-of-options marker rather than an unknown argument.
    --) shift ;;
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --web-url) WEB_URL="${2:-}"; shift 2 ;;
    --expected-api-origin) EXPECTED_API_ORIGIN="${2:-}"; shift 2 ;;
    --allow-verbose-ready) ALLOW_VERBOSE_READY=1; shift ;;
    --timeout) TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) deploy_die "unknown argument \"$1\" (try --help)" ;;
  esac
done

deploy_stage 'Validate smoke inputs'
deploy_require_command curl 'the smoke test probes the deployment over HTTP'
[[ -n "${API_URL}" ]] || deploy_die '--api-url is required'
[[ -n "${WEB_URL}" ]] || deploy_die '--web-url is required'
[[ "${TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] || deploy_die '--timeout must be a whole number of seconds'
# Trailing slashes would produce double-slashed request paths.
API_URL="${API_URL%/}"
WEB_URL="${WEB_URL%/}"
EXPECTED_API_ORIGIN="${EXPECTED_API_ORIGIN:-${API_URL}}"
EXPECTED_API_ORIGIN="${EXPECTED_API_ORIGIN%/}"
deploy_info "API ${API_URL}"
deploy_info "web ${WEB_URL}"
deploy_info "expected browser-facing API origin ${EXPECTED_API_ORIGIN}"

pass() {
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
  printf '   ok  %s\n' "$1"
}

deploy_stage 'API liveness (/health)'
deploy_wait_for_status "${API_URL}/health" 200 "${TIMEOUT_SECONDS}" 'API liveness'
health_body="$(curl -sS --max-time 10 "${API_URL}/health")"
grep -q '"status":"ok"' <<<"${health_body}" \
  || deploy_die '/health returned 200 but not the expected {"status":"ok"} envelope'
pass '/health reports ok'

deploy_stage 'API readiness (/ready)'
deploy_wait_for_status "${API_URL}/ready" 200 "${TIMEOUT_SECONDS}" 'API readiness'
ready_body="$(curl -sS --max-time 10 "${API_URL}/ready")"
grep -q '"status":"ready"' <<<"${ready_body}" \
  || deploy_die '/ready returned 200 but not the expected {"status":"ready"} envelope'
pass '/ready reports ready'

deploy_stage 'Readiness disclosure stays coarse'
if (( ALLOW_VERBOSE_READY == 1 )); then
  deploy_info 'skipped by --allow-verbose-ready (deployment is not production-mode)'
else
  # A production /ready must not enumerate dependencies: that tells an
  # unauthenticated caller which backing services exist and which one is down.
  if grep -Eq 'postgres|redis|latency' <<<"${ready_body}"; then
    deploy_die '/ready disclosed dependency details — the deployment is not running with NODE_ENV=production'
  fi
  pass '/ready body names no dependency'
fi

deploy_stage 'API security headers'
# Header names only are printed on failure; header VALUES are not echoed.
headers="$(curl -sS -o /dev/null -D - --max-time 10 "${API_URL}/health")"
for header in \
  'x-content-type-options' \
  'x-frame-options' \
  'referrer-policy' \
  'cross-origin-opener-policy' \
  'cross-origin-resource-policy' \
  'permissions-policy'; do
  grep -qi "^${header}:" <<<"${headers}" \
    || deploy_die "API response is missing the ${header} security header"
done
pass 'six baseline security headers present'

deploy_stage 'Request-ID propagation'
# The value matches the API's accepted request-ID format, so it must be echoed
# verbatim rather than replaced. It carries no information about the caller.
probe_request_id="deploy-smoke-$(date -u '+%Y%m%dT%H%M%SZ')"
echoed_id="$(curl -sS -o /dev/null -D - --max-time 10 \
  -H "x-request-id: ${probe_request_id}" "${API_URL}/health" \
  | grep -i '^x-request-id:' | tr -d '\r' | awk '{print $2}')"
[[ "${echoed_id}" == "${probe_request_id}" ]] \
  || deploy_die "x-request-id was not propagated (sent ${probe_request_id}, received ${echoed_id:-nothing})"
pass 'x-request-id echoed unchanged'

deploy_stage 'Web artifact serves a production build'
deploy_wait_for_status "${WEB_URL}/" 200 "${TIMEOUT_SECONDS}" 'web artifact'
index_html="$(curl -sS --max-time 10 "${WEB_URL}/")"
grep -q '<div id="root">' <<<"${index_html}" || deploy_die 'web index.html has no application mount point'
grep -q '/assets/' <<<"${index_html}" || deploy_die 'web index.html references no built assets'
if grep -Eq '@vite/client|src/main\.tsx' <<<"${index_html}"; then
  deploy_die 'the web deployment is serving Vite dev-server output, not a production build'
fi
pass 'web serves built production assets'

deploy_stage 'SPA history fallback'
spa_body="$(curl -sS --max-time 10 "${WEB_URL}/organizations/deploy-smoke-route")"
grep -q '<div id="root">' <<<"${spa_body}" \
  || deploy_die 'SPA history fallback did not serve index.html for a client route'
pass 'client routes resolve through the SPA fallback'

deploy_stage 'Deployment applied the expected public browser configuration'
# The API origin is RUNTIME configuration served by the deployment, not a value
# compiled into the bundle. Reading it back from the browser's own endpoint is
# how a misconfigured deployment is caught before users are.
public_config="$(curl -sS --max-time 10 "${WEB_URL}/public-config.js")"
grep -q 'window.__ORGISTRY_PUBLIC_CONFIG__' <<<"${public_config}" \
  || deploy_die "${WEB_URL}/public-config.js did not serve a runtime configuration object"
grep -qF "\"apiBaseUrl\":\"${EXPECTED_API_ORIGIN}\"" <<<"${public_config}" \
  || deploy_die "the deployment serves a different browser API origin than expected (wanted ${EXPECTED_API_ORIGIN}); check ORGISTRY_PUBLIC_API_BASE_URL for this environment"
pass "runtime public configuration targets ${EXPECTED_API_ORIGIN}"

deploy_stage 'The web artifact carries no environment identity'
# If the environment's own origin appears inside the immutable bundle, the image
# was built for this environment and can no longer be promoted to another. The
# check is skipped only when the expected origin IS the image's compiled-in
# zero-configuration default, where its presence proves nothing either way.
asset_path="$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' <<<"${index_html}" | head -n 1 || true)"
[[ -n "${asset_path}" ]] || deploy_die 'could not locate a JavaScript asset in the served index.html'
if [[ "${EXPECTED_API_ORIGIN}" == "${PUBLIC_CONFIG_FALLBACK_ORIGIN}" ]]; then
  deploy_info "skipped: this environment uses the image's built-in default origin (${PUBLIC_CONFIG_FALLBACK_ORIGIN})"
else
  asset_body="$(curl -sS --max-time 30 "${WEB_URL}${asset_path}")"
  if grep -qF "${EXPECTED_API_ORIGIN}" <<<"${asset_body}"; then
    deploy_die "the deployed bundle (${asset_path}) hard-codes ${EXPECTED_API_ORIGIN}; this web image is environment-specific and cannot be promoted"
  fi
  pass 'the deployed bundle hard-codes no environment API origin'
fi

printf '\nDEPLOY SMOKE OK: %s checks passed.\n' "${CHECKS_PASSED}"
