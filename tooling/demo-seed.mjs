// Demo bootstrap for the Orgistry web demo.
//
// Drives the REAL public HTTP API (never the database directly), so every
// invariant the backend enforces — registration provisioning, permissions,
// entitlements, quotas — holds exactly as it would for a human operator. The
// goal is a one-command, presentable demo state: a signed-up owner, a team
// organization on the Pro plan, a few projects, and a pending invitation
// (visible in Mailpit).
//
// Requirements: the API must be running (`pnpm dev:api`) with PostgreSQL/Redis
// up (`pnpm infra:up`). Re-running is safe: existing demo state is reused, not
// duplicated.
//
// THIS TOOL PRINTS NO CREDENTIALS (Sprint 22, ORG-PR-056). It creates no API
// key, and it emits no secret, token, password, or Authorization value on any
// output stream. That is a deliberate boundary, not an oversight: a terminal is
// a logging sink like any other — scrollback, screen shares, terminal
// recordings, CI transcripts, and redirected stdout all retain whatever is
// written to it, and a one-time credential printed there survives far longer
// than the moment it was needed.
//
// An API key is therefore minted interactively instead, in the web demo at
// `/app/api-keys`, where the backend returns the raw secret exactly once to the
// requesting browser and no server- or tool-side copy exists. See
// docs/demo-walkthrough.md.
//
// The demo identities this tool seeds are LOCAL-ONLY published values (they
// live in docs/demo-walkthrough.md) and must never be used outside a throwaway
// local database. `assertLocalTarget` enforces that: the tool refuses any
// non-loopback API target before it makes a single request.

import { assertLocalTarget } from './lib/demo-target-guard.mjs';

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

/**
 * Recover the newest registration-completion token Mailpit received for an
 * address. Registration is verification-first (Sprint 18): the API only ever
 * answers `{ accepted: true }`, and the completion token travels exclusively
 * in the emailed link — so the seed reads it from Mailpit's API, exactly as a
 * human operator would read their mailbox.
 */
async function fetchCompletionTokenFromMailpit(email) {
  const search = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
  ).catch(() => null);
  if (!search || !search.ok) {
    throw new Error(
      `Cannot reach Mailpit at ${MAILPIT_URL} to read the registration email. Is it running (\`pnpm infra:up\`)?`,
    );
  }
  const { messages = [] } = await search.json();
  // NEWEST first, explicitly: a shared Mailpit may hold stale messages from
  // earlier runs, and every re-request supersedes older links — only the most
  // recent completion email carries a usable token.
  const newestFirst = [...messages].sort(
    (a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime(),
  );
  for (const summary of newestFirst) {
    const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${summary.ID}`);
    if (!detail.ok) continue;
    const message = await detail.json();
    const match = (message.Text ?? '').match(
      /\/auth\/complete-registration#token=([^\s&]+)/,
    );
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  throw new Error(
    `No registration-completion email found in Mailpit for ${email}. ` +
      'If this address already has an account with a different password, no completion email is ever sent — reset the demo database or recover the password instead.',
  );
}

async function ensureOwnerSession() {
  // Login first: if the demo owner already exists this is the whole flow.
  const loggedIn = await apiCall('POST', '/v1/auth/login', {
    auth: false,
    body: { email: OWNER.email, password: OWNER.password },
  });
  if (loggedIn.ok) {
    accessToken = loggedIn.data.tokens.accessToken;
    log('auth', `Logged in existing demo owner ${OWNER.email}.`);
    return;
  }
  if (loggedIn.code !== 'INVALID_CREDENTIALS') {
    throw new Error(`Owner login failed: ${loggedIn.code} — ${loggedIn.message}`);
  }

  // Verification-first registration (Sprint 18): request -> generic accepted,
  // completion email lands in Mailpit -> complete -> authenticated session +
  // personal workspace, exactly the flow a real user drives.
  expectOk(
    await apiCall('POST', '/v1/auth/register', {
      auth: false,
      body: { email: OWNER.email, password: OWNER.password, displayName: OWNER.displayName },
    }),
    'Owner registration request',
  );
  const completionToken = await fetchCompletionTokenFromMailpit(OWNER.email);
  const completed = expectOk(
    await apiCall('POST', '/v1/auth/registration/complete', {
      auth: false,
      body: { token: completionToken },
    }),
    'Owner registration completion',
  );
  accessToken = completed.tokens.accessToken;
  log(
    'auth',
    `Registered demo owner ${OWNER.email} via email completion (personal workspace provisioned).`,
  );
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

// NOTE: this tool deliberately does NOT create an API key. The create endpoint
// returns the raw secret exactly once, and the only thing a CLI could do with
// it is write it somewhere — a terminal, a file, an environment variable — all
// of which outlive the need. Key creation belongs where the secret can be
// delivered straight to a human and then discarded: the web demo's API Keys
// page. Removing it here is what makes "this tool prints no credentials" a
// property of the code rather than a promise in a comment.

async function main() {
  assertLocalTarget(API_BASE_URL);
  console.log(`Orgistry demo bootstrap → ${API_BASE_URL}\n`);

  await ensureOwnerSession();
  const orgId = await ensureTeamOrganization();
  await ensureProPlan(orgId);
  await ensureProjects(orgId);
  await ensureInvitation(orgId);

  // Summary: identifiers and locations only. The owner's password is a
  // published local-only value and lives in docs/demo-walkthrough.md — it is
  // pointed at rather than reprinted, so this tool has no output path that
  // carries a credential of any kind.
  console.log('\n──────────────────────────────────────────────────────');
  console.log('Demo state ready.');
  console.log(`  Web demo:        http://localhost:5173`);
  console.log(`  Owner sign-in:   ${OWNER.email}`);
  console.log(`  Owner password:  see docs/demo-walkthrough.md (local-only)`);
  console.log(`  Team org id:     ${orgId}`);
  console.log(`  Mailpit (email): ${MAILPIT_URL}`);
  console.log('');
  console.log('  Need an API key for the external API?');
  console.log('  Create one in the web demo under Organization → API Keys.');
  console.log('  The raw secret is shown once, in your browser, and is never');
  console.log('  written to this terminal. Walkthrough steps 12-13.');
  console.log('──────────────────────────────────────────────────────');
}

main().catch((error) => {
  console.error(`\nDemo bootstrap failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
