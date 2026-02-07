import * as path from 'path';
import { ExecutionConnector } from '../connectors/ExecutionConnector';
import { ExecutionEvent } from '../connectors/executionTypes';
import { SymbolActor } from './Actor';
import { DecisionEngine } from './Decision';
import { runGate } from './Gate';
import { OrchestratorLogger } from './Logger';
import {
  DecisionAction,
  DecisionRecord,
  ExecutionEventEnvelope,
  GateMode,
  MetricsEventEnvelope,
  OrchestratorConfig,
  OrchestratorMetricsInput,
  SymbolState,
} from './types';

export class Orchestrator {
  private readonly actors = new Map<string, SymbolActor>();
  private readonly decisionEngine: DecisionEngine;
  private readonly logger: OrchestratorLogger;
  private readonly expectedByOrderId = new Map<string, { expectedPrice: number | null; sentAtMs: number; tag: 'entry' | 'add' | 'exit' }>();
  private readonly decisionLedger: DecisionRecord[] = [];

  constructor(
    private readonly connector: ExecutionConnector,
    private readonly config: OrchestratorConfig
  ) {
    this.decisionEngine = new DecisionEngine({
      expectedPrice: (symbol, side, type, limitPrice) => this.connector.expectedPrice(symbol, side, type, limitPrice),
      riskPerTradePercent: config.riskPerTradePercent,
      maxLeverage: config.maxLeverage,
    });

    this.logger = new OrchestratorLogger({
      dir: path.resolve(__dirname, '../logs/orchestrator'),
      queueLimit: config.loggerQueueLimit,
      dropHaltThreshold: config.loggerDropHaltThreshold,
      onDropSpike: (dropCount) => {
        for (const symbol of this.actors.keys()) {
          this.ingestExecutionReplay({
            type: 'SYSTEM_HALT',
            symbol,
            event_time_ms: Date.now(),
            reason: `logger_drop_spike:${dropCount}`,
          });
        }
      },
    });

    this.connector.onExecutionEvent((event) => {
      this.ingestExecutionReplay(event);
    });
  }

  async start() {
    await this.connector.start();
  }

  ingest(metrics: OrchestratorMetricsInput) {
    const symbol = metrics.symbol.toUpperCase();
    this.connector.ensureSymbol(symbol);

    const canonical_time_ms = metrics.canonical_time_ms ?? Date.now();
    const exchange_event_time_ms =
      typeof metrics.exchange_event_time_ms === 'number' && Number.isFinite(metrics.exchange_event_time_ms)
        ? metrics.exchange_event_time_ms
        : null;

    const gate = runGate(
      {
        canonical_time_ms,
        exchange_event_time_ms,
        metrics,
      },
      this.config.gate
    );

    this.enqueueMetrics(symbol, canonical_time_ms, exchange_event_time_ms, metrics, gate, true);
  }

  ingestLoggedMetrics(logLine: {
    symbol: string;
    canonical_time_ms: number;
    exchange_event_time_ms: number | null;
    metrics: OrchestratorMetricsInput;
    gate: MetricsEventEnvelope['gate'];
  }) {
    const symbol = logLine.symbol.toUpperCase();
    this.connector.ensureSymbol(symbol);
    this.enqueueMetrics(
      symbol,
      logLine.canonical_time_ms,
      logLine.exchange_event_time_ms,
      logLine.metrics,
      logLine.gate,
      false
    );
  }

  private enqueueMetrics(
    symbol: string,
    canonical_time_ms: number,
    exchange_event_time_ms: number | null,
    metrics: OrchestratorMetricsInput,
    gate: MetricsEventEnvelope['gate'],
    shouldLog: boolean
  ) {
    const envelope: MetricsEventEnvelope = {
      kind: 'metrics',
      symbol,
      canonical_time_ms,
      exchange_event_time_ms,
      metrics,
      gate,
    };

    if (shouldLog) {
      this.logger.logMetrics(canonical_time_ms, {
        canonical_time_ms,
        exchange_event_time_ms,
        symbol,
        gate,
        metrics,
      });
    }

    this.getActor(symbol).enqueue(envelope);
  }

  ingestExecutionReplay(execution: ExecutionEvent) {
    const symbol = execution.symbol.toUpperCase();
    this.connector.ensureSymbol(symbol);

    const envelope: ExecutionEventEnvelope = {
      kind: 'execution',
      symbol,
      event_time_ms: execution.event_time_ms,
      execution,
    };

    this.getActor(symbol).enqueue(envelope);
  }

