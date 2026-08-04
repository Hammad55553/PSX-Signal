/**
 * Where the API lives.
 *
 * Default to the page's own origin. The previous rule was "if the hostname is
 * localhost, the API is on port 8000", which broke every local setup where the
 * backend served the built frontend on any other port — the page loaded fine
 * and then every request went to a port with nothing on it.
 *
 * The only case that genuinely needs a different origin is the Vite dev server,
 * which runs the UI on 5173 while uvicorn runs separately.
 */
const DEV_SERVER_PORTS = ['5173', '4173', '3000'];

const API_BASE =
  import.meta.env.VITE_API_BASE ||
  (DEV_SERVER_PORTS.includes(window.location.port)
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : window.location.origin);

export const api = {
  fetchTickers: async () => {
    const res = await fetch(`${API_BASE}/tickers`);
    if (!res.ok) throw new Error("Failed to load tickers");
    return res.json();
  },
  
  fetchSignal: async (ticker) => {
    const res = await fetch(`${API_BASE}/signal/${ticker}`);
    if (!res.ok) throw new Error("Failed to load signal data");
    return res.json();
  },

  fetchSymbols: async () => {
    const res = await fetch(`${API_BASE}/symbols`);
    if (!res.ok) throw new Error("Failed to load symbols");
    return res.json();
  },

  fetchMarketRecommendations: async () => {
    const res = await fetch(`${API_BASE}/market-recommendations`);
    if (!res.ok) throw new Error("Failed to load recommendations");
    return res.json();
  },

  fetchChartData: async (ticker) => {
    const res = await fetch(`${API_BASE}/chart/${ticker}`);
    if (!res.ok) throw new Error("Failed to load chart data");
    return res.json();
  },

  fetchAnalystInfo: async (ticker) => {
    const res = await fetch(`${API_BASE}/analyst/${ticker}`);
    if (!res.ok) throw new Error("Failed to load company analysis");
    return res.json();
  },

  sendTelegramAlert: async (token, chatId, message) => {
    const res = await fetch(`${API_BASE}/send-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chat_id: chatId, message })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to send Telegram alert");
    }
    return res.json();
  },

  signalsUrl: () => `${API_BASE}/signals`,

  fetchMarketScan: async () => {
    const res = await fetch(`${API_BASE}/market/scan`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load market scan');
    return res.json();
  },

  fetchMarketStatus: async () => {
    const res = await fetch(`${API_BASE}/market/status`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load market status');
    return res.json();
  },

  fetchIntradayScan: async () => {
    const res = await fetch(`${API_BASE}/intraday/scan`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load intraday scan');
    return res.json();
  },

  // Derived from API_BASE so the socket always follows the API, whatever
  // origin that turned out to be.
  getWebSocketUrl: () => {
    const url = new URL(API_BASE, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/signals';
    return url.toString();
  }
};
