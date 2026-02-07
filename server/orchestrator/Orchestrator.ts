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
  private readonly executionSymbols = new Set<string>();
  private capitalSettings = {
    initialBalanceUsdt: 1000,
    walletUsagePercent: 10,
    leverage: 10,
  };
  private readonly realizedPnlBySymbol = new Map<string, number>();

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
      if (event.type === 'TRADE_UPDATE') {
        const prev = this.realizedPnlBySymbol.get(event.symbol) || 0;
        this.realizedPnlBySymbol.set(event.symbol, prev + event.realizedPnl);
      }
      this.ingestExecutionReplay(event);
    });
  }

  async start() {
    await this.connector.start();
  }

  ingest(metrics: OrchestratorMetricsInput) {
    const symbol = metrics.symbol.toUpperCase();
    if (this.executionSymbols.size > 0 && !this.executionSymbols.has(symbol)) {
      return;
    }
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
    if (this.executionSymbols.size > 0 && !this.executionSymbols.has(symbol)) {
      return;
    }
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
      this.logger.logMetrics({
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
    if (this.executionSymbols.size > 0 && !this.executionSymbols.has(symbol)) {
      return;
    }
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

  getExecutionStatus() {
    const connectorStatus = this.connector.getStatus();
    const selectedSymbols = Array.from(this.executionSymbols);
    const primarySymbol = selectedSymbols[0] || null; // Legacy support

    // Aggregated PnL
    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalWallet = 0;
    let totalAvailable = 0;

    // We can get wallet balance from any actor state if available, or just use the first valid one
    // Ideally, wallet balance is account-wide.
    let walletFound = false;

    if (this.executionSymbols.size > 0) {
      for (const sym of this.executionSymbols) {
        const state = this.actors.get(sym)?.state;
        if (state) {
          if (!walletFound) {
            totalWallet = state.walletBalance;
            totalAvailable = state.availableBalance;
            walletFound = true;
          }
          totalRealized += (this.realizedPnlBySymbol.get(sym) || 0);
          totalUnrealized += (state.position?.unrealizedPnlPct || 0);
        }
      }
    }

    return {
      connection: connectorStatus,
      selectedSymbol: primarySymbol, // Legacy
      selectedSymbols, // New
      settings: this.capitalSettings,
      wallet: {
        totalWalletUsdt: totalWallet,
        availableBalanceUsdt: totalAvailable,
        realizedPnl: totalRealized,
        unrealizedPnl: totalUnrealized,
        totalPnl: totalRealized + totalUnrealized,
      },
      openPosition: primarySymbol ? (this.actors.get(primarySymbol)?.state?.position ? {
        side: this.actors.get(primarySymbol)!.state.position!.side,
        size: this.actors.get(primarySymbol)!.state.position!.qty,
        entryPrice: this.actors.get(primarySymbol)!.state.position!.entryPrice,
        leverage: this.capitalSettings.leverage,
      } : null) : null,
      openPositions: selectedSymbols.reduce((acc, sym) => {
        const pos = this.actors.get(sym)?.state.position;
        if (pos) {
          acc[sym] = {
            side: pos.side,
            size: pos.qty,
            entryPrice: pos.entryPrice,
            leverage: this.capitalSettings.leverage
          };
        }
        return acc;
      }, {} as any)
    };
  }

  updateCapitalSettings(input: { initialBalanceUsdt?: number; walletUsagePercent?: number; leverage?: number }) {
    if (typeof input.initialBalanceUsdt === 'number' && Number.isFinite(input.initialBalanceUsdt) && input.initialBalanceUsdt >= 0) {
      this.capitalSettings.initialBalanceUsdt = input.initialBalanceUsdt;
    }
    if (typeof input.walletUsagePercent === 'number' && Number.isFinite(input.walletUsagePercent) && input.walletUsagePercent >= 0 && input.walletUsagePercent <= 100) {
      this.capitalSettings.walletUsagePercent = input.walletUsagePercent;
    }
    if (typeof input.leverage === 'number' && Number.isFinite(input.leverage) && input.leverage > 0) {
      this.capitalSettings.leverage = Math.min(input.leverage, this.config.maxLeverage);
    }
    return this.capitalSettings;
  }

  async setExecutionEnabled(enabled: boolean) {
    this.connector.setExecutionEnabled(enabled);
  }

  async connectExecution(apiKey: string, apiSecret: string) {
    this.connector.setCredentials(apiKey, apiSecret);
    await this.connector.connect();
  }

  async disconnectExecution() {
    for (const symbol of this.executionSymbols) {
      try {
        await this.connector.cancelAllOpenOrders(symbol);
      } catch (e: any) {
        // Best effort
        this.logger.logExecution(Date.now(), {
          event_time_ms: Date.now(),
          symbol,
          event: {
            type: 'ERROR',
            symbol,
            event_time_ms: Date.now(),
            error: 'Disconnect cancel failed: ' + (e.message || String(e))
          } as any, // Cast to any because ERROR type might not be fully defined in ExecutionTypes or similar
          state: this.actors.get(symbol)?.state as any
        });
      }
    }
    await this.connector.disconnect();
  }

  async listTestnetFuturesPairs() {
    return this.connector.fetchTestnetFuturesPairs();
  }

  async setExecutionSymbols(symbols: string[]) {
    const normalized = symbols.map(s => s.toUpperCase());
    const newSet = new Set(normalized);

    // Identify removed symbols
    for (const existing of this.executionSymbols) {
      if (!newSet.has(existing)) {
        await this.connector.cancelAllOpenOrders(existing);
        this.actors.delete(existing);
        this.realizedPnlBySymbol.delete(existing);
      }
    }

    this.executionSymbols.clear();
    for (const s of newSet) {
      this.executionSymbols.add(s);
    }

    this.connector.setSymbols(normalized);
    await this.connector.syncState();
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
        if (!this.connector.isExecutionEnabled()) {
          return;
        }
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

      if (!this.connector.isExecutionEnabled()) {
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
  const executionEnabledEnv = String(process.env.EXECUTION_ENABLED || 'false').toLowerCase();
  const gateMode = process.env.ENABLE_GATE_V2 === 'true'
    ? GateMode.V2_NETWORK_LATENCY
    : GateMode.V1_NO_LATENCY;

  const connector = new ExecutionConnector({
    enabled: executionEnabledEnv === 'true' || executionEnabledEnv === '1',
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
    maxLeverage: Number(process.env.MAX_LEVERAGE || 100),
    cooldownMinMs: Number(process.env.COOLDOWN_MIN_MS || 2000),
    cooldownMaxMs: Number(process.env.COOLDOWN_MAX_MS || 30000),
    loggerQueueLimit: Number(process.env.LOGGER_QUEUE_LIMIT || 5000),
    loggerDropHaltThreshold: Number(process.env.LOGGER_DROP_HALT_THRESHOLD || 200),
  });
}