  async flush() {
    // Wait until all actor queues are drained.
    while (Array.from(this.actors.values()).some((a) => !a.isIdle())) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  resetForReplay() {
    this.actors.clear();
    this.expectedByOrderId.clear();
    this.decisionLedger.length = 0;
  }

  getDecisionLedger(): DecisionRecord[] {
    return this.decisionLedger.map((r) => ({
      ...r,
      actions: r.actions.map((a) => ({ ...a })),
      stateSnapshot: {
        ...r.stateSnapshot,
        position: r.stateSnapshot.position ? { ...r.stateSnapshot.position } : null,
      },
    }));
  }

  getStateSnapshot(): Record<string, SymbolState> {
    const out: Record<string, SymbolState> = {};
    for (const [symbol, actor] of this.actors) {
      const st = actor.state;
      out[symbol] = {
        ...st,
        openOrders: new Map(st.openOrders),
        position: st.position ? { ...st.position } : null,
        execQuality: {
          poor: st.execQuality.poor,
          recentLatencyMs: [...st.execQuality.recentLatencyMs],
          recentSlippageBps: [...st.execQuality.recentSlippageBps],
        },
      };
    }
    return out;
  }

  private getActor(symbol: string): SymbolActor {
    let actor = this.actors.get(symbol);
    if (actor) {
      return actor;
    }

    actor = new SymbolActor({
      symbol,
      decisionEngine: this.decisionEngine,
      onActions: async (actions) => {
        await this.executeActions(symbol, actions);
      },
      onDecisionLogged: ({ symbol: s, canonical_time_ms, exchange_event_time_ms, gate, actions, state }) => {
        const record: DecisionRecord = {
          symbol: s,
          canonical_time_ms,
          exchange_event_time_ms,
          gate,
          actions,
          stateSnapshot: {
            halted: state.halted,
            availableBalance: state.availableBalance,
            cooldown_until_ms: state.cooldown_until_ms,
            hasOpenEntryOrder: state.hasOpenEntryOrder,
            openOrders: state.openOrders.size,
            position: state.position ? { ...state.position } : null,
          },
        };
        this.decisionLedger.push(record);
        this.logger.logDecision(canonical_time_ms, record);
      },
      onExecutionLogged: (event, state) => {
        this.logger.logExecution(event.event_time_ms, {
          event_time_ms: event.event_time_ms,
          symbol: event.symbol,
          event,
          state: {
            halted: state.halted,
            availableBalance: state.availableBalance,
            walletBalance: state.walletBalance,
            cooldown_until_ms: state.cooldown_until_ms,
            hasOpenEntryOrder: state.hasOpenEntryOrder,
            openOrders: Array.from(state.openOrders.values()),
            position: state.position,
            execQuality: state.execQuality,
          },
        });
      },
      getExpectedOrderMeta: (orderId) => this.expectedByOrderId.get(orderId) || null,
      markAddUsed: () => {
        // kept for future hook extensions
      },
      cooldownConfig: {
        minMs: this.config.cooldownMinMs,
        maxMs: this.config.cooldownMaxMs,
      },
    });

    this.actors.set(symbol, actor);
    return actor;
  }

  private async executeActions(symbol: string, actions: DecisionAction[]) {
    const actor = this.getActor(symbol);
    for (const action of actions) {
      if (action.type === 'NOOP') {
        continue;
      }

      if (action.type === 'CANCEL_OPEN_ENTRY_ORDERS') {
        for (const order of actor.state.openOrders.values()) {
          if (!order.reduceOnly) {
            await this.connector.cancelOrder({ symbol, orderId: order.orderId, clientOrderId: order.clientOrderId });
          }
        }
        continue;
      }

      if (action.type === 'EXIT_MARKET') {
        const position = actor.state.position;
        if (!position || !action.side) {
          continue;
        }
        const clientOrderId = this.clientOrderId('exit', symbol, action.event_time_ms);
        const response = await this.connector.placeOrder({
          symbol,
          side: action.side,
          type: 'MARKET',
          quantity: position.qty,
          reduceOnly: true,
          clientOrderId,
        });
        this.expectedByOrderId.set(response.orderId, {
          expectedPrice: action.expectedPrice || null,
          sentAtMs: action.event_time_ms,
          tag: 'exit',
        });
        continue;
      }

      if ((action.type === 'ENTRY_PROBE' || action.type === 'ADD_POSITION') && action.side && action.quantity && action.quantity > 0) {
        const tag = action.type === 'ENTRY_PROBE' ? 'entry' : 'add';
        const clientOrderId = this.clientOrderId(tag, symbol, action.event_time_ms);
        const response = await this.connector.placeOrder({
          symbol,
          side: action.side,
          type: 'MARKET',
          quantity: action.quantity,
          reduceOnly: false,
          clientOrderId,
        });

        this.expectedByOrderId.set(response.orderId, {
          expectedPrice: action.expectedPrice || null,
          sentAtMs: action.event_time_ms,
          tag,
        });
      }
    }
  }

  private clientOrderId(tag: string, symbol: string, eventTimeMs: number): string {
    return `${tag}_${symbol}_${eventTimeMs}`.slice(0, 36);
  }
}

export function createOrchestratorFromEnv(): Orchestrator {
  const gateMode = process.env.ENABLE_GATE_V2 === 'true'
    ? GateMode.V2_NETWORK_LATENCY
    : GateMode.V1_NO_LATENCY;

  const connector = new ExecutionConnector({
    enabled: process.env.EXECUTION_ENABLED === '1',
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
    restBaseUrl: process.env.BINANCE_TESTNET_REST_BASE || 'https://testnet.binancefuture.com',
    userDataWsBaseUrl: process.env.BINANCE_TESTNET_USER_WS_BASE || 'wss://stream.binancefuture.com',
    marketWsBaseUrl: process.env.BINANCE_TESTNET_MARKET_WS_BASE || 'wss://stream.binancefuture.com',
    recvWindowMs: Number(process.env.BINANCE_RECV_WINDOW_MS || 5000),
  });

  return new Orchestrator(connector, {
    gate: {
      mode: gateMode,
      maxSpreadPct: Number(process.env.MAX_SPREAD_PCT || 0.08),
      minObiDeep: Number(process.env.MIN_OBI_DEEP || 0.05),
      v2: {
        maxNetworkLatencyMs: Number(process.env.MAX_NETWORK_LATENCY_MS || 1500),
      },
    },
    riskPerTradePercent: Number(process.env.RISK_PER_TRADE_PERCENT || 0.5),
    maxLeverage: Number(process.env.MAX_LEVERAGE || 25),
    cooldownMinMs: Number(process.env.COOLDOWN_MIN_MS || 2000),
    cooldownMaxMs: Number(process.env.COOLDOWN_MAX_MS || 30000),
    loggerQueueLimit: Number(process.env.LOGGER_QUEUE_LIMIT || 5000),
    loggerDropHaltThreshold: Number(process.env.LOGGER_DROP_HALT_THRESHOLD || 200),
  });
}
