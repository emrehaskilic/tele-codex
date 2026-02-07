import { GateConfig, GateMode, GateResult, OrchestratorMetricsInput } from './types';

export interface RunGateInput {
  canonical_time_ms: number;
  exchange_event_time_ms: number | null;
  metrics: OrchestratorMetricsInput;
}

export function runGate(input: RunGateInput, cfg: GateConfig): GateResult {
  const spread = input.metrics.spread_pct;
  const obiDeep = input.metrics.legacyMetrics?.obiDeep;
  const deltaZ = input.metrics.legacyMetrics?.deltaZ;
  const cvdSlope = input.metrics.legacyMetrics?.cvdSlope;
  const printsPerSecond = input.metrics.prints_per_second;

  const hasRequiredMetrics = [spread, obiDeep, deltaZ, cvdSlope, printsPerSecond]
    .every((v) => typeof v === 'number' && Number.isFinite(v));

  if (!hasRequiredMetrics) {
    return {
      mode: cfg.mode,
      passed: false,
      reason: 'missing_metrics',
      network_latency_ms: null,
      checks: {
        hasRequiredMetrics: false,
        spreadOk: false,
        obiDeepOk: false,
        networkLatencyOk: cfg.mode === GateMode.V2_NETWORK_LATENCY ? false : null,
      },
    };
  }

  const spreadOk = (spread as number) <= cfg.maxSpreadPct;
  const obiDeepOk = Math.abs(obiDeep as number) >= cfg.minObiDeep;

  const networkLatencyMs = input.exchange_event_time_ms === null
    ? null
    : Math.max(0, input.canonical_time_ms - input.exchange_event_time_ms);

  const networkLatencyOk = cfg.mode === GateMode.V2_NETWORK_LATENCY
    ? networkLatencyMs !== null && networkLatencyMs <= (cfg.v2?.maxNetworkLatencyMs ?? Number.POSITIVE_INFINITY)
    : null;

  let reason: string | null = null;
  if (!spreadOk) {
    reason = 'spread_too_wide';
  } else if (!obiDeepOk) {
    reason = 'insufficient_liquidity';
  } else if (cfg.mode === GateMode.V2_NETWORK_LATENCY && !networkLatencyOk) {
    reason = 'network_latency_too_high';
  }

  return {
    mode: cfg.mode,
    passed: reason === null,
    reason,
    network_latency_ms: cfg.mode === GateMode.V2_NETWORK_LATENCY ? networkLatencyMs : null,
    checks: {
      hasRequiredMetrics,
      spreadOk,
      obiDeepOk,
      networkLatencyOk,
    },
  };
}
