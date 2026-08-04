"""
Vectorized technical indicators.

Every function takes and returns pandas Series/DataFrame over the FULL history,
so the same code path serves both live signals (last bar) and backtesting
(any historical bar). Nothing here looks ahead: each value at index i is
computed only from data at or before i.
"""
import pandas as pd
import numpy as np
from typing import Dict


def wilder_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """RSI using Wilder's smoothing (the original definition).

    The previous implementation used ewm(com=period-1) which is Wilder's
    smoothing, but seeded from the first delta rather than an SMA. Seeding
    with the SMA of the first `period` values matches TradingView/PSX charts.
    """
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)

    # Wilder's smoothing == EMA with alpha = 1/period, seeded by SMA
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    # When there are no losses at all RSI is 100 by definition
    return rsi.fillna(100).where(avg_gain.notna(), np.nan)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Dict[str, pd.Series]:
    """MACD line, signal line and histogram."""
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    line = ema_fast - ema_slow
    sig = line.ewm(span=signal, adjust=False).mean()
    return {"macd": line, "signal": sig, "hist": line - sig}


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    """Average True Range — the volatility unit used for stops and targets.

    A fixed 1% stop is meaningless when one stock moves 0.4%/day and another
    moves 4%/day. ATR normalises risk across the whole universe.
    """
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()


def adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> Dict[str, pd.Series]:
    """ADX with +DI/-DI. Measures trend STRENGTH, not direction.

    This is the piece the old scorer was missing entirely: it treated a
    2%-drift sideways market the same as a clean trend, which is why signals
    flip-flopped on noise.
    """
    up_move = high.diff()
    down_move = -low.diff()

    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=high.index)

    tr = atr(high, low, close, period)
    alpha = 1 / period
    plus_di = 100 * plus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / tr.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / tr.replace(0, np.nan)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return {
        "adx": dx.ewm(alpha=alpha, min_periods=period, adjust=False).mean(),
        "plus_di": plus_di,
        "minus_di": minus_di,
    }


def bollinger(close: pd.Series, period: int = 20, std_mult: float = 2.0) -> Dict[str, pd.Series]:
    """Bollinger Bands plus %B and bandwidth (squeeze detection)."""
    mid = close.rolling(period, min_periods=period).mean()
    sd = close.rolling(period, min_periods=period).std()
    upper = mid + std_mult * sd
    lower = mid - std_mult * sd
    width = (upper - lower) / mid.replace(0, np.nan)
    pct_b = (close - lower) / (upper - lower).replace(0, np.nan)
    return {"upper": upper, "mid": mid, "lower": lower, "width": width, "pct_b": pct_b}


def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    """On-Balance Volume — cumulative volume signed by price direction."""
    direction = np.sign(close.diff()).fillna(0)
    return (direction * volume).cumsum()


def volume_ratio(volume: pd.Series, period: int = 20) -> pd.Series:
    """Today's volume vs its own 20-day average. >1.5 means real participation."""
    avg = volume.rolling(period, min_periods=5).mean()
    return volume / avg.replace(0, np.nan)


def swing_levels(high: pd.Series, low: pd.Series, lookback: int = 20) -> Dict[str, pd.Series]:
    """Rolling support/resistance from the prior `lookback` bars.

    Shifted by 1 so the current bar's own high/low cannot define the level it
    is being tested against — that self-reference made every breakout bar look
    like it was 'at resistance'.
    """
    return {
        "resistance": high.shift(1).rolling(lookback, min_periods=5).max(),
        "support": low.shift(1).rolling(lookback, min_periods=5).min(),
    }


def slope_pct(series: pd.Series, period: int = 5) -> pd.Series:
    """Percent change of a series over `period` bars — used for SMA slope."""
    return (series - series.shift(period)) / series.shift(period).replace(0, np.nan) * 100


def crossover(a: pd.Series, b: pd.Series) -> pd.Series:
    """True on the bar where a crosses ABOVE b (event, not state)."""
    return (a > b) & (a.shift(1) <= b.shift(1))


def crossunder(a: pd.Series, b: pd.Series) -> pd.Series:
    """True on the bar where a crosses BELOW b (event, not state)."""
    return (a < b) & (a.shift(1) >= b.shift(1))


def bars_since(condition: pd.Series) -> pd.Series:
    """How many bars since `condition` was last True. Used to detect *fresh*
    crossovers — a golden cross from 40 bars ago is not news."""
    idx = np.arange(len(condition))
    last = pd.Series(np.where(condition.values, idx, np.nan), index=condition.index).ffill()
    return pd.Series(idx, index=condition.index) - last


