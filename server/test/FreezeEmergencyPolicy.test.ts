function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

import { DecisionEngine } from '../orchestrator/Decision';
import { GateMode, GateResult, SymbolState } from '../orchestrator/types';

const gatePass: GateResult = {
  mode: GateMode.V1_NO_LATENCY,
  passed: true,
  reason: null,
  network_latency_ms: null,
  checks: {
    hasRequiredMetrics: true,
    spreadOk: true,
    obiDeepOk: true,
    networkLatencyOk: null,
  },
};

function baseState(): SymbolState {
  return {
    symbol: 'BTCUSDT',
    halted: false,
    availableBalance: 1000,
    walletBalance: 1000,
    position: null,
    openOrders: new Map(),
    hasOpenEntryOrder: false,
    cooldown_until_ms: 0,
    last_exit_event_time_ms: 0,
    marginRatio: 1,
    execQuality: {
      quality: 'UNKNOWN',
      metricsPresent: false,
      freezeActive: true,
      lastLatencyMs: null,
      lastSlippageBps: null,
      lastSpreadPct: null,
      recentLatencyMs: [],
      recentSlippageBps: [],
    },
  };
}

const engine = new DecisionEngine({
  expectedPrice: () => 100,
  getSizingBalance: () => 100,
  getMaxLeverage: () => 20,
  hardStopLossPct: 1.0,
  liquidationEmergencyMarginRatio: 0.30,
  takerFeeBps: 4,
  profitLockBufferBps: 2,
});

export function runTests() {
  // 1) Missing exec metrics => FREEZE and no emergency panic exit
  {
    const state = baseState();
    state.position = {
      side: 'LONG',
      qty: 1,
      entryPrice: 100,
      unrealizedPnlPct: -0.1,
      addsUsed: 0,
      peakPnlPct: 0,
      profitLockActivated: false,
      hardStopPrice: null,
    };
    state.execQuality.quality = 'UNKNOWN';
    state.execQuality.freezeActive = true;

    const actions = engine.evaluate({
      symbol: 'BTCUSDT',
      event_time_ms: 1,
      gate: gatePass,
      metrics: {
        symbol: 'BTCUSDT',
        prints_per_second: 5,
        spread_pct: 0.01,
        legacyMetrics: { obiDeep: 0.3, deltaZ: 1.0, cvdSlope: 0.2 },
      },
      state,
    });

    assert(actions.every((a) => a.reason !== 'emergency_exit_exec_quality'), 'panic emergency exit must be forbidden');
    assert(actions.some((a) => a.type === 'NOOP' && a.reason === 'freeze_active'), 'freeze should block normal exits');
  }

  // 2) BAD exec quality without guards => FREEZE, no exit
  {
    const state = baseState();
    state.position = {
      side: 'SHORT',
      qty: 1,
      entryPrice: 100,
      unrealizedPnlPct: -0.2,
      addsUsed: 0,
      peakPnlPct: 0,
      profitLockActivated: false,
      hardStopPrice: null,
    };
    state.execQuality.quality = 'BAD';
    state.execQuality.freezeActive = true;
    state.execQuality.metricsPresent = true;

    const actions = engine.evaluate({
      symbol: 'BTCUSDT',
      event_time_ms: 2,
      gate: gatePass,
      metrics: {
        symbol: 'BTCUSDT',
        prints_per_second: 3,
        spread_pct: 0.02,
        legacyMetrics: { obiDeep: 0.4, deltaZ: -1.0, cvdSlope: -0.2 },
      },
      state,
    });

    assert(actions.some((a) => a.type === 'NOOP' && a.reason === 'freeze_active'), 'bad quality should freeze strategy exits');
    assert(!actions.some((a) => a.type === 'EXIT_MARKET'), 'no emergency exit without hard guards');
  }

  // 3) Liquidation risk => emergency exit allowed
  {
    const state = baseState();
    state.position = {
      side: 'LONG',
      qty: 1,
      entryPrice: 100,
      unrealizedPnlPct: -0.1,
      addsUsed: 0,
      peakPnlPct: 0,
      profitLockActivated: false,
      hardStopPrice: null,
    };
    state.execQuality.quality = 'UNKNOWN';
    state.execQuality.freezeActive = true;
    state.marginRatio = 0.2;

    const actions = engine.evaluate({
      symbol: 'BTCUSDT',
      event_time_ms: 3,
      gate: gatePass,
      metrics: {
        symbol: 'BTCUSDT',
        prints_per_second: 2,
        spread_pct: 0.03,
        legacyMetrics: { obiDeep: 0.5, deltaZ: 0.2, cvdSlope: 0.1 },
      },
      state,
    });

    assert(actions.some((a) => a.type === 'EXIT_MARKET' && a.reason === 'emergency_exit_liquidation_risk'), 'liquidation risk must allow emergency exit');
  }

  // 4) Hard stop => emergency exit allowed
  {
    const state = baseState();
    state.position = {
      side: 'SHORT',
      qty: 1,
      entryPrice: 100,
      unrealizedPnlPct: -2.5,
      addsUsed: 0,
      peakPnlPct: 0,
      profitLockActivated: false,
      hardStopPrice: null,
    };
    state.execQuality.quality = 'BAD';
    state.execQuality.freezeActive = true;
    state.marginRatio = 0.9;

    const actions = engine.evaluate({
      symbol: 'BTCUSDT',
      event_time_ms: 4,
      gate: gatePass,
      metrics: {
        symbol: 'BTCUSDT',
        prints_per_second: 2,
        spread_pct: 0.02,
        legacyMetrics: { obiDeep: 0.5, deltaZ: -0.5, cvdSlope: -0.1 },
      },
      state,
    });

    assert(actions.some((a) => a.type === 'EXIT_MARKET' && a.reason === 'emergency_exit_hard_stop'), 'hard stop must allow emergency exit');
  }
}
