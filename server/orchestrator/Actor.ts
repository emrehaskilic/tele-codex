import { ExecutionEvent } from '../connectors/executionTypes';
import { DecisionEngine } from './Decision';
import { assessFreezeFromExecQuality } from './FreezeController';
import { ExecQualityLevel } from './types';
import {
  ActorEnvelope,
  DecisionAction,
  GateMode,
  MetricsEventEnvelope,
  OpenOrderState,
  SymbolState,
} from './types';

export interface SymbolActorDeps {
  symbol: string;
  decisionEngine: DecisionEngine;
  onActions: (actions: DecisionAction[]) => Promise<void>;
  onDecisionLogged: (record: {
    symbol: string;
    canonical_time_ms: number;
    exchange_event_time_ms: number | null;
    gate: MetricsEventEnvelope['gate'];
    actions: DecisionAction[];
    executionMode: 'NORMAL' | 'DEGRADED' | 'FREEZE';
    execQuality: ExecQualityLevel;
    execMetricsPresent: boolean;
    freezeActive: boolean;
    emergencyExitAllowed: boolean;
    emergencyExitAllowedReason: string | null;
    invariantViolated: boolean;
    invariantReason: string | null;
    dataGaps: string[];
    initialTradingBalance: number;
    effectiveLeverage: number;
    unrealizedPnlPeak: number | null;
    profitLockActivated: boolean;
    hardStopPrice: number | null;
    exitReason: 'profit_lock' | 'hard_stop' | 'liquidation' | null;
    state: SymbolState;
  }) => void;
  onExecutionLogged: (event: ExecutionEvent | (ExecutionEvent & { slippage_bps?: number; execution_latency_ms?: number }), state: SymbolState) => void;
  getExpectedOrderMeta: (orderId: string) => { expectedPrice: number | null; sentAtMs: number; tag: 'entry' | 'add' | 'exit' } | null;
  getInitialTradingBalance: () => number;
  getEffectiveLeverage: () => number;
  markAddUsed: () => void;
  cooldownConfig: { minMs: number; maxMs: number };
}

export class SymbolActor {
  private readonly queue: ActorEnvelope[] = [];
  private processing = false;
  private lastDeltaZ = 0;
  private lastPrintsPerSecond = 0;

  readonly state: SymbolState;

  constructor(private readonly deps: SymbolActorDeps) {
    this.state = {
      symbol: deps.symbol,
      halted: false,
      availableBalance: 0,
      walletBalance: 0,
      position: null,
      openOrders: new Map<string, OpenOrderState>(),
      hasOpenEntryOrder: false,
      cooldown_until_ms: 0,
      last_exit_event_time_ms: 0,
      marginRatio: null,
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

  enqueue(event: ActorEnvelope) {
    this.queue.push(event);
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => {
        this.processQueue().catch((e) => {
          console.error(`[ACTOR ${this.deps.symbol}] processQueue error:`, e);
          this.processing = false;
        });
      });
    }
  }

  isIdle(): boolean {
    return !this.processing && this.queue.length === 0;
  }

