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
const SNAPSHOT_MIN_INTERVAL_MS = Number(process.env.SNAPSHOT_MIN_INTERVAL_MS || 1500);
const MIN_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 120000;
const DEPTH_QUEUE_MAX = Number(process.env.DEPTH_QUEUE_MAX || 2000);
const DEPTH_LAG_MAX_MS = Number(process.env.DEPTH_LAG_MAX_MS || 2000);
const LIVE_SNAPSHOT_FRESH_MS = Number(process.env.LIVE_SNAPSHOT_FRESH_MS || 15000);
const LIVE_DESYNC_RATE_10S_MAX = Number(process.env.LIVE_DESYNC_RATE_10S_MAX || 50);
const LIVE_QUEUE_MAX = Number(process.env.LIVE_QUEUE_MAX || 200);
const LIVE_GOOD_SEQUENCE_MIN = Number(process.env.LIVE_GOOD_SEQUENCE_MIN || 25);
const AUTO_SCALE_MIN_SYMBOLS = 1;
const AUTO_SCALE_LIVE_DOWN_PCT = 80;
const AUTO_SCALE_LIVE_UP_PCT = 95;
const AUTO_SCALE_UP_HOLD_MS = 10 * 60 * 1000;
const DEPTH_LEVELS = Number(process.env.DEPTH_LEVELS || 20);
const DEPTH_STREAM_MODE = String(process.env.DEPTH_STREAM_MODE || 'diff').toLowerCase(); // diff | partial
const WS_UPDATE_SPEED = String(process.env.WS_UPDATE_SPEED || '250ms'); // 100ms | 250ms
const BLOCKED_TELEMETRY_INTERVAL_MS = Number(process.env.BLOCKED_TELEMETRY_INTERVAL_MS || 1000);

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
    // Reliability
    depthQueue: Array<{
        U: number;
        u: number;
        b: [string, string][];
        a: [string, string][];
        eventTimeMs: number;
        receiptTimeMs: number;
    }>;
    isProcessingDepthQueue: boolean;
    goodSequenceStreak: number;
    lastStateTransitionTs: number;
    lastLiveTs: number;
    lastBlockedTelemetryTs: number;
    // Rolling windows
    desyncEvents: number[];
    snapshotOkEvents: number[];
    snapshotSkipEvents: number[];
    liveSamples: Array<{ ts: number; live: boolean }>;
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
let symbolConcurrencyLimit = Math.max(AUTO_SCALE_MIN_SYMBOLS, Number(process.env.SYMBOL_CONCURRENCY || 1));
let autoScaleLastUpTs = 0;

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
            applyCount10s: 0,
            depthQueue: [],
            isProcessingDepthQueue: false,
            goodSequenceStreak: 0,
            lastStateTransitionTs: Date.now(),
            lastLiveTs: 0,
            lastBlockedTelemetryTs: 0,
            desyncEvents: [],
            snapshotOkEvents: [],
            snapshotSkipEvents: [],
            liveSamples: []
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

function pruneWindow(values: number[], windowMs: number, now: number): void {
    while (values.length > 0 && now - values[0] > windowMs) {
        values.shift();
    }
}

function countWindow(values: number[], windowMs: number, now: number): number {
    pruneWindow(values, windowMs, now);
    return values.length;
}

function recordLiveSample(symbol: string, live: boolean): void {
    const meta = getMeta(symbol);
    const now = Date.now();
    meta.liveSamples.push({ ts: now, live });
    while (meta.liveSamples.length > 0 && now - meta.liveSamples[0].ts > 60000) {
        meta.liveSamples.shift();
    }
}

function liveUptimePct60s(symbol: string): number {
    const meta = getMeta(symbol);
    const now = Date.now();
    while (meta.liveSamples.length > 0 && now - meta.liveSamples[0].ts > 60000) {
        meta.liveSamples.shift();
    }
    if (meta.liveSamples.length === 0) {
        return 0;
    }
    const liveCount = meta.liveSamples.reduce((acc, sample) => acc + (sample.live ? 1 : 0), 0);
    return (liveCount / meta.liveSamples.length) * 100;
}

