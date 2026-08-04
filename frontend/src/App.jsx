import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { api } from './services/api';
import { notify } from './services/notify';
import { watchlist } from './services/watchlist';
import { CandlestickChart } from './components/CandlestickChart';
import { CompanyDetails } from './components/CompanyDetails';
import { SpeedometerGauge } from './components/SpeedometerGauge';
import { SparklineChart } from './components/SparklineChart';

/** "12s ago" / "3m ago" — recomputed each tick so the header never looks frozen. */
function secondsAgo(then, now) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function App() {
  const [currentScreen, setCurrentScreen] = useState('dashboard'); // 'dashboard' or 'details'
  const [activeChartTab, setActiveChartTab] = useState('candlestick'); // 'candlestick' or 'sparkline'
  const [tickers, setTickers] = useState([]);
  const [selectedTicker, setSelectedTicker] = useState('');
  const [allSignals, setAllSignals] = useState({});
  const [selectedAnalysis, setSelectedAnalysis] = useState(null);
  const [selectedSignal, setSelectedSignal] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState(null);

  // Live Alerts feed state
  const [alerts, setAlerts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [notifyPermission, setNotifyPermission] = useState(notify.permission());
  const [now, setNow] = useState(new Date());
  const [wsLive, setWsLive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSeconds, setRefreshSeconds] = useState(45);
  const [starred, setStarred] = useState([]);

  // Scope: 'watchlist' (the user's own list) or 'market' (whole-exchange sweep)
  const [scope, setScope] = useState('watchlist');
  const [marketSignals, setMarketSignals] = useState({});
  const [marketTickers, setMarketTickers] = useState([]);
  const [marketStatus, setMarketStatus] = useState(null);

  // Watchlist filters
  const [signalFilter, setSignalFilter] = useState('ALL'); // ALL | BUY | SELL | HOLD
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [convictionOnly, setConvictionOnly] = useState(false);
  const [sortBy, setSortBy] = useState('score'); // score | confidence | price | change | name

  const [lastScan, setLastScan] = useState(null);
  // Previous scan, kept in a ref so notification logic never runs inside a
  // setState updater (React can invoke those twice).
  const prevSignalsRef = useRef({});
  // applyScan lives inside the connection effect; the manual refresh button
  // reaches it through this ref rather than duplicating the logic.
  const applyScanRef = useRef(null);
  // Tracks which ticker's detail fetch is the most recent one requested. A
  // plain state/closure check can't do this — the closure captures whatever
  // selectedTicker was at click time, which is always stale by the time an
  // in-flight fetch resolves, since React re-renders (and hands out a new
  // closure) as soon as setSelectedTicker runs.
  const detailsRequestRef = useRef(null);
  // Reached by refreshNow so the header's refresh button reloads whatever the
  // active screen actually shows, instead of always reloading the watchlist.
  const marketLoadRef = useRef(null);
  const intradayLoadRef = useRef(null);

  // Chart timeseries states
  const [chartData, setChartData] = useState([]);
  const [loadingChart, setLoadingChart] = useState(false);

  // Search states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState('');
  const [allSymbolsList, setAllSymbolsList] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  // Market recommendations highlights states
  const [marketRecommendations, setMarketRecommendations] = useState({ buy_recommendations: [], sell_recommendations: [] });
  const [loadingRecs, setLoadingRecs] = useState(false);

  // Telegram Alert Settings
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [tgStatus, setTgStatus] = useState('');

  // 1. Initial Load: Fetch tickers and setup WebSocket connection
  useEffect(() => {
    async function loadTickers() {
      try {
        setLoadingList(true);
        const defaults = await api.fetchTickers();
        // The server's list is a starting point; the user's own edits win.
        const merged = watchlist.merge(defaults);
        setTickers(merged);
        setStarred(watchlist.starred());

        if (merged.length > 0) {
          setSelectedTicker(merged[0]);
        }
      } catch (err) {
        console.error("Error loading tickers:", err);
        setError("Failed to connect to FastAPI backend server. Ensure it is running.");
      } finally {
        setLoadingList(false);
      }
    }
    loadTickers();

    // A single path for both transports. The WebSocket and the HTTP fallback
    // deliver the identical payload, so they must not drift apart.
    //
    // Comparison happens against a ref rather than inside a setState updater:
    // React may invoke an updater twice (StrictMode, concurrent rendering), and
    // firing notifications from inside one double-alerts the user.
    function applyScan(data) {
      if (!data || !Array.isArray(data.results)) return;

      const previous = prevSignalsRef.current;
      const transitions = notify.findTransitions(data.results, previous);

      const signalMap = {};
      data.results.forEach((sig) => { signalMap[sig.ticker] = sig; });
      prevSignalsRef.current = { ...previous, ...signalMap };

      setAllSignals((prev) => ({ ...prev, ...signalMap }));
      setLastScan({
        at: new Date(),
        analyzed: data.total_analyzed ?? data.results.length,
        actionable: data.actionable ?? 0,
        highConviction: data.high_conviction ?? 0,
      });

      if (transitions.length === 0) return;

      const newAlerts = transitions.map((sig) => ({
        time: new Date().toLocaleTimeString(),
        ticker: sig.symbol || sig.ticker.replace('.KA', ''),
        signal: sig.signal,
        price: sig.current_price,
        confidence: sig.confidence,
        highConviction: sig.high_conviction,
        target: sig.target,
        stop_loss: sig.stop_loss,
        holdSessions: sig.hold_sessions,
        tradeable: sig.tradeable,
      }));

      setAlerts((prev) => [...newAlerts, ...prev].slice(0, 100));
      newAlerts.forEach(triggerToast);
      transitions.forEach((sig) => notify.send(sig));
    }
    applyScanRef.current = applyScan;

    // Setup WebSocket connection to receive real-time streams with auto-reconnection
    let ws;
    let reconnectTimeout;

    function connectWebSocket() {
      setError(null);
      ws = new WebSocket(api.getWebSocketUrl());

      ws.onopen = () => {
        console.log("WebSocket connected successfully");
        setError(null);
        setWsLive(true);
      };

      ws.onmessage = (event) => {
        try {
          applyScan(JSON.parse(event.data));
        } catch (err) {
          console.error("Error parsing WebSocket packet:", err);
        }
      };

      ws.onclose = () => {
        console.log("WebSocket disconnected. Retrying in 3 seconds...");
        setWsLive(false);
        reconnectTimeout = setTimeout(() => {
          connectWebSocket();
        }, 3000);
      };

      ws.onerror = (err) => {
        console.error("WebSocket connection error. Activating HTTP polling fallback...", err);
        triggerFallbackPolling();
      };
    }

    async function fetchSignalsHttp() {
      try {
        const res = await fetch(api.signalsUrl());
        if (!res.ok) return;
        const data = await res.json();
        if (data.results) applyScan(data);
      } catch (err) {
        console.error("Error polling signals via HTTP:", err);
      }
    }

    let fallbackInterval;
    function triggerFallbackPolling() {
      if (fallbackInterval) return;
      fetchSignalsHttp();
      fallbackInterval = setInterval(fetchSignalsHttp, 8000);
    }

    connectWebSocket();

    return () => {
      if (ws) ws.close();
      clearTimeout(reconnectTimeout);
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, []);

  // 2. Automatically sync detail view with the live signals map. Must follow
  // whichever scope the card was clicked from — a market-scope card's ticker
  // generally isn't in the watchlist's `allSignals`, so checking only that
  // map left the detail view showing whatever ticker was last loaded instead
  // of the one just clicked.
  useEffect(() => {
    const source = scope === 'market' ? marketSignals : allSignals;
    if (!selectedTicker || !source[selectedTicker]) return;
    const liveData = source[selectedTicker];
    setSelectedAnalysis(liveData);
    setSelectedSignal(liveData);
  }, [selectedTicker, scope, marketSignals, allSignals]);

  // 2a. Load all symbols on startup for autocomplete lookup
  useEffect(() => {
    async function loadSymbols() {
      try {
        const data = await api.fetchSymbols();
        if (Array.isArray(data)) {
          setAllSymbolsList(data);
        }
      } catch (err) {
        console.error("Error loading symbols list:", err);
      }
    }
    loadSymbols();
  }, []);

  // 2a2. Load daily market recommendations highlights on startup
  useEffect(() => {
    async function loadRecs() {
      try {
        setLoadingRecs(true);
        const data = await api.fetchMarketRecommendations();
        setMarketRecommendations(data);
      } catch (err) {
        console.error("Error loading recommendations:", err);
      } finally {
        setLoadingRecs(false);
      }
    }
    loadRecs();
  }, []);

  const [analystCompany, setAnalystCompany] = useState(null);

  // 2b. Fetch intraday timeseries chart data whenever selectedTicker changes
  useEffect(() => {
    if (!selectedTicker) return;
    async function fetchChart() {
      try {
        setLoadingChart(true);
        const data = await api.fetchChartData(selectedTicker);
        if (data && data.s === 'ok' && Array.isArray(data.t)) {
          const formattedCandles = data.t.map((t, idx) => ({
            time: t,
            open: data.o[idx],
            high: data.h[idx],
            low: data.l[idx],
            close: data.c[idx],
            volume: data.v[idx]
          }));
          setChartData(formattedCandles);
        } else {
          setChartData([]);
        }
      } catch (err) {
        console.error("Error fetching chart:", err);
        setChartData([]);
      } finally {
        setLoadingChart(false);
      }
    }
    async function fetchAnalystInfo() {
      try {
        const data = await api.fetchAnalystInfo(selectedTicker);
        if (data && data.status === 'success') {
          setAnalystCompany(data.company);
        } else {
          setAnalystCompany(null);
        }
      } catch (err) {
        console.error("Error loading company info:", err);
        setAnalystCompany(null);
      }
    }
    fetchChart();
    fetchAnalystInfo();
  }, [selectedTicker]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    let tickerToSearch = searchQuery.trim().toUpperCase();
    if (!tickerToSearch.endsWith('.KA')) {
      tickerToSearch = `${tickerToSearch}.KA`;
    }

    try {
      setSearchError('');
      setLoadingDetails(true);

      const data = await api.fetchSignal(tickerToSearch);
      if (data.error) {
        throw new Error(data.error);
      }

      // Persist it, so a symbol the user looked up is still there tomorrow.
      addTicker(tickerToSearch);

      setAllSignals(prev => ({
        ...prev,
        [tickerToSearch]: data
      }));

      setSelectedTicker(tickerToSearch);
      setSelectedAnalysis(data);
      setSelectedSignal(data);
      setSearchQuery('');
    } catch (err) {
      console.error(err);
      setSearchError(err.message || "Ticker not found or invalid in PSX. Please try again.");
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleSearchQueryChange = (val) => {
    setSearchQuery(val);
    if (!val.trim()) {
      setSuggestions([]);
      return;
    }
    const cleanVal = val.toLowerCase();
    const filtered = allSymbolsList.filter(item =>
      item.symbol.toLowerCase().includes(cleanVal) ||
      item.name.toLowerCase().includes(cleanVal)
    ).slice(0, 8);
    setSuggestions(filtered);
  };

  const selectSuggestion = async (item) => {
    setSearchQuery(item.symbol);
    setSuggestions([]);

    let tickerToSearch = item.symbol.toUpperCase();
    if (!tickerToSearch.endsWith('.KA')) {
      tickerToSearch = `${tickerToSearch}.KA`;
    }

    try {
      setSearchError('');
      setLoadingDetails(true);

      const data = await api.fetchSignal(tickerToSearch);
      if (data.error) {
        throw new Error(data.error);
      }

      // Persist it, so a symbol the user looked up is still there tomorrow.
      addTicker(tickerToSearch);

      setAllSignals(prev => ({
        ...prev,
        [tickerToSearch]: data
      }));

      setSelectedTicker(tickerToSearch);
      setSelectedAnalysis(data);
      setSelectedSignal(data);
      setSearchQuery('');
      setCurrentScreen('details'); // Navigate to detail view on search/suggest click
    } catch (err) {
      console.error(err);
      const message = err.message || "Ticker not found or invalid in PSX. Please try again.";
      setSearchError(message);
      triggerToast({ kind: 'error', ticker: item.symbol.toUpperCase(), message });
    } finally {
      setLoadingDetails(false);
    }
  };

  const selectRecommendationSymbol = (symbol) => {
    selectSuggestion({ symbol, name: symbol });
  };

  // One-second heartbeat. Drives the clock and the "updated Ns ago" counter so
  // the page visibly stays alive between scans.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Load the market sweep whenever that scope is active, and keep polling
  // while the first (slow) sweep is still building.
  useEffect(() => {
    if (scope !== 'market') return undefined;
    let cancelled = false;

    async function load() {
      try {
        const data = await api.fetchMarketScan();
        if (cancelled) return;
        const map = {};
        (data.results || []).forEach((s) => { map[s.ticker] = s; });
        setMarketSignals(map);
        setMarketTickers((data.results || []).map((s) => s.ticker));
        setMarketStatus({
          scanning: data.scanning ?? false,
          progress: data.progress ?? 0,
          universe: data.universe ?? 0,
          count: data.total_analyzed ?? 0,
          message: data.message,
        });
      } catch (err) {
        console.error('Market scan failed:', err);
      }
    }
    marketLoadRef.current = load;

    load();
    const id = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, [scope]);

  // Intraday gap-fade opportunities — a separate strategy from the daily
  // model (see research_intraday.py): a big overnight gap down has
  // historically closed back up by end of session. Poll independently of
  // scope since this is a day-trade view, not tied to watchlist/market.
  const [intradayOps, setIntradayOps] = useState([]);
  const [intradayScannedAt, setIntradayScannedAt] = useState(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.fetchIntradayScan();
        if (cancelled) return;
        setIntradayOps(data.opportunities || []);
        setIntradayScannedAt(data.scanned_at || null);
      } catch (err) {
        console.error('Intraday scan failed:', err);
      }
    }
    intradayLoadRef.current = load;
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Open a card's detail view. Two bugs lived here before this: (1) leaving
  // the previous ticker's data on screen while the new one loads, so the
  // header said one symbol and the body showed another's; (2) tickers that
  // never made it into a background scan (thin data, scan error) had no way
  // to load at all — clicking them just kept showing whatever was there.
  const openTickerDetails = async (ticker) => {
    detailsRequestRef.current = ticker;
    setSelectedTicker(ticker);
    setCurrentScreen('details');
    setSelectedAnalysis(null);
    setSelectedSignal(null);

    const cached = (scope === 'market' ? marketSignals : allSignals)[ticker];
    if (cached) {
      setSelectedAnalysis(cached);
      setSelectedSignal(cached);
      return;
    }

    try {
      setLoadingDetails(true);
      const data = await api.fetchSignal(ticker);
      if (data.error) throw new Error(data.error);
      if (detailsRequestRef.current !== ticker) return; // superseded by a newer click
      setSelectedAnalysis(data);
      setSelectedSignal(data);
      setAllSignals((prev) => ({ ...prev, [ticker]: data }));
    } catch (err) {
      if (detailsRequestRef.current !== ticker) return;
      console.error(err);
      const message = err.message || `Could not load data for ${ticker.replace('.KA', '')}.`;
      setSearchError(message);
      triggerToast({ kind: 'error', ticker: ticker.replace('.KA', ''), message });
      setCurrentScreen('dashboard');
    } finally {
      if (detailsRequestRef.current === ticker) setLoadingDetails(false);
    }
  };

  // Whichever set the filters and cards operate on.
  const activeTickers = scope === 'market' ? marketTickers : tickers;
  const activeSignals = scope === 'market' ? marketSignals : allSignals;

  const addTicker = (ticker) => {
    const t = watchlist.norm(ticker);
    if (!t) return;
    watchlist.add(t);
    setTickers((prev) => (prev.includes(t) ? prev : [...prev, t]));
  };

  const removeTicker = (ticker, e) => {
    // The card itself navigates; the delete control must not trigger that.
    e?.stopPropagation();
    const t = watchlist.norm(ticker);
    watchlist.remove(t);
    setTickers((prev) => prev.filter((x) => x !== t));
    setStarred(watchlist.starred());
    setAllSignals((prev) => {
      const next = { ...prev };
      delete next[t];
      return next;
    });
    delete prevSignalsRef.current[t];
    if (selectedTicker === t) {
      setSelectedTicker('');
      setCurrentScreen('dashboard');
    }
  };

  const toggleStar = (ticker, e) => {
    e?.stopPropagation();
    watchlist.toggleStar(ticker);
    setStarred(watchlist.starred());
  };

  const resetWatchlist = async () => {
    watchlist.reset();
    const defaults = await api.fetchTickers();
    setTickers(defaults.map(watchlist.norm));
    setStarred([]);
  };

  // Reloads whatever the current screen is actually showing — the intraday
  // screen refetches the gap-fade scan, a details screen refetches that one
  // ticker, and the dashboard refetches the watchlist or market scan
  // depending on scope. Previously this always hit the watchlist /signals
  // endpoint no matter where you were, so refreshing on, say, the intraday
  // tab visibly did nothing for what was on screen.
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      if (currentScreen === 'intraday') {
        await intradayLoadRef.current?.();
      } else if (currentScreen === 'details' && selectedTicker) {
        await openTickerDetails(selectedTicker);
      } else if (scope === 'market') {
        await marketLoadRef.current?.();
      } else {
        const res = await fetch(api.signalsUrl(), { cache: 'no-store' });
        if (res.ok) applyScanRef.current?.(await res.json());
      }
    } catch (err) {
      console.error('Manual refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
  };

  // Strongest candidate first. A watchlist sorted alphabetically buries the one
  // row that matters; sorting by score puts it at the top of the screen.
  const rankedTickers = React.useMemo(() => {
    const priceOf = (t) => activeSignals[t]?.current_price ?? null;

    const passes = (t) => {
      const s = activeSignals[t];
      if (!s) return true;                       // still loading — keep visible

      if (signalFilter !== 'ALL' && s.signal !== signalFilter) return false;
      if (convictionOnly && !s.high_conviction) return false;

      const min = parseFloat(priceMin);
      const max = parseFloat(priceMax);
      const p = priceOf(t);
      if (!Number.isNaN(min) && p !== null && p < min) return false;
      if (!Number.isNaN(max) && p !== null && p > max) return false;

      return true;
    };

    const key = {
      score: (t) => activeSignals[t]?.score ?? -Infinity,
      confidence: (t) => activeSignals[t]?.confidence ?? -Infinity,
      price: (t) => priceOf(t) ?? -Infinity,
      change: (t) => activeSignals[t]?.change_percent ?? -Infinity,
      name: (t) => t,
    }[sortBy];

    const filtered = activeTickers.filter(passes);
    return filtered.sort((a, b) => {
      // Starred names pin to the top under every sort — that is what starring
      // is for.
      const sa = starred.includes(a) ? 1 : 0;
      const sb = starred.includes(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;

      // Conviction floats up next in a score sort — it is the whole point of
      // the ranking.
      if (sortBy === 'score') {
        const ca = activeSignals[a]?.high_conviction ? 1 : 0;
        const cb = activeSignals[b]?.high_conviction ? 1 : 0;
        if (ca !== cb) return cb - ca;
      }
      if (sortBy === 'name') return String(key(a)).localeCompare(String(key(b)));
      return key(b) - key(a);
    });
  }, [activeTickers, activeSignals, signalFilter, priceMin, priceMax, convictionOnly, sortBy, starred]);

  const filterCounts = React.useMemo(() => {
    const c = { ALL: activeTickers.length, BUY: 0, SELL: 0, HOLD: 0 };
    activeTickers.forEach((t) => {
      const s = activeSignals[t];
      if (s && c[s.signal] !== undefined) c[s.signal] += 1;
    });
    return c;
  }, [activeTickers, activeSignals]);

  const triggerToast = (alertObj) => {
    const id = Date.now() + Math.random().toString();
    const newToast = { ...alertObj, id };
    setToasts((prevToasts) => [newToast, ...prevToasts]);
    setTimeout(() => {
      setToasts((prevToasts) => prevToasts.filter((t) => t.id !== id));
    }, 60000);
  };

  const sendTelegramAlertHandler = async (signalObj) => {
    if (!telegramToken || !telegramChatId) {
      setTgStatus('Please enter both Token and Chat ID.');
      return;
    }
    setTgStatus('Sending...');
    try {
      const message = `🚨 <b>PSX BOT ALERT</b> 🚨\n\n` +
        `<b>Stock:</b> ${signalObj.ticker.replace('.KA', '')}\n` +
        `<b>Signal:</b> ${signalObj.signal} ⚡\n` +
        `<b>Current Price:</b> Rs. ${signalObj.current_price.toFixed(2)}\n\n` +
        `🎯 <b>Buy Price (Entry):</b> Rs. ${signalObj.target_buy_price.toFixed(2)}\n` +
        `🎯 <b>Sell Price (Target):</b> Rs. ${signalObj.target_sell_price.toFixed(2)}\n` +
        `🛑 <b>Stop Loss:</b> Rs. ${signalObj.stop_loss.toFixed(2)}`;

      await api.sendTelegramAlert(telegramToken, telegramChatId, message);
      setTgStatus('Alert sent to Telegram successfully!');
    } catch (err) {
      console.error(err);
      setTgStatus(err.message || 'Connection failed.');
    }
  };

  const dynamicBuyRecs = Object.keys(allSignals)
    .map(ticker => allSignals[ticker])
    .filter(sig => sig && sig.buy_score !== undefined)
    .sort((a, b) => b.buy_score - a.buy_score)
    .map(sig => ({
      symbol: sig.ticker.replace('.KA', ''),
      strength: `${Math.round(sig.buy_score * 10)}%`
    }));

  const dynamicSellRecs = Object.keys(allSignals)
    .map(ticker => allSignals[ticker])
    .filter(sig => sig && sig.sell_score !== undefined)
    .sort((a, b) => b.sell_score - a.sell_score)
    .map(sig => ({
      symbol: sig.ticker.replace('.KA', ''),
      strength: `${Math.round(sig.sell_score * 10)}%`
    }));

  // Candlestick calculation helper
  const getMinMaxHighLow = () => {
    if (chartData.length === 0) return { max: 100, min: 0 };
    const slice = chartData.slice(-40);
    return {
      max: Math.max(...slice.map(d => d.high)),
      min: Math.min(...slice.map(d => d.low))
    };
  };
  const { max: chartMax, min: chartMin } = getMinMaxHighLow();

  return (
    <div className="dashboard-container">
      {/* Animated Motion Lines Background Grid */}
      <div className="animated-bg-container">
        <div className="animated-line-up" style={{ left: '10%', animationDelay: '0s' }}></div>
        <div className="animated-line-down" style={{ left: '30%', animationDelay: '2s' }}></div>
        <div className="animated-line-up" style={{ left: '50%', animationDelay: '4s' }}></div>
        <div className="animated-line-down" style={{ left: '70%', animationDelay: '1s' }}></div>
        <div className="animated-line-up" style={{ left: '90%', animationDelay: '3s' }}></div>
      </div>

      {/* Toast Notifications Container */}
      <div className="toast-container">
        {toasts.map((toast) => (
          toast.kind === 'error' ? (
            <div key={toast.id} className="notification-toast error">
              <div className="toast-title">
                <span>⚠️ {toast.ticker}</span>
                <button className="toast-close" onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>×</button>
              </div>
              <p>{toast.message}</p>
            </div>
          ) : (
            <div key={toast.id} className={`notification-toast ${toast.signal.toLowerCase()}${toast.highConviction ? ' high-conviction' : ''}`}>
              <div className="toast-title">
                <span>
                  {toast.signal === 'BUY' ? '🟢 BUY' : '🔴 EXIT'} {toast.ticker}
                  {toast.highConviction && <span className="conviction-tag">HIGH CONVICTION</span>}
                </span>
                <button className="toast-close" onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>×</button>
              </div>
              <p>
                At <strong>Rs. {toast.price.toFixed(2)}</strong> · confidence{' '}
                <strong>{Math.round(toast.confidence)}%</strong>
              </p>
              {toast.signal === 'BUY' ? (
                <div className="toast-targets">
                  <span>Target Rs. {toast.target.toFixed(2)}</span>
                  <span>Stop Rs. {toast.stop_loss.toFixed(2)}</span>
                  <span>Hold {toast.holdSessions} sessions</span>
                </div>
              ) : (
                /* The short side lost 1.5% per trade in testing, so this must
                   never read as an invitation to short. */
                <div className="toast-targets">
                  <span>Close longs — exit signal only, not a short.</span>
                </div>
              )}
            </div>
          )
        ))}
      </div>

      {/* Premium Header & Navigation */}
      <header className="header">
        <div className="header-logo" onClick={() => setCurrentScreen('dashboard')}>
          <span>📈</span>
          <h1 style={{ margin: 0, fontSize: 'inherit' }}>PSX-Signal</h1>
        </div>
        <div className="header-nav">
          <button
            onClick={() => setCurrentScreen('dashboard')}
            className={`header-nav-btn ${currentScreen === 'dashboard' ? 'active' : ''}`}
          >
            🏠 Market Overview
          </button>
          <button
            onClick={() => setCurrentScreen('intraday')}
            className={`header-nav-btn ${currentScreen === 'intraday' ? 'active' : ''}`}
          >
            ⚡ Intraday{intradayOps.length > 0 ? ` (${intradayOps.length})` : ''}
          </button>
          {selectedTicker && (
            <button
              onClick={() => setCurrentScreen('details')}
              className={`header-nav-btn ${currentScreen === 'details' ? 'active' : ''}`}
            >
              📊 {selectedTicker.replace('.KA', '')} Analytics
            </button>
          )}
          {notifyPermission !== 'granted' && notifyPermission !== 'unsupported' && (
            <button
              className="header-nav-btn notify-cta"
              onClick={async () => setNotifyPermission(await notify.request())}
              title="Get a desktop alert the moment a signal fires"
            >
              🔔 Enable alerts
            </button>
          )}

          {/* Live status. The age counter ticks every second off `now`, so the
              header proves the connection is alive between scans instead of
              looking frozen for 45 seconds at a time. */}
          <div
            className={`market-badge ${wsLive ? 'live' : 'offline'}`}
            title={lastScan ? `${lastScan.analyzed} tickers · updates every ${refreshSeconds}s` : 'Connecting…'}
          >
            <span className={`live-dot ${wsLive ? '' : 'off'}`} />
            {lastScan
              ? `${lastScan.actionable} actionable · ${secondsAgo(lastScan.at, now)}`
              : 'Connecting…'}
          </div>

          <span className="clock">{now.toLocaleTimeString()}</span>

          <button
            className={`header-nav-btn refresh-btn ${refreshing ? 'spinning' : ''}`}
            onClick={refreshNow}
            disabled={refreshing}
            title="Fetch the latest scan now"
          >
            ⟳
          </button>
        </div>
      </header>

      {error ? (
        <div style={{ color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', padding: '1.5rem', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          <h3>⚠️ Connection Error</h3>
          <p style={{ marginTop: '0.5rem' }}>{error}</p>
        </div>
      ) : (
        <div className="dashboard-content-wrapper">
          {currentScreen === 'dashboard' ? (
            /* OVERVIEW SCREEN (DASHBOARD) */
            <div>
              <div className="glass-panel" style={{ marginBottom: '2rem' }}>
                <h3 className="panel-title">Tracked Securities</h3>

                <form onSubmit={handleSearch} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem', position: 'relative' }}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      placeholder="Search Symbol (e.g. LUCK, BAFL)"
                      value={searchQuery}
                      onChange={(e) => handleSearchQueryChange(e.target.value)}
                      className="form-input"
                      style={{ flex: 1, padding: '0.6rem 0.8rem', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '0.85rem' }}
                    />
                    <button type="submit" className="config-button" style={{ width: 'auto', padding: '0.6rem 1rem', borderRadius: '8px' }}>
                      🔍 Search
                    </button>
                  </div>

                  {suggestions.length > 0 && (
                    <div className="search-suggestions-dropdown" style={{ background: '#ffffff', border: '1px solid var(--border-color)', borderRadius: '8px', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)', position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000, maxHeight: '200px', overflowY: 'auto', marginTop: '0.25rem' }}>
                      {suggestions.map((item, idx) => (
                        <div
                          key={idx}
                          onClick={() => selectSuggestion(item)}
                          style={{ padding: '0.6rem 0.8rem', cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.03)', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', color: '#0f172a' }}
                          className="suggestion-item"
                        >
                          <strong style={{ color: '#2563eb' }}>{item.symbol}</strong>
                          <span style={{ color: '#64748b', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '180px' }}>{item.name}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {searchError && (
                    <div style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: '0.2rem', padding: '0.25rem 0.5rem', background: 'rgba(239,68,68,0.05)', borderRadius: '4px' }}>
                      {searchError}
                    </div>
                  )}
                </form>

                {/* Scope: the user's own list, or a sweep of the whole market */}
                <div className="scope-bar">
                  <div className="filter-group segmented scope-seg">
                    <button
                      className={`seg-btn all ${scope === 'watchlist' ? 'active' : ''}`}
                      onClick={() => setScope('watchlist')}
                    >
                      My watchlist<span className="seg-count">{tickers.length}</span>
                    </button>
                    <button
                      className={`seg-btn all ${scope === 'market' ? 'active' : ''}`}
                      onClick={() => setScope('market')}
                    >
                      Whole market
                      <span className="seg-count">{marketTickers.length || '…'}</span>
                    </button>
                  </div>

                  {scope === 'market' && marketStatus?.scanning && (
                    <span className="scope-note">
                      <span className="spinner tiny" />
                      Sweeping the exchange… {marketStatus.progress}/{marketStatus.universe}
                    </span>
                  )}
                  {scope === 'market' && !marketStatus?.scanning && marketStatus?.count > 0 && (
                    <span className="scope-note">
                      {marketStatus.count} symbols scanned · refreshes every 15 min
                    </span>
                  )}
                  {scope === 'watchlist' && (
                    <button className="filter-reset" onClick={resetWatchlist}>
                      Reset to defaults
                    </button>
                  )}
                </div>

                {/* Filters */}
                <div className="filter-bar">
                  <div className="filter-group segmented">
                    {['ALL', 'BUY', 'SELL', 'HOLD'].map((s) => (
                      <button
                        key={s}
                        className={`seg-btn ${s.toLowerCase()} ${signalFilter === s ? 'active' : ''}`}
                        onClick={() => setSignalFilter(s)}
                      >
                        {s === 'SELL' ? 'EXIT' : s}
                        <span className="seg-count">{filterCounts[s]}</span>
                      </button>
                    ))}
                  </div>

                  <label className="filter-check">
                    <input
                      type="checkbox"
                      checked={convictionOnly}
                      onChange={(e) => setConvictionOnly(e.target.checked)}
                    />
                    High conviction only
                  </label>

                  <div className="filter-group price-range">
                    <span className="filter-label">Price</span>
                    <input
                      type="number" inputMode="decimal" placeholder="min"
                      className="filter-input" value={priceMin}
                      onChange={(e) => setPriceMin(e.target.value)}
                    />
                    <span className="filter-dash">–</span>
                    <input
                      type="number" inputMode="decimal" placeholder="max"
                      className="filter-input" value={priceMax}
                      onChange={(e) => setPriceMax(e.target.value)}
                    />
                  </div>

                  <div className="filter-group">
                    <span className="filter-label">Sort</span>
                    <select
                      className="filter-select"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                    >
                      <option value="score">Signal score</option>
                      <option value="confidence">Confidence</option>
                      <option value="change">Day change</option>
                      <option value="price">Price</option>
                      <option value="name">Symbol A–Z</option>
                    </select>
                  </div>

                  {(signalFilter !== 'ALL' || priceMin || priceMax || convictionOnly || sortBy !== 'score') && (
                    <button
                      className="filter-reset"
                      onClick={() => {
                        setSignalFilter('ALL'); setPriceMin(''); setPriceMax('');
                        setConvictionOnly(false); setSortBy('score');
                      }}
                    >
                      Reset
                    </button>
                  )}

                  <span className="filter-result">
                    {rankedTickers.length} of {activeTickers.length}
                  </span>
                </div>

                {loadingList ? (
                  <div className="loader">
                    <div className="spinner"></div>
                  </div>
                ) : rankedTickers.length === 0 ? (
                  <div className="filter-empty">
                    No securities match these filters.
                    <button className="filter-reset" onClick={() => {
                      setSignalFilter('ALL'); setPriceMin(''); setPriceMax('');
                      setConvictionOnly(false);
                    }}>Clear filters</button>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem' }}>
                    {rankedTickers.map((ticker) => {
                      const summary = activeSignals[ticker];
                      const cleanName = ticker.replace('.KA', '');
                      const stale = summary && summary.stale_days > 3;
                      return (
                        <div
                          key={ticker}
                          className={`ticker-item premium-hover-card ${selectedTicker === ticker ? 'active' : ''}${summary?.high_conviction ? ' high-conviction' : ''}`}
                          onClick={() => openTickerDetails(ticker)}
                        >
                          {/* In market scope these are watchlist operations on
                              something not yet in the list, so the only useful
                              control is "add". */}
                          <div className="card-actions">
                            {scope === 'market' ? (
                              <button
                                className={`icon-btn add ${tickers.includes(ticker) ? 'on' : ''}`}
                                onClick={(e) => { e.stopPropagation(); addTicker(ticker); }}
                                title={tickers.includes(ticker) ? 'Already in your watchlist' : `Add ${cleanName} to watchlist`}
                                disabled={tickers.includes(ticker)}
                              >
                                {tickers.includes(ticker) ? '✓' : '+'}
                              </button>
                            ) : (
                              <>
                                <button
                                  className={`icon-btn star ${starred.includes(ticker) ? 'on' : ''}`}
                                  onClick={(e) => toggleStar(ticker, e)}
                                  title={starred.includes(ticker) ? 'Unpin from top' : 'Pin to top'}
                                  aria-label={starred.includes(ticker) ? 'Unpin' : 'Pin'}
                                >
                                  {starred.includes(ticker) ? '★' : '☆'}
                                </button>
                                <button
                                  className="icon-btn remove"
                                  onClick={(e) => removeTicker(ticker, e)}
                                  title={`Remove ${cleanName} from watchlist`}
                                  aria-label={`Remove ${cleanName}`}
                                >
                                  ×
                                </button>
                              </>
                            )}
                          </div>

                          <div className="ticker-card-head">
                            <div>
                              <span className="ticker-name">{cleanName}</span>
                              <div className="ticker-fullname">{summary ? summary.name : 'Karachi Stock Exchange'}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              {summary ? (
                                <>
                                  <div className="price-value">Rs. {summary.current_price.toFixed(2)}</div>
                                  <div className={`price-change ${summary.change >= 0 ? 'up' : 'down'}`}>
                                    {summary.change >= 0 ? '+' : ''}{summary.change_percent.toFixed(2)}%
                                  </div>
                                </>
                              ) : (
                                <div className="price-value">Loading…</div>
                              )}
                            </div>
                          </div>

                          {summary && (
                            <>
                              <div className="ticker-card-signal">
                                <span className={`signal-pill ${summary.signal.toLowerCase()}`}>
                                  {summary.signal === 'SELL' ? 'EXIT' : summary.signal}
                                </span>
                                {summary.high_conviction && <span className="conviction-tag">HIGH CONVICTION</span>}
                                {summary.entry_timing === 'WAIT' && <span className="wait-tag">WAIT FOR PRICE</span>}
                                {stale && <span className="stale-tag" title={`Last bar ${summary.updated_at}`}>DATA {summary.stale_days}d OLD</span>}
                              </div>

                              {/* Confidence is the field that actually separates
                                  outcomes in testing, so it gets the visual weight. */}
                              <div className="confidence-row">
                                <div className="confidence-bar">
                                  <div
                                    className={`confidence-fill ${summary.confidence >= 70 ? 'strong' : summary.confidence >= 55 ? 'medium' : 'weak'}`}
                                    style={{ width: `${Math.min(100, summary.confidence)}%` }}
                                  />
                                </div>
                                <span className="confidence-value">{Math.round(summary.confidence)}%</span>
                              </div>

                              {summary.signal === 'BUY' && summary.entry_timing === 'NOW' && (
                                <div className="ticker-levels">
                                  <span>Target <strong>{summary.target.toFixed(2)}</strong></span>
                                  <span>Stop <strong>{summary.stop_loss.toFixed(2)}</strong></span>
                                  <span>{summary.hold_sessions}d</span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Live Market Recommendations Highlights */}
              <div className="glass-panel" style={{ marginTop: '2rem' }}>
                <h3 className="panel-title" style={{ fontSize: '1.15rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
                  🔥 Live Market Technical Highlights (Daily Recommendations)
                  <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-secondary)' }}>Source: psxtechnicalanalysis.com</span>
                </h3>
                {loadingRecs ? (
                  <div className="loader">
                    <div className="spinner"></div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }} className="recs-grid-split">
                    {/* Recommended to Buy Table */}
                    <div>
                      <h4 style={{ color: 'var(--color-buy)', fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        📈 Recommended to Buy (Strongest Uptrends)
                      </h4>
                      <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                          <thead>
                            <tr style={{ background: '#f8fafc', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'left', fontWeight: 600 }}>Symbol</th>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600 }}>Buy Strength</th>
                            </tr>
                          </thead>
                          <tbody>
                            {marketRecommendations.buy_recommendations.length === 0 ? (
                              dynamicBuyRecs.length === 0 ? (
                                <tr>
                                  <td colSpan="2" style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No buy recommendations loaded today.</td>
                                </tr>
                              ) : (
                                dynamicBuyRecs.map((item, idx) => (
                                  <tr
                                    key={idx}
                                    onClick={() => selectRecommendationSymbol(item.symbol)}
                                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background-color 0.2s' }}
                                    className="rec-row-hover"
                                  >
                                    <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600, color: '#2563eb' }}>{item.symbol}</td>
                                    <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600, color: 'var(--color-buy)' }}>{item.strength}</td>
                                  </tr>
                                ))
                              )
                            ) : (
                              marketRecommendations.buy_recommendations.map((item, idx) => (
                                <tr
                                  key={idx}
                                  onClick={() => selectRecommendationSymbol(item.symbol)}
                                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background-color 0.2s' }}
                                  className="rec-row-hover"
                                >
                                  <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600, color: '#2563eb' }}>{item.symbol}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600, color: 'var(--color-buy)' }}>{item.strength}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Recommended to Sell Table */}
                    <div>
                      <h4 style={{ color: 'var(--color-sell)', fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        📉 Recommended to Sell (Bearish Trends)
                      </h4>
                      <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                          <thead>
                            <tr style={{ background: '#f8fafc', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'left', fontWeight: 600 }}>Symbol</th>
                              <th style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600 }}>Sell Strength</th>
                            </tr>
                          </thead>
                          <tbody>
                            {marketRecommendations.sell_recommendations.length === 0 ? (
                              dynamicSellRecs.length === 0 ? (
                                <tr>
                                  <td colSpan="2" style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No sell recommendations loaded today.</td>
                                </tr>
                              ) : (
                                dynamicSellRecs.map((item, idx) => (
                                  <tr
                                    key={idx}
                                    onClick={() => selectRecommendationSymbol(item.symbol)}
                                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background-color 0.2s' }}
                                    className="rec-row-hover"
                                  >
                                    <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600, color: '#2563eb' }}>{item.symbol}</td>
                                    <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600, color: 'var(--color-sell)' }}>{item.strength}</td>
                                  </tr>
                                ))
                              )
                            ) : (
                              marketRecommendations.sell_recommendations.map((item, idx) => (
                                <tr
                                  key={idx}
                                  onClick={() => selectRecommendationSymbol(item.symbol)}
                                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background-color 0.2s' }}
                                  className="rec-row-hover"
                                >
                                  <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600, color: '#2563eb' }}>{item.symbol}</td>
                                  <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600, color: 'var(--color-sell)' }}>{item.strength}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : currentScreen === 'intraday' ? (
            /* DEDICATED INTRADAY GAP-FADE SCREEN — a day-trade strategy,
               separate from the daily swing model. Validated OOS in
               research_intraday.py: a big overnight gap down on PSX has
               closed back up ~1.5-2% by end of session in 72-80% of cases
               historically. Nothing else tested on 5-min bars cleared the
               round-trip cost, so this is deliberately the only intraday
               strategy shown. */
            <div className="details-panel-wrapper">
              <div className="glass-panel">
                <h3 className="panel-title" style={{ fontSize: '1.15rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
                  ⚡ Intraday Gap-Fade (Day Trade)
                  <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                    Buy the open, hold to close — not an overnight position
                  </span>
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0, marginBottom: '1.25rem' }}>
                  Fires when a stock opens ≥2.5% below yesterday's close. Historically
                  those gaps have closed back up ~1.5-2% by end of session, 72-80% win
                  rate out-of-sample across 29 liquid PSX names. Rescans every 2 minutes
                  during the session. This is the only intraday factor tested (momentum,
                  VWAP deviation, opening-range breakout, volume) that cleared PSX's
                  ~0.3-0.5% round-trip cost — so it's the only one shown here.
                </p>
                {intradayOps.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
                    No stock has gapped down enough today to trigger this signal.
                    These are rare by design — check back through the session, or
                    tomorrow at the open.
                  </p>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem' }}>
                    {intradayOps.map((op) => (
                      <div key={op.symbol} className="ticker-item premium-hover-card intraday-card">
                        <div className="ticker-item-header">
                          <span className="ticker-symbol">{op.symbol}</span>
                          <span className="signal-tag buy">GAP-FADE BUY</span>
                        </div>
                        <div className="ticker-levels">
                          <span>Gap <strong>{op.gap_pct.toFixed(2)}%</strong></span>
                          <span>Open <strong>{op.session_open.toFixed(2)}</strong></span>
                          <span>Now <strong>{op.last_price.toFixed(2)}</strong></span>
                        </div>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>
                          {op.expected_edge}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                {intradayScannedAt && (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '1rem', marginBottom: 0 }}>
                    Scanned {new Date(intradayScannedAt * 1000).toLocaleTimeString()}
                  </p>
                )}
              </div>
            </div>
          ) : currentScreen === 'details' ? (
            /* DEDICATED DETAILS SCREEN FOR A SELECTED STOCK */
            <div className="details-panel-wrapper">
              <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button
                  onClick={() => setCurrentScreen('dashboard')}
                  style={{
                    background: '#ffffff',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '0.5rem 1rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontFamily: 'var(--font-family)',
                    fontSize: '0.85rem',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem'
                  }}
                >
                  ← Back to Market Overview
                </button>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Market Overview &gt; {selectedSignal ? selectedSignal.name : selectedTicker.replace('.KA', '')}
                </span>
              </div>

              <div className="glass-panel" style={{ marginBottom: '2rem' }}>
                <h3 className="panel-title" style={{ fontSize: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
                  📊 Detailed Technical Analytics Report
                  <span style={{ color: '#047857', background: '#f0f7f4', padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.85rem' }}>
                    {selectedSignal ? selectedSignal.name : selectedTicker.replace('.KA', '')} ({selectedTicker.replace('.KA', '')})
                  </span>
                </h3>

                {loadingDetails || !selectedAnalysis || !selectedSignal ? (
                  <div className="loader">
                    <div className="spinner"></div>
                  </div>
                ) : (
                  <div style={{ marginTop: '1.5rem' }}>
                    {/* Recommendation Banner */}
                    <div className={`signal-banner ${selectedSignal.signal.toLowerCase()}`} style={{ marginBottom: '2rem' }}>
                      <div className="signal-banner-info">
                        <h2>Current Spot Recommendation</h2>
                        <div className={`signal-recomm ${selectedSignal.signal.toLowerCase()}`} style={{ fontSize: '2.2rem' }}>
                          {selectedSignal.signal}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '2rem', fontWeight: 800 }}>
                          Rs. {selectedAnalysis.current_price.toFixed(2)}
                        </div>
                        <div className={`price-change ${selectedAnalysis.change >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.05rem', fontWeight: 600 }}>
                          {selectedAnalysis.change >= 0 ? '+' : ''}
                          {selectedAnalysis.change.toFixed(2)} ({selectedAnalysis.change_percent.toFixed(2)}%)
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.8)', marginTop: '0.25rem' }}>
                          Volume: {selectedAnalysis.volume ? selectedAnalysis.volume.toLocaleString() : 'N/A'} shares
                        </div>
                      </div>
                    </div>

                    {/* Speedometer Gauge & Trading Targets Grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1.5rem', marginBottom: '2rem' }} className="gauge-targets-grid">
                      <SpeedometerGauge
                        signal={selectedSignal.signal}
                        score={selectedSignal.score}
                        confidence={selectedSignal.confidence}
                        highConviction={selectedSignal.high_conviction}
                      />

                      <div style={{ background: '#ffffff', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '1.5rem' }}>
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          🎯 Precision Trading Targets (Spot & Swing)
                        </h4>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', textAlign: 'center' }}>
                          <div style={{ background: 'rgba(16, 185, 129, 0.05)', padding: '1rem', borderRadius: '12px', border: '1px solid rgba(16, 185, 129, 0.15)' }}>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Target Buy Price</div>
                            <div style={{ fontSize: '1.4rem', fontWeight: 750, color: 'var(--color-buy)', marginTop: '0.25rem' }}>
                              Rs. {selectedSignal.target_buy_price.toFixed(2)}
                            </div>
                          </div>
                          <div style={{ background: 'rgba(245, 158, 11, 0.05)', padding: '1rem', borderRadius: '12px', border: '1px solid rgba(245, 158, 11, 0.15)' }}>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Target Sell Price</div>
                            <div style={{ fontSize: '1.4rem', fontWeight: 750, color: 'var(--color-hold)', marginTop: '0.25rem' }}>
                              Rs. {selectedSignal.target_sell_price.toFixed(2)}
                            </div>
                          </div>
                          <div style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '1rem', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Stop Loss</div>
                            <div style={{ fontSize: '1.4rem', fontWeight: 750, color: 'var(--color-sell)', marginTop: '0.25rem' }}>
                              Rs. {selectedSignal.stop_loss.toFixed(2)}
                            </div>
                          </div>
                        </div>
                        {selectedSignal.explanation && (
                          <div style={{ background: 'rgba(59, 130, 246, 0.05)', borderLeft: '4px solid #3b82f6', borderRadius: '0 8px 8px 0', padding: '1rem', marginTop: '1.25rem', lineHeight: '1.5', fontSize: '0.9rem' }}>
                            <strong style={{ color: '#2563eb', display: 'block', marginBottom: '0.25rem' }}>💡 Trading Rationale:</strong>
                            <span style={{ color: 'var(--text-secondary)' }}>{selectedSignal.explanation}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Chart Tabs Options */}
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                      <button
                        onClick={() => setActiveChartTab('candlestick')}
                        style={{
                          flex: 1,
                          padding: '0.75rem',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          background: activeChartTab === 'candlestick' ? '#10b981' : '#ffffff',
                          color: activeChartTab === 'candlestick' ? '#ffffff' : 'var(--text-primary)',
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'var(--font-family)',
                          fontSize: '0.85rem'
                        }}
                      >
                        🕯️ Candlestick Trading Chart
                      </button>
                      <button
                        onClick={() => setActiveChartTab('sparkline')}
                        style={{
                          flex: 1,
                          padding: '0.75rem',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          background: activeChartTab === 'sparkline' ? '#10b981' : '#ffffff',
                          color: activeChartTab === 'sparkline' ? '#ffffff' : 'var(--text-primary)',
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'var(--font-family)',
                          fontSize: '0.85rem'
                        }}
                      >
                        📈 Area Sparkline Chart
                      </button>
                    </div>

                    {/* SVG Chart Render */}
                    {activeChartTab === 'candlestick' ? (
                      <CandlestickChart chartData={chartData} loadingChart={loadingChart} />
                    ) : (
                      <SparklineChart chartData={chartData} loading={loadingChart} />
                    )}

                    {/* AskAnalyst Company Profile details */}
                    <CompanyDetails analystCompany={analystCompany} />

                    {/* Technical Indicators Summary */}
                    <h4 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '2rem 0 1rem' }}>Technical Indicators Evaluation</h4>
                    <div className="indicators-grid">
                      {/* RSI card */}
                      <div className="indicator-card">
                        <div className="indicator-card-title">
                          <span>RSI (14)</span>
                          <span className={`signal-pill ${selectedAnalysis.rsi < 30 ? 'buy' : selectedAnalysis.rsi > 70 ? 'sell' : 'hold'}`}>
                            {selectedAnalysis.rsi < 30 ? 'Oversold' : selectedAnalysis.rsi > 70 ? 'Overbought' : 'Neutral'}
                          </span>
                        </div>
                        <div className="indicator-value">
                          {selectedAnalysis.rsi ? selectedAnalysis.rsi.toFixed(2) : 'N/A'}
                        </div>
                        <div className="rsi-track-bar">
                          <div
                            className="rsi-pin"
                            style={{ left: `${Math.min(Math.max(selectedAnalysis.rsi || 50, 0), 100)}%` }}
                          ></div>
                        </div>
                        <div className="rsi-labels">
                          <span>0</span>
                          <span>50</span>
                          <span>100</span>
                        </div>
                      </div>

                      {/* Moving Average cross */}
                      <div className="indicator-card">
                        <div className="indicator-card-title">Moving Averages (SMA)</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: '#94a3b8' }}>SMA 20:</span>
                            <span style={{ fontWeight: 600 }}>Rs. {selectedAnalysis.sma_20 ? selectedAnalysis.sma_20.toFixed(2) : 'N/A'}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: '#94a3b8' }}>SMA 50:</span>
                            <span style={{ fontWeight: 600 }}>Rs. {selectedAnalysis.sma_50 ? selectedAnalysis.sma_50.toFixed(2) : 'N/A'}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(0,0,0,0.05)', paddingTop: '0.5rem', marginTop: '0.2rem', fontSize: '0.85rem' }}>
                            <span style={{ color: '#94a3b8' }}>Trend:</span>
                            <span style={{ fontWeight: 600, color: selectedAnalysis.sma_20 > selectedAnalysis.sma_50 ? 'var(--color-buy)' : 'var(--color-sell)' }}>
                              {selectedAnalysis.sma_20 > selectedAnalysis.sma_50 ? 'Bullish Cross' : 'Bearish Cross'}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* MACD cross */}
                      <div className="indicator-card" style={{ gridColumn: 'span 2' }}>
                        <div className="indicator-card-title">MACD (12, 26, 9)</div>
                        <div className="macd-inner" style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', marginTop: '0.5rem' }}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#3b82f6' }}>
                              {selectedAnalysis.macd ? selectedAnalysis.macd.toFixed(4) : 'N/A'}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>MACD</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#f59e0b' }}>
                              {selectedAnalysis.macd_signal ? selectedAnalysis.macd_signal.toFixed(4) : 'N/A'}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Signal</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1.15rem', fontWeight: 700, color: selectedAnalysis.macd_hist >= 0 ? 'var(--color-buy)' : 'var(--color-sell)' }}>
                              {selectedAnalysis.macd_hist ? selectedAnalysis.macd_hist.toFixed(4) : 'N/A'}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Histogram</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : currentScreen === 'telegram' ? (
            /* TELEGRAM BOT SETTINGS SCREEN */
            <div className="details-panel-wrapper">
              <div className="glass-panel" style={{ padding: '2rem' }}>
                <h3 className="panel-title" style={{ fontSize: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '1.5rem' }}>
                  ✈️ Telegram Bot Alert configuration
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: '1.5' }}>
                  Configure your Telegram Bot credentials to receive instant real-time alerts. Alerts are automatically dispatched when the algorithm identifies a verified <strong>BUY</strong> or <strong>SELL</strong> confluence setup.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '500px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                      Bot Token
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                      value={telegramToken}
                      onChange={(e) => setTelegramToken(e.target.value)}
                      className="form-input"
                      style={{ padding: '0.75rem', borderRadius: '8px' }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                      Chat ID
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. -100123456789 or 987654321"
                      value={telegramChatId}
                      onChange={(e) => setTelegramChatId(e.target.value)}
                      className="form-input"
                      style={{ padding: '0.75rem', borderRadius: '8px' }}
                    />
                  </div>

                  {tgStatus && (
                    <div style={{
                      padding: '0.75rem',
                      borderRadius: '8px',
                      background: tgStatus.includes('success') ? 'rgba(16, 185, 129, 0.05)' : 'rgba(37, 99, 235, 0.05)',
                      border: `1px solid ${tgStatus.includes('success') ? 'rgba(16, 185, 129, 0.15)' : 'rgba(37, 99, 235, 0.15)'}`,
                      color: tgStatus.includes('success') ? 'var(--color-buy)' : 'var(--text-primary)',
                      fontSize: '0.85rem',
                      fontWeight: 500
                    }}>
                      {tgStatus}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
                    <button
                      onClick={() => {
                        if (selectedSignal) {
                          sendTelegramAlertHandler(selectedSignal);
                        } else {
                          setTgStatus('Select a security to send test alert.');
                        }
                      }}
                      className="config-button"
                      style={{ padding: '0.75rem', borderRadius: '8px' }}
                    >
                      🧪 Send Test Alert
                    </button>
                    <button
                      onClick={() => {
                        localStorage.setItem('tg_token', telegramToken);
                        localStorage.setItem('tg_chat_id', telegramChatId);
                        setTgStatus('Configuration saved locally!');
                      }}
                      className="config-button"
                      style={{ padding: '0.75rem', borderRadius: '8px', background: '#10b981' }}
                    >
                      💾 Save Config
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Modern Premium Footer */}
      <footer className="footer">
        <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>📈 PSX-Signal — Pakistan Stock Exchange Technical Analytics</p>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          Data is scraped live from DPS PSX and PSX Technical Analysis. Past performance is not indicative of future results.
        </p>
        <div className="footer-links">
          <a href="https://dps.psx.com.pk" target="_blank" rel="noopener noreferrer" className="footer-link">PSX Data Portal</a>
          <span>•</span>
          <a href="https://psxtechnicalanalysis.com" target="_blank" rel="noopener noreferrer" className="footer-link">Technical Analysis Source</a>
          <span>•</span>
          <a href="#" className="footer-link">Privacy Policy</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
