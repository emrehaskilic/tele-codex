function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

import { runGate } from '../orchestrator/Gate';
import { GateMode } from '../orchestrator/types';

export function runTests() {
  const baseMetrics = {
    symbol: 'BTCUSDT',
    spread_pct: 0.01,
    prints_per_second: 4,
    legacyMetrics: {
      obiDeep: 0.3,
      deltaZ: 1.1,
      cvdSlope: 0.2,
    },
  };

  const v1 = runGate(
    {
      canonical_time_ms: 2_000,
      exchange_event_time_ms: 1,
      metrics: baseMetrics,
    },
    {
      mode: GateMode.V1_NO_LATENCY,
      maxSpreadPct: 0.08,
      minObiDeep: 0.05,
      v2: { maxNetworkLatencyMs: 10 },
    }
  );

  assert(v1.passed === true, `V1 should pass without latency check, got ${JSON.stringify(v1)}`);
  assert(v1.network_latency_ms === null, 'V1 network latency must be null');

  const v2 = runGate(
    {
      canonical_time_ms: 2_000,
      exchange_event_time_ms: 1,
      metrics: baseMetrics,
    },
    {
      mode: GateMode.V2_NETWORK_LATENCY,
      maxSpreadPct: 0.08,
      minObiDeep: 0.05,
      v2: { maxNetworkLatencyMs: 100 },
    }
  );

  assert(v2.passed === false, 'V2 should fail when network latency exceeds threshold');
  assert(v2.reason === 'network_latency_too_high', `unexpected V2 reason: ${v2.reason}`);
}
