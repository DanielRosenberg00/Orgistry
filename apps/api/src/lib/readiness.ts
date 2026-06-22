/**
 * Readiness probes.
 *
 * A probe names a downstream dependency and a `check` that throws if the
 * dependency is unavailable. The readiness route runs every probe and reports
 * per-dependency status. Probes are injected into `buildApp`, so tests can
 * supply fakes and never touch real infrastructure.
 */
export interface ReadinessProbe {
  name: string;
  check: () => Promise<void>;
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  latencyMs: number;
}

/** Run a single probe, capturing success/failure and latency. Never throws. */
async function runProbe(probe: ReadinessProbe): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    await probe.check();
    return { name: probe.name, ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { name: probe.name, ok: false, latencyMs: Date.now() - startedAt };
  }
}

/** Run all probes concurrently and report whether every dependency is ready. */
export async function evaluateReadiness(
  probes: ReadinessProbe[],
): Promise<{ ready: boolean; checks: ProbeResult[] }> {
  const checks = await Promise.all(probes.map(runProbe));
  return { ready: checks.every((c) => c.ok), checks };
}
