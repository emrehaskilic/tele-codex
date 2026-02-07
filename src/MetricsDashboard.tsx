import React, { useEffect, useState } from 'react';

// Type definitions matching the telemetry contract
interface ConsecutiveBurst {
  side: 'buy' | 'sell' | null;
  count: number;
}

interface TimeAndSalesMetrics {
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  tradeCount: number;
  smallTrades: number;
  midTrades: number;
  largeTrades: number;
  bidHitAskLiftRatio: number;
  consecutiveBurst: ConsecutiveBurst;
  printsPerSecond: number;
}

interface CvdMetrics {
  cvd: number;
  delta: number;
  exhaustion: boolean;
}

interface CvdMessage {
  tf1m: CvdMetrics;
  tf5m: CvdMetrics;
  tf15m: CvdMetrics;
}

interface OpenInterestMetrics {
  openInterest: number;
  delta: number;
  source: 'real' | 'mock';
}

interface FundingMetrics {
  rate: number;
  timeToFundingMs: number;
  trend: 'up' | 'down' | 'flat';
  source: 'real' | 'mock';
}

interface LegacyMetrics {
  price: number;
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
}

interface MetricsMessage {
  type: string;
  symbol: string;
  state: string;
  timeAndSales: TimeAndSalesMetrics;
  cvd: CvdMessage;
  absorption: number | null;
  openInterest: OpenInterestMetrics | null;
  funding: FundingMetrics | null;
  legacyMetrics?: LegacyMetrics;
}

interface SymbolCardProps {
  metrics: MetricsMessage;
  showLatency: boolean;
}

/**
 * A card component that renders all telemetry metrics for a single symbol. It
 * displays time & sales information, multi‑timeframe CVD and delta,
 * absorption status, open interest and funding context and the current
 * connection state. Colours and layout follow the dark “orderflow” aesthetic.
 */
