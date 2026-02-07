import { ExecutionEvent } from '../connectors/executionTypes';

export interface OrchestratorMetricsInput {
  symbol: string;
  event_time_ms: number;
  latency_ms?: number | null;
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

export interface GateResult {
  passed: boolean;
  reason: string | null;
  latency_ms: number;
  checks: {
    hasRequiredMetrics: boolean;
    latencyOk: boolean;
    spreadOk: boolean;
    obiDeepOk: boolean;
  };
}

export interface MetricsEventEnvelope {
  kind: 'metrics';
  symbol: string;
  event_time_ms: number;
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
}

export interface ExecutionQualityState {
  poor: boolean;
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
  event_time_ms: number;
  gate: GateResult;
  actions: DecisionAction[];
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
  maxLatencyMs: number;
  maxSpreadPct: number;
  minObiDeep: number;
  riskPerTradePercent: number;
  maxLeverage: number;
  cooldownMinMs: number;
  cooldownMaxMs: number;
  loggerQueueLimit: number;
  loggerDropHaltThreshold: number;
}
