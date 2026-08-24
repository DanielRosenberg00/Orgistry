#!/usr/bin/env node
//
// Release-eligibility CLI (Sprint 26 refinement).
//
// Proves, before anything is published, that every required check succeeded for
// the EXACT commit being released, and writes that evidence to a file the
// release manifest embeds. The decision logic lives in
// tooling/lib/release-gates.mjs; this file is the GitHub API boundary.
//
// Usage:
//   release-gates.mjs verify --repository OWNER/REPO --sha SHA --output PATH \
//       [--release-branch main] [--timeout-seconds 1800] [--poll-seconds 20]
//
// RACE BEHAVIOR — the deliberate choice.
// `Release` is triggered by the same push that starts CI, Security scans, and
// CodeQL, so the gates are normally still running when this begins. Rather than
// guess, it POLLS with a bounded timeout and three distinct outcomes:
//
//   satisfied -> write evidence, exit 0
//   failed    -> exit non-zero IMMEDIATELY (a failure never becomes a success)
//   pending   -> keep waiting; on timeout, exit non-zero naming what was still
//                pending, so the operator re-dispatches `Release` once the
//                gates finish
//
// "Run not found yet" is treated as pending, never as success.
//
// AUTHENTICATION: the caller's GITHUB_TOKEN, which needs only `actions: read`
// (plus `contents: read` for the branch-reachability check). The token is read
// from the environment, sent only as an Authorization header, and never logged.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  GATE_STATUS,
  buildGateEvidence,
  describeGates,
  evaluateGates,
} from './lib/release-gates.mjs';

const GITHUB_API = 'https://api.github.com';

function die(message) {
  console.error(`release-gates: ${message}`);
  process.exit(1);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      die(`unexpected argument "${argument}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`option ${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) {
    die(`--${name} is required`);
  }
  return value;
}

function positiveInteger(options, name, fallback) {
  if (options[name] === undefined) {
    return fallback;
  }
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value <= 0) {
    die(`--${name} must be a positive whole number of seconds`);
  }
  return value;
}

/** One authenticated GitHub REST call. The token never reaches stdout/stderr. */
async function githubRequest(token, path) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'orgistry-release-gates',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} responded ${response.status}`);
  }
  return response.json();
}

/**
 * Refuse a SHA that is not reachable from the release branch.
 *
 * `compare/{branch}...{sha}` reports `identical` when the SHA is the branch
 * head and `behind` when it is an ancestor. Anything else — `ahead`,
 * `diverged` — means the commit is not on the release branch, so it was never
 * subject to the branch's protections.
 */
async function assertReachableFromReleaseBranch(token, repository, branch, sha) {
  const comparison = await githubRequest(token, `/repos/${repository}/compare/${branch}...${sha}`);
  if (comparison.status !== 'identical' && comparison.status !== 'behind') {
    die(
      `${sha} is not reachable from ${branch} (compare status "${comparison.status}"); ` +
        'only commits on the release branch may be published',
    );
  }
  console.log(`release-gates: ${sha} is reachable from ${branch} (${comparison.status})`);
}

/** Every workflow run recorded for one SHA, with the jobs of each. */
async function collectRunsAndJobs(token, repository, sha) {
  const runsResponse = await githubRequest(
    token,
    `/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
  );
  const runs = runsResponse.workflow_runs ?? [];

  const jobsByRunId = {};
  for (const run of runs) {
    if (run.status !== 'completed') {
      // Jobs of an in-flight run cannot satisfy anything; skip the call.
      continue;
    }
    const jobsResponse = await githubRequest(
      token,
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    jobsByRunId[String(run.id)] = jobsResponse.jobs ?? [];
  }
  return { runs, jobsByRunId };
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function commandVerify(argv) {
  const options = parseOptions(argv);
  const repository = requireOption(options, 'repository');
  const sha = requireOption(options, 'sha');
  const outputPath = requireOption(options, 'output');
  const releaseBranch = options['release-branch'] ?? 'main';
  const timeoutSeconds = positiveInteger(options, 'timeout-seconds', 1800);
  const pollSeconds = positiveInteger(options, 'poll-seconds', 20);

  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    die('GITHUB_TOKEN is required (actions: read is sufficient)');
  }

  await assertReachableFromReleaseBranch(token, repository, releaseBranch, sha);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let evaluation;
  for (;;) {
    const { runs, jobsByRunId } = await collectRunsAndJobs(token, repository, sha);
    evaluation = evaluateGates({ sha, runs, jobsByRunId });
    console.log(`release-gates: required checks are ${evaluation.status} for ${sha}`);
    console.log(describeGates(evaluation));

    if (evaluation.status === GATE_STATUS.satisfied) {
      break;
    }
    if (evaluation.status === GATE_STATUS.failed) {
      die('a required check failed for this commit; it is not eligible for release');
    }
    if (Date.now() >= deadline) {
      die(
        `required checks were still pending after ${timeoutSeconds}s. ` +
          'Nothing was published. Re-run the Release workflow once every required check has finished.',
      );
    }
    await sleep(pollSeconds);
  }

  const evidence = buildGateEvidence({
    sha,
    evaluation,
    verifiedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`release-gates: wrote gate evidence for ${evidence.required.length} checks to ${outputPath}`);
}

const [command, ...argv] = process.argv.slice(2);
if (command === 'verify') {
  await commandVerify(argv);
} else {
  die('usage: release-gates.mjs verify --repository OWNER/REPO --sha SHA --output PATH [options]');
}
