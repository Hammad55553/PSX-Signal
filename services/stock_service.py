"""
Data layer for PSX securities.

Source priority:
  1. yfinance  — deep history (years). Primary, because indicators like SMA-200
                 and any backtest need far more than 3 months of bars.
  2. EK Global  — fallback, but it only serves ~58 daily bars.
  3. PSX portal — live intraday quote only, used to refresh the last bar.

Hard rule: if we cannot get real bars, we return an error. The previous version
manufactured a flat synthetic series from the live price, which produced
confident-looking indicators (RSI 0, SMA == price) and therefore fake signals.
"""
import time
import re
from typing import Dict, Any, Tuple, Optional

import pandas as pd
import requests
import yfinance as yf
from bs4 import BeautifulSoup

from services.indicators import compute_all

_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36')
_HEADERS = {'User-Agent': _UA}

# Minimum bars required before we are willing to emit a signal at all.
# 50 is the floor for SMA-50 and a settled ADX; below that it is noise.
MIN_BARS = 50
# Below this, indicators work but have little context — confidence is capped.
THIN_HISTORY_BARS = 120

_OHLCV = ["Open", "High", "Low", "Close", "Volume"]


def normalize(ticker: str) -> str:
    """Uppercase and ensure the .KA (Karachi) suffix."""
    t = ticker.upper().strip()
    return t if t.endswith(".KA") else f"{t}.KA"


def bare(ticker: str) -> str:
    """Symbol without the .KA suffix, as PSX/EK expect it."""
    return ticker.upper().strip().replace(".KA", "")


def scrape_live_price(symbol: str) -> Dict[str, Any]:
    """Live quote from the official PSX data portal."""
    url = f"https://dps.psx.com.pk/company/{bare(symbol)}"
    try:
        res = requests.get(url, headers=_HEADERS, timeout=6)
        if res.status_code != 200:
            return {}
        soup = BeautifulSoup(res.content, 'html.parser')

        title_str = soup.title.string if soup.title else ""
        name_match = re.search(r"Stock quote for\s+(.*?)\s+-", title_str or "")
        company_name = name_match.group(1).strip() if name_match else f"{bare(symbol)} Limited"

        price_div = soup.find(class_=re.compile("quote__close|price|close"))
        if price_div:
            text = re.sub(r'\s+', ' ', price_div.get_text().replace('Rs.', '').strip())
            match = re.search(r'([\d\.,]+)\s+([-\+\d\.,]+)\s+\(?([-\+\d\.,]+)%?\)?', text)
            if match:
                return {
                    "price": float(match.group(1).replace(',', '')),
                    "change": float(match.group(2).replace(',', '')),
                    "change_percent": float(match.group(3).replace(',', '')),
                    "name": company_name,
                }
    except Exception as e:
        print(f"[psx-scrape] {symbol}: {e}")
    return {}


def fetch_ek_history(symbol: str, days: int = 90) -> pd.DataFrame:
    """Daily OHLCV from EK Global Capital's TradingView feed.

    The feed is inconsistent: asking for a wider window can return FEWER bars
    (200d returns ~5 rows, 90d returns ~57). Callers should use
    fetch_ek_history_best() rather than trusting a single window.
    """
    to_time = int(time.time())
    from_time = to_time - (days * 86400)
    url = (f"https://api.ekglobalcapital.com/tvfeed/history?symbol={bare(symbol)}"
           f"&resolution=D&from={from_time}&to={to_time}")
    try:
        res = requests.get(url, headers=_HEADERS, timeout=6)
        if res.status_code == 200:
            data = res.json()
            if data.get('s') == 'ok' and data.get('t'):
                return pd.DataFrame({
                    'Open': data['o'], 'High': data['h'], 'Low': data['l'],
                    'Close': data['c'], 'Volume': data['v'],
                }, index=pd.to_datetime(data['t'], unit='s'))
    except Exception as e:
        print(f"[ek-history] {symbol}: {e}")
    return pd.DataFrame()


def fetch_ek_history_best(symbol: str) -> pd.DataFrame:
    """Probe several EK windows and keep whichever returns the most bars."""
    best = pd.DataFrame()
    for days in (90, 60, 120):
        df = fetch_ek_history(symbol, days)
        if len(df) > len(best):
            best = df
        if len(best) >= 55:  # as good as this feed gets
            break
    return best


def fetch_yf_history(symbol: str, period: str = "2y") -> pd.DataFrame:
    """Daily OHLCV from Yahoo Finance."""
    try:
        df = yf.Ticker(normalize(symbol)).history(period=period)
        if not df.empty:
            df = df[_OHLCV].copy()
            df.index = pd.to_datetime(df.index).tz_localize(None)
            return df
    except Exception as e:
        print(f"[yf-history] {symbol}: {e}")
    return pd.DataFrame()


