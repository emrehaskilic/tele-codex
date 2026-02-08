/**
 * Binance Futures Proxy Server (Strict Architecture)
 *
 * Mandates:
 * 1. Futures ONLY (fapi/fstream).
 * 2. Strict Rate Limiting (Token Bucket / 429 Backoff).
 * 3. Independent Trade Tape (works even if Orderbook is stale).
 * 4. Observability-first (Detailed /health and JSON logs).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cors from 'cors';

// Polyfills
declare var process: any;
declare var Buffer: any;

// Metrics Imports
import { TimeAndSales } from './metrics/TimeAndSales';
import { CvdCalculator } from './metrics/CvdCalculator';
import { AbsorptionDetector } from './metrics/AbsorptionDetector';
import { OpenInterestMonitor, OpenInterestMetrics } from './metrics/OpenInterestMonitor';
import { FundingMonitor, FundingMetrics } from './metrics/FundingMonitor';
import {
    OrderbookState,
    createOrderbookState,
    applyDepthUpdate,
    applySnapshot,
    bestBid,
    bestAsk,
    getLevelSize,
    getTopLevels,
} from './metrics/OrderbookManager';
import { LegacyCalculator } from './metrics/LegacyCalculator';
import { createOrchestratorFromEnv } from './orchestrator/Orchestrator';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for Nginx proxy
const BINANCE_REST_BASE = 'https://fapi.binance.com';
const BINANCE_WS_BASE = 'wss://fstream.binance.com/stream';

// Dynamic CORS - allow configured origins plus common development ports
const ALLOWED_ORIGINS = [
    // Development
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    // Production - add your domain here or use env var
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
];

// Rate Limiting
const SNAPSHOT_MIN_INTERVAL_MS = 60000;
const MIN_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 120000;

// =============================================================================
// Logging
// =============================================================================

function log(event: string, data: any = {}) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...data
    }));
}

// =============================================================================
// State
// =============================================================================

interface SymbolMeta {
    lastSnapshotAttempt: number;
    lastSnapshotOk: number;
    backoffMs: number;
    consecutiveErrors: number;
    isResyncing: boolean;
    // Counters
    depthMsgCount: number;
    depthMsgCount10s: number;
    lastDepthMsgTs: number;
    tradeMsgCount: number;
    desyncCount: number;
    snapshotCount: number;
    lastSnapshotHttpStatus: number;
    snapshotLastUpdateId: number;
    // Broadcast tracking
    lastBroadcastTs: number;
    metricsBroadcastCount10s: number;
    metricsBroadcastDepthCount10s: number;
    metricsBroadcastTradeCount10s: number;
    lastMetricsBroadcastReason: 'depth' | 'trade' | 'none';
    applyCount10s: number;
}

const symbolMeta = new Map<string, SymbolMeta>();
const orderbookMap = new Map<string, OrderbookState>();

// Metrics
const timeAndSalesMap = new Map<string, TimeAndSales>();
const cvdMap = new Map<string, CvdCalculator>();
const absorptionMap = new Map<string, AbsorptionDetector>();
const absorptionResult = new Map<string, number>();
const legacyMap = new Map<string, LegacyCalculator>();

// Monitor Caches
const lastOpenInterest = new Map<string, OpenInterestMetrics>();
const lastFunding = new Map<string, FundingMetrics>();
const oiMonitors = new Map<string, OpenInterestMonitor>();
const fundingMonitors = new Map<string, FundingMonitor>();
const orchestrator = createOrchestratorFromEnv();

// Cached Exchange Info
let exchangeInfoCache: { data: any; timestamp: number } | null = null;
const EXCHANGE_INFO_TTL_MS = 1000 * 60 * 60; // 1 hr

// Global Rate Limit
let globalBackoffUntil = 0; // Starts at 0 to allow fresh attempts on restart

// =============================================================================
// Helpers
// =============================================================================

function getMeta(symbol: string): SymbolMeta {
    let meta = symbolMeta.get(symbol);
    if (!meta) {
        meta = {
            lastSnapshotAttempt: 0,
            lastSnapshotOk: 0,
            backoffMs: MIN_BACKOFF_MS,
            consecutiveErrors: 0,
            isResyncing: false,
            depthMsgCount: 0,
            depthMsgCount10s: 0,
            lastDepthMsgTs: 0,
            tradeMsgCount: 0,
            desyncCount: 0,
            snapshotCount: 0,
            lastSnapshotHttpStatus: 0,
            snapshotLastUpdateId: 0,
            // Broadcast tracking
            lastBroadcastTs: 0,
            metricsBroadcastCount10s: 0,
            metricsBroadcastDepthCount10s: 0,
            metricsBroadcastTradeCount10s: 0,
            lastMetricsBroadcastReason: 'none',
            applyCount10s: 0
        };
        symbolMeta.set(symbol, meta);
    }
    return meta;
}

function getOrderbook(symbol: string): OrderbookState {
    let state = orderbookMap.get(symbol);
    if (!state) {
        state = createOrderbookState();
        orderbookMap.set(symbol, state);
    }
    return state;
}

// Lazy Metric Getters
const getTaS = (s: string) => { if (!timeAndSalesMap.has(s)) timeAndSalesMap.set(s, new TimeAndSales()); return timeAndSalesMap.get(s)!; };
const getCvd = (s: string) => { if (!cvdMap.has(s)) cvdMap.set(s, new CvdCalculator()); return cvdMap.get(s)!; };
const getAbs = (s: string) => { if (!absorptionMap.has(s)) absorptionMap.set(s, new AbsorptionDetector()); return absorptionMap.get(s)!; };
const getLegacy = (s: string) => { if (!legacyMap.has(s)) legacyMap.set(s, new LegacyCalculator(s)); return legacyMap.get(s)!; };

function ensureMonitors(symbol: string) {
    // Open Interest is now managed by LegacyCalculator
    /*
    if (!oiMonitors.has(symbol)) {
       // Deprecated
    }
    */
    if (!fundingMonitors.has(symbol)) {
        const m = new FundingMonitor(symbol);
        m.onUpdate(d => lastFunding.set(symbol, d));
        m.start();
        fundingMonitors.set(symbol, m);
    }
}