const SymbolCard: React.FC<SymbolCardProps> = ({ metrics, showLatency }) => {
  const { symbol, state, timeAndSales, cvd, openInterest, funding, absorption, legacyMetrics } = metrics;
  const buy = timeAndSales.aggressiveBuyVolume;
  const sell = timeAndSales.aggressiveSellVolume;
  const totalTrade = buy + sell;
  const buyPct = totalTrade > 0 ? (buy / totalTrade) * 100 : 0;
  const sellPct = totalTrade > 0 ? (sell / totalTrade) * 100 : 0;
  const totalCount = timeAndSales.tradeCount || 1;
  const smallPct = (timeAndSales.smallTrades / totalCount) * 100;
  const midPct = (timeAndSales.midTrades / totalCount) * 100;
  const largePct = (timeAndSales.largeTrades / totalCount) * 100;
  // Map states to tailwind colour classes
  const stateColours: Record<string, string> = {
    LIVE: 'bg-green-900/40 text-green-400',
    STALE: 'bg-red-900/40 text-red-400',
    RESYNCING: 'bg-yellow-900/40 text-yellow-400'
  };
  const stateClass = stateColours[state] || 'bg-zinc-800 text-zinc-400';
  const formatNumber = (n: number, decimals = 2) =>
    n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  // Convert milliseconds into a human readable mm:ss string
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-4 space-y-4">
      {/* Header with symbol name and state badge */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <span className="text-lg font-bold text-white">{symbol}</span>
          <span className={`px-2 py-0.5 text-xs font-mono rounded ${stateClass}`}>{state}</span>
        </div>
        <div className="text-xs text-zinc-500">
          Trades: {totalCount}, PPS: {formatNumber(timeAndSales.printsPerSecond, 2)}
        </div>
      </div>

      {/* Aggressive buy/sell bar */}
      <div>
        <div className="flex justify-between text-xs text-zinc-500 mb-1">
          <span>Agg Buy: {formatNumber(buy, 2)}</span>
          <span>Agg Sell: {formatNumber(sell, 2)}</span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded bg-zinc-800">
          <div style={{ width: `${buyPct}%` }} className="bg-green-500"></div>
          <div style={{ width: `${sellPct}%` }} className="bg-red-500"></div>
        </div>
      </div>

      {/* Trade size distribution */}
      <div className="space-y-1">
        {/* Small trades */}
        <div className="flex justify-between text-xs text-zinc-500">
          <span>Small</span>
          <span>{timeAndSales.smallTrades}</span>
        </div>
        <div className="flex h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div style={{ width: `${smallPct}%` }} className="bg-blue-500"></div>
        </div>
        {/* Mid trades */}
        <div className="flex justify-between text-xs text-zinc-500">
          <span>Mid</span>
          <span>{timeAndSales.midTrades}</span>
        </div>
        <div className="flex h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div style={{ width: `${midPct}%` }} className="bg-purple-500"></div>
        </div>
        {/* Large trades */}
        <div className="flex justify-between text-xs text-zinc-500">
          <span>Large</span>
          <span>{timeAndSales.largeTrades}</span>
        </div>
        <div className="flex h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div style={{ width: `${largePct}%` }} className="bg-orange-500"></div>
        </div>
      </div>

      {/* Bid/Ask ratio and burst info */}
      <div className="flex justify-between text-xs text-zinc-500">
        <div>
          BidHit/AskLift:
          <span
            className={
              timeAndSales.bidHitAskLiftRatio > 1
                ? 'text-green-400'
                : timeAndSales.bidHitAskLiftRatio < 1
                ? 'text-red-400'
                : 'text-zinc-300'
            }
          >
            {' '}
            {formatNumber(timeAndSales.bidHitAskLiftRatio, 3)}
          </span>
        </div>
        <div>
          Burst:{' '}
          {timeAndSales.consecutiveBurst.side
            ? `${timeAndSales.consecutiveBurst.side} ×${timeAndSales.consecutiveBurst.count}`
            : 'None'}
        </div>
      </div>

      {/* CVD multi‑timeframe section */}
      <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
        {Object.entries(cvd).map(([tf, obj]) => {
          const deltaClass = obj.delta > 0 ? 'text-green-400' : obj.delta < 0 ? 'text-red-400' : 'text-zinc-300';
          return (
            <div key={tf} className="bg-zinc-800/50 p-2 rounded">
              <div className="font-semibold text-zinc-400 uppercase text-[10px]">{tf}</div>
              <div className="flex items-center space-x-1">
                <span className={deltaClass}>
                  {obj.delta > 0 ? '+' : obj.delta < 0 ? '-' : ''}
                  {formatNumber(Math.abs(obj.delta), 2)}
                </span>
                <span className="text-zinc-300">Δ</span>
              </div>
              <div className="text-zinc-200">{formatNumber(obj.cvd, 2)}</div>
              {obj.exhaustion && <div className="text-red-400">Exhaust</div>}
            </div>
          );
        })}
      </div>

      {/* Open interest and funding section */}
      <div className="grid grid-cols-2 gap-2 text-xs mt-2">
        {/* Open Interest card */}
        <div className="bg-zinc-800/50 p-2 rounded">
          <div className="font-semibold text-zinc-400">Open Interest</div>
          {openInterest ? (
            <>
              <div className="text-zinc-200">OI: {formatNumber(openInterest.openInterest, 2)}</div>
              <div
                className={`text-sm ${
                  openInterest.delta > 0
                    ? 'text-green-400'
                    : openInterest.delta < 0
                    ? 'text-red-400'
                    : 'text-zinc-300'
                }`}
              >
                Δ: {openInterest.delta > 0 ? '+' : openInterest.delta < 0 ? '-' : ''}
                {formatNumber(Math.abs(openInterest.delta), 2)}
              </div>
            </>
          ) : (
            <div className="text-zinc-500">-</div>
          )}
        </div>
        {/* Funding card */}
        <div className="bg-zinc-800/50 p-2 rounded">
          <div className="font-semibold text-zinc-400">Funding</div>
          {funding ? (
            <>
              <div className="text-zinc-200">Rate: {formatNumber(funding.rate, 4)}</div>
              <div className="text-zinc-200">TtF: {formatTime(funding.timeToFundingMs)}</div>
              <div
                className={`text-sm ${
                  funding.trend === 'up'
                    ? 'text-green-400'
                    : funding.trend === 'down'
                    ? 'text-red-400'
                    : 'text-zinc-300'
                }`}
              >
                Trend: {funding.trend}
              </div>
            </>
          ) : (
            <div className="text-zinc-500">-</div>
          )}
        </div>
      </div>

      {/* Absorption flag */}
      <div className="text-xs mt-2">
        Absorption:{' '}
        {absorption && absorption > 0 ? (
          <span className="text-yellow-300">Detected</span>
        ) : (
          <span className="text-zinc-500">None</span>
        )}
      </div>

      {/* Legacy core metrics section */}
      {legacyMetrics && (
        <div className="grid grid-cols-3 gap-2 mt-4 text-xs">
          {/* OBI weighted */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">OBI W</div>
            <div className={legacyMetrics.obiWeighted > 0 ? 'text-green-400' : legacyMetrics.obiWeighted < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.obiWeighted.toFixed(2)}
            </div>
          </div>
          {/* OBI deep */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">OBI D</div>
            <div className={legacyMetrics.obiDeep > 0 ? 'text-green-400' : legacyMetrics.obiDeep < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.obiDeep.toFixed(2)}
            </div>
          </div>
          {/* OBI divergence */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">OBI Div</div>
            <div className={legacyMetrics.obiDivergence > 0 ? 'text-green-400' : legacyMetrics.obiDivergence < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.obiDivergence.toFixed(2)}
            </div>
          </div>
          {/* Delta 1s */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">Δ1s</div>
            <div className={legacyMetrics.delta1s > 0 ? 'text-green-400' : legacyMetrics.delta1s < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.delta1s.toFixed(2)}
            </div>
          </div>
          {/* Delta 5s */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">Δ5s</div>
            <div className={legacyMetrics.delta5s > 0 ? 'text-green-400' : legacyMetrics.delta5s < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.delta5s.toFixed(2)}
            </div>
          </div>
          {/* Delta Z */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">ΔZ</div>
            <div className={legacyMetrics.deltaZ > 0 ? 'text-green-400' : legacyMetrics.deltaZ < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.deltaZ.toFixed(2)}
            </div>
          </div>
          {/* CVD session */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">CVD (Sess)</div>
            <div className={legacyMetrics.cvdSession > 0 ? 'text-green-400' : legacyMetrics.cvdSession < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.cvdSession.toFixed(2)}
            </div>
          </div>
          {/* CVD slope */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">CVD Slope</div>
            <div className={legacyMetrics.cvdSlope > 0 ? 'text-green-400' : legacyMetrics.cvdSlope < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {legacyMetrics.cvdSlope.toFixed(2)}
            </div>
          </div>
          {/* VWAP */}
          <div className="bg-zinc-800/50 p-2 rounded">
            <div className="font-semibold text-zinc-400 text-[10px]">VWAP</div>
            <div className="text-zinc-300">
              {legacyMetrics.vwap.toFixed(2)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Top‑level dashboard component. It connects to the WebSocket telemetry
 * endpoint, maintains a metrics map keyed by symbol and renders a card
 * for each monitored symbol. Users can toggle latency display for
 * debugging. Default symbols: BTCUSDT and ETHUSDT.
 */
const MetricsDashboard: React.FC = () => {
  const [metricsMap, setMetricsMap] = useState<Record<string, MetricsMessage>>({});
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [showLatency, setShowLatency] = useState<boolean>(false);
  useEffect(() => {
    const proxyWs = (import.meta as any).env?.VITE_PROXY_WS || 'ws://localhost:8787';
    const defaultSymbols = ['BTCUSDT', 'ETHUSDT'];
    const ws = new WebSocket(`${proxyWs}/ws?symbols=${defaultSymbols.join(',')}`);
    ws.onopen = () => setWsStatus('open');
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'metrics' && msg.symbol) {
          setMetricsMap(prev => ({ ...prev, [msg.symbol]: msg as MetricsMessage }));
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.onclose = () => setWsStatus('closed');
    ws.onerror = () => setWsStatus('closed');
    return () => {
      ws.close();
    };
  }, []);
  return (
    <div className="bg-[#09090b] min-h-screen text-zinc-200 p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-xl md:text-2xl font-bold text-white">Orderflow Telemetry</h1>
        <div className="flex items-center space-x-4 text-sm">
          <span className="text-zinc-500">WS: {wsStatus}</span>
          <label className="flex items-center space-x-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={showLatency}
              onChange={e => setShowLatency(e.target.checked)}
              className="accent-blue-600"
            />
            <span>Show Latency</span>
          </label>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {['BTCUSDT', 'ETHUSDT'].map(sym => {
          const m = metricsMap[sym];
          return m ? (
            <SymbolCard key={sym} metrics={m} showLatency={showLatency} />
          ) : (
            <div
              key={sym}
              className="text-center text-zinc-500 border border-zinc-800 rounded-lg p-4"
            >
              Waiting {sym}...
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MetricsDashboard;
