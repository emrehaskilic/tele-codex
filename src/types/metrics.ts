// Metrics types shared between the frontend and backend.  These
// interfaces describe the shape of the WebSocket messages emitted by
// the server and the structures stored in the UI state.  Do not
// compute any values on the client; the server must populate all
// fields.

/**
 * Per‐timeframe cumulative volume delta (CVD) metrics.  Each
 * timeframe includes the cumulative delta, the delta over the
 * interval and an exhaustion flag indicating diminishing returns.
 */
export interface CvdTfMetrics {
  cvd: number;
  delta: number;
  exhaustion: boolean;
}

/**
 * Legacy orderflow metrics that were formerly computed in the
 * frontend.  These values are derived from both trades and the
 * orderbook on the server.  They maintain parity with the original
 * "Orderflow Matrix" UI.
 */
export interface LegacyMetrics {
  price: number;
  high24h?: number;
  low24h?: number;
  obiWeighted: number;
  obiDeep: number;
  obiDivergence: number;
  delta1s: number;
  delta5s: number;
  deltaZ: number;
  cvdSession: number;
  cvdSlope: number;
  vwap: number;
  totalVolume: number;
  totalNotional: number;
  absorptionScore: number;
  sweepFadeScore: number;
  breakoutScore: number;
  regimeWeight: number;
  tradeCount: number;
  tradeSignal?: number; // 1=Buy, -1=Sell, 0=Neutral
  exhaustion?: boolean; // True = market exhaustion detected
}

/**
 * Time and sales summary metrics derived from the trade tape.  These
 * values summarise aggressive buy and sell volume, trade counts and
 * distribution, bid/ask dominance and microburst detection.
 */
export interface TimeAndSalesMetrics {
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  tradeCount: number;
  smallTrades: number;
  midTrades: number;
  largeTrades: number;
  bidHitAskLiftRatio: number;
  consecutiveBurst: {
    side: 'buy' | 'sell';
    count: number;
  };
  printsPerSecond: number;
}

/**
 * Open interest metrics (futures context).  Delta is the change in
 * open interest since the previous update.  Source describes whether
 * the data comes from the real exchange or a mock feed.
 */
export interface OpenInterestMetrics {
  openInterest: number;
  delta: number;
  deltaPercent: number;
  trend: 'up' | 'down' | 'flat';
  signal: 'bullish' | 'bearish' | 'neutral';
  volatility: number;
  strength: number;
  lastUpdate: number;
  source: 'real' | 'mock';
}

/**
 * Funding rate metrics.  ``rate`` is the current funding rate,
 * ``timeToFundingMs`` is the milliseconds until the next funding
 * event and ``trend`` indicates whether the rate is rising, falling
 * or flat.  Source indicates real or mock.
 */
export interface FundingContext {
  rate: number;
  timeToFundingMs: number;
  trend: 'up' | 'down' | 'flat';
  source: 'real' | 'mock';
}

/**
 * The structure of a single ``metrics`` message from the server.
 * Each message contains data for one symbol.  The UI should not
 * perform any calculations on these fields; they are ready for
 * rendering.
 */
export interface MetricsMessage {
  type: 'metrics';
  symbol: string;
  state: 'LIVE' | 'STALE' | 'RESYNCING';
  timeAndSales: TimeAndSalesMetrics;
  cvd: {
    tf1m: CvdTfMetrics;
    tf5m: CvdTfMetrics;
    tf15m: CvdTfMetrics;
  };
  absorption: number | null;
  openInterest: OpenInterestMetrics | null;
  funding: FundingContext | null;
  legacyMetrics: LegacyMetrics;
  bids: [number, number, number][];
  asks: [number, number, number][];
  midPrice: number | null;
  lastUpdateId?: number;
}

/**
 * Per symbol state stored in the Dashboard.  Each symbol maps to
 * its latest metrics message.  We do not store derived values on
 * the client.
 */
export type MetricsState = Record<string, MetricsMessage>;
