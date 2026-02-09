import { createHmac, randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import {
  CancelOrderRequest,
  ExecutionConnectorConfig,
  ExecutionEvent,
  MarginType,
  OpenOrdersSnapshotEvent,
  OrderUpdateEvent,
  PlaceOrderRequest,
  TestnetQuote,
  TradeUpdateEvent,
} from './executionTypes';

type ExecutionListener = (event: ExecutionEvent) => void;
type StatusListener = (status: ExecutionConnectorStatus) => void;
type DebugListener = (event: ExecutionDebugEvent) => void;

type UserDataMessage = {
  e?: string;
  E?: number;
  o?: any;
  a?: any;
};

interface SymbolRules {
  minQty: number;
  maxQty: number;
  stepSize: number;
  priceTickSize: number;
  minNotional: number;
}

interface SignedRequestOptions {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | number | boolean | undefined | null>;
  requiresAuth: boolean;
  orderAttemptId?: string;
}

export type ExecutionConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

export interface ExecutionConnectorStatus {
  state: ExecutionConnectionState;
  executionEnabled: boolean;
  hasCredentials: boolean;
  symbols: string[];
  lastError: string | null;
  ready: boolean;
  readyReason: string | null;
  serverTimeOffsetMs: number;
  dualSidePosition: boolean | null;
  effectiveLeverageBySymbol: Record<string, number>;
  updatedAtMs: number;
}

export interface ExecutionDebugEvent {
  channel: 'execution';
  type:
  | 'order_attempt'
  | 'order_result'
  | 'order_error'
  | 'request_debug'
  | 'request_error'
  | 'why_not_sent'
  | 'readiness'
  | 'margin_type';
  order_attempt_id?: string;
  decision_id?: string;
  symbol?: string;
  ts: number;
  payload: any;
}

export class ExecutionConnector {
  private readonly config: ExecutionConnectorConfig;
  private readonly listeners = new Set<ExecutionListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly debugListeners = new Set<DebugListener>();
  private readonly symbols = new Set<string>();
  private readonly quotes = new Map<string, TestnetQuote>();
  private readonly effectiveLeverageBySymbol = new Map<string, number>();
  private readonly readyBySymbol = new Map<string, { ready: boolean; reason: string | null }>();
  private readonly symbolRules = new Map<string, SymbolRules>();

  private userWs: WebSocket | null = null;
  private marketWs: WebSocket | null = null;
  private listenKey: string | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private serverTimeSyncTimer: NodeJS.Timeout | null = null;
  private reconnectingUserStream = false;

  private apiKey: string | undefined;
  private apiSecret: string | undefined;
  private executionEnabled: boolean;
  private state: ExecutionConnectionState = 'DISCONNECTED';
  private lastError: string | null = null;

  private serverTimeOffsetMs = 0;
  private dualSidePosition: boolean | null = null;
  private exchangeInfoLoaded = false;

  constructor(config: ExecutionConnectorConfig) {
    this.config = config;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.executionEnabled = config.enabled;
  }

  onExecutionEvent(listener: ExecutionListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  onDebug(listener: DebugListener) {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  getStatus(): ExecutionConnectorStatus {
    const readiness = this.aggregateReadiness();
    return {
      state: this.state,
      executionEnabled: this.executionEnabled,
      hasCredentials: Boolean(this.apiKey && this.apiSecret),
      symbols: Array.from(this.symbols),
      lastError: this.lastError,
      ready: readiness.ready,
      readyReason: readiness.reason,
      serverTimeOffsetMs: this.serverTimeOffsetMs,
      dualSidePosition: this.dualSidePosition,
      effectiveLeverageBySymbol: Object.fromEntries(this.effectiveLeverageBySymbol.entries()),
      updatedAtMs: Date.now(),
    };
  }

  isExecutionEnabled(): boolean {
    return this.executionEnabled;
  }

  setExecutionEnabled(enabled: boolean) {
    this.executionEnabled = Boolean(enabled);
    this.emitStatus();
  }

  setDefaultLeverage(leverage: number) {
    if (Number.isFinite(leverage) && leverage > 0) {
      this.config.defaultLeverage = Math.max(1, Math.trunc(leverage));
    }
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED';
  }

  setCredentials(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.lastError = null;
    this.emitStatus();
  }

  ensureSymbol(symbol: string) {
    const normalized = symbol.toUpperCase();
    if (!this.symbols.has(normalized)) {
      this.symbols.add(normalized);
      this.reconnectMarketData();
      this.emitStatus();
    }
  }

  setSymbols(symbols: string[]) {
    this.symbols.clear();
    this.readyBySymbol.clear();
    this.effectiveLeverageBySymbol.clear();
    for (const symbol of symbols) {
      this.symbols.add(symbol.toUpperCase());
    }
    this.reconnectMarketData();
    this.emitStatus();
  }

  getQuote(symbol: string): TestnetQuote | null {
    return this.quotes.get(symbol.toUpperCase()) || null;
  }

  async start() {
    if (this.apiKey && this.apiSecret) {
      await this.connect();
    } else {
      this.emitStatus();
    }
  }

  async connect(): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Missing testnet API credentials');
    }

    if (this.state === 'CONNECTED' || this.state === 'CONNECTING') {
      return;
    }

    this.state = 'CONNECTING';
    this.lastError = null;
    this.emitStatus();

    try {
      await this.syncServerTimeOffset();
      await this.loadExchangeInfo();
      await this.syncPositionMode();
      await this.startUserStream();
      this.reconnectMarketData();
      await this.syncState();
      await this.ensureReadyForSymbols();

      this.serverTimeSyncTimer = setInterval(() => {
        this.syncServerTimeOffset().catch(() => {
          // status remains last known; request errors are logged
        });
      }, 30_000);

      this.state = 'CONNECTED';
      this.lastError = null;
      this.emitStatus();
    } catch (error: any) {
      this.state = 'ERROR';
      this.lastError = error?.message || 'connect_failed';
      this.emitStatus();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.stop();
  }

  async stop() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.serverTimeSyncTimer) {
      clearInterval(this.serverTimeSyncTimer);
      this.serverTimeSyncTimer = null;
    }
    if (this.userWs) {
      this.userWs.close();
      this.userWs = null;
    }
    if (this.marketWs) {
      this.marketWs.close();
      this.marketWs = null;
    }
    if (this.listenKey) {
      try {
        await this.deleteListenKey(this.listenKey);
      } catch {
        // best effort cleanup
      }
      this.listenKey = null;
    }

    this.state = 'DISCONNECTED';
    this.lastError = null;
    this.emitStatus();
  }

  expectedPrice(symbol: string, side: 'BUY' | 'SELL', orderType: 'MARKET' | 'LIMIT', limitPrice?: number): number | null {
    if (orderType === 'LIMIT') {
      return typeof limitPrice === 'number' ? limitPrice : null;
    }
    const quote = this.getQuote(symbol);
    if (!quote) {
      return null;
    }
    return side === 'BUY' ? quote.bestAsk : quote.bestBid;
  }

  async placeOrder(
    request: PlaceOrderRequest,
    context?: { decisionId?: string; orderAttemptId?: string }
  ): Promise<{ orderId: string }> {
    const orderAttemptId = context?.orderAttemptId || randomUUID();

    if (!this.executionEnabled) {
      this.emitDebug({
        channel: 'execution',
        type: 'why_not_sent',
        order_attempt_id: orderAttemptId,
        decision_id: context?.decisionId,
        symbol: request.symbol,
        ts: Date.now(),
        payload: { why_not_sent: 'disabled' },
      });
      return { orderId: `dry-${request.clientOrderId}` };
    }

    if (!this.apiKey || !this.apiSecret) {
      this.emitDebug({
        channel: 'execution',
        type: 'why_not_sent',
        order_attempt_id: orderAttemptId,
        decision_id: context?.decisionId,
        symbol: request.symbol,
        ts: Date.now(),
        payload: { why_not_sent: 'missing_keys' },
      });
      throw new Error('Execution keys are missing');
    }

    if (!this.isConnected()) {
      this.emitDebug({
        channel: 'execution',
        type: 'why_not_sent',
        order_attempt_id: orderAttemptId,
        decision_id: context?.decisionId,
        symbol: request.symbol,
        ts: Date.now(),
        payload: { why_not_sent: 'not_connected', state: this.state },
      });
      throw new Error('Execution connector is not connected');
    }

    const symbol = request.symbol.toUpperCase();
    const readiness = this.readyBySymbol.get(symbol);
    if (!readiness || !readiness.ready) {
      this.emitDebug({
        channel: 'execution',
        type: 'why_not_sent',
        order_attempt_id: orderAttemptId,
        decision_id: context?.decisionId,
        symbol,
        ts: Date.now(),
        payload: { why_not_sent: 'execution_not_ready', reason: readiness?.reason || 'missing_symbol_readiness' },
      });
      throw new Error(readiness?.reason || 'Execution not ready for symbol');
    }

    const qty = await this.normalizeQuantity(symbol, request.side, request.quantity);
    const positionSide = this.resolvePositionSide(request, {
      symbol,
      orderAttemptId,
      decisionId: context?.decisionId,
    });

    const params: Record<string, string | number | boolean | undefined> = {
      symbol,
      side: request.side,
      type: 'MARKET',
      quantity: qty,
      newClientOrderId: request.clientOrderId,
      reduceOnly: request.reduceOnly ? true : undefined,
      positionSide,
      recvWindow: Math.trunc(this.config.recvWindowMs || 5000),
    };

    this.emitDebug({
      channel: 'execution',
      type: 'order_attempt',
      order_attempt_id: orderAttemptId,
      decision_id: context?.decisionId,
      symbol,
      ts: Date.now(),
      payload: {
        method: 'POST',
        baseUrl: this.config.restBaseUrl,
        path: '/fapi/v1/order',
        params,
      },
    });

    try {
      const response = await this.signedRequest({
        path: '/fapi/v1/order',
        method: 'POST',
        params,
        requiresAuth: true,
        orderAttemptId,
      });

      this.emitDebug({
        channel: 'execution',
        type: 'order_result',
        order_attempt_id: orderAttemptId,
        decision_id: context?.decisionId,
        symbol,
        ts: Date.now(),
        payload: {
          orderId: response.orderId,
          status: response.status,
          response: this.truncate(response),
        },
      });

      return { orderId: String(response.orderId || request.clientOrderId || randomUUID()) };
    } catch (error: any) {
      this.emitDebug({
        channel: 'execution',
        type: 'order_error',
        order_attempt_id: orderAttemptId,
        decision_id: context?.decisionId,
        symbol,
        ts: Date.now(),
        payload: {
          error_class: this.classifyBinanceError(error),
          message: error?.message || 'order_failed',
          code: error?.binanceCode || null,
          response: this.truncate(error?.binanceBody || error?.message),
        },
      });
      throw error;
    }
  }

  async cancelOrder(request: CancelOrderRequest): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      return;
    }

    const params: Record<string, string | number> = {
      symbol: request.symbol,
      recvWindow: Math.trunc(this.config.recvWindowMs || 5000),
    };

    if (request.orderId) {
      params.orderId = request.orderId;
    }
    if (request.clientOrderId) {
      params.origClientOrderId = request.clientOrderId;
    }

    await this.signedRequest({ path: '/fapi/v1/order', method: 'DELETE', params, requiresAuth: true });
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      return;
    }

    await this.signedRequest({
      path: '/fapi/v1/allOpenOrders',
      method: 'DELETE',
      params: {
        symbol,
        recvWindow: Math.trunc(this.config.recvWindowMs || 5000),
      },
      requiresAuth: true,
    });
  }

  async syncState(): Promise<void> {
    if (!this.apiKey || !this.apiSecret || this.symbols.size === 0) {
      return;
    }

    const now = Date.now();

    const [balances, positions] = await Promise.all([
      this.signedRequest({ path: '/fapi/v2/balance', method: 'GET', requiresAuth: true }),
      this.signedRequest({ path: '/fapi/v2/positionRisk', method: 'GET', requiresAuth: true }),
    ]);

    const usdtBalance = Array.isArray(balances)
      ? balances.find((b: any) => b.asset === 'USDT')
      : null;

    const availableBalance = Number(usdtBalance?.availableBalance || 0);
    const walletBalance = Number(usdtBalance?.balance || 0);

    const bySymbol = new Map<string, any>();
    if (Array.isArray(positions)) {
      for (const p of positions) {
        bySymbol.set(String(p.symbol), p);
      }
    }

    for (const symbol of this.symbols) {
      const p = bySymbol.get(symbol);
      this.emitEvent({
        type: 'ACCOUNT_UPDATE',
        symbol,
        event_time_ms: now,
        availableBalance,
        walletBalance,
        positionAmt: Number(p?.positionAmt || 0),
        entryPrice: Number(p?.entryPrice || 0),
        unrealizedPnL: Number(p?.unRealizedProfit || 0),
      });

      const openOrders = await this.signedRequest({
        path: '/fapi/v1/openOrders',
        method: 'GET',
        params: { symbol },
        requiresAuth: true,
      });

      if (Array.isArray(openOrders)) {
        const snapshot: OpenOrdersSnapshotEvent = {
          type: 'OPEN_ORDERS_SNAPSHOT',
          symbol,
          event_time_ms: now,
          orders: openOrders.map((order: any) => ({
            orderId: String(order.orderId),
            clientOrderId: String(order.clientOrderId),
            side: order.side,
            orderType: order.type,
            status: order.status,
            origQty: Number(order.origQty || 0),
            executedQty: Number(order.executedQty || 0),
            price: Number(order.price || 0),
            reduceOnly: Boolean(order.reduceOnly),
          })),
        };
        this.emitEvent(snapshot);
      }
    }
  }

  async fetchTestnetFuturesPairs(): Promise<string[]> {
    const response = await fetch(`${this.config.restBaseUrl}/fapi/v1/exchangeInfo`);
    if (!response.ok) {
      throw new Error(`testnet exchangeInfo failed: ${response.status}`);
    }
    const body: any = await response.json();
    const symbols = Array.isArray(body.symbols) ? body.symbols : [];
    return symbols
      .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map((s: any) => String(s.symbol))
      .sort();
  }

  async ensureSymbolsReady() {
    await this.ensureReadyForSymbols();
  }

  private async startUserStream() {
    this.listenKey = await this.createListenKey();
    this.connectUserWs(this.listenKey);

    this.keepAliveTimer = setInterval(() => {
      if (!this.listenKey) {
        return;
      }
      this.keepAliveListenKey(this.listenKey).catch(() => {
        // reconnect path handles recovery
      });
    }, 30 * 60 * 1000);
  }

  private connectUserWs(listenKey: string) {
    const url = `${this.config.userDataWsBaseUrl.replace(/\/$/, '')}/ws/${listenKey}`;
    this.userWs = new WebSocket(url);

    this.userWs.on('open', () => {
      this.state = 'CONNECTED';
      this.lastError = null;
      this.emitStatus();
    });

    this.userWs.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as UserDataMessage;
        this.handleUserMessage(message);
      } catch {
        // ignore malformed payload
      }
    });

    this.userWs.on('close', () => {
      this.handleUserStreamDisconnect('user stream closed');
    });

    this.userWs.on('error', () => {
      this.handleUserStreamDisconnect('user stream error');
    });
  }

  private async handleUserStreamDisconnect(reason: string) {
    if (this.reconnectingUserStream) {
      return;
    }
    this.reconnectingUserStream = true;

    this.state = 'ERROR';
    this.lastError = reason;
    this.emitStatus();

    const haltTime = Date.now();
    for (const symbol of this.symbols) {
      this.emitEvent({ type: 'SYSTEM_HALT', symbol, event_time_ms: haltTime, reason });
    }

    try {
      if (!this.apiKey || !this.apiSecret) {
        return;
      }

      if (this.listenKey) {
        try {
          await this.deleteListenKey(this.listenKey);
        } catch {
          // ignore cleanup errors
        }
      }

      this.listenKey = await this.createListenKey();
      this.connectUserWs(this.listenKey);
      await this.syncState();
      await this.ensureReadyForSymbols();

      const resumeTime = Date.now();
      for (const symbol of this.symbols) {
        this.emitEvent({ type: 'SYSTEM_RESUME', symbol, event_time_ms: resumeTime, reason: 'reconnected + synced' });
      }
    } finally {
      this.reconnectingUserStream = false;
    }
  }

  private handleUserMessage(message: UserDataMessage) {
    if (!message.e) {
      return;
    }

    if (message.e === 'ACCOUNT_UPDATE' && message.a) {
      const balance = Array.isArray(message.a.B)
        ? message.a.B.find((x: any) => x.a === 'USDT')
        : null;

      const availableBalance = Number(balance?.cw || 0);
      const walletBalance = Number(balance?.wb || 0);
      const eventTime = Number(message.E || 0);

      const positions = Array.isArray(message.a.P) ? message.a.P : [];
      for (const p of positions) {
        const symbol = String(p.s || '').toUpperCase();
        if (!symbol || !this.symbols.has(symbol)) {
          continue;
        }
        this.emitEvent({
          type: 'ACCOUNT_UPDATE',
          symbol,
          event_time_ms: eventTime,
          availableBalance,
          walletBalance,
          positionAmt: Number(p.pa || 0),
          entryPrice: Number(p.ep || 0),
          unrealizedPnL: Number(p.up || 0),
        });
      }
      return;
    }

    if (message.e === 'ORDER_TRADE_UPDATE' && message.o) {
      const o = message.o;
      const symbol = String(o.s || '').toUpperCase();
      if (!this.symbols.has(symbol)) {
        return;
      }

      const eventTime = Number(message.E || o.T || 0);
      const orderEvent: OrderUpdateEvent = {
        type: 'ORDER_UPDATE',
        symbol,
        event_time_ms: eventTime,
        orderId: String(o.i),
        clientOrderId: String(o.c || ''),
        side: o.S,
        orderType: o.o,
        status: o.X,
        origQty: Number(o.q || 0),
        executedQty: Number(o.z || 0),
        price: Number(o.p || 0),
        reduceOnly: Boolean(o.R),
      };
      this.emitEvent(orderEvent);

      if (o.x === 'TRADE') {
        const tradeEvent: TradeUpdateEvent = {
          type: 'TRADE_UPDATE',
          symbol,
          event_time_ms: eventTime,
          orderId: String(o.i),
          tradeId: String(o.t || ''),
          side: o.S,
          fillQty: Number(o.l || 0),
          fillPrice: Number(o.L || 0),
          commission: Number(o.n || 0),
          commissionAsset: String(o.N || ''),
          realizedPnl: Number(o.rp || 0),
          quoteQty: Number(o.Y || 0),
        };
        this.emitEvent(tradeEvent);
      }
    }
  }

  private reconnectMarketData() {
    if (this.symbols.size === 0 || !this.apiKey || !this.apiSecret) {
      if (this.marketWs) {
        this.marketWs.close();
        this.marketWs = null;
      }
      return;
    }

    if (this.marketWs) {
      this.marketWs.close();
      this.marketWs = null;
    }

    const streams = Array.from(this.symbols)
      .map((s) => `${s.toLowerCase()}@bookTicker`)
      .join('/');

    const base = this.config.marketWsBaseUrl.replace(/\/$/, '');
    const url = streams.includes('/') || streams.length > 0
      ? `${base}/stream?streams=${streams}`
      : `${base}/ws`;

    this.marketWs = new WebSocket(url);

    this.marketWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const data = msg.data || msg;
        const symbol = String(data.s || '').toUpperCase();
        if (!symbol) {
          return;
        }
        const quote: TestnetQuote = {
          symbol,
          bestBid: Number(data.b || 0),
          bestAsk: Number(data.a || 0),
          ts: Number(data.E || Date.now()),
        };
        if (quote.bestBid > 0 && quote.bestAsk > 0) {
          this.quotes.set(symbol, quote);
        }
      } catch {
        // ignore malformed payload
      }
    });

    this.marketWs.on('error', async () => {
      await this.refreshQuotesByRest();
    });
  }

  async refreshQuotesByRest() {
    if (!this.apiKey || !this.apiSecret) {
      return;
    }
    for (const symbol of this.symbols) {
      const response = await fetch(`${this.config.restBaseUrl}/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
      if (!response.ok) {
        continue;
      }
      const body: any = await response.json();
      const bestBid = Number(body.bidPrice || 0);
      const bestAsk = Number(body.askPrice || 0);
      if (bestBid > 0 && bestAsk > 0) {
        this.quotes.set(symbol, {
          symbol,
          bestBid,
          bestAsk,
          ts: Date.now(),
        });
      }
    }
  }

  private async createListenKey(): Promise<string> {
    const response = await this.signedRequest({
      path: '/fapi/v1/listenKey',
      method: 'POST',
      requiresAuth: false,
      params: {},
    });
    if (!response.listenKey) {
      throw new Error('listenKey missing in response');
    }
    return String(response.listenKey);
  }

  private async keepAliveListenKey(listenKey: string): Promise<void> {
    await this.signedRequest({
      path: '/fapi/v1/listenKey',
      method: 'PUT',
      requiresAuth: false,
      params: { listenKey },
    });
  }

  private async deleteListenKey(listenKey: string): Promise<void> {
    await this.signedRequest({
      path: '/fapi/v1/listenKey',
      method: 'DELETE',
      requiresAuth: false,
      params: { listenKey },
    });
  }

  private emitEvent(event: ExecutionEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitStatus() {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private emitDebug(event: ExecutionDebugEvent) {
    for (const listener of this.debugListeners) {
      listener(event);
    }
  }

  private aggregateReadiness(): { ready: boolean; reason: string | null } {
    if (this.symbols.size === 0) {
      return { ready: false, reason: 'symbol_not_selected' };
    }
    for (const symbol of this.symbols) {
      const r = this.readyBySymbol.get(symbol);
      if (!r?.ready) {
        return { ready: false, reason: r?.reason || `symbol_not_ready:${symbol}` };
      }
    }
    return { ready: true, reason: null };
  }

  private async ensureReadyForSymbols() {
    for (const symbol of this.symbols) {
      try {
        await this.ensureSymbolExecutionReady(symbol);
        this.readyBySymbol.set(symbol, { ready: true, reason: null });
        this.emitDebug({
          channel: 'execution',
          type: 'readiness',
          symbol,
          ts: Date.now(),
          payload: { ready: true },
        });
      } catch (e: any) {
        const reason = e?.message || 'execution_not_ready';
        this.readyBySymbol.set(symbol, { ready: false, reason });
        this.emitDebug({
          channel: 'execution',
          type: 'readiness',
          symbol,
          ts: Date.now(),
          payload: { ready: false, reason },
        });
      }
    }
    this.emitStatus();
  }

  private async ensureSymbolExecutionReady(symbol: string) {
    await this.loadExchangeInfo();
    await this.syncPositionMode();

    const rules = this.symbolRules.get(symbol);
    if (!rules) {
      throw new Error(`symbol_not_in_testnet_exchange_info:${symbol}`);
    }

    const leverage = Math.max(1, Math.trunc(this.config.defaultLeverage || 20));
    const leverageResponse = await this.signedRequest({
      path: '/fapi/v1/leverage',
      method: 'POST',
      requiresAuth: true,
      params: { symbol, leverage },
    });
    const effectiveLeverage = Number(leverageResponse?.leverage);
    if (Number.isFinite(effectiveLeverage) && effectiveLeverage > 0) {
      this.effectiveLeverageBySymbol.set(symbol, effectiveLeverage);
    } else {
      this.effectiveLeverageBySymbol.delete(symbol);
    }

    const marginType: MarginType = this.config.defaultMarginType || 'ISOLATED';
    try {
      await this.signedRequest({
        path: '/fapi/v1/marginType',
        method: 'POST',
        requiresAuth: true,
        params: { symbol, marginType },
      });
    } catch (error: any) {
      const code = Number(error?.binanceCode);
      if (code !== -4046) {
        throw error;
      }
      this.emitDebug({
        channel: 'execution',
        type: 'margin_type',
        symbol,
        ts: Date.now(),
        payload: {
          message: 'margin_type_already_set',
          marginType,
          binanceCode: code,
        },
      });
    }
  }

  private async loadExchangeInfo() {
    if (this.exchangeInfoLoaded) {
      return;
    }

    const response = await fetch(`${this.config.restBaseUrl}/fapi/v1/exchangeInfo`);
    if (!response.ok) {
      throw new Error(`exchange_info_failed:${response.status}`);
    }

    const body: any = await response.json();
    const symbols = Array.isArray(body.symbols) ? body.symbols : [];
    for (const symbolInfo of symbols) {
      const symbol = String(symbolInfo.symbol || '');
      if (!symbol) {
        continue;
      }
      const lot = Array.isArray(symbolInfo.filters)
        ? symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE' || f.filterType === 'MARKET_LOT_SIZE')
        : null;
      const priceFilter = Array.isArray(symbolInfo.filters)
        ? symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER')
        : null;

      this.symbolRules.set(symbol, {
        minQty: Number(lot?.minQty || 0),
        maxQty: Number(lot?.maxQty || Number.POSITIVE_INFINITY),
        stepSize: Number(lot?.stepSize || 0.001),
        priceTickSize: Number(priceFilter?.tickSize || 0.01),
        minNotional: Number(
          (Array.isArray(symbolInfo.filters)
            ? symbolInfo.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL')?.notional
            : null) || 0
        ),
      });
    }

    this.exchangeInfoLoaded = true;
  }

  private async syncPositionMode() {
    // 1. Get current mode
    const response = await this.signedRequest({
      path: '/fapi/v1/positionSide/dual',
      method: 'GET',
      requiresAuth: true,
    });
    const current = String(response?.dualSidePosition) === 'true';

    // 2. Decide target (prefer config, default to false/One-Way for this bot)
    const target = this.config.dualSidePosition !== undefined ? this.config.dualSidePosition : false;

    if (current !== target) {
      console.log(`[CONNECTOR] Mismatch in Position Mode: Account is ${current ? 'Hedge' : 'One-Way'}, Bot wants ${target ? 'Hedge' : 'One-Way'}. Attempting to switch...`);
      try {
        await this.signedRequest({
          path: '/fapi/v1/positionSide/dual',
          method: 'POST',
          params: { dualSidePosition: String(target) },
          requiresAuth: true,
        });
        this.dualSidePosition = target;
        console.log(`[CONNECTOR] Successfully switched to ${target ? 'Hedge' : 'One-Way'} mode.`);
      } catch (e: any) {
        console.warn(`[CONNECTOR] Failed to switch position mode: ${e.message}. Bot will proceed with current account mode: ${current ? 'Hedge' : 'One-Way'}`);
        this.dualSidePosition = current;
      }
    } else {
      this.dualSidePosition = current;
    }

    this.emitStatus();
  }

  private resolvePositionSide(
    request: PlaceOrderRequest,
    context: { symbol: string; orderAttemptId: string; decisionId?: string }
  ): 'LONG' | 'SHORT' | undefined {
    if (!this.dualSidePosition) {
      if (request.positionSide === 'LONG' || request.positionSide === 'SHORT') {
        this.emitDebug({
          channel: 'execution',
          type: 'why_not_sent',
          order_attempt_id: context.orderAttemptId,
          decision_id: context.decisionId,
          symbol: context.symbol,
          ts: Date.now(),
          payload: {
            reason: 'one_way_mode_forces_both',
            requested: request.positionSide,
          },
        });
      }
      return undefined;
    }

    if (request.positionSide === 'LONG' || request.positionSide === 'SHORT') {
      return request.positionSide;
    }

    return request.side === 'BUY' ? 'LONG' : 'SHORT';
  }

  private async normalizeQuantity(symbol: string, side: 'BUY' | 'SELL', rawQty: number): Promise<string> {
    const rules = this.symbolRules.get(symbol);
    if (!rules) {
      throw new Error(`missing_symbol_rules:${symbol}`);
    }

    if (!Number.isFinite(rawQty) || rawQty <= 0) {
      throw new Error(`invalid_quantity:${rawQty}`);
    }

    const step = rules.stepSize > 0 ? rules.stepSize : 0.001;
    const stepDigits = this.stepDigits(step);

    let qty = Math.floor(rawQty / step) * step;
    if (qty < rules.minQty) {
      qty = rules.minQty;
    }
    if (Number.isFinite(rules.maxQty) && qty > rules.maxQty) {
      qty = rules.maxQty;
    }

    if (rules.minNotional > 0) {
      const marketPrice = await this.referencePrice(symbol, side);
      if (marketPrice > 0) {
        const currentNotional = qty * marketPrice;
        if (currentNotional < rules.minNotional) {
          const minQtyFromNotional = rules.minNotional / marketPrice;
          qty = Math.ceil(minQtyFromNotional / step) * step;
        }
      }
    }

    if (Number.isFinite(rules.maxQty) && qty > rules.maxQty) {
      qty = rules.maxQty;
    }

    if (qty <= 0) {
      throw new Error(`normalized_quantity_non_positive:${qty}`);
    }

    return qty.toFixed(stepDigits);
  }

  private async referencePrice(symbol: string, side: 'BUY' | 'SELL'): Promise<number> {
    const quote = this.getQuote(symbol);
    if (quote) {
      return side === 'BUY' ? quote.bestAsk : quote.bestBid;
    }

    const response = await fetch(`${this.config.restBaseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
    if (!response.ok) {
      return 0;
    }
    const body: any = await response.json();
    return Number(body.price || 0);
  }

  private stepDigits(step: number): number {
    const stepString = step.toString();
    if (!stepString.includes('.')) {
      return 0;
    }
    return stepString.split('.')[1].replace(/0+$/, '').length;
  }

  private async syncServerTimeOffset() {
    const t0 = Date.now();
    const response = await fetch(`${this.config.restBaseUrl}/fapi/v1/time`);
    if (!response.ok) {
      throw new Error(`server_time_sync_failed:${response.status}`);
    }
    const body: any = await response.json();
    const t1 = Date.now();
    const serverTime = Number(body?.serverTime || 0);
    const rttHalf = Math.floor((t1 - t0) / 2);
    this.serverTimeOffsetMs = serverTime - (t0 + rttHalf);
    this.emitStatus();
  }

  private sanitizeParams(params?: Record<string, string | number | boolean | undefined | null>): Record<string, string> {
    const out: Record<string, string> = {};
    if (!params) {
      return out;
    }

    const keys = Object.keys(params).sort();
    for (const key of keys) {
      const value = params[key];
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === 'number') {
        out[key] = Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
        continue;
      }
      if (typeof value === 'boolean') {
        out[key] = value ? 'true' : 'false';
        continue;
      }
      out[key] = String(value);
    }
    return out;
  }

  private async signedRequest(options: SignedRequestOptions): Promise<any> {
    const apiKey = this.apiKey;
    const secret = this.apiSecret;
    if (!apiKey || !secret) {
      throw new Error('Execution connector is missing API keys');
    }

    const params = this.sanitizeParams(options.params);

    if (options.requiresAuth) {
      params.recvWindow = String(Math.trunc(this.config.recvWindowMs || 5000));
      params.timestamp = String(Date.now() + this.serverTimeOffsetMs);
    }

    const sortedParams = new URLSearchParams();
    for (const key of Object.keys(params).sort()) {
      sortedParams.set(key, params[key]);
    }
    const queryNoSignature = sortedParams.toString();
    const signature = createHmac('sha256', secret).update(queryNoSignature).digest('hex');
    const signedQuery = options.requiresAuth
      ? `${queryNoSignature}${queryNoSignature ? '&' : ''}signature=${signature}`
      : queryNoSignature;

    const url = `${this.config.restBaseUrl}${options.path}${signedQuery ? `?${signedQuery}` : ''}`;

    this.emitDebug({
      channel: 'execution',
      type: 'request_debug',
      order_attempt_id: options.orderAttemptId,
      ts: Date.now(),
      payload: {
        method: options.method,
        baseUrl: this.config.restBaseUrl,
        path: options.path,
        params,
        query_string: queryNoSignature,
        signature_len: signature.length,
        recvWindow: params.recvWindow ? Number(params.recvWindow) : null,
        timestamp: params.timestamp ? Number(params.timestamp) : null,
      },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep raw
    }

    if (!response.ok) {
      const binanceCode = typeof body?.code === 'number' ? body.code : null;
      const err: any = new Error(`Binance ${options.method} ${options.path} failed (${response.status})`);
      err.binanceCode = binanceCode;
      err.binanceBody = body;
      err.httpStatus = response.status;

      this.emitDebug({
        channel: 'execution',
        type: 'request_error',
        order_attempt_id: options.orderAttemptId,
        ts: Date.now(),
        payload: {
          method: options.method,
          path: options.path,
          status: response.status,
          error_class: this.classifyBinanceError(err),
          code: binanceCode,
          message: err.message,
          response: this.truncate(body),
        },
      });

      throw err;
    }

    return body;
  }

  private classifyBinanceError(error: any): string {
    const code = Number(error?.binanceCode);
    if (code === -1021) return 'timestamp_out_of_window';
    if (code === -1022) return 'invalid_signature';
    if (code === -2015) return 'invalid_key_or_permissions';
    if (code === -1102) return 'missing_mandatory_param';
    if (code === -4164) return 'min_notional_too_small';
    return 'unknown_binance_error';
  }

  private truncate(value: any): any {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (!str) {
      return value;
    }
    if (str.length <= 1000) {
      return value;
    }
    return str.slice(0, 1000);
  }
}