def get_history(ticker: str, period: str = "2y") -> Tuple[pd.DataFrame, str]:
    """Best available daily history. Returns (df, source_name)."""
    df = fetch_yf_history(ticker, period)
    if len(df) >= MIN_BARS:
        return df, "yahoo"

    ek = fetch_ek_history_best(ticker)
    # Keep whichever source gave us more usable bars
    if len(ek) > len(df):
        return ek, "ekglobal"
    return df, ("yahoo" if not df.empty else "none")


def get_enriched(ticker: str, period: str = "2y") -> Dict[str, Any]:
    """Full history + all indicators + live quote, or an explicit error.

    This is the single entry point for both live signalling and backtesting.
    """
    sym = normalize(ticker)
    try:
        df, source = get_history(sym, period)

        if df.empty:
            return {"error": f"No market data for '{bare(sym)}'. Symbol may be "
                             f"delisted or renamed (e.g. ENGRO is now ENGROH)."}

        df = df[~df.index.duplicated(keep="last")].sort_index()
        df = df[df["Close"] > 0]

        if len(df) < MIN_BARS:
            return {"error": f"Only {len(df)} bars available for '{bare(sym)}'; "
                             f"{MIN_BARS} needed for a reliable signal."}

        live = scrape_live_price(sym)
        last_bar_date = df.index[-1]

        # Refresh the most recent bar with the live PSX quote, but only if the
        # quote is plausible (within 20% of last close). A bad scrape must not
        # silently corrupt the series.
        live_applied = False
        if live and live.get("price"):
            lp = live["price"]
            if abs(lp - df["Close"].iloc[-1]) / df["Close"].iloc[-1] < 0.20:
                df.loc[df.index[-1], "Close"] = lp
                df.loc[df.index[-1], "High"] = max(df["High"].iloc[-1], lp)
                df.loc[df.index[-1], "Low"] = min(df["Low"].iloc[-1], lp)
                live_applied = True

        enriched = compute_all(df)
        staleness = (pd.Timestamp.now().normalize() - last_bar_date.normalize()).days

        return {
            "df": enriched,
            "meta": {
                "ticker": sym,
                "symbol": bare(sym),
                "name": live.get("name", f"{bare(sym)} Limited"),
                "source": source,
                "bars": len(df),
                "last_bar": last_bar_date.strftime("%Y-%m-%d"),
                "stale_days": int(staleness),
                "thin_history": len(df) < THIN_HISTORY_BARS,
                "live_quote": live_applied,
                "live_change": live.get("change"),
                "live_change_percent": live.get("change_percent"),
            },
        }
    except Exception as e:
        return {"error": f"{bare(ticker)}: {e}"}


def _f(v) -> Optional[float]:
    """Float or None for JSON safety (NaN is not valid JSON)."""
    return None if v is None or pd.isna(v) else float(v)


def get_stock_analysis(ticker: str) -> Dict[str, Any]:
    """Flat indicator snapshot for the /analyze endpoint."""
    enriched = get_enriched(ticker)
    if "error" in enriched:
        return enriched

    df, meta = enriched["df"], enriched["meta"]
    latest = df.iloc[-1]
    prev = df.iloc[-2]

    change = meta.get("live_change")
    change_pct = meta.get("live_change_percent")
    if change is None:
        change = float(latest["Close"] - prev["Close"])
        change_pct = float(change / prev["Close"] * 100) if prev["Close"] else 0.0

    return {
        "ticker": meta["ticker"],
        "name": meta["name"],
        "current_price": _f(latest["Close"]),
        "change": _f(change),
        "change_percent": _f(change_pct),
        "rsi": _f(latest["RSI"]),
        "sma_20": _f(latest["SMA_20"]),
        "sma_50": _f(latest["SMA_50"]),
        "sma_200": _f(latest["SMA_200"]),
        "macd": _f(latest["MACD"]),
        "macd_signal": _f(latest["MACD_Signal"]),
        "macd_hist": _f(latest["MACD_Hist"]),
        "atr": _f(latest["ATR"]),
        "atr_pct": _f(latest["ATR_PCT"]),
        "adx": _f(latest["ADX"]),
        "plus_di": _f(latest["PLUS_DI"]),
        "minus_di": _f(latest["MINUS_DI"]),
        "bb_pct": _f(latest["BB_PCT"]),
        "vol_ratio": _f(latest["VOL_RATIO"]),
        "support": _f(latest["SUPPORT"]),
        "resistance": _f(latest["RESISTANCE"]),
        "high_20": _f(latest["RESISTANCE"]),
        "low_20": _f(latest["SUPPORT"]),
        "volume": int(latest["Volume"]) if not pd.isna(latest["Volume"]) else 0,
        "updated_at": meta["last_bar"],
        "data_source": meta["source"],
        "stale_days": meta["stale_days"],
        "bars": meta["bars"],
    }
