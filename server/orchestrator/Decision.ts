import { DecisionAction, GateResult, OrchestratorMetricsInput, SymbolState } from './types';

export interface DecisionDependencies {
  expectedPrice: (symbol: string, side: 'BUY' | 'SELL', type: 'MARKET' | 'LIMIT', limitPrice?: number) => number | null;
  getInitialMarginUsdt: () => number;
  getMaxLeverage: () => number;
}

export class DecisionEngine {
  constructor(private readonly deps: DecisionDependencies) { }

  evaluate(input: {
    symbol: string;
    event_time_ms: number;
    gate: GateResult;
    metrics: OrchestratorMetricsInput;
    state: SymbolState;
  }): DecisionAction[] {
    const { gate, metrics, state, symbol, event_time_ms } = input;
    const actions: DecisionAction[] = [];

    if (!gate.passed) {
      return [{ type: 'NOOP', symbol, event_time_ms, reason: `gate_fail:${gate.reason || 'unknown'}` }];
    }

    const deltaZ = metrics.legacyMetrics?.deltaZ as number;
    const cvdSlope = metrics.legacyMetrics?.cvdSlope as number;
    const obiDeep = metrics.legacyMetrics?.obiDeep as number;
    const printsPerSecond = metrics.prints_per_second as number;

    const inCooldown = event_time_ms < state.cooldown_until_ms;

    if (state.halted && state.hasOpenEntryOrder) {
      actions.push({
        type: 'CANCEL_OPEN_ENTRY_ORDERS',
        symbol,
        event_time_ms,
        reason: 'halt_mode_cancel_entry',
      });
    }

    if (state.position === null) {
      if (!state.halted && !state.hasOpenEntryOrder && state.openOrders.size === 0 && !inCooldown) {
        const side = deltaZ > 0 ? 'BUY' : deltaZ < 0 ? 'SELL' : null;
        if (side) {
          const price = this.deps.expectedPrice(symbol, side, 'MARKET');
          if (price && price > 0) {
            const probeQuantity = this.computeProbeQuantity({
              initialMarginUsdt: this.deps.getInitialMarginUsdt(),
              expectedPrice: price,
              deltaZ,
              obiDeep,
              execPoor: state.execQuality.poor,
            });

            if (probeQuantity > 0) {
              const targetMarginUsdt = this.deps.getInitialMarginUsdt();
              const targetNotionalUsdt = targetMarginUsdt * this.deps.getMaxLeverage();
              actions.push({
                type: 'ENTRY_PROBE',
                symbol,
                event_time_ms,
                side,
                quantity: probeQuantity,
                reduceOnly: false,
                expectedPrice: price,
                targetMarginUsdt,
                targetNotionalUsdt,
                reason: 'entry_probe_liquidity_pressure_context',
              });
            }
          }
        }
      }
      return actions.length > 0 ? actions : [{ type: 'NOOP', symbol, event_time_ms, reason: state.halted ? 'halt_mode' : inCooldown ? 'cooldown' : 'flat_wait' }];
    }

    const position = state.position;

    const pnlDrawdown = position.peakPnlPct - position.unrealizedPnlPct;
    if (position.peakPnlPct > 0.5 && pnlDrawdown > 0.2) {
      actions.push(this.exitAction(symbol, event_time_ms, position.side === 'LONG' ? 'SELL' : 'BUY', 'profit_lock_drawdown'));
    }

    if (position.side === 'LONG' && deltaZ < -3 && cvdSlope < -0.5) {
      actions.push(this.exitAction(symbol, event_time_ms, 'SELL', 'reversal_exit_long'));
    }

    if (position.side === 'SHORT' && deltaZ > 3 && cvdSlope > 0.5) {
      actions.push(this.exitAction(symbol, event_time_ms, 'BUY', 'reversal_exit_short'));
    }

    if (state.execQuality.poor && state.execQuality.recentLatencyMs.length >= 3) {
      actions.push(this.exitAction(symbol, event_time_ms, position.side === 'LONG' ? 'SELL' : 'BUY', 'emergency_exit_exec_quality'));
    }

    const canAdd =
      !state.halted &&
      position.addsUsed < 2 &&
      position.unrealizedPnlPct > 0.10 &&
      !state.execQuality.poor &&
      ((position.side === 'LONG' && deltaZ > 0) || (position.side === 'SHORT' && deltaZ < 0));

    if (canAdd) {
      const side = position.side === 'LONG' ? 'BUY' : 'SELL';
      const price = this.deps.expectedPrice(symbol, side, 'MARKET');
      if (price && price > 0) {
        const qty = this.computeProbeQuantity({
          initialMarginUsdt: this.deps.getInitialMarginUsdt(),
          expectedPrice: price,
          deltaZ,
          obiDeep,
          execPoor: state.execQuality.poor,
        });
        if (qty > 0) {
          const targetMarginUsdt = this.deps.getInitialMarginUsdt();
          const targetNotionalUsdt = targetMarginUsdt * this.deps.getMaxLeverage();
          actions.push({
            type: 'ADD_POSITION',
            symbol,
            event_time_ms,
            side,
            quantity: qty,
            reduceOnly: false,
            expectedPrice: price,
            targetMarginUsdt,
            targetNotionalUsdt,
            reason: 'scale_in_momentum',
          });
        }
      }
    }

    return actions.length > 0 ? actions : [{ type: 'NOOP', symbol, event_time_ms, reason: 'position_manage' }];
  }

  computeCooldownMs(deltaZ: number, printsPerSecond: number, minMs: number, maxMs: number): number {
    const raw = 200 * (Math.abs(deltaZ) + printsPerSecond / 10);
    return Math.max(minMs, Math.min(maxMs, Math.round(raw)));
  }

  private exitAction(symbol: string, event_time_ms: number, side: 'BUY' | 'SELL', reason: string): DecisionAction {
    const expectedPrice = this.deps.expectedPrice(symbol, side, 'MARKET');
    return {
      type: 'EXIT_MARKET',
      symbol,
      event_time_ms,
      side,
      reduceOnly: true,
      reason,
      expectedPrice,
    };
  }

  private computeProbeQuantity(input: {
    initialMarginUsdt: number;
    expectedPrice: number;
    deltaZ: number;
    obiDeep: number;
    execPoor: boolean;
  }): number {
    const leverage = this.deps.getMaxLeverage();

    const targetMargin = input.initialMarginUsdt;
    const notional = targetMargin * leverage;
    const qty = notional / input.expectedPrice;

    if (!Number.isFinite(qty) || qty <= 0) {
      return 0;
    }

    return Number(qty.toFixed(6));
  }
}
