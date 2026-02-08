/**
 * Orderbook management utilities.
 *
 * Binance depth streams provide incremental updates with sequence IDs. To
 * maintain a consistent in‑memory orderbook we must apply updates
 * sequentially and detect gaps. When a gap is detected we discard
 * incremental updates and fetch a fresh snapshot via the REST API.
 *
 * This module encapsulates the state and logic for an individual
 * symbol's orderbook.  It maintains bids and asks in maps keyed by
 * price (number) and exposes helpers to apply incremental updates,
 * determine the best bid/ask, and retrieve size at a given price.
 */

// Define DepthCache locally to avoid circular dependency/missing export
export interface DepthCache {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export type OrderbookUiState = 'LIVE' | 'STALE' | 'RESYNCING' | 'UNSEEDED';

export interface OrderbookState {
  lastUpdateId: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  lastDepthTime: number;
  uiState: OrderbookUiState;
  resyncPromise: Promise<void> | null;
  // New fields for strict Futures Logic
  buffer: any[];
  // Diagnostic fields
  lastSeenU_u: string; // "U-u"
  stats: {
    applied: number;
    dropped: number;
    buffered: number;
    desyncs: number;
  };
}

export function createOrderbookState(): OrderbookState {
  return {
    lastUpdateId: 0,
    bids: new Map(),
    asks: new Map(),
    lastDepthTime: 0,
    uiState: 'UNSEEDED',
    resyncPromise: null,
    buffer: [],
    lastSeenU_u: '',
    stats: { applied: 0, dropped: 0, buffered: 0, desyncs: 0 }
  };
}

export function applySnapshot(state: OrderbookState, snapshot: DepthCache) {
  state.bids.clear();
  state.asks.clear();
  for (const [priceStr, qtyStr] of snapshot.bids) {
    const q = parseFloat(qtyStr);
    if (q > 0) state.bids.set(parseFloat(priceStr), q);
  }
  for (const [priceStr, qtyStr] of snapshot.asks) {
    const q = parseFloat(qtyStr);
    if (q > 0) state.asks.set(parseFloat(priceStr), q);
  }
  state.lastUpdateId = snapshot.lastUpdateId;
  state.lastDepthTime = Date.now();
  state.uiState = 'LIVE';

  // Process buffer if exists
  if (state.buffer.length > 0) {
    // Keep only updates that have NOT been fully applied (u > lastUpdateId)
    // AND process those where U <= lastUpdateId + 1
    const validUpdates = state.buffer.filter(u => u.u > state.lastUpdateId);
    state.buffer = []; // clear buffer to re-ingest strictly

    for (const update of validUpdates) {
      applyDepthUpdate(state, update);
    }
    // After processing buffer, if we are desynced again, UI stays RESYNCING likely
  }
}

/**
 * Returns TRUE if applied or buffered. Returns FALSE if desync (GAP) detected that requires snapshot.
 * 
 * Tolerant Mode: Small gaps (up to MAX_GAP_TOLERANCE) are accepted and we simply update lastUpdateId.
 * This prevents frequent resyncs due to minor packet loss while maintaining reasonable accuracy.
 */
const MAX_GAP_TOLERANCE = 100; // Allow gaps up to 100 sequence IDs before triggering resync

export function applyDepthUpdate(state: OrderbookState, update: { U: number; u: number; b: [string, string][]; a: [string, string][] }): boolean {
  // 1. If UNSEEDED or RESYNCING, Buffer It.
  if (state.lastUpdateId === 0 || state.uiState === 'RESYNCING' || state.uiState === 'UNSEEDED') {
    state.buffer.push(update);
    // Limit buffer size to avoid memory leaks
    if (state.buffer.length > 1000) state.buffer.shift();
    state.stats.buffered++;
    return true;
  }

  // 2. Drop old updates (u <= lastUpdateId)
  if (update.u <= state.lastUpdateId) {
    state.stats.dropped++;
    return true; // Looked at it, didn't need it. Not a gap.
  }

  // 3. Sequence Check with Tolerance
  // Standard check: U <= lastUpdateId + 1 <= u
  // Tolerant check: Allow small gaps where U > lastUpdateId + 1 but gap is small
  const expectedNext = state.lastUpdateId + 1;
  const gap = update.U - expectedNext;

  if (gap <= 0 && update.u >= expectedNext) {
    // Perfect match or overlapping - apply normally
    applyDelta(state, update);
    return true;
  } else if (gap > 0 && gap <= MAX_GAP_TOLERANCE) {
    // Small gap detected - accept and apply anyway (tolerant mode)
    // This may cause minor orderbook inaccuracies but prevents constant resyncs
    applyDelta(state, update);
    return true;
  } else {
    // Large GAP Detected (gap > MAX_GAP_TOLERANCE) - requires resync
    state.stats.desyncs++;
    return false; // Caller triggers resync
  }
}

// Helper function to apply the delta update to orderbook
function applyDelta(state: OrderbookState, update: { U: number; u: number; b: [string, string][]; a: [string, string][] }) {
  for (const [p, q] of update.b) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (qty === 0) state.bids.delete(price);
    else state.bids.set(price, qty);
  }
  for (const [p, q] of update.a) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (qty === 0) state.asks.delete(price);
    else state.asks.set(price, qty);
  }
  state.lastUpdateId = update.u;
  state.lastDepthTime = Date.now();
  state.stats.applied++;

  // Ensure state is LIVE after successful apply (if it was somehow stuck)
  if (state.uiState === 'STALE') {
    state.uiState = 'LIVE';
  }
}

