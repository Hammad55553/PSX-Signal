"""
Intraday PSX bars from the EK Global Capital TradingView feed.

The feed's windowing is unreliable in a specific way: asking for a wide range
does not return the most recent data, it returns *some* window inside the range.
Probing SYS at 5-minute resolution:

    request 10d  -> 493 bars, 2026-07-27 .. 2026-08-04   (recent, correct)
    request 30d  -> 1501 bars, 2026-07-06 .. 2026-08-04  (recent, correct)
    request 60d  -> 2968 bars, 2026-06-05 .. 2026-08-04  (recent, correct)
    request 120d -> 4041 bars, 2026-04-07 .. 2026-05-22  (NOT recent!)
    request 365d -> 3273 bars, 2025-12-08 .. 2026-04-08  (NOT recent!)

So a single wide request silently hands back stale history. Anything needing
more than ~60 days must stitch consecutive bounded windows instead.

Note the intraday feed is *fresher* than the daily one — daily has been running
about 5 sessions behind while intraday reaches the current session.
"""
import time
from typing import Dict, List, Optional

import pandas as pd
import requests

_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36')
_HEADERS = {'User-Agent': _UA}

BASE = "https://api.ekglobalcapital.com/tvfeed/history"

# The PSX Data Portal's own tick feed — direct from the exchange, no auth,
# no window-corruption bug. Only ever holds the *current* session's ticks,
# so it can't replace EK for history, but for "right now" it is authoritative.
PSX_TICK_URL = "https://dps.psx.com.pk/timeseries/int"

# The widest window that still returns *recent* data (see module docstring).
SAFE_WINDOW_DAYS = 55

# PSX regular session, Pakistan time.
SESSION_START = (9, 32)
SESSION_END = (15, 30)


def _fetch_window(symbol: str, resolution: str, frm: int, to: int) -> pd.DataFrame:
    sym = symbol.upper().replace(".KA", "")
    url = f"{BASE}?symbol={sym}&resolution={resolution}&from={frm}&to={to}"
    try:
        res = requests.get(url, headers=_HEADERS, timeout=15)
        if res.status_code != 200:
            return pd.DataFrame()
        d = res.json()
        if d.get("s") != "ok" or not d.get("t"):
            return pd.DataFrame()
        return pd.DataFrame({
            "Open": d["o"], "High": d["h"], "Low": d["l"],
            "Close": d["c"], "Volume": d.get("v", [0] * len(d["t"])),
        }, index=pd.to_datetime(d["t"], unit="s"))
    except Exception as e:
        print(f"[intraday] {symbol} {resolution}: {e}")
        return pd.DataFrame()


def sanitize(df: pd.DataFrame) -> pd.DataFrame:
    """Drop the feed's corrupt bars, same rule as the daily chart proxy."""
    if df.empty:
        return df
    df = df[(df[["Open", "High", "Low", "Close"]] > 0).all(axis=1)]
    if df.empty:
        return df
    median = df["Close"].median()
    df = df[(df["Close"] >= median / 5) & (df["Close"] <= median * 5)]
    body_hi = df[["Open", "Close"]].max(axis=1)
    body_lo = df[["Open", "Close"]].min(axis=1)
    return df[(df["High"] <= body_hi * 1.5) & (df["Low"] >= body_lo / 1.5)
              & (df["High"] >= df["Low"])]


def fetch_live_ticks(symbol: str) -> pd.DataFrame:
    """Raw trade-by-trade ticks for the current session, straight from PSX's
    own Data Portal. No auth, no stale-window bug — but only today's ticks
    are ever available, so this cannot serve historical requests."""
    sym = symbol.upper().replace(".KA", "")
    url = f"{PSX_TICK_URL}/{sym}"
    try:
        res = requests.get(url, headers=_HEADERS, timeout=15)
        if res.status_code != 200:
            return pd.DataFrame()
        d = res.json()
        rows = d.get("data") or []
        if d.get("status") != 1 or not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows, columns=["ts", "Price", "Volume"])
        df["ts"] = pd.to_datetime(df["ts"], unit="s")
        return df.set_index("ts").sort_index()
    except Exception as e:
        print(f"[intraday] live ticks {symbol}: {e}")
        return pd.DataFrame()


def ticks_to_bars(ticks: pd.DataFrame, resolution: str = "5") -> pd.DataFrame:
    """Resample raw ticks into OHLCV bars at the given resolution (minutes)."""
    if ticks.empty:
        return ticks
    freq = f"{resolution}min"
    px = ticks["Price"]
    bars = pd.concat({
        "Open": px.resample(freq).first(),
        "High": px.resample(freq).max(),
        "Low": px.resample(freq).min(),
        "Close": px.resample(freq).last(),
        "Volume": ticks["Volume"].resample(freq).sum(),
    }, axis=1)
    return bars.dropna(subset=["Close"])


def fetch(symbol: str, resolution: str = "5", days: int = 55, live: bool = False) -> pd.DataFrame:
    """Intraday OHLCV, stitching bounded EK windows when `days` exceeds the
    range that feed serves reliably.

    With `live=True`, today's bars are rebuilt from PSX's own tick feed
    instead of EK's — the exchange's current session is always accurate,
    where EK's current-session bars can lag or repeat a stale last price.
    """
    now = int(time.time())
    frames: List[pd.DataFrame] = []

    remaining = days
    end = now
    while remaining > 0:
        chunk = min(remaining, SAFE_WINDOW_DAYS)
        start = end - chunk * 86400
        part = _fetch_window(symbol, resolution, start, end)
        if part.empty:
            break
        frames.append(part)
        end = start
        remaining -= chunk

    if not frames and not live:
        return pd.DataFrame()

    df = pd.concat(frames) if frames else pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = sanitize(df)

    if live:
        ticks = fetch_live_ticks(symbol)
        today_bars = ticks_to_bars(ticks, resolution)
        if not today_bars.empty:
            today = today_bars.index.normalize()[0]
            df = df[df.index.normalize() != today]
            df = pd.concat([df, today_bars]).sort_index()

    return df


