import { GateResult, OrchestratorMetricsInput } from './types';

export class DataQualityGate {
  constructor(
    private readonly maxLatencyMs: number,
    private readonly maxSpreadPct: number,
    private readonly minObiDeep: number
  ) {}

  evaluate(input: OrchestratorMetricsInput): GateResult {
    const latency = input.latency_ms;
    const spread = input.spread_pct;
    const obiDeep = input.legacyMetrics?.obiDeep;
    const deltaZ = input.legacyMetrics?.deltaZ;
    const cvdSlope = input.legacyMetrics?.cvdSlope;
    const printsPerSecond = input.prints_per_second;

    const hasRequiredMetrics = [latency, spread, obiDeep, deltaZ, cvdSlope, printsPerSecond]
      .every((v) => typeof v === 'number' && Number.isFinite(v));

    if (!hasRequiredMetrics) {
      return {
        passed: false,
        reason: 'missing_metrics',
        latency_ms: typeof latency === 'number' && Number.isFinite(latency) ? latency : Number.NaN,
        checks: {
          hasRequiredMetrics: false,
          latencyOk: false,
          spreadOk: false,
          obiDeepOk: false,
        },
      };
    }

    const latencyOk = (latency as number) <= this.maxLatencyMs;
    const spreadOk = (spread as number) <= this.maxSpreadPct;
    const obiDeepOk = Math.abs(obiDeep as number) >= this.minObiDeep;

    let reason: string | null = null;
    if (!latencyOk) {
      reason = 'latency_too_high';
    } else if (!spreadOk) {
      reason = 'spread_too_wide';
    } else if (!obiDeepOk) {
      reason = 'obi_deep_too_low';
    }

    return {
      passed: reason === null,
      reason,
      latency_ms: latency as number,
      checks: {
        hasRequiredMetrics,
        latencyOk,
        spreadOk,
        obiDeepOk,
      },
    };
  }
}
