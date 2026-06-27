// Demo bootstrap for the Orgistry web demo.
//
// Drives the REAL public HTTP API (never the database directly), so every
// invariant the backend enforces — registration provisioning, permissions,
// entitlements, quotas — holds exactly as it would for a human operator. The
// goal is a one-command, presentable demo state: a signed-up owner, a team
// organization on the Pro plan, a few projects, a pending invitation (visible in
// Mailpit), and an API key whose one-time secret is printed for you to try the
// external API.
//
// Requirements: the API must be running (`pnpm dev:api`) with PostgreSQL/Redis
// up (`pnpm infra:up`). Re-running is safe: existing demo state is reused, not
// duplicated.
//
// The credentials below are LOCAL-ONLY demo values. They are not secrets and
// must never be used outside a throwaway local database.

const API_BASE_URL =
  process.env.DEMO_API_BASE_URL ??
  process.env.VITE_API_BASE_URL ??
  'http://localhost:3000';

const MAILPIT_URL = process.env.VITE_MAILPIT_URL ?? 'http://localhost:8025';

// Local-only demo identities. Documented in docs/demo-walkthrough.md.
const OWNER = {
  email: 'demo.owner@orgistry.local',
  password: 'demo-password-123',
  displayName: 'Demo Owner',
};
const INVITEE_EMAIL = 'demo.invitee@orgistry.local';
const TEAM_ORG_NAME = 'Acme Corp';
const PROJECT_NAMES = ['Website Relaunch', 'Mobile App', 'Internal Tools'];

let accessToken = null;

/** Call the API, unwrap the success envelope, and surface error envelopes. */
async function apiCall(method, path, { body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(
      `Cannot reach the API at ${API_BASE_URL}. Is it running (\`pnpm dev:api\`)? ` +
        `Underlying error: ${cause instanceof Error ? cause.message : cause}`,
    );
  }

  const envelope = await response.json().catch(() => null);
  if (envelope && envelope.ok === true) {
    return { ok: true, data: envelope.data };
  }
  const error = envelope && envelope.error ? envelope.error : { code: 'UNKNOWN', message: 'Unknown error' };
  return { ok: false, status: response.status, code: error.code, message: error.message };
}

/** Throw on an unexpected error envelope; return data on success. */
function expectOk(result, context) {
  if (!result.ok) {
    throw new Error(`${context} failed: ${result.code} — ${result.message}`);
  }
  return result.data;
}

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

async function ensureOwnerSession() {
  // Register provisions the account + a personal workspace atomically. If the
  // demo owner already exists, registration is a CONFLICT and we log in instead.
  const registered = await apiCall('POST', '/v1/auth/register', {
    auth: false,
    body: { email: OWNER.email, password: OWNER.password, displayName: OWNER.displayName },
  });

  if (registered.ok) {
    accessToken = registered.data.tokens.accessToken;
    log('auth', `Registered demo owner ${OWNER.email} (personal workspace provisioned).`);
    return;
  }

  if (registered.code !== 'CONFLICT' && registered.code !== 'EMAIL_ALREADY_REGISTERED') {
    throw new Error(`Owner registration failed: ${registered.code} — ${registered.message}`);
  }

  const loggedIn = expectOk(
    await apiCall('POST', '/v1/auth/login', {
      auth: false,
      body: { email: OWNER.email, password: OWNER.password },
    }),
    'Owner login',
  );
  accessToken = loggedIn.tokens.accessToken;
  log('auth', `Logged in existing demo owner ${OWNER.email}.`);
}

async function ensureTeamOrganization() {
  const list = expectOk(await apiCall('GET', '/v1/organizations'), 'List organizations');
  const existing = list.items.find((entry) => entry.organization.name === TEAM_ORG_NAME);
  if (existing) {
    log('org', `Reusing team organization "${TEAM_ORG_NAME}" (${existing.organization.id}).`);
    return existing.organization.id;
  }

  const created = expectOk(
    await apiCall('POST', '/v1/organizations', { body: { name: TEAM_ORG_NAME } }),
    'Create team organization',
  );
  log('org', `Created team organization "${TEAM_ORG_NAME}" (${created.organization.id}).`);
  return created.organization.id;
}

async function ensureProPlan(orgId) {
  const result = await apiCall('PATCH', `/v1/organizations/${orgId}/plan/demo`, {
    body: { planKey: 'pro' },
  });
  const data = expectOk(result, 'Upgrade plan to Pro');
  log('plan', `Team organization on the ${data.plan.name} plan (API keys + audit enabled).`);
}

async function ensureProjects(orgId) {
  const list = expectOk(
    await apiCall('GET', `/v1/organizations/${orgId}/projects`),
    'List projects',
  );
  const existingNames = new Set(list.items.map((project) => project.name));

  for (const name of PROJECT_NAMES) {
    if (existingNames.has(name)) {
      log('projects', `Project "${name}" already exists — skipping.`);
      continue;
    }
    expectOk(
      await apiCall('POST', `/v1/organizations/${orgId}/projects`, { body: { name } }),
      `Create project "${name}"`,
    );
    log('projects', `Created project "${name}".`);
  }
}

async function ensureInvitation(orgId) {
  const result = await apiCall('POST', `/v1/organizations/${orgId}/invitations`, {
    body: { email: INVITEE_EMAIL, role: 'member' },
  });
  if (result.ok) {
    log('invite', `Invited ${INVITEE_EMAIL} (member). Email delivered to Mailpit: ${MAILPIT_URL}`);
    return;
  }
  if (result.code === 'CONFLICT') {
    log('invite', `Pending invitation for ${INVITEE_EMAIL} already exists — skipping.`);
    return;
  }
  throw new Error(`Create invitation failed: ${result.code} — ${result.message}`);
}

async function ensureApiKey(orgId) {
  const list = expectOk(
    await apiCall('GET', `/v1/organizations/${orgId}/api-keys`),
    'List API keys',
  );
  if (list.items.length > 0) {
    log('apikey', `An API key already exists (secret shown only at creation). Revoke + re-run to mint a fresh one.`);
    return null;
  }

  const created = expectOk(
    await apiCall('POST', `/v1/organizations/${orgId}/api-keys`, {
      body: { name: 'Demo Read Key', scopes: ['projects:read'] },
    }),
    'Create API key',
  );
  log('apikey', `Created API key "${created.apiKey.name}" — secret shown once below.`);
  return created.secret;
}

async function main() {
  console.log(`Orgistry demo bootstrap → ${API_BASE_URL}\n`);

  await ensureOwnerSession();
  const orgId = await ensureTeamOrganization();
  await ensureProPlan(orgId);
  await ensureProjects(orgId);
  await ensureInvitation(orgId);
  const apiKeySecret = await ensureApiKey(orgId);

  console.log('\n──────────────────────────────────────────────────────');
  console.log('Demo state ready. Local-only credentials:');
  console.log(`  Web demo:        http://localhost:5173`);
  console.log(`  Owner email:     ${OWNER.email}`);
  console.log(`  Owner password:  ${OWNER.password}`);
  console.log(`  Team org id:     ${orgId}`);
  console.log(`  Mailpit (email): ${MAILPIT_URL}`);
  if (apiKeySecret) {
    console.log(`\n  API key secret (shown ONCE — copy it now):`);
    console.log(`    ${apiKeySecret}`);
    console.log(`\n  Try the external API:`);
    console.log(`    curl -H "Authorization: Bearer ${apiKeySecret}" ${API_BASE_URL}/v1/external/projects`);
  }
  console.log('──────────────────────────────────────────────────────');
}

main().catch((error) => {
  console.error(`\nDemo bootstrap failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
