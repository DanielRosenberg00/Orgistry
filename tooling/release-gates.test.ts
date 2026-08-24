import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without type declarations
import {
  GATE_STATUS,
  REQUIRED_GATES,
  buildGateEvidence,
  evaluateGates,
} from './lib/release-gates.mjs';

/**
 * Release eligibility (Sprint 26 refinement). Publication must be tied to the
 * required checks having succeeded for the EXACT commit being published, so
 * these tests pin the three ways that can go wrong:
 *
 *   - a gate that has not reported yet is `pending`, never a silent success;
 *   - a gate that failed is `failed` immediately and can never become success
 *     by waiting;
 *   - runs belonging to a NEIGHBOURING commit authorise nothing.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

let nextRunId = 32700000000;

function run(workflowFile: string, overrides: Record<string, any> = {}): Record<string, any> {
  nextRunId += 1;
  return {
    id: nextRunId,
    path: `.github/workflows/${workflowFile}`,
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    html_url: `https://github.com/example/orgistry/actions/runs/${nextRunId}`,
    ...overrides,
  };
}

/** Every required check reported as a successful job, grouped by its run. */
function greenWorld(sha = SHA) {
  const runs: Record<string, any>[] = [];
  const jobsByRunId: Record<string, unknown[]> = {};
  for (const workflowFile of ['ci.yml', 'security.yml', 'codeql.yml']) {
    const workflowRun = run(workflowFile, { head_sha: sha });
    runs.push(workflowRun);
    jobsByRunId[String(workflowRun.id)] = REQUIRED_GATES.filter(
      (gate: any) => gate.workflowFile === workflowFile,
    ).map((gate: any) => ({ name: gate.check, status: 'completed', conclusion: 'success' }));
  }
  return { runs, jobsByRunId };
}

describe('evaluateGates', () => {
  it('is satisfied when every required check succeeded for the SHA', () => {
    const evaluation = evaluateGates({ sha: SHA, ...greenWorld() });
    expect(evaluation.status).toBe(GATE_STATUS.satisfied);
    expect(evaluation.gates).toHaveLength(REQUIRED_GATES.length);
    expect(evaluation.gates.every((gate: any) => gate.conclusion === 'success')).toBe(true);
  });

  it('is pending when no run exists yet', () => {
    const evaluation = evaluateGates({ sha: SHA, runs: [], jobsByRunId: {} });
    expect(evaluation.status).toBe(GATE_STATUS.pending);
    expect(evaluation.gates.every((gate: any) => gate.state === GATE_STATUS.pending)).toBe(true);
  });

  it('is pending while a run is still in progress', () => {
    const world = greenWorld();
    world.runs[0].status = 'in_progress';
    world.runs[0].conclusion = null;
    expect(evaluateGates({ sha: SHA, ...world }).status).toBe(GATE_STATUS.pending);
  });

  it('is pending while a job is still running inside a completed run', () => {
    const world = greenWorld();
    const runId = String(world.runs[1].id);
    (world.jobsByRunId[runId] as any[])[0].status = 'in_progress';
    expect(evaluateGates({ sha: SHA, ...world }).status).toBe(GATE_STATUS.pending);
  });

  it('fails as soon as a required job concluded anything but success', () => {
    const world = greenWorld();
    const runId = String(world.runs[0].id);
    (world.jobsByRunId[runId] as any[])[2].conclusion = 'failure';
    const evaluation = evaluateGates({ sha: SHA, ...world });
    expect(evaluation.status).toBe(GATE_STATUS.failed);
  });

  it('fails when a completed run never produced a required job', () => {
    const world = greenWorld();
    const runId = String(world.runs[0].id);
    world.jobsByRunId[runId] = (world.jobsByRunId[runId] as any[]).slice(1);
    const evaluation = evaluateGates({ sha: SHA, ...world });
    expect(evaluation.status).toBe(GATE_STATUS.failed);
    expect(
      evaluation.gates.find((gate: any) => gate.state === GATE_STATUS.failed).reason,
    ).toContain('without the required job');
  });

  it('ignores green runs that belong to a different commit', () => {
    // The whole point of exact-SHA authorization: a neighbouring commit's green
    // CI must not release this one.
    const evaluation = evaluateGates({ sha: SHA, ...greenWorld(OTHER_SHA) });
    expect(evaluation.status).toBe(GATE_STATUS.pending);
  });

  it('uses the newest run when a workflow was re-run for the same SHA', () => {
    const world = greenWorld();
    const stale = world.runs[0];
    (world.jobsByRunId[String(stale.id)] as any[])[0].conclusion = 'failure';
    const rerun = run('ci.yml');
    world.runs.push(rerun);
    world.jobsByRunId[String(rerun.id)] = REQUIRED_GATES.filter(
      (gate: any) => gate.workflowFile === 'ci.yml',
    ).map((gate: any) => ({ name: gate.check, status: 'completed', conclusion: 'success' }));

    expect(evaluateGates({ sha: SHA, ...world }).status).toBe(GATE_STATUS.satisfied);
  });
});

describe('buildGateEvidence', () => {
  it('records the real run identity of every required check', () => {
    const evaluation = evaluateGates({ sha: SHA, ...greenWorld() });
    const evidence = buildGateEvidence({
      sha: SHA,
      evaluation,
      verifiedAt: '2026-08-24T09:05:00.000Z',
    });

    expect(evidence.headSha).toBe(SHA);
    expect(evidence.required).toHaveLength(REQUIRED_GATES.length);
    for (const gate of evidence.required) {
      expect(gate.conclusion).toBe('success');
      expect(gate.headSha).toBe(SHA);
      expect(gate.runId).toMatch(/^[0-9]+$/);
    }
  });

  it('refuses to produce evidence unless every gate succeeded', () => {
    const evaluation = evaluateGates({ sha: SHA, runs: [], jobsByRunId: {} });
    expect(() =>
      buildGateEvidence({ sha: SHA, evaluation, verifiedAt: '2026-08-24T09:05:00.000Z' }),
    ).toThrow(/refusing to build gate evidence/);
  });
});
