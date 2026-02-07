export type Side = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT';
export type OrderType = 'MARKET' | 'LIMIT';

export interface TestnetQuote {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  ts: number;
}

export interface AccountUpdateEvent {
  type: 'ACCOUNT_UPDATE';
  symbol: string;
  event_time_ms: number;
  availableBalance: number;
  walletBalance: number;
  positionAmt: number;
  entryPrice: number;
  unrealizedPnL: number;
}

export interface OrderUpdateEvent {
  type: 'ORDER_UPDATE';
  symbol: string;
  event_time_ms: number;
  orderId: string;
  clientOrderId: string;
  side: Side;
  orderType: OrderType;
  status: string;
  origQty: number;
  executedQty: number;
  price: number;
  reduceOnly: boolean;
}

export interface TradeUpdateEvent {
  type: 'TRADE_UPDATE';
  symbol: string;
  event_time_ms: number;
  orderId: string;
  tradeId: string;
  side: Side;
  fillQty: number;
  fillPrice: number;
  commission: number;
  commissionAsset: string;
  realizedPnl: number;
  quoteQty: number;
}

export interface OpenOrdersSnapshotEvent {
  type: 'OPEN_ORDERS_SNAPSHOT';
  symbol: string;
  event_time_ms: number;
  orders: Array<{
    orderId: string;
    clientOrderId: string;
    side: Side;
    orderType: OrderType;
    status: string;
    origQty: number;
    executedQty: number;
    price: number;
    reduceOnly: boolean;
  }>;
}

export interface SystemHaltEvent {
  type: 'SYSTEM_HALT';
  symbol: string;
  event_time_ms: number;
  reason: string;
}

export interface SystemResumeEvent {
  type: 'SYSTEM_RESUME';
  symbol: string;
  event_time_ms: number;
  reason: string;
}

export type ExecutionEvent =
  | AccountUpdateEvent
  | OrderUpdateEvent
  | TradeUpdateEvent
  | OpenOrdersSnapshotEvent
  | SystemHaltEvent
  | SystemResumeEvent;

export interface PlaceOrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  price?: number;
  reduceOnly?: boolean;
  clientOrderId: string;
}

export interface CancelOrderRequest {
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

export interface ExecutionConnectorConfig {
  enabled: boolean;
  apiKey?: string;
  apiSecret?: string;
  restBaseUrl: string;
  userDataWsBaseUrl: string;
  marketWsBaseUrl: string;
  recvWindowMs: number;
}
