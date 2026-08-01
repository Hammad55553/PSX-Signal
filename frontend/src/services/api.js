const API_BASE = import.meta.env.VITE_API_BASE || (
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8000'
    : window.location.origin
);

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

  getWebSocketUrl: () => {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocal) {
      return 'ws://127.0.0.1:8000/ws/signals';
    } else {
      // Secure WebSocket in production
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${window.location.host}/ws/signals`;
    }
  }
};
