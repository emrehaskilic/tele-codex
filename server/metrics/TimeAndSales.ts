/**
 * Time and Sales metrics aggregation for orderflow analysis.
 *
 * This module exposes a `TimeAndSales` class which collects trade events
 * (sometimes referred to as the “trade tape”) and computes summary
 * statistics over a sliding time window.  These statistics follow the
 * guidelines laid out in the project specification:
 *
 *  - Aggressive buy volume versus aggressive sell volume
 *  - Trade count
 *  - Distribution of trade sizes (small, mid, large)
 *  - Bid‐hit vs ask‐lift ratio
 *  - Detection of consecutive market orders in the same direction
 *
 * The class does not persist any state beyond the sliding window and
 * therefore can be freely instantiated per symbol.  It does not perform
 * any network calls or rely on external services.  Consumers of this
 * module are expected to feed it trade messages as they arrive from
 * Binance’s aggregated trade stream (``@aggTrade``).
 */

export type AggressiveSide = 'buy' | 'sell';

/**
 * Representation of a single trade event.  The timestamp is expected
 * to reflect the event time reported by the exchange (not the receipt
 * time on the client).  This distinction is critical for accurate
 * aggregation and aligns with the “Event Time vs Receipt Time” rule.
 */
export interface TradeEvent {
  price: number;
  quantity: number;
  side: AggressiveSide;
  timestamp: number;
}

/**
 * Metrics summarising the trade tape within the current window.
 */
export interface TradeMetrics {
  /**
   * Total quantity (not notional) executed by aggressive buyers.
   */
  aggressiveBuyVolume: number;
  /**
   * Total quantity executed by aggressive sellers.
   */
  aggressiveSellVolume: number;
  /**
   * Number of individual trade prints recorded.
   */
  tradeCount: number;
  /**
   * Number of small trades (quantity below the mid threshold).
   */
  smallTrades: number;
  /**
   * Number of mid-sized trades (quantity between small and large thresholds).
   */
  midTrades: number;
  /**
   * Number of large trades (quantity above the large threshold).
   */
  largeTrades: number;
  /**
   * Ratio of bid‐hits to ask‐lifts.  Defined as aggressiveSellVolume / aggressiveBuyVolume.
   * If either side has zero volume the ratio is defined as 0.
   */
  bidHitAskLiftRatio: number;
  /**
   * Consecutive market order burst detection.  When a sequence of
   * trades in the same direction occurs without interruption, this
   * counter reflects how long the current burst has persisted.  The
   * side indicates whether the current burst is on the buy or sell
   * side.  If there is no active burst the count is zero.
   */
  consecutiveBurst: {
    side: AggressiveSide | null;
    count: number;
  };

  /**
   * Prints per second.  Defined as tradeCount divided by the window
   * duration in seconds.  Provides a measure of trade intensity.
   */
  printsPerSecond: number;
}

/**
 * Internal representation of a trade within the sliding window.  In
 * addition to the public fields, we capture the arrival time so that
 * we can expire older trades efficiently.
 */
interface StoredTrade extends TradeEvent {
  arrival: number;
}

/**
 * Time and Sales aggregator for a single symbol.
 *
 * Each instance maintains a list of recent trades up to a configurable
 * maximum window (default 60 seconds).  Trades older than the window
 * are discarded on each update.  Consumers may adjust the window size
 * to control the responsiveness of the metrics.  A shorter window
 * emphasises the most recent activity, whereas a longer window
 * provides smoother statistics.
 */
export class TimeAndSales {
  private readonly windowMs: number;
  private trades: StoredTrade[] = [];
  private lastBurstSide: AggressiveSide | null = null;
  private lastBurstCount = 0;

  /**
   * Construct a new TimeAndSales aggregator.
   *
   * @param windowMs Duration of the sliding window in milliseconds.  Defaults to 60 000 (1 minute).
   */
  constructor(windowMs: number = 60_000) {
    this.windowMs = windowMs;
  }

  /**
   * Ingest a new trade event.  The event is immediately stored and
   * older events are purged according to the configured window.  This
   * method performs no aggregation; call `computeMetrics()` to
   * retrieve the current summary.
   *
   * @param event Trade event to ingest
   */
  public addTrade(event: TradeEvent): void {
    const arrival = Date.now();
    this.trades.push({ ...event, arrival });

    // Purge expired trades based on the event timestamp (not receipt time)
    const cutoff = event.timestamp - this.windowMs;
    this.trades = this.trades.filter(t => t.timestamp >= cutoff);

    // Update consecutive burst detection.  If the side matches the
    // previous trade’s side we increment the burst counter; otherwise
    // reset it.  We ignore zero quantity trades.
    if (event.quantity > 0) {
      if (this.lastBurstSide === event.side) {
        this.lastBurstCount += 1;
      } else {
        this.lastBurstSide = event.side;
        this.lastBurstCount = 1;
      }
    }
  }

  /**
   * Compute summary metrics over the current sliding window.  This
   * performs a full scan of the stored trades and aggregates them
   * according to the definitions above.  The thresholds for small,
   * medium and large trades are derived from the quantiles of
   * quantities observed in the current window.  If fewer than 10
   * trades exist the thresholds fall back to fixed values (small < 1,
   * mid < 10, large ≥ 10).
   */
  public computeMetrics(): TradeMetrics {
    let buyVol = 0;
    let sellVol = 0;
    const sizes: number[] = [];

    for (const t of this.trades) {
      sizes.push(t.quantity);
      if (t.side === 'buy') {
        buyVol += t.quantity;
      } else {
        sellVol += t.quantity;
      }
    }

    const tradeCount = this.trades.length;
    // Determine thresholds based on distribution of sizes
    let smallThreshold = 1;
    let largeThreshold = 10;
    if (sizes.length >= 10) {
      // sort a copy to avoid mutating original
      const sorted = [...sizes].sort((a, b) => a - b);
      smallThreshold = sorted[Math.floor(sorted.length * 0.33)] || smallThreshold;
      largeThreshold = sorted[Math.floor(sorted.length * 0.66)] || largeThreshold;
    }

    let smallCount = 0;
    let midCount = 0;
    let largeCount = 0;
    for (const qty of sizes) {
      if (qty < smallThreshold) {
        smallCount++;
      } else if (qty < largeThreshold) {
        midCount++;
      } else {
        largeCount++;
      }
    }

    // Compute bid‐hit vs ask‐lift ratio
    let ratio = 0;
    if (buyVol > 0 && sellVol > 0) {
      ratio = sellVol / buyVol;
    }

    // Provide consecutive burst details
    const burst = {
      side: this.lastBurstSide,
      count: this.lastBurstCount,
    };

    const printsPerSecond = this.windowMs > 0 ? tradeCount / (this.windowMs / 1000) : 0;

    return {
      aggressiveBuyVolume: buyVol,
      aggressiveSellVolume: sellVol,
      tradeCount,
      smallTrades: smallCount,
      midTrades: midCount,
      largeTrades: largeCount,
      bidHitAskLiftRatio: ratio,
      consecutiveBurst: burst,
      printsPerSecond,
    };
  }
}
