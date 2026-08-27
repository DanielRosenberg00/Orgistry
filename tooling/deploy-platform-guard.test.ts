import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The image/host platform gate (Sprint 27, ORG-PR-001).
 *
 * WHY THIS EXISTS AT ALL
 * Orgistry publishes SINGLE-architecture images: `.github/workflows/release.yml`
 * builds on a GitHub-hosted `linux/amd64` runner and pushes one manifest, not a
 * manifest list. Pulling is architecture-agnostic, so an arm64 host pulls those
 * images successfully and only fails when a container starts. Before this gate
 * that surfaced as "the API container did not become healthy" — after the
 * backup preflight and the migration had already run against the target's
 * database. This was found by pulling the real published release onto an arm64
 * host, not by a rehearsal, which always builds natively and so can never
 * produce a mismatch.
 *
 * WHAT IS TESTED HERE AND WHY IT IS TESTED THIS WAY
 * These call the REAL shell functions in `tooling/lib/deploy-common.sh` through
 * bash, rather than re-implementing the comparison in TypeScript. The rule that
 * matters is the one the deployment executes, and a second copy of it in test
 * code would prove only that two implementations agree.
 *
 * Architecture NORMALISATION is the subtle half: the Docker daemon reports the
 * host the way the kernel names it (`x86_64`, `aarch64`) while an image reports
 * the OCI name (`amd64`, `arm64`). Comparing the raw strings would refuse every
 * deployment on every host — a gate that fails closed on correct input is worse
 * than no gate, because operators disable it.
 */

const DEPLOY_COMMON_PATH = fileURLToPath(
  new URL('./lib/deploy-common.sh', import.meta.url),
);

/**
 * Run a snippet with `deploy-common.sh` sourced. Returns stdout, stderr, and
 * the exit code rather than throwing, so a refusal can be asserted on.
 */
function runWithDeployCommon(
  snippet: string,
  environment: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const script = `DEPLOY_LOG_PREFIX=test\nsource ${DEPLOY_COMMON_PATH}\n${snippet}\n`;
  try {
    const stdout = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return {
      status: failure.status,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('deploy_normalize_architecture', () => {
  // Each pair is (what some tool reports, the canonical token both sides of the
  // comparison must reduce to).
  const equivalences: ReadonlyArray<readonly [string, string]> = [
    ['x86_64', 'amd64'],
    ['amd64', 'amd64'],
    ['aarch64', 'arm64'],
    ['arm64', 'arm64'],
    ['armv7l', 'arm'],
  ];

  for (const [reported, canonical] of equivalences) {
    it(`reduces ${reported} to ${canonical}`, () => {
      const result = runWithDeployCommon(
        `deploy_normalize_architecture '${reported}'`,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(canonical);
    });
  }

  it('passes an unrecognised architecture through unchanged rather than guessing', () => {
    // A wrong guess here would compare two architectures as equal and let a
    // deployment proceed onto a host that cannot run the image.
    const result = runWithDeployCommon("deploy_normalize_architecture 'riscv64'");
    expect(result.stdout).toBe('riscv64');
  });
});

describe('deploy_require_determined_platform', () => {
  // `docker image inspect` and `docker info` exit 0 even when a template field
  // renders empty, which yields the string "/". If that happened on BOTH sides
  // the equality check would MATCH and the gate would pass by accident — a gate
  // that fails open is worse than no gate, so an incomplete platform is a
  // refusal.
  const unusable = ['/', 'linux/', '/amd64', '', 'linux'];

  for (const platform of unusable) {
    it(`refuses the incompletely determined platform ${JSON.stringify(platform)}`, () => {
      const result = runWithDeployCommon(
        `deploy_require_determined_platform '${platform}' 'the test'`,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('could not determine');
    });
  }

  it('accepts a fully determined platform', () => {
    const result = runWithDeployCommon(
      "deploy_require_determined_platform 'linux/amd64' 'the test'",
    );
    expect(result.status).toBe(0);
  });
});

describe('deploy_assert_image_runs_on_host', () => {
  // The function reads the image platform through `docker image inspect`, which
  // is not available to a unit test. Overriding `deploy_image_platform` for the
  // duration of the snippet isolates the DECISION — which is the part with a
  // rule in it — from the lookup, which is one docker call.
  const withImagePlatform = (platform: string) =>
    `deploy_image_platform() { printf '%s' '${platform}'; }\n`;

  it('accepts an image whose platform matches the host', () => {
    const result = runWithDeployCommon(
      `${withImagePlatform('linux/amd64')}deploy_assert_image_runs_on_host ref 'API image' 'linux/amd64'; echo "emulated=[\${DEPLOY_EMULATED_PLATFORM}]"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('emulated=[]');
  });

  it('refuses a mismatched image and names both platforms', () => {
    const result = runWithDeployCommon(
      `${withImagePlatform('linux/amd64')}deploy_assert_image_runs_on_host ref 'API image' 'linux/arm64'`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('linux/amd64');
    expect(result.stderr).toContain('linux/arm64');
    // The refusal must tell the operator what to do about it, not only that
    // something is wrong.
    expect(result.stderr).toContain('multi-architecture');
  });

  it('refuses a mismatch when the emulation opt-in is anything but the exact opt-in value', () => {
    // A truthy-looking value must not be accepted: the opt-in has to be
    // deliberate, and `yes` is what the documentation and the runbook name.
    for (const attempted of ['true', '1', 'YES']) {
      const result = runWithDeployCommon(
        `${withImagePlatform('linux/amd64')}deploy_assert_image_runs_on_host ref 'API image' 'linux/arm64'`,
        { ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH: attempted },
      );
      expect(result.status).toBe(1);
    }
  });

  it('refuses rather than passing when both platforms are undetermined', () => {
    // The regression this guards: two empty inspections both render "/", which
    // compares equal. The deployment must abort, not proceed onto a host whose
    // architecture nobody established.
    const result = runWithDeployCommon(
      `${withImagePlatform('/')}deploy_assert_image_runs_on_host ref 'API image' '/'`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not determine');
  });

  it('refuses an undetermined host platform even when the image platform is valid', () => {
    const result = runWithDeployCommon(
      `${withImagePlatform('linux/amd64')}deploy_assert_image_runs_on_host ref 'API image' 'linux/'`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not determine');
  });

  it('allows an explicitly opted-in mismatch and records it for the deployment evidence', () => {
    const result = runWithDeployCommon(
      `${withImagePlatform('linux/amd64')}deploy_assert_image_runs_on_host ref 'API image' 'linux/arm64'; echo "emulated=[\${DEPLOY_EMULATED_PLATFORM}]"`,
      { ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH: 'yes' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING');
    // tooling/deploy.sh turns a non-empty value into a limitation on the
    // deployment record, so emulation cannot vanish into a log line.
    expect(result.stdout).toContain(
      'emulated=[linux/amd64 images on a linux/arm64 host]',
    );
  });
});
