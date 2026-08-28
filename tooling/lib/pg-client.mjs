/**
 * Containerised PostgreSQL client access for the Node backup tooling
 * (Sprint 28, ORG-PR-005).
 *
 * This is the Node-side counterpart to tooling/lib/pg-tools.sh and follows the
 * same two rules for the same reasons:
 *
 *   1. Every client program runs from the SAME pinned PostgreSQL image the
 *      repository runs its servers from, so a client can never drift from a
 *      server in a way that only surfaces during a real recovery.
 *   2. The connection URL reaches the container through an ENVIRONMENT
 *      VARIABLE. It is never an argument, never a filename, and never logged —
 *      arguments are visible in `ps` output to every account on the host.
 *
 * The pinned image is READ FROM pg-tools.sh rather than repeated here. Two
 * copies of a digest is two things to update and one thing to forget; the
 * shell file remains the single source of truth and this module fails loudly if
 * it cannot find it.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIBRARY_DIR = dirname(fileURLToPath(import.meta.url));
const PG_TOOLS_PATH = join(LIBRARY_DIR, 'pg-tools.sh');

let cachedImage = '';

/** The pinned `postgres:...@sha256:...` reference declared by pg-tools.sh. */
export function pinnedPostgresImage() {
  if (cachedImage) return cachedImage;
  const source = readFileSync(PG_TOOLS_PATH, 'utf8');
  const match = source.match(/^ORGISTRY_PG_IMAGE='([^']+)'/m);
  if (!match) {
    throw new Error(`could not read ORGISTRY_PG_IMAGE from ${PG_TOOLS_PATH}`);
  }
  cachedImage = match[1];
  return cachedImage;
}

/**
 * A loopback host in a URL means the CONTAINER when the client is containerised.
 * Rewrite it to the host gateway, exactly as pg_host_gateway_url does.
 */
export function toHostGatewayUrl(databaseUrl) {
  return databaseUrl.replace('@localhost:', '@host.docker.internal:').replace('@127.0.0.1:', '@host.docker.internal:');
}

/**
 * Run one PostgreSQL client command in the pinned image.
 *
 * `command` is a shell string executed inside the container; the URL is
 * available to it as `$ORGISTRY_PG_URL`. Every call site in this repository
 * passes a literal command with no interpolation of untrusted input.
 *
 * `stdoutPath`, when given, receives the command's stdout — that is how
 * `pg_basebackup` streams a tar archive straight to a file without it ever
 * passing through this process's memory.
 */
export function runPostgresClient({
  command,
  databaseUrl,
  dockerNetwork = '',
  stdinData = null,
  stdoutStream = null,
  extraDockerArgs = [],
}) {
  const dockerArgs = ['run', '--rm', '--interactive'];
  let urlForContainer = databaseUrl;
  if (dockerNetwork) {
    dockerArgs.push('--network', dockerNetwork);
  } else {
    dockerArgs.push('--add-host', 'host.docker.internal:host-gateway');
    urlForContainer = toHostGatewayUrl(databaseUrl);
  }
  dockerArgs.push(...extraDockerArgs);
  dockerArgs.push('--env', `ORGISTRY_PG_URL=${urlForContainer}`, '--entrypoint', 'sh', pinnedPostgresImage(), '-c', command);

  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', dockerArgs, {
      stdio: [stdinData === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdinData !== null) {
      child.stdin.end(stdinData);
    }

    let stdout = '';
    let stderr = '';
    if (stdoutStream) {
      child.stdout.pipe(stdoutStream);
    } else {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      // stderr from psql/pg_dump names the actual cause and — because the URL
      // was passed by environment — cannot contain the connection string.
      reject(new Error(`PostgreSQL client exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });
}

/**
 * Run a query and return its rows as arrays of column strings.
 *
 * The statement is delivered on psql's STDIN, never as `--command` inside a
 * shell string. SQL routinely contains double quotes and dollar signs; putting
 * it through a shell would require escaping that is easy to get subtly wrong,
 * and the failure mode is not an error but a query that runs and returns
 * something slightly different from what was written.
 */
export async function queryRows({ statement, databaseUrl, dockerNetwork }) {
  const command =
    "psql \"$ORGISTRY_PG_URL\" --no-psqlrc --tuples-only --no-align --quiet " +
    "--field-separator='\t' --set ON_ERROR_STOP=1 --file -";
  const { stdout } = await runPostgresClient({
    command,
    databaseUrl,
    dockerNetwork,
    stdinData: `${statement};\n`,
  });
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
}

/** Run a query expected to return exactly one value. */
export async function queryScalar({ statement, databaseUrl, dockerNetwork }) {
  const rows = await queryRows({ statement, databaseUrl, dockerNetwork });
  return rows.length > 0 ? rows[0][0] : '';
}
