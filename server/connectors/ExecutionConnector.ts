import { createHmac, randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import {
  CancelOrderRequest,
  ExecutionConnectorConfig,
  ExecutionEvent,
  OpenOrdersSnapshotEvent,
  OrderUpdateEvent,
  PlaceOrderRequest,
  TestnetQuote,
  TradeUpdateEvent,
} from './executionTypes';

type ExecutionListener = (event: ExecutionEvent) => void;
type StatusListener = (status: ExecutionConnectorStatus) => void;

type UserDataMessage = {
  e?: string;
  E?: number;
  o?: any;
  a?: any;
};

export type ExecutionConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

export interface ExecutionConnectorStatus {
  state: ExecutionConnectionState;
  executionEnabled: boolean;
  hasCredentials: boolean;
  symbols: string[];
  lastError: string | null;
  updatedAtMs: number;
}

export class ExecutionConnector {
  private readonly config: ExecutionConnectorConfig;
  private readonly listeners = new Set<ExecutionListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly symbols = new Set<string>();
  private readonly quotes = new Map<string, TestnetQuote>();

  private userWs: WebSocket | null = null;
  private marketWs: WebSocket | null = null;
  private listenKey: string | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectingUserStream = false;
  private lastSequenceEventMs = 0;

  private apiKey: string | undefined;
  private apiSecret: string | undefined;
  private executionEnabled: boolean;
  private state: ExecutionConnectionState = 'DISCONNECTED';
  private lastError: string | null = null;

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

  getStatus(): ExecutionConnectorStatus {
    return {
      state: this.state,
      executionEnabled: this.executionEnabled,
      hasCredentials: Boolean(this.apiKey && this.apiSecret),
      symbols: Array.from(this.symbols),
      lastError: this.lastError,
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

  setCredentials(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.lastError = null;
    this.emitStatus();
  }

  clearCredentials() {
    this.apiKey = undefined;
    this.apiSecret = undefined;
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
    for (const symbol of symbols) {
      this.symbols.add(symbol.toUpperCase());
    }
    this.reconnectMarketData();
    this.emitStatus();
  }

  getQuote(symbol: string): TestnetQuote | null {
    return this.quotes.get(symbol.toUpperCase()) || null;
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
      await this.startUserStream();
      this.reconnectMarketData();
      await this.syncState();
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

  async start() {
    if (this.apiKey && this.apiSecret) {
      await this.connect();
    } else {
      this.emitStatus();
    }
  }

  async stop() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
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

  async disconnect(): Promise<void> {
    await this.stop();
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

  async placeOrder(request: PlaceOrderRequest): Promise<{ orderId: string }> {
    if (!this.executionEnabled) {
      return { orderId: `dry-${request.clientOrderId}` };
    }

    const params: Record<string, string | number | boolean> = {
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      newClientOrderId: request.clientOrderId,
      recvWindow: this.config.recvWindowMs,
      timestamp: Date.now(),
    };

    if (request.type === 'LIMIT') {
      params.price = request.price || 0;
      params.timeInForce = 'GTC';
    }
    if (request.reduceOnly) {
      params.reduceOnly = true;
    }

    const response = await this.signedRequest('/fapi/v1/order', 'POST', params);
    return { orderId: String(response.orderId || request.clientOrderId || randomUUID()) };
  }

  async cancelOrder(request: CancelOrderRequest): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      return;
    }

    const params: Record<string, string | number> = {
      symbol: request.symbol,
      recvWindow: this.config.recvWindowMs,
      timestamp: Date.now(),
    };

    if (request.orderId) {
      params.orderId = request.orderId;
    }
    if (request.clientOrderId) {
      params.origClientOrderId = request.clientOrderId;
    }

    await this.signedRequest('/fapi/v1/order', 'DELETE', params);
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      return;
    }
    await this.signedRequest('/fapi/v1/allOpenOrders', 'DELETE', {
      symbol,
      recvWindow: this.config.recvWindowMs,
      timestamp: Date.now(),
    });
  }

  async syncState(): Promise<void> {
    console.log('[CONNECTOR] syncState called, symbols:', Array.from(this.symbols));
    if (!this.apiKey || !this.apiSecret || this.symbols.size === 0) {
      console.log('[CONNECTOR] syncState skipped - missing creds or no symbols');
      return;
    }

    const now = Date.now();

    const [balances, positions] = await Promise.all([
      this.signedRequest('/fapi/v2/balance', 'GET', {
        recvWindow: this.config.recvWindowMs,
        timestamp: Date.now(),
      }),
      this.signedRequest('/fapi/v2/positionRisk', 'GET', {
        recvWindow: this.config.recvWindowMs,
        timestamp: Date.now(),
      }),
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

      const openOrders = await this.signedRequest('/fapi/v1/openOrders', 'GET', {
        symbol,
        recvWindow: this.config.recvWindowMs,
        timestamp: Date.now(),
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
    const response = await fetch(`${this.config.restBaseUrl}/fapi/v1/listenKey`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey || '',
      },
    });
    if (!response.ok) {
      throw new Error(`listenKey create failed: ${response.status}`);
    }
    const body: any = await response.json();
    if (!body.listenKey) {
      throw new Error('listenKey missing in response');
    }
    return String(body.listenKey);
  }

  private async keepAliveListenKey(listenKey: string): Promise<void> {
    await fetch(`${this.config.restBaseUrl}/fapi/v1/listenKey`, {
      method: 'PUT',
      headers: {
        'X-MBX-APIKEY': this.apiKey || '',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `listenKey=${encodeURIComponent(listenKey)}`,
    });
  }

  private async deleteListenKey(listenKey: string): Promise<void> {
    await fetch(`${this.config.restBaseUrl}/fapi/v1/listenKey`, {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': this.apiKey || '',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `listenKey=${encodeURIComponent(listenKey)}`,
    });
  }

  private emitEvent(event: ExecutionEvent) {
    this.lastSequenceEventMs = Math.max(this.lastSequenceEventMs, event.event_time_ms);
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

  private async signedRequest(path: string, method: 'GET' | 'POST' | 'DELETE', params: Record<string, string | number | boolean>): Promise<any> {
    const apiKey = this.apiKey;
    const secret = this.apiSecret;
    if (!apiKey || !secret) {
      throw new Error('Execution connector is missing API keys');
    }

    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      query.set(k, String(v));
    }

    const signature = createHmac('sha256', secret).update(query.toString()).digest('hex');
    query.set('signature', signature);

    const url = `${this.config.restBaseUrl}${path}?${query.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Binance ${method} ${path} failed (${response.status}): ${errBody}`);
      }

      return await response.json();
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new Error(`Binance ${method} ${path} request timed out after 10s`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}
