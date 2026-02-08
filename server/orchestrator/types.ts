import { ExecutionEvent } from '../connectors/executionTypes';

export interface OrchestratorMetricsInput {
  symbol: string;
  canonical_time_ms?: number;
  exchange_event_time_ms?: number | null;
  spread_pct?: number | null;
  prints_per_second?: number | null;
  best_bid?: number | null;
  best_ask?: number | null;
  legacyMetrics?: {
    obiDeep?: number | null;
    deltaZ?: number | null;
    cvdSlope?: number | null;
  } | null;
}

export enum GateMode {
  V1_NO_LATENCY = 'V1_NO_LATENCY',
  V2_NETWORK_LATENCY = 'V2_NETWORK_LATENCY',
}

export interface GateConfig {
  mode: GateMode;
  maxSpreadPct: number;
  minObiDeep: number;
  v2?: {
    maxNetworkLatencyMs: number;
  };
}

export interface GateResult {
  mode: GateMode;
  passed: boolean;
  reason: string | null;
  network_latency_ms: number | null;
  checks: {
    hasRequiredMetrics: boolean;
    spreadOk: boolean;
    obiDeepOk: boolean;
    networkLatencyOk: boolean | null;
  };
}

export interface MetricsEventEnvelope {
  kind: 'metrics';
  symbol: string;
  canonical_time_ms: number;
  exchange_event_time_ms: number | null;
  metrics: OrchestratorMetricsInput;
  gate: GateResult;
}

export interface ExecutionEventEnvelope {
  kind: 'execution';
  symbol: string;
  event_time_ms: number;
  execution: ExecutionEvent;
}

export type ActorEnvelope = MetricsEventEnvelope | ExecutionEventEnvelope;

export interface OpenOrderState {
  orderId: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  status: string;
  origQty: number;
  executedQty: number;
  reduceOnly: boolean;
  event_time_ms: number;
}

export interface PositionState {
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  unrealizedPnlPct: number;
  addsUsed: number;
  peakPnlPct: number;
  profitLockActivated: boolean;
  hardStopPrice: number | null;
}

export type ExecQualityLevel = 'GOOD' | 'BAD' | 'UNKNOWN';

export interface ExecutionQualityState {
  quality: ExecQualityLevel;
  metricsPresent: boolean;
  freezeActive: boolean;
  lastLatencyMs: number | null;
  lastSlippageBps: number | null;
  lastSpreadPct: number | null;
  recentLatencyMs: number[];
  recentSlippageBps: number[];
}

export interface SymbolState {
  symbol: string;
  halted: boolean;
  availableBalance: number;
  walletBalance: number;
  position: PositionState | null;
  openOrders: Map<string, OpenOrderState>;
  hasOpenEntryOrder: boolean;
  cooldown_until_ms: number;
  last_exit_event_time_ms: number;
  marginRatio: number | null;
  execQuality: ExecutionQualityState;
}

export type DecisionActionType =
  | 'ENTRY_PROBE'
  | 'ADD_POSITION'
  | 'EXIT_MARKET'
  | 'CANCEL_OPEN_ENTRY_ORDERS'
  | 'NOOP';

export interface DecisionAction {
  type: DecisionActionType;
  symbol: string;
  event_time_ms: number;
  side?: 'BUY' | 'SELL';
  quantity?: number;
  price?: number;
  reduceOnly?: boolean;
  reason: string;
  expectedPrice?: number | null;
}

export interface DecisionRecord {
  symbol: string;
  canonical_time_ms: number;
  exchange_event_time_ms: number | null;
  gate: GateResult;
  actions: DecisionAction[];
  execution_mode: 'NORMAL' | 'DEGRADED' | 'FREEZE';
  exec_quality: ExecQualityLevel;
  exec_metrics_present: boolean;
  freeze_active: boolean;
  emergency_exit_allowed: boolean;
  emergency_exit_allowed_reason: string | null;
  invariant_violated: boolean;
  invariant_reason: string | null;
  data_gaps: string[];
  initial_trading_balance: number;
  effective_leverage: number;
  unrealized_pnl_peak: number | null;
  profit_lock_activated: boolean;
  hard_stop_price: number | null;
  exit_reason: 'profit_lock' | 'hard_stop' | 'liquidation' | null;
  stateSnapshot: {
    halted: boolean;
    availableBalance: number;
    cooldown_until_ms: number;
    hasOpenEntryOrder: boolean;
    openOrders: number;
    position: PositionState | null;
  };
}

export interface OrchestratorConfig {
  gate: GateConfig;
  initialTradingBalance: number;
  maxLeverage: number;
  hardStopLossPct: number;
  liquidationEmergencyMarginRatio: number;
  takerFeeBps: number;
  profitLockBufferBps: number;
  cooldownMinMs: number;
  cooldownMaxMs: number;
  loggerQueueLimit: number;
  loggerDropHaltThreshold: number;
}
