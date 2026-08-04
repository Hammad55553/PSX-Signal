/**
 * The user's watchlist, persisted in localStorage.
 *
 * Previously the tracked list came straight from the server's DEFAULT_TICKERS
 * and a searched symbol was pushed into React state only — it vanished on
 * reload, and there was no way to remove anything. The list a person actually
 * watches is theirs, so it lives on their device and survives refreshes.
 *
 * Shape: { symbols: string[], starred: string[], removed: string[] }
 * `removed` records defaults the user deleted, so a server default they threw
 * away does not silently come back on the next load.
 */

const KEY = 'psx_watchlist_v1';

const norm = (t) => {
  const s = String(t || '').trim().toUpperCase();
  if (!s) return '';
  return s.endsWith('.KA') ? s : `${s}.KA`;
};

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      symbols: Array.isArray(raw.symbols) ? raw.symbols : [],
      starred: Array.isArray(raw.starred) ? raw.starred : [],
      removed: Array.isArray(raw.removed) ? raw.removed : [],
    };
  } catch {
    return { symbols: [], starred: [], removed: [] };
  }
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the list just won't persist */
  }
  return state;
}

export const watchlist = {
  norm,

  /** Server defaults minus what the user deleted, plus what they added. */
  merge(defaults) {
    const { symbols, removed } = read();
    const kept = (defaults || []).map(norm).filter((t) => !removed.includes(t));
    return [...new Set([...kept, ...symbols])];
  },

  add(ticker) {
    const t = norm(ticker);
    if (!t) return read();
    const s = read();
    if (!s.symbols.includes(t)) s.symbols.push(t);
    // Adding something back clears any earlier deletion of it.
    s.removed = s.removed.filter((x) => x !== t);
    return write(s);
  },

  remove(ticker) {
    const t = norm(ticker);
    const s = read();
    s.symbols = s.symbols.filter((x) => x !== t);
    s.starred = s.starred.filter((x) => x !== t);
    if (!s.removed.includes(t)) s.removed.push(t);
    return write(s);
  },

  toggleStar(ticker) {
    const t = norm(ticker);
    const s = read();
    s.starred = s.starred.includes(t)
      ? s.starred.filter((x) => x !== t)
      : [...s.starred, t];
    return write(s);
  },

  starred() {
    return read().starred;
  },

  isStarred(ticker) {
    return read().starred.includes(norm(ticker));
  },

  /** Forget every customisation and fall back to the server defaults. */
  reset() {
    return write({ symbols: [], starred: [], removed: [] });
  },
};
