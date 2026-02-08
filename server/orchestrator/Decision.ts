import { DecisionAction, GateResult, OrchestratorMetricsInput, SymbolState } from './types';
import { evaluateHardStop } from './HardStopGuard';
import { liquidationRiskTriggered } from './LiquidationGuard';

export interface DecisionDependencies {
  expectedPrice: (symbol: string, side: 'BUY' | 'SELL', type: 'MARKET' | 'LIMIT', limitPrice?: number) => number | null;
  getSizingBalance: (symbol: string, availableBalance: number) => number;
  getMaxLeverage: () => number;
  hardStopLossPct: number;
  liquidationEmergencyMarginRatio: number;
  takerFeeBps: number;
  profitLockBufferBps: number;
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
    const freezeActive = state.execQuality.freezeActive;

    const inCooldown = event_time_ms < state.cooldown_until_ms;
    const marketPrice = this.resolveMarketPrice(metrics, state.position?.side || null);
    this.activateProfitLockIfEligible(state, marketPrice);

    const liquidationTriggered = liquidationRiskTriggered(state, {
      emergencyMarginRatio: this.deps.liquidationEmergencyMarginRatio,
    });
    const hardStopEvaluation = evaluateHardStop(state, { maxLossPct: this.deps.hardStopLossPct }, marketPrice);

    const emergencyReason = liquidationTriggered
      ? 'emergency_exit_liquidation_risk'
      : hardStopEvaluation.profitLockTriggered
      ? 'profit_lock_exit'
      : hardStopEvaluation.hardStopTriggered
      ? 'emergency_exit_hard_stop'
      : null;

    if (state.halted && state.hasOpenEntryOrder) {
      actions.push({
        type: 'CANCEL_OPEN_ENTRY_ORDERS',
        symbol,
        event_time_ms,
        reason: 'halt_mode_cancel_entry',
      });
    }

    if (state.position === null) {
      if (!state.halted && !freezeActive && !state.hasOpenEntryOrder && state.openOrders.size === 0 && !inCooldown) {
        const side = deltaZ > 0 ? 'BUY' : deltaZ < 0 ? 'SELL' : null;
        if (side) {
          const price = this.deps.expectedPrice(symbol, side, 'MARKET');
          if (price && price > 0) {
            const probeQuantity = this.computeProbeQuantity({
              symbol,
              availableBalance: state.availableBalance,
              expectedPrice: price,
              deltaZ,
              obiDeep,
              execPoor: state.execQuality.quality === 'BAD',
            });

            if (probeQuantity > 0) {
              actions.push({
                type: 'ENTRY_PROBE',
                symbol,
                event_time_ms,
                side,
                quantity: probeQuantity,
                reduceOnly: false,
                expectedPrice: price,
                reason: 'entry_probe_liquidity_pressure_context',
              });
            }
          }
        }
      }
      return actions.length > 0
        ? actions
        : [{ type: 'NOOP', symbol, event_time_ms, reason: state.halted ? 'halt_mode' : freezeActive ? 'freeze_active' : inCooldown ? 'cooldown' : 'flat_wait' }];
    }

    const position = state.position;

    if (emergencyReason) {
      actions.push(this.exitAction(symbol, event_time_ms, position.side === 'LONG' ? 'SELL' : 'BUY', emergencyReason));
      return actions;
    }

    if (freezeActive) {
      return actions.length > 0 ? actions : [{ type: 'NOOP', symbol, event_time_ms, reason: 'freeze_active' }];
    }

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

    const canAdd =
      !state.halted &&
      position.addsUsed < 2 &&
      position.unrealizedPnlPct > 0.10 &&
      state.execQuality.quality === 'GOOD' &&
      ((position.side === 'LONG' && deltaZ > 0) || (position.side === 'SHORT' && deltaZ < 0));

    if (canAdd) {
      const side = position.side === 'LONG' ? 'BUY' : 'SELL';
      const price = this.deps.expectedPrice(symbol, side, 'MARKET');
      if (price && price > 0) {
        const qty = this.computeProbeQuantity({
            symbol,
            availableBalance: state.availableBalance,
            expectedPrice: price,
            deltaZ,
            obiDeep,
            execPoor: state.execQuality.quality === 'BAD',
          });
        if (qty > 0) {
          actions.push({
            type: 'ADD_POSITION',
            symbol,
            event_time_ms,
            side,
            quantity: qty,
            reduceOnly: false,
            expectedPrice: price,
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
    symbol: string;
    availableBalance: number;
    expectedPrice: number;
    deltaZ: number;
    obiDeep: number;
    execPoor: boolean;
  }): number {
    const sizingBalance = this.deps.getSizingBalance(input.symbol, input.availableBalance);
    const leverage = this.deps.getMaxLeverage();

    const notional = sizingBalance * leverage;
    const qty = notional / input.expectedPrice;

    if (!Number.isFinite(qty) || qty <= 0) {
      return 0;
    }

    return Number(qty.toFixed(6));
  }

  private resolveMarketPrice(metrics: OrchestratorMetricsInput, positionSide: 'LONG' | 'SHORT' | null): number | null {
    if (positionSide === 'LONG') {
      const px = metrics.best_bid ?? metrics.best_ask ?? null;
      return typeof px === 'number' && Number.isFinite(px) ? px : null;
    }
    if (positionSide === 'SHORT') {
      const px = metrics.best_ask ?? metrics.best_bid ?? null;
      return typeof px === 'number' && Number.isFinite(px) ? px : null;
    }
    const bid = metrics.best_bid;
    const ask = metrics.best_ask;
    if (typeof bid === 'number' && Number.isFinite(bid) && typeof ask === 'number' && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
    return null;
  }

  private activateProfitLockIfEligible(state: SymbolState, marketPrice: number | null) {
    if (!state.position) {
      return;
    }
    if (state.position.profitLockActivated) {
      return;
    }
    if (state.position.unrealizedPnlPct < 0.30) {
      return;
    }
    if (!(typeof marketPrice === 'number' && Number.isFinite(marketPrice) && marketPrice > 0)) {
      return;
    }

    const feeAndBufferBps = (this.deps.takerFeeBps * 2) + this.deps.profitLockBufferBps;
    const multiplier = feeAndBufferBps / 10_000;
    const stop = state.position.side === 'LONG'
      ? state.position.entryPrice * (1 + multiplier)
      : state.position.entryPrice * (1 - multiplier);

    state.position.hardStopPrice = Number(stop.toFixed(8));
    state.position.profitLockActivated = true;
  }
}
