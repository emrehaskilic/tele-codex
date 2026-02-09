import React, { useEffect, useMemo, useState } from 'react';
import { useTelemetrySocket } from '../services/useTelemetrySocket';
import { MetricsState, MetricsMessage } from '../types/metrics';
import SymbolRow from './SymbolRow';
import MobileSymbolCard from './MobileSymbolCard';

type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

interface ExecutionStatus {
  connection: {
    state: ConnectionState;
    executionEnabled: boolean;
    hasCredentials: boolean;
    symbols: string[];
    lastError: string | null;
    effectiveLeverageBySymbol?: Record<string, number>;
  };
  selectedSymbol?: string | null; // Legacy
  selectedSymbols: string[]; // New
  settings: {
    initialBalanceUsdt: number;
    leverage: number;
  };
  wallet: {
    totalWalletUsdt: number;
    availableBalanceUsdt: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
  };
  openPosition: {
    side: 'LONG' | 'SHORT';
    size: number;
    entryPrice: number;
    leverage: number;
  } | null;
  openPositions?: Record<string, {
    side: 'LONG' | 'SHORT';
    size: number;
    entryPrice: number;
    leverage: number;
  }>;
}

const defaultExecutionStatus: ExecutionStatus = {
  connection: {
    state: 'DISCONNECTED',
    executionEnabled: false,
    hasCredentials: false,
    symbols: [],
    lastError: null,
  },
  selectedSymbol: null,
  selectedSymbols: [],
  settings: {
    initialBalanceUsdt: 1000,
    leverage: 10,
  },
  wallet: {
    totalWalletUsdt: 0,
    availableBalanceUsdt: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
  },
  openPosition: null,
  openPositions: {},
};