  private async processQueue() {
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      if (event.kind === 'metrics') {
        await this.onMetrics(event);
      } else {
        this.onExecutionEvent(event.execution);
      }
    }
    this.processing = false;
  }

  private async onMetrics(envelope: MetricsEventEnvelope) {
    this.lastDeltaZ = envelope.metrics.legacyMetrics?.deltaZ || 0;
    this.lastPrintsPerSecond = envelope.metrics.prints_per_second || 0;
    this.updateExecQualityFromMetrics(envelope.metrics.spread_pct);

    const actions = this.deps.decisionEngine.evaluate({
      symbol: envelope.symbol,
      event_time_ms: envelope.canonical_time_ms,
      gate: envelope.gate,
      metrics: envelope.metrics,
      state: this.state,
    });

    const emergencyAction = actions.find((a) => a.type === 'EXIT_MARKET' && (a.reason === 'emergency_exit_liquidation_risk' || a.reason === 'emergency_exit_hard_stop'));
    const emergencyExitAllowed = Boolean(emergencyAction);
    const emergencyExitAllowedReason = emergencyAction?.reason || null;
    const dataGaps: string[] = [];
    if (!this.state.execQuality.metricsPresent) {
      dataGaps.push('exec_metrics_missing');
    }
    if (this.state.execQuality.lastSpreadPct === null) {
      dataGaps.push('spread_missing');
    }
    if (this.state.execQuality.lastLatencyMs === null) {
      dataGaps.push('latency_missing');
    }
    if (this.state.execQuality.lastSlippageBps === null) {
      dataGaps.push('slippage_missing');
    }
    const forbiddenEmergency = actions.some((a) => a.type === 'EXIT_MARKET' && a.reason.startsWith('emergency_exit_') && a.reason !== 'emergency_exit_liquidation_risk' && a.reason !== 'emergency_exit_hard_stop');
    const invariantViolated = forbiddenEmergency || (this.state.execQuality.quality === 'UNKNOWN' && actions.some((a) => a.reason === 'emergency_exit_exec_quality'));
    const invariantReason = forbiddenEmergency
      ? 'forbidden_emergency_exit_reason'
      : this.state.execQuality.quality === 'UNKNOWN' && actions.some((a) => a.reason === 'emergency_exit_exec_quality')
      ? 'panic_exit_with_missing_exec_metrics'
      : null;
    const executionMode: 'NORMAL' | 'DEGRADED' | 'FREEZE' =
      this.state.execQuality.freezeActive
        ? 'FREEZE'
        : envelope.gate.mode === GateMode.V1_NO_LATENCY
        ? 'DEGRADED'
        : 'NORMAL';
    const exitReason = actions.some((a) => a.reason === 'profit_lock_exit')
      ? 'profit_lock'
      : actions.some((a) => a.reason === 'emergency_exit_hard_stop')
      ? 'hard_stop'
      : actions.some((a) => a.reason === 'emergency_exit_liquidation_risk')
      ? 'liquidation'
      : null;

    this.deps.onDecisionLogged({
      symbol: envelope.symbol,
      canonical_time_ms: envelope.canonical_time_ms,
      exchange_event_time_ms: envelope.exchange_event_time_ms,
      gate: envelope.gate,
      actions,
      executionMode,
      execQuality: this.state.execQuality.quality,
      execMetricsPresent: this.state.execQuality.metricsPresent,
      freezeActive: this.state.execQuality.freezeActive,
      emergencyExitAllowed,
      emergencyExitAllowedReason,
      invariantViolated,
      invariantReason,
      dataGaps,
      initialTradingBalance: this.deps.getInitialTradingBalance(),
      effectiveLeverage: this.deps.getEffectiveLeverage(),
      unrealizedPnlPeak: this.state.position?.peakPnlPct ?? null,
      profitLockActivated: Boolean(this.state.position?.profitLockActivated),
      hardStopPrice: this.state.position?.hardStopPrice ?? null,
      exitReason,
      state: this.snapshotState(),
    });

    if (actions.length > 0 && !(actions.length === 1 && actions[0].type === 'NOOP')) {
      await this.deps.onActions(actions);
    }
  }

  private onExecutionEvent(event: ExecutionEvent) {
    if (event.type === 'SYSTEM_HALT') {
      this.state.halted = true;
      this.deps.onExecutionLogged(event, this.snapshotState());
      return;
    }

    if (event.type === 'SYSTEM_RESUME') {
      this.state.halted = false;
      this.deps.onExecutionLogged(event, this.snapshotState());
      return;
    }

    if (event.type === 'ORDER_UPDATE') {
      const terminal = event.status === 'FILLED' || event.status === 'CANCELED' || event.status === 'REJECTED' || event.status === 'EXPIRED';
      if (terminal) {
        this.state.openOrders.delete(event.orderId);
      } else {
        this.state.openOrders.set(event.orderId, {
          orderId: event.orderId,
          clientOrderId: event.clientOrderId,
          side: event.side,
          orderType: event.orderType,
          status: event.status,
          origQty: event.origQty,
          executedQty: event.executedQty,
          reduceOnly: event.reduceOnly,
          event_time_ms: event.event_time_ms,
        });
      }

      this.state.hasOpenEntryOrder = Array.from(this.state.openOrders.values()).some((o) => !o.reduceOnly);
      this.deps.onExecutionLogged(event, this.snapshotState());
      return;
    }

    if (event.type === 'OPEN_ORDERS_SNAPSHOT') {
      this.state.openOrders.clear();
      for (const order of event.orders) {
        this.state.openOrders.set(order.orderId, {
          ...order,
          event_time_ms: event.event_time_ms,
        });
      }
      this.state.hasOpenEntryOrder = Array.from(this.state.openOrders.values()).some((o) => !o.reduceOnly);
      this.deps.onExecutionLogged(event, this.snapshotState());
      return;
    }

    if (event.type === 'TRADE_UPDATE') {
      const expected = this.deps.getExpectedOrderMeta(event.orderId);
      let derivedLatencyMs: number | undefined;
      let derivedSlippageBps: number | undefined;
      if (expected) {
        const latency = Math.max(0, event.event_time_ms - expected.sentAtMs);
        const denominator = expected.expectedPrice || event.fillPrice;
        const slippageBps = denominator > 0
          ? Math.abs(event.fillPrice - denominator) / denominator * 10_000
          : 0;
        derivedLatencyMs = latency;
        derivedSlippageBps = slippageBps;

        this.pushExecQuality(latency, slippageBps);
        if (expected.tag === 'add' && this.state.position) {
          this.state.position.addsUsed = Math.min(2, this.state.position.addsUsed + 1);
        }
      }

      this.deps.onExecutionLogged({
        ...event,
        slippage_bps: derivedSlippageBps,
        execution_latency_ms: derivedLatencyMs,
      }, this.snapshotState());
      return;
    }

    if (event.type === 'ACCOUNT_UPDATE') {
      const hadPosition = this.state.position !== null;
      this.state.availableBalance = event.availableBalance;
      this.state.walletBalance = event.walletBalance;
      this.state.marginRatio = event.walletBalance > 0
        ? Math.max(0, Math.min(1, event.availableBalance / event.walletBalance))
        : null;

      const qty = Math.abs(event.positionAmt);
      if (qty === 0) {
        this.state.position = null;
      } else {
        const side = event.positionAmt > 0 ? 'LONG' : 'SHORT';
        const sideChanged = this.state.position?.side && this.state.position.side !== side;
        const prevPeak = this.state.position?.peakPnlPct ?? event.unrealizedPnL;
        this.state.position = {
          side,
          qty,
          entryPrice: event.entryPrice,
          unrealizedPnlPct: event.unrealizedPnL,
          addsUsed: this.state.position?.addsUsed ?? 0,
          peakPnlPct: Math.max(prevPeak, event.unrealizedPnL),
          profitLockActivated: sideChanged ? false : (this.state.position?.profitLockActivated ?? false),
          hardStopPrice: sideChanged ? null : (this.state.position?.hardStopPrice ?? null),
        };
      }

      if (hadPosition && this.state.position === null) {
        this.state.last_exit_event_time_ms = event.event_time_ms;
        const cooldownMs = this.deps.decisionEngine.computeCooldownMs(
          this.lastDeltaZ,
          this.lastPrintsPerSecond,
          this.deps.cooldownConfig.minMs,
          this.deps.cooldownConfig.maxMs
        );
        this.state.cooldown_until_ms = event.event_time_ms + cooldownMs;
      }

      this.deps.onExecutionLogged(event, this.snapshotState());
    }
  }

  private pushExecQuality(latencyMs: number, slippageBps: number) {
    this.state.execQuality.lastLatencyMs = latencyMs;
    this.state.execQuality.lastSlippageBps = slippageBps;
    this.state.execQuality.recentLatencyMs.push(latencyMs);
    this.state.execQuality.recentSlippageBps.push(slippageBps);

    if (this.state.execQuality.recentLatencyMs.length > 20) {
      this.state.execQuality.recentLatencyMs.shift();
    }
    if (this.state.execQuality.recentSlippageBps.length > 20) {
      this.state.execQuality.recentSlippageBps.shift();
    }

    this.refreshExecQuality();
  }

  private updateExecQualityFromMetrics(spreadPct?: number | null) {
    this.state.execQuality.lastSpreadPct = typeof spreadPct === 'number' && Number.isFinite(spreadPct)
      ? spreadPct
      : null;
    this.refreshExecQuality();
  }

  private refreshExecQuality() {
    const hasLatency = typeof this.state.execQuality.lastLatencyMs === 'number' && Number.isFinite(this.state.execQuality.lastLatencyMs);
    const hasSlippage = typeof this.state.execQuality.lastSlippageBps === 'number' && Number.isFinite(this.state.execQuality.lastSlippageBps);
    const hasSpread = typeof this.state.execQuality.lastSpreadPct === 'number' && Number.isFinite(this.state.execQuality.lastSpreadPct);

    this.state.execQuality.metricsPresent = hasLatency && hasSlippage && hasSpread;

    let quality: ExecQualityLevel = 'UNKNOWN';
    if (this.state.execQuality.metricsPresent) {
      const latencyBad = (this.state.execQuality.lastLatencyMs as number) > 2000;
      const slippageBad = (this.state.execQuality.lastSlippageBps as number) > 30;
      const spreadBad = Math.abs(this.state.execQuality.lastSpreadPct as number) > 0.08;
      quality = latencyBad || slippageBad || spreadBad ? 'BAD' : 'GOOD';
    }

    this.state.execQuality.quality = quality;
    this.state.execQuality.freezeActive = assessFreezeFromExecQuality(quality).freezeActive;
  }

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private snapshotState(): SymbolState {
    return {
      ...this.state,
      openOrders: new Map(this.state.openOrders),
      position: this.state.position ? { ...this.state.position } : null,
      execQuality: {
        quality: this.state.execQuality.quality,
        metricsPresent: this.state.execQuality.metricsPresent,
        freezeActive: this.state.execQuality.freezeActive,
        lastLatencyMs: this.state.execQuality.lastLatencyMs,
        lastSlippageBps: this.state.execQuality.lastSlippageBps,
        lastSpreadPct: this.state.execQuality.lastSpreadPct,
        recentLatencyMs: [...this.state.execQuality.recentLatencyMs],
        recentSlippageBps: [...this.state.execQuality.recentSlippageBps],
      },
    };
  }
}
