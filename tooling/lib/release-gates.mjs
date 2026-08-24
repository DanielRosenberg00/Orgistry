/**
 * Required-gate evaluation for a release candidate (Sprint 26 refinement).
 *
 * WHY THIS EXISTS
 * "The commit is on main" and "the release job re-ran the artifact smoke test"
 * are both weaker than what the deployment model claims. Publication must be
 * tied to the required checks having actually succeeded FOR THE EXACT SOURCE
 * SHA being published — the same six checks the `main` ruleset requires.
 *
 * This module is the pure decision layer: it takes workflow runs and their jobs
 * as data and answers satisfied / pending / failed. The network calls live in
 * tooling/release-gates.mjs so this stays directly testable.
 *
 * GRANULARITY: evaluation is per JOB, not per workflow run, because that is the
 * granularity branch protection uses. `ci.yml` alone carries three of the six
 * required checks, and a run whose conclusion is "failure" tells you nothing
 * about which of them failed.
 *
 * "Not found yet" is NEVER success. A gate with no recorded run is `pending`,
 * which the caller must either wait on or refuse — never skip.
 */

/**
 * The six required checks, mirroring the `main` ruleset
 * (docs/validation.md, "Branch protection"). `check` is the job name GitHub
 * reports, which is also the name the ruleset matches on.
 */
export const REQUIRED_GATES = [
  { check: 'Validate (offline)', workflow: 'CI', workflowFile: 'ci.yml' },
  { check: 'Integration (PostgreSQL + Redis)', workflow: 'CI', workflowFile: 'ci.yml' },
  { check: 'Artifacts (build + smoke)', workflow: 'CI', workflowFile: 'ci.yml' },
  { check: 'Dependency audit (pnpm)', workflow: 'Security scans', workflowFile: 'security.yml' },
  { check: 'Secret scan (Gitleaks)', workflow: 'Security scans', workflowFile: 'security.yml' },
  { check: 'Analyze (javascript-typescript)', workflow: 'CodeQL', workflowFile: 'codeql.yml' },
];

/** Overall outcomes. `pending` is retryable; `failed` never is. */
export const GATE_STATUS = {
  satisfied: 'satisfied',
  pending: 'pending',
  failed: 'failed',
};

/** The newest run for a workflow file at a SHA, or null. Highest id wins. */
function latestRunFor(runs, workflowFile, sha) {
  const candidates = runs.filter(
    (run) => run.head_sha === sha && String(run.path ?? '').endsWith(`/${workflowFile}`),
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((newest, run) => (run.id > newest.id ? run : newest));
}

/** Evaluate one required gate against the runs and jobs observed so far. */
function evaluateGate(gate, { sha, runs, jobsByRunId }) {
  const run = latestRunFor(runs, gate.workflowFile, sha);
  if (run === null) {
    return {
      ...gate,
      state: GATE_STATUS.pending,
      reason: `no ${gate.workflowFile} run recorded for ${sha} yet`,
    };
  }

  const identity = {
    ...gate,
    runId: String(run.id),
    runAttempt: String(run.run_attempt ?? 1),
    headSha: run.head_sha,
    runConclusion: run.conclusion ?? null,
    url: run.html_url ?? null,
  };

  if (run.status !== 'completed') {
    return { ...identity, state: GATE_STATUS.pending, reason: `run ${run.id} is ${run.status}` };
  }

  const jobs = jobsByRunId[String(run.id)] ?? [];
  const job = jobs.find((candidate) => candidate.name === gate.check);
  if (job === undefined) {
    // A completed run that never produced the required job is a real failure:
    // the check the ruleset requires did not run.
    return {
      ...identity,
      state: GATE_STATUS.failed,
      reason: `run ${run.id} completed without the required job "${gate.check}"`,
    };
  }
  if (job.status !== 'completed') {
    return { ...identity, state: GATE_STATUS.pending, reason: `job "${gate.check}" is ${job.status}` };
  }
  if (job.conclusion !== 'success') {
    return {
      ...identity,
      state: GATE_STATUS.failed,
      reason: `job "${gate.check}" concluded ${job.conclusion}`,
    };
  }
  return { ...identity, state: GATE_STATUS.satisfied, conclusion: 'success' };
}

/**
 * Evaluate every required gate for one SHA.
 *
 * Returns `{ status, gates }`. `status` is `failed` if any gate failed (a
 * failure never becomes a success by waiting), otherwise `pending` if any gate
 * is still incomplete, otherwise `satisfied`.
 */
export function evaluateGates({ sha, runs, jobsByRunId = {} }) {
  const gates = REQUIRED_GATES.map((gate) => evaluateGate(gate, { sha, runs, jobsByRunId }));
  const failed = gates.filter((gate) => gate.state === GATE_STATUS.failed);
  const pending = gates.filter((gate) => gate.state === GATE_STATUS.pending);

  let status = GATE_STATUS.satisfied;
  if (failed.length > 0) {
    status = GATE_STATUS.failed;
  } else if (pending.length > 0) {
    status = GATE_STATUS.pending;
  }
  return { status, gates };
}

/**
 * Reduce a satisfied evaluation to the evidence a release manifest records.
 *
 * Throws unless every gate succeeded — evidence is only ever produced for an
 * authorised release, so a partially green result can never be written down as
 * if it authorised anything.
 */
export function buildGateEvidence({ sha, evaluation, verifiedAt }) {
  if (evaluation.status !== GATE_STATUS.satisfied) {
    throw new Error(
      `refusing to build gate evidence: required gates are ${evaluation.status}`,
    );
  }
  return {
    headSha: sha,
    verifiedAt,
    required: evaluation.gates.map((gate) => ({
      check: gate.check,
      workflow: gate.workflow,
      workflowFile: gate.workflowFile,
      runId: gate.runId,
      runAttempt: gate.runAttempt,
      conclusion: 'success',
      headSha: gate.headSha,
      url: gate.url,
    })),
  };
}

/** A one-line-per-gate summary for a workflow log. Never includes a token. */
export function describeGates(evaluation) {
  return evaluation.gates
    .map((gate) => {
      const location = gate.runId === undefined ? gate.workflowFile : `run ${gate.runId}`;
      const detail = gate.reason === undefined ? 'success' : gate.reason;
      return `  [${gate.state}] ${gate.check} (${location}): ${detail}`;
    })
    .join('\n');
}
