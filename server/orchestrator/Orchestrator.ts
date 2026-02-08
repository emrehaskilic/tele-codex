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
  private readonly realizedPnlBySymbol = new Map<string, number>();

  private capitalSettings = {
    initialTradingBalance: 100,
    leverage: 10,
  };

  constructor(
    private readonly connector: ExecutionConnector,
    private readonly config: OrchestratorConfig
  ) {
    this.capitalSettings.initialTradingBalance = Math.max(0, config.initialTradingBalance);
    this.capitalSettings.leverage = Math.min(this.connector.getPreferredLeverage(), config.maxLeverage);
    this.connector.setPreferredLeverage(this.capitalSettings.leverage);

    this.decisionEngine = new DecisionEngine({
      expectedPrice: (symbol, side, type, limitPrice) => this.connector.expectedPrice(symbol, side, type, limitPrice),
      getSizingBalance: (symbol, availableBalance) => this.resolveSizingBalance(symbol, availableBalance),
      getMaxLeverage: () => this.capitalSettings.leverage,
      hardStopLossPct: this.config.hardStopLossPct,
      liquidationEmergencyMarginRatio: this.config.liquidationEmergencyMarginRatio,
      takerFeeBps: this.config.takerFeeBps,
      profitLockBufferBps: this.config.profitLockBufferBps,
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

    this.connector.onDebug((event) => {
      this.logger.logExecution(event.ts, event);
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
          quality: st.execQuality.quality,
          metricsPresent: st.execQuality.metricsPresent,
          freezeActive: st.execQuality.freezeActive,
          lastLatencyMs: st.execQuality.lastLatencyMs,
          lastSlippageBps: st.execQuality.lastSlippageBps,
          lastSpreadPct: st.execQuality.lastSpreadPct,
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
    const primarySymbol = selectedSymbols[0] || null;

    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalWallet = 0;
    let totalAvailable = 0;
    let walletFound = false;

    for (const sym of selectedSymbols) {
      const state = this.actors.get(sym)?.state;
      if (!state) {
        continue;
      }
      if (!walletFound) {
        totalWallet = state.walletBalance;
        totalAvailable = state.availableBalance;
        walletFound = true;
      }
      totalRealized += this.realizedPnlBySymbol.get(sym) || 0;
      totalUnrealized += state.position?.unrealizedPnlPct || 0;
    }

    const openPositions = selectedSymbols.reduce((acc, sym) => {
      const pos = this.actors.get(sym)?.state.position;
      if (pos) {
        acc[sym] = {
          side: pos.side,
          size: pos.qty,
          entryPrice: pos.entryPrice,
          leverage: this.capitalSettings.leverage,
        };
      }
      return acc;
    }, {} as Record<string, { side: 'LONG' | 'SHORT'; size: number; entryPrice: number; leverage: number }>);

    const primaryPosition = primarySymbol ? openPositions[primarySymbol] || null : null;

    return {
      connection: connectorStatus,
      selectedSymbol: primarySymbol,
      selectedSymbols,
      settings: this.capitalSettings,
      wallet: {
        totalWalletUsdt: totalWallet,
        availableBalanceUsdt: totalAvailable,
        realizedPnl: totalRealized,
        unrealizedPnl: totalUnrealized,
        totalPnl: totalRealized + totalUnrealized,
      },
      openPosition: primaryPosition,
      openPositions,
    };
  }

  async updateCapitalSettings(input: { initialTradingBalance?: number; leverage?: number }) {
    if (typeof input.initialTradingBalance === 'number' && Number.isFinite(input.initialTradingBalance) && input.initialTradingBalance >= 0) {
      this.capitalSettings.initialTradingBalance = input.initialTradingBalance;
    }
    if (typeof input.leverage === 'number' && Number.isFinite(input.leverage) && input.leverage > 0) {
      this.capitalSettings.leverage = Math.min(input.leverage, this.config.maxLeverage);
      this.connector.setPreferredLeverage(this.capitalSettings.leverage);
      if (this.connector.isConnected() && this.executionSymbols.size > 0) {
        await this.connector.ensureSymbolsReady();
      }
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
      await this.connector.cancelAllOpenOrders(symbol);
    }
    await this.connector.disconnect();
  }

  async listTestnetFuturesPairs() {
    return this.connector.fetchTestnetFuturesPairs();
  }

  async refreshExecutionState() {
    if (this.executionSymbols.size > 0) {
      const realizedSnapshot = await this.connector.fetchRealizedPnlBySymbol(Array.from(this.executionSymbols));
      for (const [symbol, realized] of realizedSnapshot) {
        this.realizedPnlBySymbol.set(symbol, realized);
      }
    }
    await this.connector.syncState();
    await this.flush();
    return this.getExecutionStatus();
  }

  async setExecutionSymbols(symbols: string[]) {
    const normalized = symbols.map((s) => s.toUpperCase());
    const newSet = new Set(normalized);

    for (const existing of this.executionSymbols) {
      if (!newSet.has(existing)) {
        await this.connector.cancelAllOpenOrders(existing);
        this.actors.delete(existing);
        this.realizedPnlBySymbol.delete(existing);
      }
    }

    this.executionSymbols.clear();
    for (const symbol of newSet) {
      this.executionSymbols.add(symbol);
      this.getActor(symbol);
    }

    this.connector.setSymbols(normalized);
    await this.connector.syncState();
    await this.connector.ensureSymbolsReady();
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
      onDecisionLogged: ({
        symbol: s,
        canonical_time_ms,
        exchange_event_time_ms,
        gate,
        actions,
        executionMode,
        execQuality,
        execMetricsPresent,
        freezeActive,
        emergencyExitAllowed,
        emergencyExitAllowedReason,
        invariantViolated,
        invariantReason,
        dataGaps,
        initialTradingBalance,
        effectiveLeverage,
        unrealizedPnlPeak,
        profitLockActivated,
        hardStopPrice,
        exitReason,
        state,
      }) => {
        const record: DecisionRecord = {
          symbol: s,
          canonical_time_ms,
          exchange_event_time_ms,
          gate,
          actions,
          execution_mode: executionMode,
          exec_quality: execQuality,
          exec_metrics_present: execMetricsPresent,
          freeze_active: freezeActive,
          emergency_exit_allowed: emergencyExitAllowed,
          emergency_exit_allowed_reason: emergencyExitAllowedReason,
          invariant_violated: invariantViolated,
          invariant_reason: invariantReason,
          data_gaps: dataGaps,
          initial_trading_balance: initialTradingBalance,
          effective_leverage: effectiveLeverage,
          unrealized_pnl_peak: unrealizedPnlPeak,
          profit_lock_activated: profitLockActivated,
          hard_stop_price: hardStopPrice,
          exit_reason: exitReason,
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
            marginRatio: state.marginRatio,
            initial_trading_balance: this.capitalSettings.initialTradingBalance,
            effective_leverage: this.capitalSettings.leverage,
            unrealized_pnl_peak: state.position?.peakPnlPct ?? null,
            profit_lock_activated: state.position?.profitLockActivated ?? false,
            hard_stop_price: state.position?.hardStopPrice ?? null,
          },
        });
      },
      getExpectedOrderMeta: (orderId) => this.expectedByOrderId.get(orderId) || null,
      getInitialTradingBalance: () => this.capitalSettings.initialTradingBalance,
      getEffectiveLeverage: () => this.capitalSettings.leverage,
      markAddUsed: () => {
        // no-op
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
      const decisionId = `${symbol}_${action.event_time_ms}`;
      const orderAttemptId = `${decisionId}_${action.type}`;

      if (action.type === 'NOOP') {
        continue;
      }

      if (!this.connector.isExecutionEnabled()) {
        this.logger.logExecution(action.event_time_ms, {
          channel: 'execution',
          type: 'why_not_sent',
          ts: action.event_time_ms,
          decision_id: decisionId,
          order_attempt_id: orderAttemptId,
          symbol,
          payload: { why_not_sent: 'disabled' },
        });
        continue;
      }

      if (!this.connector.isConnected()) {
        this.logger.logExecution(action.event_time_ms, {
          channel: 'execution',
          type: 'why_not_sent',
          ts: action.event_time_ms,
          decision_id: decisionId,
          order_attempt_id: orderAttemptId,
          symbol,
          payload: { why_not_sent: 'not_connected' },
        });
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
        const response = await this.connector.placeOrder(
          {
            symbol,
            side: action.side,
            type: 'MARKET',
            quantity: position.qty,
            reduceOnly: true,
            clientOrderId,
          },
          { decisionId, orderAttemptId }
        );

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

        const response = await this.connector.placeOrder(
          {
            symbol,
            side: action.side,
            type: 'MARKET',
            quantity: action.quantity,
            reduceOnly: false,
            clientOrderId,
          },
          { decisionId, orderAttemptId }
        );

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

  private resolveSizingBalance(symbol: string, availableBalance: number): number {
    const base = Math.max(0, this.capitalSettings.initialTradingBalance);
    const realized = Math.max(0, this.realizedPnlBySymbol.get(symbol) || 0);
    const target = base + realized;
    return Math.max(0, Math.min(availableBalance, target));
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
    defaultMarginType: (String(process.env.DEFAULT_MARGIN_TYPE || 'ISOLATED').toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED'),
    defaultLeverage: Number(process.env.DEFAULT_SYMBOL_LEVERAGE || 20),
    dualSidePosition: String(process.env.POSITION_MODE || 'ONE-WAY').toUpperCase() === 'HEDGE',
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
    initialTradingBalance: Number(process.env.INITIAL_TRADING_BALANCE || 100),
    maxLeverage: Number(process.env.MAX_LEVERAGE || 100),
    hardStopLossPct: Number(process.env.HARD_STOP_LOSS_PCT || 1.0),
    liquidationEmergencyMarginRatio: Number(process.env.LIQUIDATION_EMERGENCY_MARGIN_RATIO || 0.30),
    takerFeeBps: Number(process.env.TAKER_FEE_BPS || 4),
    profitLockBufferBps: Number(process.env.PROFIT_LOCK_BUFFER_BPS || 2),
    cooldownMinMs: Number(process.env.COOLDOWN_MIN_MS || 2000),
    cooldownMaxMs: Number(process.env.COOLDOWN_MAX_MS || 30000),
    loggerQueueLimit: Number(process.env.LOGGER_QUEUE_LIMIT || 5000),
    loggerDropHaltThreshold: Number(process.env.LOGGER_DROP_HALT_THRESHOLD || 200),
  });
}
