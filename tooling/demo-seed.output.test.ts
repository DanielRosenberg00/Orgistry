import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Demo bootstrap output contract (Sprint 22, ORG-PR-056).
 *
 * The Definition of Done requires that no raw secret, token, password,
 * Authorization value, or cookie reaches a logging sink — and a terminal is a
 * logging sink: scrollback, screen shares, terminal recordings, CI transcripts,
 * and redirected stdout all retain it.
 *
 * These tests run the REAL script as a child process against a stub API on
 * loopback and inspect everything it actually wrote to stdout and stderr. That
 * is deliberately end-to-end rather than a source scan: it would catch a
 * credential emitted through any output primitive, including ones a static
 * check would not think to look for.
 */

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

const OWNER_PASSWORD = 'demo-password-123';
const ACCESS_TOKEN = 'stub-access-token-ffd3a1c47b90e5628a1f';
const ORG_ID = 'org_STUBORG000000000000000001';

let server: Server;
let baseUrl: string;
let requests: RecordedRequest[];

/**
 * A stub Orgistry API covering exactly the endpoints the bootstrap touches on
 * the login-first (idempotent re-run) path. Login succeeding means Mailpit is
 * never consulted, which keeps this test hermetic.
 *
 * It answers every API-key route too — so if the bootstrap ever starts creating
 * keys again, the request is RECORDED rather than failing the run for an
 * unrelated reason, and the assertion below names the real problem.
 */
function buildStubApi(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?', 1)[0] ?? '';
      requests.push({
        method: req.method ?? '',
        path,
        body: raw ? JSON.parse(raw) : null,
      });

      const send = (data: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      };

      if (path === '/v1/auth/login') {
        send({ tokens: { accessToken: ACCESS_TOKEN } });
      } else if (path === '/v1/organizations' && req.method === 'GET') {
        send({ items: [] });
      } else if (path === '/v1/organizations' && req.method === 'POST') {
        send({ organization: { id: ORG_ID, name: 'Acme Corp' } });
      } else if (path.endsWith('/plan/demo')) {
        send({ plan: { name: 'Pro' } });
      } else if (path.endsWith('/projects') && req.method === 'GET') {
        send({ items: [] });
      } else if (path.endsWith('/projects') && req.method === 'POST') {
        send({ project: { id: 'prj_stub', name: 'stub' } });
      } else if (path.endsWith('/invitations')) {
        send({ invitation: { id: 'inv_stub' } });
      } else if (path.endsWith('/api-keys') && req.method === 'GET') {
        send({ items: [] });
      } else if (path.endsWith('/api-keys') && req.method === 'POST') {
        // If this is ever reached, the assertions below fail loudly and
        // explain why. The response deliberately contains a secret-shaped
        // value so a regression would show up in captured output.
        send({
          apiKey: { id: 'key_stub', name: 'Demo Read Key' },
          secret: 'orgistry_STUBKEY1_leakcanary0000000000000000000',
        });
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: path } }),
        );
      }
    });
  });
}

function runDemoSeed(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tooling/demo-seed.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEMO_API_BASE_URL: baseUrl,
        VITE_MAILPIT_URL: baseUrl,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeEach(async () => {
  requests = [];
  server = buildStubApi();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('pnpm demo:seed — output carries no credential', () => {
  it('completes successfully against a loopback API', async () => {
    const { code, stderr } = await runDemoSeed();
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('creates no API key, so no one-time secret is ever produced', async () => {
    await runDemoSeed();
    const apiKeyRequests = requests.filter((entry) =>
      entry.path.includes('/api-keys'),
    );
    expect(apiKeyRequests).toEqual([]);
  });

  it('emits no password, token, or key secret on stdout or stderr', async () => {
    const { stdout, stderr } = await runDemoSeed();
    const emitted = `${stdout}\n${stderr}`;

    // The literal values that exist during this run and must never be written.
    expect(emitted).not.toContain(OWNER_PASSWORD);
    expect(emitted).not.toContain(ACCESS_TOKEN);
    // The stub's key secret, which only appears if key creation regressed.
    expect(emitted).not.toContain('leakcanary');

    // Shape-level checks, so a DIFFERENT credential would also be caught:
    // an Orgistry API key, a bearer header, or a long opaque token.
    expect(emitted).not.toMatch(/orgistry_[A-Z0-9]{6,}_/);
    expect(emitted).not.toMatch(/Bearer\s+\S+/);
    expect(emitted).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('still prints the metadata an operator needs', async () => {
    const { stdout } = await runDemoSeed();
    expect(stdout).toContain('Demo state ready.');
    expect(stdout).toContain('demo.owner@orgistry.local');
    expect(stdout).toContain(ORG_ID);
    expect(stdout).toContain('http://localhost:5173');
  });

  it('directs the operator to the web demo for an API key', async () => {
    const { stdout } = await runDemoSeed();
    expect(stdout).toContain('API Keys');
    expect(stdout).toContain('shown once, in your browser');
    // Points at documentation for the password rather than reprinting it.
    expect(stdout).toContain('docs/demo-walkthrough.md');
  });

  it('leaves the rest of the bootstrap flow intact', async () => {
    await runDemoSeed();
    const performed = requests.map((entry) => `${entry.method} ${entry.path}`);

    expect(performed).toContain('POST /v1/auth/login');
    expect(performed).toContain('GET /v1/organizations');
    expect(performed).toContain('POST /v1/organizations');
    expect(performed).toContain(`PATCH /v1/organizations/${ORG_ID}/plan/demo`);
    expect(performed).toContain(`GET /v1/organizations/${ORG_ID}/projects`);
    expect(performed).toContain(`POST /v1/organizations/${ORG_ID}/invitations`);
    // Three demo projects, as before.
    expect(
      performed.filter(
        (entry) => entry === `POST /v1/organizations/${ORG_ID}/projects`,
      ),
    ).toHaveLength(3);
  });

  it('refuses a non-loopback target before issuing any request', async () => {
    const child = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const proc = spawn(process.execPath, ['tooling/demo-seed.mjs'], {
          cwd: process.cwd(),
          env: { ...process.env, DEMO_API_BASE_URL: 'https://api.example.com' },
        });
        let stderr = '';
        proc.stderr.on('data', (chunk) => (stderr += String(chunk)));
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code, stderr }));
      },
    );

    expect(child.code).toBe(1);
    expect(child.stderr).toMatch(/non-loopback API/);
    // The guard runs before the first request, so nothing was seeded anywhere.
    expect(requests).toEqual([]);
  });
});