const formatNum = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export const Dashboard: React.FC = () => {
  const [selectedPairs, setSelectedPairs] = useState<string[]>(['BTCUSDT']);
  const [availablePairs, setAvailablePairs] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setDropdownOpen] = useState(false);
  const [isLoadingPairs, setIsLoadingPairs] = useState(true);

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Settings inputs - initialize with defaults, only update from server on first load/explicit sync
  const [initialBalanceInput, setInitialBalanceInput] = useState<string>('1000');
  const [leverageInput, setLeverageInput] = useState<string>('10');
  const settingsLoadedRef = React.useRef(false);

  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus>(defaultExecutionStatus);

  const activeSymbols = useMemo(() => selectedPairs, [selectedPairs]);
  const marketData: MetricsState = useTelemetrySocket(activeSymbols);

  const hostname = window.location.hostname;
  const proxyUrl = (import.meta as any).env?.VITE_PROXY_API || `http://${hostname}:8787`;

  useEffect(() => {
    const fetchPairs = async () => {
      try {
        const res = await fetch(`${proxyUrl}/api/testnet/exchange-info`);
        const data = await res.json();
        const pairs = Array.isArray(data?.symbols) ? data.symbols : [];
        setAvailablePairs(pairs);
        if (pairs.length > 0 && selectedPairs.length === 0) {
          setSelectedPairs([pairs[0]]);
        }
      } catch {
        setAvailablePairs(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
      } finally {
        setIsLoadingPairs(false);
      }
    };

    fetchPairs();
  }, [proxyUrl]);

  useEffect(() => {
    const pollStatus = async () => {
      try {
        const res = await fetch(`${proxyUrl}/api/execution/status`);
        const data = (await res.json()) as ExecutionStatus;
        setExecutionStatus(data);

        // Sync local settings only if not yet loaded (prevents overwrite while typing)
        if (!settingsLoadedRef.current && data.settings) {
          setInitialBalanceInput(String(data.settings.initialBalanceUsdt));
          setLeverageInput(String(data.settings.leverage));
          settingsLoadedRef.current = true;

          // Also sync selected symbols if server has them
          if (data.selectedSymbols && data.selectedSymbols.length > 0) {
            // Merge with local? Or overwrite locally?
            // Overwrite locally since server is source of truth on load
            const serverSyms = data.selectedSymbols.filter(s => s && s.length > 0);
            if (serverSyms.length > 0) {
              setSelectedPairs(serverSyms);
            }
          } else if (data.selectedSymbol) {
            setSelectedPairs([data.selectedSymbol]);
          }
        }
      } catch {
        // no-op: keep last known state
      }
    };

    pollStatus();
    const timer = window.setInterval(pollStatus, 2000);
    return () => window.clearInterval(timer);
  }, [proxyUrl]);

  useEffect(() => {
    const syncSelectedSymbols = async () => {
      try {
        await fetch(`${proxyUrl}/api/execution/symbol`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: selectedPairs }),
        });
      } catch {
        // ignore and retry on next change
      }
    };
    // Debounce slightly to avoid spamming while selecting multiple?
    const timer = setTimeout(syncSelectedSymbols, 500);
    return () => clearTimeout(timer);
  }, [proxyUrl, selectedPairs]);

  const filteredPairs = availablePairs.filter((p) => p.includes(searchTerm.toUpperCase()));

  const togglePair = (pair: string) => {
    if (selectedPairs.includes(pair)) {
      setSelectedPairs(selectedPairs.filter(p => p !== pair));
    } else {
      setSelectedPairs([...selectedPairs, pair]);
    }
  };

  const startExecution = async () => {
    setConnectionError(null);
    try {
      // 1. Connect
      if (executionStatus.connection.state !== 'CONNECTED') {
        const res = await fetch(`${proxyUrl}/api/execution/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret }),
        });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error || 'connect_failed');
        }
      }

      // 2. Enable
      const res2 = await fetch(`${proxyUrl}/api/execution/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res2.json();
      if (res2.ok) {
        setExecutionStatus(data.status);
      } else {
        throw new Error(data.error || 'enable_failed');
      }
    } catch (e: any) {
      setConnectionError(e.message || 'start_failed');
    }
  };

  const killSwitch = async () => {
    setConnectionError(null);
    try {
      // 1. Disable
      await fetch(`${proxyUrl}/api/execution/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      // 2. Disconnect (triggers cancel all)
      const res = await fetch(`${proxyUrl}/api/execution/disconnect`, {
        method: 'POST'
      });
      const data = await res.json();
      setExecutionStatus(data.status);
    } catch (e: any) {
      setConnectionError(e.message || 'kill_failed');
    }
  };

  const connectTestnet = async () => {
    setConnectionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/execution/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'connect_failed');
      }
      setExecutionStatus(data.status as ExecutionStatus);
    } catch (e: any) {
      setConnectionError(e.message || 'connect_failed');
    }
  };

  const disconnectTestnet = async () => {
    setConnectionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/execution/disconnect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'disconnect_failed');
      }
      setExecutionStatus(data.status as ExecutionStatus);
    } catch (e: any) {
      setConnectionError(e.message || 'disconnect_failed');
    }
  };

  const toggleExecution = async (enabled: boolean) => {
    const res = await fetch(`${proxyUrl}/api/execution/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    if (res.ok) {
      setExecutionStatus(data.status as ExecutionStatus);
    }
  };

  const saveSettings = async () => {
    const res = await fetch(`${proxyUrl}/api/execution/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initialBalanceUsdt: Number(initialBalanceInput) || 1000,
        leverage: Number(leverageInput) || 1
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setExecutionStatus(data.status as ExecutionStatus);
      // Update inputs to reflect any server-side clamping/validation results
      if (data.settings) {
        setInitialBalanceInput(String(data.settings.initialBalanceUsdt));
        setLeverageInput(String(data.settings.leverage));
      }
    }
  };

  const statusColor = executionStatus.connection.state === 'CONNECTED'
    ? 'text-green-400'
    : executionStatus.connection.state === 'ERROR'
      ? 'text-red-400'
      : 'text-zinc-400';

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200 font-sans p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Orderflow Matrix</h1>
            <p className="text-zinc-500 text-sm mt-1">DATA: MAINNET | EXECUTION: TESTNET</p>
          </div>
          <div className="text-xs rounded border border-zinc-700 px-3 py-2 bg-zinc-900">
            {executionStatus.connection.executionEnabled ? (
              <span className="text-green-400">Execution ON</span>
            ) : (
              <span className="text-amber-300">Execution OFF (orders blocked)</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">API & Execution</h2>
            <input
              type="password"
              placeholder="Testnet API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
            />
            <input
              type="password"
              placeholder="Testnet API Secret"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
            />

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={startExecution}
                className="px-3 py-3 bg-green-600 hover:bg-green-500 rounded text-sm font-bold text-white shadow-lg shadow-green-900/20 transition-all active:scale-95"
                disabled={executionStatus.connection.executionEnabled}
              >
                START EXECUTION
              </button>
              <button
                onClick={killSwitch}
                className="px-3 py-3 bg-red-600 hover:bg-red-500 rounded text-sm font-bold text-white shadow-lg shadow-red-900/20 transition-all active:scale-95 animate-pulse"
              >
                KILL SWITCH
              </button>
            </div>

            <div className="flex gap-2 opacity-50 text-xs">
              <button onClick={connectTestnet} className="hover:underline">Manual Connect</button>
              <button onClick={disconnectTestnet} className="hover:underline">Manual Disconnect</button>
            </div>

            <div className="text-xs">
              Status: <span className={statusColor} title={executionStatus.connection.lastError || ''}>{executionStatus.connection.state}</span>
            </div>
            {connectionError && <div className="text-xs text-red-400">{connectionError}</div>}
            <label className="flex items-center justify-between text-xs pt-2 border-t border-zinc-800">
              <span>Execution Enabled</span>
              <input
                type="checkbox"
                checked={executionStatus.connection.executionEnabled}
                onChange={(e) => toggleExecution(e.target.checked)}
                className="accent-green-500"
              />
            </label>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">Pair Selection (Multi)</h2>
            <p className="text-[11px] text-zinc-500">Pair list source: TESTNET futures exchangeInfo. Data stream: MAINNET metrics.</p>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="w-full flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              <span>{isLoadingPairs ? 'Loading...' : `${selectedPairs.length} pairs selected`}</span>
              <span>▾</span>
            </button>

            <div className="flex flex-wrap gap-1 mt-2 mb-2">
              {selectedPairs.map(p => (
                <span key={p} className="text-xs px-2 py-1 bg-blue-900/30 text-blue-300 rounded flex items-center gap-1 border border-blue-900/50">
                  {p}
                  <button onClick={() => togglePair(p)} className="hover:text-white">×</button>
                </span>
              ))}
            </div>

            {isDropdownOpen && !isLoadingPairs && (
              <div className="border border-zinc-800 rounded bg-zinc-950 p-2 space-y-2">
                <input
                  type="text"
                  placeholder="Search pair"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-black border border-zinc-800 rounded px-2 py-1 text-xs"
                />
                <div className="max-h-56 overflow-y-auto space-y-1">
                  {filteredPairs.map((pair) => {
                    const isSelected = selectedPairs.includes(pair);
                    return (
                      <button
                        key={pair}
                        onClick={() => togglePair(pair)}
                        className={`w-full text-left px-2 py-1 rounded text-xs flex justify-between ${isSelected ? 'bg-blue-900/40 text-blue-300' : 'hover:bg-zinc-800 text-zinc-400'}`}
                      >
                        <span>{pair}</span>
                        {isSelected && <span>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">Risk & Capital</h2>
            <label className="text-xs text-zinc-400 block">Initial Margin per Symbol (USDT)</label>
            <input
              type="number"
              value={initialBalanceInput}
              onChange={(e) => setInitialBalanceInput(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
            />
            <label className="text-xs text-zinc-400 block">Leverage (no hard cap, env MAX_LEVERAGE applies)</label>
            <input
              type="number"
              min={1}
              value={leverageInput}
              onChange={(e) => setLeverageInput(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
            />
            <div className="text-[11px] text-zinc-500">
              Requested leverage: <span className="text-zinc-300">{formatNum(executionStatus.settings.leverage, 0)}x</span>
            </div>
            <div className="text-[11px] text-zinc-500">
              Effective leverage (testnet):{' '}
              {executionStatus.connection.effectiveLeverageBySymbol &&
              Object.keys(executionStatus.connection.effectiveLeverageBySymbol).length > 0 ? (
                <span className="text-zinc-300">
                  {Object.entries(executionStatus.connection.effectiveLeverageBySymbol)
                    .map(([symbol, lev]) => {
                      const requested = executionStatus.settings.leverage;
                      const effective = Number(lev);
                      const mismatch = Number.isFinite(effective) && effective !== requested;
                      return mismatch
                        ? `${symbol} ${formatNum(effective, 0)}x (req ${formatNum(requested, 0)}x)`
                        : `${symbol} ${formatNum(effective, 0)}x`;
                    })
                    .join(' · ')}
                </span>
              ) : (
                <span className="text-zinc-400">pending</span>
              )}
            </div>
            <button onClick={saveSettings} className="w-full px-3 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-semibold">Apply Settings</button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-zinc-300 mb-2">Wallet & PnL (Testnet Execution Events)</h2>
            <div className="grid grid-cols-2 gap-y-2 text-xs">
              <div className="text-zinc-500">Total Wallet</div><div className="text-right font-mono">{formatNum(executionStatus.wallet.totalWalletUsdt)} USDT</div>
              <div className="text-zinc-500">Available</div><div className="text-right font-mono">{formatNum(executionStatus.wallet.availableBalanceUsdt)} USDT</div>
              <div className="text-zinc-500">Realized PnL</div><div className={`text-right font-mono ${executionStatus.wallet.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatNum(executionStatus.wallet.realizedPnl)}</div>
              <div className="text-zinc-500">Unrealized PnL</div><div className={`text-right font-mono ${executionStatus.wallet.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatNum(executionStatus.wallet.unrealizedPnl)}</div>
              <div className="text-zinc-500">Total PnL</div><div className={`text-right font-mono ${executionStatus.wallet.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatNum(executionStatus.wallet.totalPnl)}</div>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-zinc-300 mb-2">Open Position</h2>
            {executionStatus.openPosition ? (
              <div className="grid grid-cols-2 gap-y-2 text-xs">
                <div className="text-zinc-500">Side</div><div className="text-right font-mono">{executionStatus.openPosition.side}</div>
                <div className="text-zinc-500">Size</div><div className="text-right font-mono">{formatNum(executionStatus.openPosition.size, 6)}</div>
                <div className="text-zinc-500">Entry Price</div><div className="text-right font-mono">{formatNum(executionStatus.openPosition.entryPrice)}</div>
                <div className="text-zinc-500">Leverage</div><div className="text-right font-mono">{formatNum(executionStatus.openPosition.leverage, 1)}x</div>
              </div>
            ) : (
              <div className="text-xs text-zinc-500">No open position</div>
            )}
          </div>
        </div>

        <div className="md:hidden space-y-3 mb-4">
          {activeSymbols.map((symbol) => {
            const msg: MetricsMessage | undefined = marketData[symbol];
            if (!msg) return null;
            return <MobileSymbolCard key={symbol} symbol={symbol} metrics={msg} showLatency={false} />;
          })}
        </div>

        <div className="hidden md:block border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900/80">
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid gap-0 px-4 py-3 text-xs font-bold text-zinc-400 uppercase tracking-wider bg-zinc-900/80 border-b border-zinc-700" style={{ gridTemplateColumns: '120px 100px 110px 90px 90px 100px 80px 90px' }}>
                <div>Symbol</div>
                <div className="text-right font-mono">Price</div>
                <div className="text-right font-mono">OI / Δ</div>
                <div className="text-center">OBI (W)</div>
                <div className="text-center">Δ Z-Score</div>
                <div className="text-center">CVD Slope</div>
                <div className="text-center">Signal</div>
                <div className="text-right">Status</div>
              </div>
              <div className="bg-black/20 divide-y divide-zinc-800/50">
                {activeSymbols.map((symbol) => {
                  const msg: MetricsMessage | undefined = marketData[symbol];
                  if (!msg) return null;
                  return <SymbolRow key={symbol} symbol={symbol} data={msg} showLatency={false} />;
                })}
                {Object.keys(marketData).length === 0 && (
                  <div className="p-12 text-center text-zinc-500 animate-pulse">Connecting to MAINNET market data...</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="text-xs text-zinc-600 text-center">Market data source is always MAINNET. Execution route is always TESTNET.</div>
      </div>
    </div>
  );
};

export default Dashboard;
