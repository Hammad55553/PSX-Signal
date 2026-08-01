import React, { useState, useEffect } from 'react';
import './App.css';
import { api } from './services/api';
import { CandlestickChart } from './components/CandlestickChart';
import { CompanyDetails } from './components/CompanyDetails';
import { SpeedometerGauge } from './components/SpeedometerGauge';
import { SparklineChart } from './components/SparklineChart';

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
        const tickersList = await api.fetchTickers();
        setTickers([...new Set(tickersList)]);

        if (tickersList.length > 0) {
          setSelectedTicker(tickersList[0]);
        }
      } catch (err) {
        console.error("Error loading tickers:", err);
        setError("Failed to connect to FastAPI backend server. Ensure it is running.");
      } finally {
        setLoadingList(false);
      }
    }
    loadTickers();

    // Setup WebSocket connection to receive real-time streams with auto-reconnection
    let ws;
    let reconnectTimeout;

    function connectWebSocket() {
      setError(null);
      ws = new WebSocket(api.getWebSocketUrl());

      ws.onopen = () => {
        console.log("WebSocket connected successfully");
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const signalMap = {};
          const newAlerts = [];

          data.results.forEach((sig) => {
            signalMap[sig.ticker] = sig;
          });

          setAllSignals((prevSignals) => {
            data.results.forEach((sig) => {
              const prevSig = prevSignals[sig.ticker];
              if (prevSig && prevSig.signal !== sig.signal && (sig.signal === "BUY" || sig.signal === "SELL")) {
                const newAlert = {
                  time: new Date().toLocaleTimeString(),
                  ticker: sig.ticker.replace('.KA', ''),
                  signal: sig.signal,
                  price: sig.current_price,
                  target_buy: sig.target_buy_price,
                  target_sell: sig.target_sell_price,
                  stop_loss: sig.stop_loss
                };
                newAlerts.push(newAlert);
                triggerToast(newAlert);
              }
            });
            return { ...prevSignals, ...signalMap };
          });

          if (newAlerts.length > 0) {
            setAlerts((prevAlerts) => [...newAlerts, ...prevAlerts]);
          }
        } catch (err) {
          console.error("Error parsing WebSocket packet:", err);
        }
      };

      ws.onclose = () => {
        console.log("WebSocket disconnected. Retrying in 3 seconds...");
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
        const data = await api.fetchTickers(); // Fallback endpoints trigger
        // Re-route to signals list fetcher
        const res = await fetch(api.getWebSocketUrl().replace('ws://', 'http://').replace('wss://', 'https://').replace('/ws/signals', '/signals'));
        if (!res.ok) return;
        const sigs = await res.json();
        if (sigs.results) {
          const signalMap = {};
          const newAlerts = [];

          sigs.results.forEach((sig) => {
            signalMap[sig.ticker] = sig;
          });

          setAllSignals((prevSignals) => {
            sigs.results.forEach((sig) => {
              const prevSig = prevSignals[sig.ticker];
              if (prevSig && prevSig.signal !== sig.signal && (sig.signal === "BUY" || sig.signal === "SELL")) {
                const newAlert = {
                  time: new Date().toLocaleTimeString(),
                  ticker: sig.ticker.replace('.KA', ''),
                  signal: sig.signal,
                  price: sig.current_price,
                  target_buy: sig.target_buy_price,
                  target_sell: sig.target_sell_price,
                  stop_loss: sig.stop_loss
                };
                newAlerts.push(newAlert);
                triggerToast(newAlert);
              }
            });
            return { ...prevSignals, ...signalMap };
          });

          if (newAlerts.length > 0) {
            setAlerts((prevAlerts) => [...newAlerts, ...prevAlerts]);
          }
        }
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

  // 2. Automatically sync detail view with the live WebSocket signals map
  useEffect(() => {
    if (!selectedTicker || !allSignals[selectedTicker]) return;
    const liveData = allSignals[selectedTicker];
    setSelectedAnalysis(liveData);
    setSelectedSignal(liveData);
  }, [selectedTicker, allSignals]);

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

      if (!tickers.includes(tickerToSearch)) {
        setTickers(prev => [...new Set([...prev, tickerToSearch])]);
      }

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

      if (!tickers.includes(tickerToSearch)) {
        setTickers(prev => [...new Set([...prev, tickerToSearch])]);
      }

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
      setSearchError(err.message || "Ticker not found or invalid in PSX. Please try again.");
    } finally {
      setLoadingDetails(false);
    }
  };

  const selectRecommendationSymbol = (symbol) => {
    selectSuggestion({ symbol, name: symbol });
  };

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
          <div key={toast.id} className={`notification-toast ${toast.signal.toLowerCase()}`}>
            <div className="toast-title">
              <span>🚨 Live trading alert!</span>
              <button className="toast-close" onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>×</button>
            </div>
            <p>
              <strong>{toast.ticker}</strong>: {toast.signal} signal triggered at{' '}
              <strong>Rs. {toast.price.toFixed(2)}</strong>.
            </p>
            <div className="toast-targets">
              <span>Buy: Rs. {toast.target_buy.toFixed(2)}</span>
              <span>Sell: Rs. {toast.target_sell.toFixed(2)}</span>
              <span>SL: Rs. {toast.stop_loss.toFixed(2)}</span>
            </div>
          </div>
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
          {selectedTicker && (
            <button
              onClick={() => setCurrentScreen('details')}
              className={`header-nav-btn ${currentScreen === 'details' ? 'active' : ''}`}
            >
              📊 {selectedTicker.replace('.KA', '')} Analytics
            </button>
          )}
          <div className="market-badge">🟢 Live</div>
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

                {loadingList ? (
                  <div className="loader">
                    <div className="spinner"></div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem' }}>
                    {tickers.map((ticker) => {
                      const summary = allSignals[ticker];
                      const cleanName = ticker.replace('.KA', '');
                      return (
                        <div
                          key={ticker}
                          className={`ticker-item premium-hover-card ${selectedTicker === ticker ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedTicker(ticker);
                            setCurrentScreen('details'); // Navigate to details on click
                          }}
                          style={{ padding: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                        >
                          <div>
                            <span className="ticker-name" style={{ fontSize: '1.2rem' }}>{cleanName}</span>
                            <div className="ticker-fullname">{summary ? summary.name : 'Karachi Stock Exchange'}</div>
                          </div>
                          <div className="ticker-price" style={{ textAlign: 'right' }}>
                            {summary ? (
                              <>
                                <div className="price-value" style={{ fontSize: '1.1rem', fontWeight: 700 }}>Rs. {summary.current_price.toFixed(2)}</div>
                                <span className={`signal-pill ${summary.signal.toLowerCase()}`} style={{ display: 'inline-block', marginTop: '0.25rem' }}>
                                  {summary.signal}
                                </span>
                              </>
                            ) : (
                              <div className="price-value">Loading...</div>
                            )}
                          </div>
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
                        buyScore={selectedSignal.buy_score}
                        sellScore={selectedSignal.sell_score}
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
                      <CandlestickChart chartData={chartData} loadingChart={loadingChart} maxVal={chartMax} minVal={chartMin} />
                    ) : (
                      (() => {
                        if (chartData.length === 0) return <SparklineChart chartData={[]} />;
                        const prices = chartData.map(d => d.close);
                        const maxPrice = Math.max(...prices);
                        const minPrice = Math.min(...prices);
                        const priceDiff = maxPrice - minPrice || 1;
                        const width = 500;
                        const height = 150;
                        const padding = 10;
                        const coordinates = chartData.slice(-40).map((p, idx) => {
                          const x = padding + (idx / 39) * (width - padding * 2);
                          const y = padding + (1 - (p.close - minPrice) / priceDiff) * (height - padding * 2);
                          return { x, y };
                        });
                        const linePointsStr = coordinates.map(c => `${c.x},${c.y}`).join(' ');
                        const areaPathStr = `M ${coordinates[0].x} ${height} ` +
                          coordinates.map(c => `L ${c.x} ${c.y}`).join(' ') +
                          ` L ${coordinates[coordinates.length - 1].x} ${height} Z`;
                        const isUp = prices[prices.length - 1] >= prices[0];
                        return (
                          <SparklineChart
                            chartData={chartData}
                            maxPrice={maxPrice}
                            minPrice={minPrice}
                            chartColor={isUp ? 'var(--color-buy)' : 'var(--color-sell)'}
                            chartGradientId={isUp ? 'greenGrad' : 'redGrad'}
                            areaPathStr={areaPathStr}
                            linePointsStr={linePointsStr}
                            width={width}
                            height={height}
                          />
                        );
                      })()
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