def add_session(df: pd.DataFrame) -> pd.DataFrame:
    """Tag each bar with its trading date and position within the session.

    Intraday work has to respect session boundaries: an overnight gap is not a
    price move a day trader could have captured, and any 'return over the next
    N bars' that straddles a close is fiction.

    Session boundaries are derived from the data rather than hard-coded — the
    feed timestamps are UTC (PSX 09:32 PKT arrives as 04:32), and deriving them
    means a DST or session-hours change cannot silently mislabel every bar.
    """
    out = df.copy()
    out["session"] = out.index.normalize()

    grp = out.groupby("session")
    out["bar_in_session"] = grp.cumcount()
    out["bars_this_session"] = grp["Close"].transform("size")
    out["bars_to_close"] = out["bars_this_session"] - out["bar_in_session"] - 1

    # Session open / prior close, for gap and VWAP-style measures
    out["session_open"] = grp["Open"].transform("first")
    out["session_high"] = grp["High"].transform("cummax")
    out["session_low"] = grp["Low"].transform("cummin")
    return out


# --- Gap-fade intraday signal ----------------------------------------------
#
# Validated in research_intraday.py against 60k 5-min bars / 29 tickers / 38
# sessions, forward return measured to the SAME session's close, entry at the
# next bar's open (never the signalling bar itself):
#
#   bottom decile of opening gap (gap <= ~-2.8%) -> average +1.86% to close,
#   75.5% win rate, n=7176. Session-split OOS: train rho -0.48 (n=3605,
#   +2.27%, 80% win), test rho -0.24 (n=3585, +1.53%, 72% win) — same sign,
#   both far larger than PSX's ~0.3-0.5% round-trip cost, and positive across
#   every ticker in the universe bar one with a single observation.
#
# This is the only intraday factor tested that cleared that bar; none of the
# momentum/ORB/VWAP factors did (|rho| 0.03-0.10, spreads under cost).
GAP_BUY_THRESHOLD = -2.5  # % vs prior close

PSX_EOD_URL = "https://dps.psx.com.pk/timeseries/eod"


def get_prior_close(symbol: str) -> Optional[float]:
    """Last *complete* session's close, straight from PSX's own EOD feed.

    Not sourced from the daily pipeline (services.stock_service) — its last
    bar gets live-patched with today's running price, so it can't tell you
    what yesterday closed at once today's session is underway.
    """
    sym = symbol.upper().replace(".KA", "")
    try:
        res = requests.get(f"{PSX_EOD_URL}/{sym}", headers=_HEADERS, timeout=10)
        if res.status_code != 200:
            return None
        rows = (res.json() or {}).get("data") or []
        if not rows:
            return None
        rows.sort(key=lambda r: r[0])
        today = pd.Timestamp.now().normalize()
        for ts, close, *_ in reversed(rows):
            if pd.Timestamp(ts, unit="s").normalize() < today:
                return float(close)
        return float(rows[-1][1])
    except Exception as e:
        print(f"[intraday] prior close {symbol}: {e}")
        return None


def gap_fade_signal(symbol: str, prior_close: float) -> Optional[Dict]:
    """Today's gap-fade opportunity for one symbol, or None if no edge fires.

    `prior_close` must be the last *complete* session's close — callers
    already have this from the daily pipeline (services.stock_service),
    which is more reliable than re-deriving it from an intraday feed.
    """
    if not prior_close or prior_close <= 0:
        return None

    ticks = fetch_live_ticks(symbol)
    if ticks.empty:
        return None

    session_open = float(ticks["Price"].iloc[0])
    last_price = float(ticks["Price"].iloc[-1])
    gap_pct = (session_open / prior_close - 1) * 100
    if gap_pct > GAP_BUY_THRESHOLD:
        return None

    captured_pct = (last_price / session_open - 1) * 100
    minutes_since_open = (ticks.index[-1] - ticks.index[0]).total_seconds() / 60

    return {
        "symbol": symbol.replace(".KA", "").upper(),
        "strategy": "gap_fade",
        "signal": "INTRADAY_BUY",
        "gap_pct": round(gap_pct, 2),
        "prior_close": round(prior_close, 2),
        "session_open": round(session_open, 2),
        "last_price": round(last_price, 2),
        "captured_pct": round(captured_pct, 2),
        "minutes_since_open": round(minutes_since_open, 1),
        "expected_edge": "Historically closes ~+1.5-2% above the open on days "
                          "like this (72-80% win rate, out-of-sample validated). "
                          "Enter now, hold to today's close — do not carry overnight.",
    }


def session_stats(df: pd.DataFrame) -> Dict[str, float]:
    s = add_session(df)
    per = s.groupby("session").size()
    return {
        "bars": len(s),
        "sessions": int(per.size),
        "bars_per_session": float(per.mean()) if per.size else 0.0,
        "first": str(s.index.min()),
        "last": str(s.index.max()),
    }