function transitionOrderbookState(symbol: string, to: OrderbookState['uiState'], trigger: string, detail: any = {}) {
    const ob = getOrderbook(symbol);
    const from = ob.uiState;
    if (from === to) {
        return;
    }
    ob.uiState = to;
    const meta = getMeta(symbol);
    meta.lastStateTransitionTs = Date.now();
    if (to === 'LIVE') {
        meta.lastLiveTs = meta.lastStateTransitionTs;
    }
    log('ORDERBOOK_STATE_TRANSITION', { symbol, from, to, trigger, ...detail });
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

async function fetchSnapshot(symbol: string, trigger: string, force = false) {
    const meta = getMeta(symbol);
    const ob = getOrderbook(symbol);
    const now = Date.now();

    if (now < globalBackoffUntil) {
        log('SNAPSHOT_SKIP_GLOBAL', { symbol, wait: globalBackoffUntil - now });
        return;
    }

    const waitMs = Math.max(SNAPSHOT_MIN_INTERVAL_MS, meta.backoffMs);
    if (now - meta.lastSnapshotAttempt < waitMs) {
        meta.snapshotSkipEvents.push(now);
        log('SNAPSHOT_SKIP_LOCAL', { symbol, trigger, force, wait: waitMs - (now - meta.lastSnapshotAttempt) });
        return;
    }

    meta.lastSnapshotAttempt = now;
    meta.isResyncing = true;
    transitionOrderbookState(symbol, 'SNAPSHOT_PENDING', trigger);

    try {
        log('SNAPSHOT_REQ', { symbol, trigger });
        const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${symbol}&limit=1000`);

        meta.lastSnapshotHttpStatus = res.status;

        if (res.status === 429 || res.status === 418) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10) * 1000;
            const weight = res.headers.get('x-mbx-used-weight-1m');
            globalBackoffUntil = Date.now() + retryAfter;
            meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
            log('SNAPSHOT_429', { symbol, retryAfter, backoff: meta.backoffMs, weight });
            transitionOrderbookState(symbol, 'HALTED', 'snapshot_429', { retryAfter });
            return;
        }

        if (!res.ok) {
            log('SNAPSHOT_FAIL', { symbol, trigger, status: res.status });
            meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
            meta.consecutiveErrors++;
            transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_http_fail', { status: res.status });
            return;
        }

        const data: any = await res.json();
        transitionOrderbookState(symbol, 'APPLYING_SNAPSHOT', 'snapshot_received', { lastUpdateId: data.lastUpdateId });

        const snapshotResult = applySnapshot(ob, data);
        meta.lastSnapshotOk = now;
        meta.snapshotOkEvents.push(now);
        meta.snapshotLastUpdateId = data.lastUpdateId;
        meta.backoffMs = MIN_BACKOFF_MS;
        meta.consecutiveErrors = 0;
        meta.isResyncing = false;
        meta.snapshotCount++;
        meta.goodSequenceStreak = snapshotResult.ok ? Math.max(meta.goodSequenceStreak, snapshotResult.appliedCount) : 0;

        log('SNAPSHOT_TOP', {
            symbol,
            snapshotLastUpdateId: data.lastUpdateId,
            bestBid: bestBid(ob),
            bestAsk: bestAsk(ob),
            bidsCount: ob.bids.size,
            asksCount: ob.asks.size,
            bufferedApplied: snapshotResult.appliedCount,
            bufferedDropped: snapshotResult.droppedCount,
            gapDetected: snapshotResult.gapDetected
        });

        if (snapshotResult.ok) {
            transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_applied_wait_live_window');
            log('SNAPSHOT_OK', { symbol, trigger, lastUpdateId: data.lastUpdateId });
        } else {
            transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_buffer_gap_detected');
            log('SNAPSHOT_BUFFER_GAP', { symbol, trigger, lastUpdateId: data.lastUpdateId });
        }

    } catch (e: any) {
        log('SNAPSHOT_ERR', { symbol, err: e.message });
        meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
        transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_exception', { error: e.message });
    } finally {
        meta.isResyncing = false;
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
let autoScaleForcedSingle = false;

function buildDepthStream(symbolLower: string): string {
    if (DEPTH_STREAM_MODE === 'partial') {
        return `${symbolLower}@depth${DEPTH_LEVELS}@${WS_UPDATE_SPEED}`;
    }
    return `${symbolLower}@depth@${WS_UPDATE_SPEED}`;
}

function updateStreams() {
    const required = new Set<string>();
    clients.forEach(c => {
        const subs = clientSubs.get(c);
        if (subs) subs.forEach(s => required.add(s));
    });

    const requiredSorted = [...required].sort();
    const limitedSymbols = requiredSorted.slice(0, Math.max(AUTO_SCALE_MIN_SYMBOLS, symbolConcurrencyLimit));
    const effective = new Set<string>(limitedSymbols);

    if (requiredSorted.length > limitedSymbols.length) {
        log('AUTO_SCALE_APPLIED', {
            requested: requiredSorted.length,
            activeLimit: symbolConcurrencyLimit,
            kept: limitedSymbols,
            dropped: requiredSorted.slice(limitedSymbols.length),
        });
    }

    // Simple diff check
    if (effective.size === activeSymbols.size && [...effective].every(s => activeSymbols.has(s))) {
        if (ws && ws.readyState === WebSocket.OPEN) return;
    }

    if (effective.size === 0) {
        if (ws) ws.close();
        ws = null;
        wsState = 'disconnected';
        activeSymbols.clear();
        return;
    }

    if (ws) ws.close();

    activeSymbols = new Set(effective);
    const streams = [...activeSymbols].flatMap(s => {
        const l = s.toLowerCase();
        return [buildDepthStream(l), `${l}@trade`];
    });

    const url = `${BINANCE_WS_BASE}?streams=${streams.join('/')}`;
    log('WS_CONNECT', { count: activeSymbols.size, url });

    wsState = 'connecting';
    ws = new WebSocket(url);

    ws.on('open', () => {
        wsState = 'connected';
        log('WS_OPEN', {});
        activeSymbols.forEach((symbol) => {
            const ob = getOrderbook(symbol);
            if (ob.uiState === 'INIT' || ob.lastUpdateId === 0) {
                transitionOrderbookState(symbol, 'SNAPSHOT_PENDING', 'ws_open_seed');
                fetchSnapshot(symbol, 'ws_open_seed', true).catch(() => { });
            }
        });
    });

    ws.on('message', (raw: Buffer) => handleMsg(raw));

    ws.on('close', () => {
        wsState = 'disconnected';
        log('WS_CLOSE', {});
        setTimeout(updateStreams, 5000);
    });

    ws.on('error', (e) => log('WS_ERROR', { msg: e.message }));
}

function enqueueDepthUpdate(symbol: string, update: { U: number; u: number; b: [string, string][]; a: [string, string][]; eventTimeMs: number; receiptTimeMs: number }) {
    const meta = getMeta(symbol);
    meta.depthQueue.push(update);
    if (meta.depthQueue.length > DEPTH_QUEUE_MAX) {
        meta.depthQueue = [];
        meta.desyncCount++;
        meta.desyncEvents.push(Date.now());
        meta.goodSequenceStreak = 0;
        transitionOrderbookState(symbol, 'RESYNCING', 'queue_overflow', { max: DEPTH_QUEUE_MAX });
        fetchSnapshot(symbol, 'queue_overflow', true).catch(() => { });
        return;
    }
    processDepthQueue(symbol).catch((e) => {
        log('DEPTH_QUEUE_PROCESS_ERR', { symbol, error: e.message });
    });
}

async function processDepthQueue(symbol: string) {
    const meta = getMeta(symbol);
    if (meta.isProcessingDepthQueue) {
        return;
    }
    meta.isProcessingDepthQueue = true;
    try {
        while (meta.depthQueue.length > 0) {
            const update = meta.depthQueue.shift()!;
            const now = Date.now();
            const lagMs = now - update.receiptTimeMs;
            if (lagMs > DEPTH_LAG_MAX_MS) {
                meta.desyncCount++;
                meta.desyncEvents.push(now);
                meta.goodSequenceStreak = 0;
                meta.depthQueue = [];
                transitionOrderbookState(symbol, 'RESYNCING', 'lag_too_high', { lagMs, max: DEPTH_LAG_MAX_MS });
                await fetchSnapshot(symbol, 'lag_too_high', true);
                break;
            }

            const ob = getOrderbook(symbol);
            ob.lastSeenU_u = `${update.U}-${update.u}`;
            ob.lastDepthTime = now;

            const applied = applyDepthUpdate(ob, update);
            if (!applied.ok && applied.gapDetected) {
                meta.desyncCount++;
                meta.desyncEvents.push(now);
                meta.goodSequenceStreak = 0;
                log('DEPTH_DESYNC', { symbol, U: update.U, u: update.u, lastUpdateId: ob.lastUpdateId });
                transitionOrderbookState(symbol, 'RESYNCING', 'sequence_gap', { U: update.U, u: update.u, lastUpdateId: ob.lastUpdateId });
                await fetchSnapshot(symbol, 'sequence_gap', true);
                break;
            }

            if (applied.applied) {
                meta.applyCount10s++;
                meta.goodSequenceStreak++;
            }

            evaluateLiveReadiness(symbol);
            emitBlockedReasonTelemetry(symbol);

            const tas = getTaS(symbol);
            const cvd = getCvd(symbol);
            const abs = getAbs(symbol);
            const leg = getLegacy(symbol);
            const absVal = absorptionResult.get(symbol) ?? 0;
            broadcastMetrics(symbol, ob, tas, cvd, absVal, leg, update.eventTimeMs || 0, 'depth');
        }
    } finally {
        meta.isProcessingDepthQueue = false;
    }
}

function evaluateLiveReadiness(symbol: string) {
    const meta = getMeta(symbol);
    const ob = getOrderbook(symbol);
    const now = Date.now();

    const desyncRate10s = countWindow(meta.desyncEvents, 10000, now);
    const snapshotFresh = meta.lastSnapshotOk > 0 && (now - meta.lastSnapshotOk) <= LIVE_SNAPSHOT_FRESH_MS;
    const queueOk = meta.depthQueue.length <= LIVE_QUEUE_MAX;
    const goodSequence = meta.goodSequenceStreak >= LIVE_GOOD_SEQUENCE_MIN;
    const hasBook = ob.bids.size > 0 && ob.asks.size > 0;

    const live = snapshotFresh && desyncRate10s <= LIVE_DESYNC_RATE_10S_MAX && queueOk && goodSequence && hasBook;
    recordLiveSample(symbol, live);

    if (live) {
        transitionOrderbookState(symbol, 'LIVE', 'live_criteria_met', {
            desyncRate10s,
            queueLen: meta.depthQueue.length,
            goodSequenceStreak: meta.goodSequenceStreak,
            lastSnapshotOkMsAgo: now - meta.lastSnapshotOk,
        });
    } else {
        transitionOrderbookState(symbol, 'RESYNCING', 'live_criteria_not_met', {
            desyncRate10s,
            queueLen: meta.depthQueue.length,
            goodSequenceStreak: meta.goodSequenceStreak,
            lastSnapshotOkMsAgo: meta.lastSnapshotOk > 0 ? (now - meta.lastSnapshotOk) : null,
        });
    }
}

function emitBlockedReasonTelemetry(symbol: string) {
    const meta = getMeta(symbol);
    const now = Date.now();
    if (now - meta.lastBlockedTelemetryTs < BLOCKED_TELEMETRY_INTERVAL_MS) {
        return;
    }
    meta.lastBlockedTelemetryTs = now;

    const ob = getOrderbook(symbol);
    const executionStatus: any = orchestrator.getExecutionStatus();
    const connectorState = executionStatus?.connection || {};
    const actorState = (orchestrator.getStateSnapshot() || {})[symbol];
    const execQuality = actorState?.execQuality?.quality || 'UNKNOWN';
    const execMetricsPresent = Boolean(actorState?.execQuality?.metricsPresent);
    const freezeActive = Boolean(actorState?.execQuality?.freezeActive);
    const legacy = getLegacy(symbol);
    const maybeMetrics = legacy.computeMetrics(ob);

    const metricsAvailability = {
        obi: typeof maybeMetrics?.obiDeep === 'number' && Number.isFinite(maybeMetrics.obiDeep),
        cvd: typeof maybeMetrics?.cvdSlope === 'number' && Number.isFinite(maybeMetrics.cvdSlope),
        deltaZ: typeof maybeMetrics?.deltaZ === 'number' && Number.isFinite(maybeMetrics.deltaZ),
    };

    const desyncRate10s = countWindow(meta.desyncEvents, 10000, now);
    const snapshotSkipRate10s = countWindow(meta.snapshotSkipEvents, 10000, now);
    const lastSnapshotOkMsAgo = meta.lastSnapshotOk > 0 ? now - meta.lastSnapshotOk : null;

    const dataIntegrityUnstable =
        ob.uiState !== 'LIVE' ||
        desyncRate10s > LIVE_DESYNC_RATE_10S_MAX ||
        meta.depthQueue.length > LIVE_QUEUE_MAX;

    let blockedReason: string | null = null;
    if (ob.uiState !== 'LIVE') blockedReason = 'orderbook_not_live';
    else if (!metricsAvailability.obi || !metricsAvailability.cvd || !metricsAvailability.deltaZ) blockedReason = 'metrics_missing';
    else if (dataIntegrityUnstable) blockedReason = 'data_integrity_unstable';
    else if (!connectorState?.executionEnabled) blockedReason = 'execution_disabled';
    else if (!connectorState?.hasCredentials) blockedReason = 'missing_credentials';
    else if (freezeActive) blockedReason = 'freeze_active';
    else blockedReason = null;

    log('BLOCKED_REASON', {
        symbol,
        ts: now,
        state: { orderbook_state: ob.uiState, ws_state: wsState },
        data_integrity: {
            live: ob.uiState === 'LIVE',
            desync_rate_10s: desyncRate10s,
            snapshot_skip_rate_10s: snapshotSkipRate10s,
            last_snapshot_ok_ms_ago: lastSnapshotOkMsAgo,
            queue_len: meta.depthQueue.length,
        },
        metrics_availability: metricsAvailability,
        gate: {
            can_decide: blockedReason === null,
            blocked_reason: blockedReason || null,
        },
        execution: {
            enabled: Boolean(connectorState?.executionEnabled),
            hasCredentials: Boolean(connectorState?.hasCredentials),
            ready: Boolean(connectorState?.ready),
        },
        freeze: {
            active: freezeActive,
            exec_quality: execQuality,
            exec_metrics_present: execMetricsPresent,
        },
    });
}

function runAutoScaler() {
    const symbols = Array.from(activeSymbols);
    if (symbols.length === 0) {
        return;
    }

    const avgLive = symbols.reduce((acc, s) => acc + liveUptimePct60s(s), 0) / symbols.length;
    const now = Date.now();

    if (avgLive < AUTO_SCALE_LIVE_DOWN_PCT && symbolConcurrencyLimit > AUTO_SCALE_MIN_SYMBOLS) {
        symbolConcurrencyLimit = AUTO_SCALE_MIN_SYMBOLS;
        autoScaleForcedSingle = true;
        log('AUTO_SCALE_DOWN', { avgLiveUptimePct60s: Number(avgLive.toFixed(2)), symbolConcurrencyLimit });
        updateStreams();
        return;
    }

    if (avgLive > AUTO_SCALE_LIVE_UP_PCT) {
        if (autoScaleLastUpTs === 0) {
            autoScaleLastUpTs = now;
        }
        const heldLongEnough = now - autoScaleLastUpTs >= AUTO_SCALE_UP_HOLD_MS;
        if (heldLongEnough && autoScaleForcedSingle) {
            symbolConcurrencyLimit = Math.max(symbolConcurrencyLimit + 1, AUTO_SCALE_MIN_SYMBOLS + 1);
            autoScaleForcedSingle = false;
            autoScaleLastUpTs = now;
            log('AUTO_SCALE_UP', { avgLiveUptimePct60s: Number(avgLive.toFixed(2)), symbolConcurrencyLimit });
            updateStreams();
        }
        return;
    }

    autoScaleLastUpTs = 0;
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

        // Ensure Monitors are running
        ensureMonitors(s);
        enqueueDepthUpdate(s, {
            U: Number(d.U || 0),
            u: Number(d.u || 0),
            b: Array.isArray(d.b) ? d.b : [],
            a: Array.isArray(d.a) ? d.a : [],
            eventTimeMs: Number(d.E || d.T || Date.now()),
            receiptTimeMs: Date.now(),
        });
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
        emitBlockedReasonTelemetry(s);
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
        summary: {
            desync_count_10s: 0,
            desync_count_60s: 0,
            snapshot_ok_count_60s: 0,
            snapshot_skip_count_60s: 0,
            live_uptime_pct_60s: 0,
        },
        symbols: {}
    };

    activeSymbols.forEach(s => {
        const meta = getMeta(s);
        const ob = getOrderbook(s);
        const desync10s = countWindow(meta.desyncEvents, 10000, now);
        const desync60s = countWindow(meta.desyncEvents, 60000, now);
        const snapshotOk60s = countWindow(meta.snapshotOkEvents, 60000, now);
        const snapshotSkip60s = countWindow(meta.snapshotSkipEvents, 60000, now);
        const livePct60s = liveUptimePct60s(s);
        result.symbols[s] = {
            status: ob.uiState,
            lastSnapshot: meta.lastSnapshotOk ? Math.floor((now - meta.lastSnapshotOk) / 1000) + 's ago' : 'never',
            lastSnapshotOkTs: meta.lastSnapshotOk,
            snapshotLastUpdateId: meta.snapshotLastUpdateId,
            lastSnapshotHttpStatus: meta.lastSnapshotHttpStatus,
            desync_count_10s: desync10s,
            desync_count_60s: desync60s,
            snapshot_ok_count_60s: snapshotOk60s,
            snapshot_skip_count_60s: snapshotSkip60s,
            live_uptime_pct_60s: Number(livePct60s.toFixed(2)),
            last_live_ts: meta.lastLiveTs,
            last_snapshot_ok_ts: meta.lastSnapshotOk,
            depthMsgCount10s: meta.depthMsgCount10s,
            lastDepthMsgTs: meta.lastDepthMsgTs,
            bufferedDepthCount: ob.buffer.length,
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
        result.summary.desync_count_10s += desync10s;
        result.summary.desync_count_60s += desync60s;
        result.summary.snapshot_ok_count_60s += snapshotOk60s;
        result.summary.snapshot_skip_count_60s += snapshotSkip60s;
        result.summary.live_uptime_pct_60s += livePct60s;
    });
    if (activeSymbols.size > 0) {
        result.summary.live_uptime_pct_60s = Number((result.summary.live_uptime_pct_60s / activeSymbols.size).toFixed(2));
    }
    res.json(result);
});

app.get('/api/status', (req, res) => {
    res.redirect(307, '/api/health');
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
        if (ob.uiState === 'INIT') {
            transitionOrderbookState(s, 'SNAPSHOT_PENDING', 'client_subscribe_init');
            fetchSnapshot(s, 'client_subscribe_init', true);
        }
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
    const now = Date.now();
    symbolMeta.forEach((meta, symbol) => {
        meta.depthMsgCount10s = 0;
        meta.metricsBroadcastCount10s = 0;
        meta.metricsBroadcastDepthCount10s = 0;
        meta.metricsBroadcastTradeCount10s = 0;
        meta.applyCount10s = 0;
        const desyncRate10s = countWindow(meta.desyncEvents, 10000, now);
        if (desyncRate10s > LIVE_DESYNC_RATE_10S_MAX) {
            transitionOrderbookState(symbol, 'RESYNCING', 'desync_rate_high', { desyncRate10s });
            fetchSnapshot(symbol, 'desync_rate_high', true).catch(() => { });
        }
    });
}, 10000);

setInterval(() => {
    activeSymbols.forEach((symbol) => {
        evaluateLiveReadiness(symbol);
        emitBlockedReasonTelemetry(symbol);
    });
    runAutoScaler();
}, 1000);

server.listen(PORT, HOST, () => log('SERVER_UP', { port: PORT, host: HOST }));
orchestrator.start().catch((e) => {
    log('ORCHESTRATOR_START_ERROR', { error: e.message });
});