def zscore_ts(s: pd.Series, window: int = 120, min_periods: int = 40) -> pd.Series:
    """Causal z-score against the series' own trailing window.

    Time-series (not cross-sectional) so a single ticker can be scored on its
    own — the live app must work without the rest of the universe loaded.
    """
    mean = s.rolling(window, min_periods=min_periods).mean()
    sd = s.rolling(window, min_periods=min_periods).std()
    return (s - mean) / sd.replace(0, np.nan)


def reversion_factors(df: pd.DataFrame) -> Dict[str, pd.Series]:
    """The factors that actually carry predictive information on PSX.

    Established empirically (see analyze_edge.py / validate_oos.py): daily
    trend-following indicators have |rho| < 0.03 against forward excess
    returns, but sharp volatility-adjusted declines mean-revert over 5-20 days.

    Each raw factor is divided by the stock's own ATR% so a 4% drop in a
    4%-ATR name is not equated with a 4% drop in a 2%-ATR name.
    """
    close = df["Close"]
    atr_pct = df["ATR_PCT"].replace(0, np.nan)

    ret_5 = (close / close.shift(5) - 1) * 100
    stretch_5 = ret_5 / atr_pct
    macdh_n = df["MACD_Hist"] / close * 100
    dist20_n = ((close / df["SMA_20"] - 1) * 100) / atr_pct

    return {
        "RET_5": ret_5,
        "STRETCH_5": stretch_5,
        "MACDH_N": macdh_n,
        "DIST20_N": dist20_n,
        "Z_STRETCH_5": zscore_ts(stretch_5),
        "Z_MACDH": zscore_ts(macdh_n),
        "Z_DIST20": zscore_ts(dist20_n),
        "Z_RSI": zscore_ts(df["RSI"]),
    }


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """Attach every indicator to an OHLCV frame. Returns a new frame."""
    out = df.copy()
    close, high, low, vol = out["Close"], out["High"], out["Low"], out["Volume"]

    out["RSI"] = wilder_rsi(close)
    out["SMA_20"] = close.rolling(20, min_periods=20).mean()
    out["SMA_50"] = close.rolling(50, min_periods=50).mean()
    out["SMA_200"] = close.rolling(200, min_periods=200).mean()
    out["EMA_9"] = close.ewm(span=9, adjust=False).mean()
    out["EMA_21"] = close.ewm(span=21, adjust=False).mean()

    m = macd(close)
    out["MACD"] = m["macd"]
    out["MACD_Signal"] = m["signal"]
    out["MACD_Hist"] = m["hist"]

    out["ATR"] = atr(high, low, close)
    out["ATR_PCT"] = out["ATR"] / close * 100

    a = adx(high, low, close)
    out["ADX"] = a["adx"]
    out["PLUS_DI"] = a["plus_di"]
    out["MINUS_DI"] = a["minus_di"]

    bb = bollinger(close)
    out["BB_UPPER"] = bb["upper"]
    out["BB_LOWER"] = bb["lower"]
    out["BB_PCT"] = bb["pct_b"]
    out["BB_WIDTH"] = bb["width"]

    out["OBV"] = obv(close, vol)
    out["OBV_SLOPE"] = slope_pct(out["OBV"].abs().replace(0, np.nan), 10)
    out["VOL_RATIO"] = volume_ratio(vol)

    sl = swing_levels(high, low)
    out["RESISTANCE"] = sl["resistance"]
    out["SUPPORT"] = sl["support"]

    out["SMA20_SLOPE"] = slope_pct(out["SMA_20"], 5)

    # Crossover events
    out["GOLDEN_CROSS"] = crossover(out["SMA_20"], out["SMA_50"])
    out["DEATH_CROSS"] = crossunder(out["SMA_20"], out["SMA_50"])
    out["MACD_BULL_CROSS"] = crossover(out["MACD"], out["MACD_Signal"])
    out["MACD_BEAR_CROSS"] = crossunder(out["MACD"], out["MACD_Signal"])

    out["BARS_SINCE_GC"] = bars_since(out["GOLDEN_CROSS"])
    out["BARS_SINCE_DC"] = bars_since(out["DEATH_CROSS"])
    out["BARS_SINCE_MACD_BULL"] = bars_since(out["MACD_BULL_CROSS"])
    out["BARS_SINCE_MACD_BEAR"] = bars_since(out["MACD_BEAR_CROSS"])

    # Mean-reversion factors — the validated core of the signal
    for name, series in reversion_factors(out).items():
        out[name] = series

    return out