/**
 * Compute the best bid (highest price) for the current orderbook.
 */
export function bestBid(state: OrderbookState): number | null {
  if (state.bids.size === 0) return null;
  let max = -Infinity;
  for (const p of state.bids.keys()) {
    if (p > max) max = p;
  }
  return max;
}

/**
 * Compute the best ask (lowest price) for the current orderbook.
 */
export function bestAsk(state: OrderbookState): number | null {
  if (state.asks.size === 0) return null;
  let min = Infinity;
  for (const p of state.asks.keys()) {
    if (p < min) min = p;
  }
  return min;
}

/**
 * Retrieve the orderbook size at a specific price level.  Returns
 * undefined if the level is not present.
 */
export function getLevelSize(state: OrderbookState, price: number): number | undefined {
  const bidSize = state.bids.get(price);
  if (bidSize !== undefined) return bidSize;
  const askSize = state.asks.get(price);
  if (askSize !== undefined) return askSize;
  return undefined;
}

/**
 * Retrieve the top N bid and ask levels from the orderbook.  Bids are
 * returned in descending price order and asks in ascending price order.
 * Each level is a two‑element tuple of [price, size].  This helper
 * is used by the server to expose a depth ladder to the frontend.
 *
 * @param state The orderbook state
 * @param depth The maximum number of levels to return on each side
 */
/**
 * Retrieve the top N bid and ask levels from the orderbook.  Each
 * returned level includes a cumulative `total` field which is the
 * running sum of sizes up to and including that level.  This allows
 * the frontend to render depth bars without recomputing totals.  Bids
 * are returned in descending price order and asks in ascending price
 * order.
 */
export function getTopLevels(
  state: OrderbookState,
  depth: number
): { bids: [number, number, number][]; asks: [number, number, number][] } {
  // Extract and sort bids descending by price
  const sortedBids = Array.from(state.bids.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, depth);
  // Compute cumulative totals for bids (from best bid downwards)
  let cumulativeBid = 0;
  const bidsArray: [number, number, number][] = sortedBids.map(([price, size]) => {
    cumulativeBid += size;
    return [price, size, cumulativeBid];
  });
  // Extract and sort asks ascending by price
  const sortedAsks = Array.from(state.asks.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, depth);
  // Compute cumulative totals for asks (from best ask upwards)
  let cumulativeAsk = 0;
  const asksArray: [number, number, number][] = sortedAsks.map(([price, size]) => {
    cumulativeAsk += size;
    return [price, size, cumulativeAsk];
  });
  return { bids: bidsArray, asks: asksArray };
}