// =============================================================================
// Binance Interactions
// =============================================================================

async function fetchExchangeInfo() {
    if (exchangeInfoCache && (Date.now() - exchangeInfoCache.timestamp < EXCHANGE_INFO_TTL_MS)) {
        return exchangeInfoCache.data;
    }
    try {
        log('EXCHANGE_INFO_REQ', { url: `${BINANCE_REST_BASE}/fapi/v1/exchangeInfo` });
        const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        const symbols = data.symbols
            .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
            .map((s: any) => s.symbol).sort();
        exchangeInfoCache = { data: { symbols }, timestamp: Date.now() };
        return exchangeInfoCache.data;
    } catch (e: any) {
        log('EXCHANGE_INFO_ERROR', { error: e.message });
        return exchangeInfoCache?.data || { symbols: [] };
    }
}

async function fetchSnapshot(symbol: string) {
    const meta = getMeta(symbol);
    const ob = getOrderbook(symbol);
    const now = Date.now();

    // 1. Global Check (Skip if UNSEEDED to force first boot, unless actually 429'd recently)
    // We assume restart means we "want" to try. But let's respect if it's huge.
    // Better strategy: If UNSEEDED, we try ONCE even if `globalBackoffUntil` is slightly future, 
    // BUT since we just restarted, `globalBackoffUntil` is 0 anyway.
    if (now < globalBackoffUntil) {
        // If UNSEEDED, we might want to prioritize this, but if we are globally blocked by 418, we MUST wait.
        log('SNAPSHOT_SKIP_GLOBAL', { symbol, wait: globalBackoffUntil - now });
        return;
    }

    // 2. Local Check
    // Allow immediate retry if UNSEEDED
    if (ob.uiState !== 'UNSEEDED') {
        if (now - meta.lastSnapshotAttempt < SNAPSHOT_MIN_INTERVAL_MS && now - meta.lastSnapshotAttempt < meta.backoffMs) {
            log('SNAPSHOT_SKIP_LOCAL', { symbol, wait: Math.max(SNAPSHOT_MIN_INTERVAL_MS, meta.backoffMs) - (now - meta.lastSnapshotAttempt) });
            return;
        }
    }

    meta.lastSnapshotAttempt = now;
    meta.isResyncing = true;
    // Don't set RESYNCING if unseeded, keep UNSEEDED until success? No, RESYNCING is fine.
    // Actually OrderbookManager handles UNSEEDED -> Buffer. RESYNCING -> also Buffer.
    ob.uiState = 'RESYNCING';

    try {
        log('SNAPSHOT_REQ', { symbol });
        const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${symbol}&limit=1000`);

        meta.lastSnapshotHttpStatus = res.status;

        if (res.status === 429 || res.status === 418) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10) * 1000;
            const weight = res.headers.get('x-mbx-used-weight-1m');
            globalBackoffUntil = Date.now() + retryAfter;
            meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
            log('SNAPSHOT_429', { symbol, retryAfter, backoff: meta.backoffMs, weight });
            ob.uiState = 'STALE';
            return;
        }

        if (!res.ok) {
            log('SNAPSHOT_FAIL', { symbol, status: res.status });
            meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
            meta.consecutiveErrors++;
            ob.uiState = meta.consecutiveErrors > 3 ? 'STALE' : 'RESYNCING';
            return;
        }

        const data: any = await res.json();

        // Success
        applySnapshot(ob, data);
        meta.lastSnapshotOk = now;
        meta.snapshotLastUpdateId = data.lastUpdateId;
        meta.backoffMs = MIN_BACKOFF_MS;
        meta.consecutiveErrors = 0;
        meta.isResyncing = false;
        meta.snapshotCount++;

        // Debug: SNAPSHOT_TOP event
        log('SNAPSHOT_TOP', {
            symbol,
            snapshotLastUpdateId: data.lastUpdateId,
            bestBid: bestBid(ob),
            bestAsk: bestAsk(ob),
            bidsCount: ob.bids.size,
            asksCount: ob.asks.size
        });

        log('SNAPSHOT_OK', { symbol, lastUpdateId: data.lastUpdateId });

    } catch (e: any) {
        log('SNAPSHOT_ERR', { symbol, err: e.message });
        meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
    }
}

// =============================================================================
// WebSocket Multiplexer
// =============================================================================

let ws: WebSocket | null = null;
let wsState = 'disconnected';
let activeSymbols = new Set<string>();
const clients = new Set<WebSocket>();
const clientSubs = new Map<WebSocket, Set<string>>();

function updateStreams() {
    const required = new Set<string>();
    clients.forEach(c => {
        const subs = clientSubs.get(c);
        if (subs) subs.forEach(s => required.add(s));
    });

    // Simple diff check
    if (required.size === activeSymbols.size && [...required].every(s => activeSymbols.has(s))) {
        if (ws && ws.readyState === WebSocket.OPEN) return;
    }

    if (required.size === 0) {
        if (ws) ws.close();
        ws = null;
        wsState = 'disconnected';
        activeSymbols.clear();
        return;
    }

    if (ws) ws.close();

    activeSymbols = new Set(required);
    const streams = [...activeSymbols].flatMap(s => {
        const l = s.toLowerCase();
        return [`${l}@depth@100ms`, `${l}@trade`]; // Using @trade for tape, @depth for OB
    });

    const url = `${BINANCE_WS_BASE}?streams=${streams.join('/')}`;
    log('WS_CONNECT', { count: activeSymbols.size, url });

    wsState = 'connecting';
    ws = new WebSocket(url);

    ws.on('open', () => {
        wsState = 'connected';
        log('WS_OPEN', {});
    });

    ws.on('message', (raw: Buffer) => handleMsg(raw));

    ws.on('close', () => {
        wsState = 'disconnected';
        log('WS_CLOSE', {});
        setTimeout(updateStreams, 5000);
    });

    ws.on('error', (e) => log('WS_ERROR', { msg: e.message }));
}

function handleMsg(raw: Buffer) {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg.data) return;

    const d = msg.data;
    const e = d.e;
    const s = d.s;
    if (!s) return;

    if (e === 'depthUpdate') {
        const meta = getMeta(s);
        meta.depthMsgCount++;
        meta.depthMsgCount10s++;
        meta.lastDepthMsgTs = Date.now();
        const ob = getOrderbook(s);
        ob.lastSeenU_u = `${d.U}-${d.u}`;

        // Ensure Monitors are running
        ensureMonitors(s);
        ob.lastDepthTime = Date.now();

        // Core Logic: Apply or Buffer
        const success = applyDepthUpdate(ob, d);

        if (!success) {
            // Desync detected by OrderbookManager
            meta.desyncCount++;
            log('DEPTH_DESYNC', { symbol: s, u: d.u, U: d.U, lastUpdateId: ob.lastUpdateId });
            // Only trigger snapshot if not already trying
            if (!meta.isResyncing) fetchSnapshot(s);
        } else {
            // Check if we are stuck buffering without seed
            if (ob.uiState === 'UNSEEDED') {
                // We are buffering. Log periodically?
                // logic handled by applyDepthUpdate stats.
                if (meta.depthMsgCount % 100 === 0) {
                    log('DEPTH_BUFFERING_NO_SEED', { symbol: s, bufferSize: ob.buffer.length });
                }

                if (!meta.isResyncing) {
                    fetchSnapshot(s);
                }
            } else {
                // Track applies
                meta.applyCount10s++;

                // Broadcast metrics on depth updates (throttled internally by broadcastMetrics)
                const tas = getTaS(s);
                const cvd = getCvd(s);
                const abs = getAbs(s);
                const leg = getLegacy(s);
                const absVal = absorptionResult.get(s) ?? 0;
                broadcastMetrics(s, ob, tas, cvd, absVal, leg, d.E || d.T || 0, 'depth');

                // Debug: BOOK_TOP event (every 200th apply to avoid spam)
                if (ob.stats.applied % 200 === 0) {
                    log('BOOK_TOP', {
                        symbol: s,
                        bestBid: bestBid(ob),
                        bestAsk: bestAsk(ob),
                        bidsCount: ob.bids.size,
                        asksCount: ob.asks.size,
                        lastAppliedUpdateId: ob.lastUpdateId
                    });
                }

                if (ob.stats.applied % 100 === 0) {
                    // Log book levels occasionally
                    const { bids, asks } = getTopLevels(ob, 1);
                    log('BOOK_LEVELS', { symbol: s, bestBid: bids[0]?.[0], bestAsk: asks[0]?.[0] });
                }
            }
        }
    } else if (e === 'trade') {
        // Trade Tape - Independent of Orderbook State
        const meta = getMeta(s);
        meta.tradeMsgCount++;
        const p = parseFloat(d.p);
        const q = parseFloat(d.q);
        const t = d.T;
        const side = d.m ? 'sell' : 'buy'; // Maker=Buyer => Seller is Taker (Sell)

        const tas = getTaS(s);
        const cvd = getCvd(s);
        const abs = getAbs(s);
        const leg = getLegacy(s);
        const ob = getOrderbook(s);

        tas.addTrade({ price: p, quantity: q, side, timestamp: t });
        cvd.addTrade({ price: p, quantity: q, side, timestamp: t });
        leg.addTrade({ price: p, quantity: q, side, timestamp: t });

        const levelSize = getLevelSize(ob, p) || 0;
        const absVal = abs.addTrade(s, p, side, t, levelSize);
        absorptionResult.set(s, absVal);

        // Broadcast
        broadcastMetrics(s, ob, tas, cvd, absVal, leg, t);
    }
}

function broadcastMetrics(
    s: string,
    ob: OrderbookState,
    tas: TimeAndSales,
    cvd: CvdCalculator,
    absVal: number,
    leg: LegacyCalculator,
    eventTimeMs: number,
    reason: 'depth' | 'trade' = 'trade'
) {
    const THROTTLE_MS = 250; // 4Hz max per symbol
    const meta = getMeta(s);
    if (leg) leg.updateOpenInterest();
    const now = Date.now();

    // Throttle check - skip if last broadcast was too recent
    const intervalMs = now - meta.lastBroadcastTs;
    if (intervalMs < THROTTLE_MS) {
        // Throttled - skip but log occasionally
        return;
    }

    const cvdM = cvd.computeMetrics();
    const tasMetrics = tas.computeMetrics();
    // Calculate OBI/Legacy if Orderbook has data (bids and asks exist)
    // This allows metrics to continue displaying during brief resyncs
    const hasBookData = ob.bids.size > 0 && ob.asks.size > 0;
    const legacyM = hasBookData ? leg.computeMetrics(ob) : null;

    // Top of book
    const { bids, asks } = getTopLevels(ob, 20);
    const bestBidPx = bestBid(ob);
    const bestAskPx = bestAsk(ob);
    const mid = (bestBidPx && bestAskPx) ? (bestBidPx + bestAskPx) / 2 : null;
    const spreadPct = (bestBidPx && bestAskPx && mid && mid > 0)
        ? ((bestAskPx - bestBidPx) / mid) * 100
        : null;

    const payload = {
        type: 'metrics',
        symbol: s,
        event_time_ms: eventTimeMs,
        state: ob.uiState,
        timeAndSales: tasMetrics,
        cvd: {
            tf1m: cvdM.find(x => x.timeframe === '1m') || { cvd: 0, delta: 0, exhaustion: false },
            tf5m: cvdM.find(x => x.timeframe === '5m') || { cvd: 0, delta: 0, exhaustion: false },
            tf15m: cvdM.find(x => x.timeframe === '15m') || { cvd: 0, delta: 0, exhaustion: false },
            tradeCounts: cvd.getTradeCounts() // Debug: trade counts per timeframe
        },
        absorption: absVal,
        openInterest: leg ? leg.getOpenInterestMetrics() : null,
        funding: lastFunding.get(s) || null,
        legacyMetrics: legacyM, // Null if unseeded
        bids, asks,
        bestBid: bestBidPx,
        bestAsk: bestAskPx,
        spreadPct,
        midPrice: mid,
        lastUpdateId: ob.lastUpdateId
    };

    const str = JSON.stringify(payload);
    let sentCount = 0;
    clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && clientSubs.get(c)?.has(s)) {
            c.send(str);
            sentCount++;
        }
    });

    // Update counters
    meta.lastBroadcastTs = now;
    meta.metricsBroadcastCount10s++;
    meta.lastMetricsBroadcastReason = reason;
    if (reason === 'depth') {
        meta.metricsBroadcastDepthCount10s++;
    } else {
        meta.metricsBroadcastTradeCount10s++;
    }

    // Log broadcast event (every 20th to avoid spam)
    if (meta.metricsBroadcastCount10s % 20 === 1) {
        log(reason === 'depth' ? 'METRICS_BROADCAST_DEPTH' : 'METRICS_BROADCAST_TRADE', {
            symbol: s,
            reason,
            throttled: false,
            intervalMs,
            sentTo: sentCount,
            obiWeighted: legacyM?.obiWeighted ?? null,
            obiDeep: legacyM?.obiDeep ?? null,
            obiDivergence: legacyM?.obiDivergence ?? null
        });

        // Debug: METRICS_SYMBOL_BIND for integrity check
        log('METRICS_SYMBOL_BIND', {
            symbol: s,
            bestBid: bestBid(ob),
            bestAsk: bestAsk(ob),
            obiWeighted: legacyM?.obiWeighted ?? null,
            obiDeep: legacyM?.obiDeep ?? null,
            bookLevels: { bids: ob.bids.size, asks: ob.asks.size }
        });
    }

    if (eventTimeMs > 0) {
        const canonicalTimeMs = Date.now();
        // Mainnet market data is ingested here only for signal/intent generation.
        // Execution state remains testnet-only via execution events in orchestrator.
        orchestrator.ingest({
            symbol: s,
            canonical_time_ms: canonicalTimeMs,
            exchange_event_time_ms: eventTimeMs,
            spread_pct: spreadPct,
            prints_per_second: tasMetrics.printsPerSecond,
            best_bid: bestBidPx,
            best_ask: bestAskPx,
            legacyMetrics: legacyM ? {
                obiDeep: legacyM.obiDeep,
                deltaZ: legacyM.deltaZ,
                cvdSlope: legacyM.cvdSlope
            } : null
        });
    }
}


// =============================================================================
// Server
// =============================================================================

const app = express();
app.use(express.json());

// CORS configuration - more permissive for development, restrictive for production
const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
            callback(null, true);
            return;
        }
        // Check against allowed origins
        if (ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
            return;
        }
        // In development, allow any origin
        if (process.env.NODE_ENV !== 'production') {
            callback(null, true);
            return;
        }
        // Reject in production if not in list
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));

app.get('/api/health', (req, res) => {
    const now = Date.now();
    const result: any = {
        ok: true,
        uptime: Math.floor(process.uptime()),
        ws: { state: wsState, count: activeSymbols.size },
        globalBackoff: Math.max(0, globalBackoffUntil - now),
        symbols: {}
    };

    activeSymbols.forEach(s => {
        const meta = getMeta(s);
        const ob = getOrderbook(s);
        result.symbols[s] = {
            status: ob.uiState,
            lastSnapshot: meta.lastSnapshotOk ? Math.floor((now - meta.lastSnapshotOk) / 1000) + 's ago' : 'never',
            lastSnapshotOkTs: meta.lastSnapshotOk,
            snapshotLastUpdateId: meta.snapshotLastUpdateId,
            lastSnapshotHttpStatus: meta.lastSnapshotHttpStatus,
            depthMsgCount10s: meta.depthMsgCount10s,
            lastDepthMsgTs: meta.lastDepthMsgTs,
            bufferedDepthCount: ob.stats.buffered,
            applyCount: ob.stats.applied,
            applyCount10s: meta.applyCount10s,
            dropCount: ob.stats.dropped,
            desyncCount: meta.desyncCount,
            lastSeenU_u: ob.lastSeenU_u,
            bookLevels: {
                bids: ob.bids.size,
                asks: ob.asks.size,
                bestBid: bestBid(ob),
                bestAsk: bestAsk(ob)
            },
            // Broadcast tracking
            metricsBroadcastCount10s: meta.metricsBroadcastCount10s,
            metricsBroadcastDepthCount10s: meta.metricsBroadcastDepthCount10s,
            metricsBroadcastTradeCount10s: meta.metricsBroadcastTradeCount10s,
            lastMetricsBroadcastTs: meta.lastBroadcastTs,
            lastMetricsBroadcastReason: meta.lastMetricsBroadcastReason,
            backoff: meta.backoffMs,
            trades: meta.tradeMsgCount
        };
    });
    res.json(result);
});

app.get('/api/exchange-info', async (req, res) => {
    // Disable caching to prevent 304 responses
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.json(await fetchExchangeInfo());
});

app.get('/api/testnet/exchange-info', async (req, res) => {
    try {
        const symbols = await orchestrator.listTestnetFuturesPairs();
        res.json({ symbols });
    } catch (e: any) {
        res.status(500).json({ error: e.message || 'testnet_exchange_info_failed' });
    }
});

app.get('/api/execution/status', (req, res) => {
    res.json(orchestrator.getExecutionStatus());
});

app.post('/api/execution/connect', async (req, res) => {
    try {
        const apiKey = String(req.body?.apiKey || '');
        const apiSecret = String(req.body?.apiSecret || '');
        if (!apiKey || !apiSecret) {
            res.status(400).json({ error: 'apiKey and apiSecret are required' });
            return;
        }
        await orchestrator.connectExecution(apiKey, apiSecret);
        res.json({ ok: true, status: orchestrator.getExecutionStatus() });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_connect_failed' });
    }
});

app.post('/api/execution/disconnect', async (req, res) => {
    try {
        await orchestrator.disconnectExecution();
        res.json({ ok: true, status: orchestrator.getExecutionStatus() });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_disconnect_failed' });
    }
});

app.post('/api/execution/enabled', async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    await orchestrator.setExecutionEnabled(enabled);
    res.json({ ok: true, status: orchestrator.getExecutionStatus() });
});

app.post('/api/execution/symbol', async (req, res) => {
    try {
        const symbol = String(req.body?.symbol || '').toUpperCase();
        let symbols = Array.isArray(req.body?.symbols) ? req.body.symbols.map((s: any) => String(s).toUpperCase()) : null;

        if (!symbols && symbol) {
            symbols = [symbol];
        }

        if (!symbols || symbols.length === 0) {
            res.status(400).json({ error: 'symbol or symbols required' });
            return;
        }

        await orchestrator.setExecutionSymbols(symbols);
        res.json({ ok: true, status: orchestrator.getExecutionStatus() });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_symbol_set_failed' });
    }
});

app.post('/api/execution/settings', async (req, res) => {
    const settings = await orchestrator.updateCapitalSettings({
        initialTradingBalance: Number(req.body?.initialTradingBalance),
        leverage: Number(req.body?.leverage),
    });
    res.json({ ok: true, settings, status: orchestrator.getExecutionStatus() });
});

app.post('/api/execution/refresh', async (req, res) => {
    try {
        const status = await orchestrator.refreshExecutionState();
        res.json({ ok: true, status });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_refresh_failed' });
    }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (wc, req) => {
    const p = new URL(req.url || '', 'http://l').searchParams.get('symbols') || '';
    const syms = p.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    clients.add(wc);
    clientSubs.set(wc, new Set(syms));
    log('CLIENT_JOIN', { symbols: syms });

    syms.forEach(s => {
        // Trigger initial seed if needed
        const ob = getOrderbook(s);
        if (ob.uiState === 'UNSEEDED') fetchSnapshot(s);
    });

    updateStreams();

    wc.on('close', () => {
        clients.delete(wc);
        clientSubs.delete(wc);
        updateStreams();
    });
});

// Reset 10s counters
setInterval(() => {
    symbolMeta.forEach(meta => {
        meta.depthMsgCount10s = 0;
        meta.metricsBroadcastCount10s = 0;
        meta.metricsBroadcastDepthCount10s = 0;
        meta.metricsBroadcastTradeCount10s = 0;
        meta.applyCount10s = 0;
    });
}, 10000);

server.listen(PORT, HOST, () => log('SERVER_UP', { port: PORT, host: HOST }));
orchestrator.start().catch((e) => {
    log('ORCHESTRATOR_START_ERROR', { error: e.message });
});
