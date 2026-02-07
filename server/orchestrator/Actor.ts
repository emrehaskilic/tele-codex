import { ExecutionEvent } from '../connectors/executionTypes';
import { DecisionEngine } from './Decision';
import {
  ActorEnvelope,
  DecisionAction,
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
    state: SymbolState;
  }) => void;
  onExecutionLogged: (event: ExecutionEvent | (ExecutionEvent & { slippage_bps?: number; execution_latency_ms?: number }), state: SymbolState) => void;
  getExpectedOrderMeta: (orderId: string) => { expectedPrice: number | null; sentAtMs: number; tag: 'entry' | 'add' | 'exit' } | null;
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
      execQuality: {
        poor: false,
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
        this.processQueue().catch(() => {
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

    const actions = this.deps.decisionEngine.evaluate({
      symbol: envelope.symbol,
      event_time_ms: envelope.canonical_time_ms,
      gate: envelope.gate,
      metrics: envelope.metrics,
      state: this.state,
    });

    this.deps.onDecisionLogged({
      symbol: envelope.symbol,
      canonical_time_ms: envelope.canonical_time_ms,
      exchange_event_time_ms: envelope.exchange_event_time_ms,
      gate: envelope.gate,
      actions,
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

      const qty = Math.abs(event.positionAmt);
      if (qty === 0) {
        this.state.position = null;
      } else {
        const side = event.positionAmt > 0 ? 'LONG' : 'SHORT';
        const prevPeak = this.state.position?.peakPnlPct ?? event.unrealizedPnL;
        this.state.position = {
          side,
          qty,
          entryPrice: event.entryPrice,
          unrealizedPnlPct: event.unrealizedPnL,
          addsUsed: this.state.position?.addsUsed ?? 0,
          peakPnlPct: Math.max(prevPeak, event.unrealizedPnL),
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
    this.state.execQuality.recentLatencyMs.push(latencyMs);
    this.state.execQuality.recentSlippageBps.push(slippageBps);

    if (this.state.execQuality.recentLatencyMs.length > 20) {
      this.state.execQuality.recentLatencyMs.shift();
    }
    if (this.state.execQuality.recentSlippageBps.length > 20) {
      this.state.execQuality.recentSlippageBps.shift();
    }

    const latAvg = this.average(this.state.execQuality.recentLatencyMs);
    const slipAvg = this.average(this.state.execQuality.recentSlippageBps);
    this.state.execQuality.poor = latAvg > 2000 || slipAvg > 30;
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
        poor: this.state.execQuality.poor,
        recentLatencyMs: [...this.state.execQuality.recentLatencyMs],
        recentSlippageBps: [...this.state.execQuality.recentSlippageBps],
      },
    };
  }
}
