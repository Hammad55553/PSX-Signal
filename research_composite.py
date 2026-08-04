"""
Build and test a mean-reversion composite before committing it to the engine.

analyze_edge.py established that on PSX the durable effect is reversion:
sharply-sold names outperform over the next 1-2 weeks, stretched names
underperform. This script builds a composite from those factors and checks it
BOTH ways:

  cross-sectional  — z-scored against the other stocks that day. This is the
                     "which of my watchlist should I buy" question, and it is
                     how the effect was measured.
  time-series      — z-scored against the stock's own history. Needed because
                     the live app must be able to score a single ticker on its
                     own, with no universe around it.

A factor that only works cross-sectionally cannot be shipped as a per-ticker
signal, so both must be checked.
"""
import numpy as np
import pandas as pd

from services.indicators import compute_all
from backtest import load_universe, WARMUP
from analyze_edge import derive, spearman

HORIZONS = (5, 10, 20)


def zscore_ts(s: pd.Series, window: int = 120) -> pd.Series:
    """Rolling z-score against the series' own recent history (causal)."""
    m = s.rolling(window, min_periods=40).mean()
    sd = s.rolling(window, min_periods=40).std()
    return (s - m) / sd.replace(0, np.nan)


def build(data):
    frames = []
    for ticker, raw in data.items():
        df = derive(compute_all(raw))
        # Normalise the raw factors by the stock's own volatility so a 4% drop
        # in TRG (ATR 4.3%) is not treated like a 4% drop in MCB (ATR 2.1%).
        df["STRETCH_5"] = df["RET_5"] / df["ATR_PCT"].replace(0, np.nan)
        df["STRETCH_10"] = df["RET_10"] / df["ATR_PCT"].replace(0, np.nan)
        df["MACDH_N"] = df["MACD_Hist"] / df["Close"] * 100
        df["DIST20_N"] = df["DIST_SMA20"] / df["ATR_PCT"].replace(0, np.nan)

        rec = pd.DataFrame(index=df.index)
        rec["ticker"] = ticker
        rec["date"] = df.index
        for c in ["STRETCH_5", "STRETCH_10", "MACDH_N", "DIST20_N", "RSI",
                  "ADX", "RANGE_POS", "VOL_RATIO", "ATR_PCT", "Close"]:
            rec[c] = df[c]
        # Time-series z-scores
        for c in ["STRETCH_5", "MACDH_N", "DIST20_N", "RSI"]:
            rec[f"tz_{c}"] = zscore_ts(df[c])
        for h in HORIZONS:
            rec[f"fwd{h}"] = (df["Close"].shift(-h) / df["Close"] - 1) * 100
        frames.append(rec.iloc[WARMUP:])
    return pd.concat(frames, ignore_index=True)


def add_cross_sectional(p: pd.DataFrame) -> pd.DataFrame:
    for h in HORIZONS:
        p[f"ex{h}"] = p[f"fwd{h}"] - p.groupby("date")[f"fwd{h}"].transform("mean")
    for c in ["STRETCH_5", "MACDH_N", "DIST20_N", "RSI"]:
        g = p.groupby("date")[c]
        p[f"cz_{c}"] = (p[c] - g.transform("mean")) / g.transform("std").replace(0, np.nan)
    return p


def composite(p: pd.DataFrame, prefix: str) -> pd.Series:
    """Reversion composite. Negative stretch -> positive score, hence the signs."""
    return (
        -1.00 * p[f"{prefix}_STRETCH_5"].clip(-3, 3)
        - 0.70 * p[f"{prefix}_MACDH_N"].clip(-3, 3)
        - 0.40 * p[f"{prefix}_DIST20_N"].clip(-3, 3)
        - 0.30 * p[f"{prefix}_RSI"].clip(-3, 3)
    )


def report(p, col, target, label):
    sub = p[[col, target]].dropna()
    if len(sub) < 500:
        print(f"  {label}: insufficient data")
        return
    rho = spearman(sub[col], sub[target])
    sub = sub.copy()
    sub["d"] = pd.qcut(sub[col], 10, labels=False, duplicates="drop")
    g = sub.groupby("d")[target].agg(["size", "mean"])
    print(f"\n  {label}  (rho={rho:+.4f}, n={len(sub)})")
    for d, row in g.iterrows():
        bar = "#" * int(abs(row["mean"]) * 8)
        print(f"    d{int(d)}  n={int(row['size']):>6}  {target}={row['mean']:>+6.2f}%  {bar}")
    spread = g["mean"].iloc[-1] - g["mean"].iloc[0]
    print(f"    top-bottom spread: {spread:+.2f}%")


def main():
    data = load_universe()
    print(f"Building composite panel over {len(data)} tickers ...")
    p = add_cross_sectional(build(data))
    p = p.dropna(subset=["ex10"])
    print(f"{len(p)} rows\n")

    p["comp_cz"] = composite(p, "cz")
    p["comp_tz"] = composite(p, "tz")

    print("=== CROSS-SECTIONAL composite vs 10-day EXCESS return ===")
    report(p, "comp_cz", "ex10", "cross-sectional z composite")

    print("\n=== TIME-SERIES composite vs 10-day EXCESS return ===")
    report(p, "comp_tz", "ex10", "time-series z composite")

    print("\n=== TIME-SERIES composite vs 10-day RAW return ===")
    report(p, "comp_tz", "fwd10", "time-series z composite (raw)")

    print("\n=== Horizon sensitivity (time-series composite, excess) ===")
    for h in HORIZONS:
        rho = spearman(p["comp_tz"], p[f"ex{h}"])
        top = p[p["comp_tz"] >= p["comp_tz"].quantile(0.9)][f"ex{h}"].mean()
        bot = p[p["comp_tz"] <= p["comp_tz"].quantile(0.1)][f"ex{h}"].mean()
        print(f"  {h:>2}d: rho={rho:+.4f}  top10%={top:+.2f}%  bottom10%={bot:+.2f}%  "
              f"spread={top - bot:+.2f}%")

    print("\n=== Does an ADX filter improve the top decile? ===")
    top = p[p["comp_tz"] >= p["comp_tz"].quantile(0.9)]
    for lo, hi in [(0, 100), (0, 20), (20, 30), (30, 45), (45, 100), (25, 45)]:
        sub = top[(top["ADX"] >= lo) & (top["ADX"] < hi)]
        if len(sub) > 200:
            print(f"  ADX [{lo:>3},{hi:>3}): n={len(sub):>6}  ex10={sub['ex10'].mean():+.2f}%")

    print("\n=== Volatility filter on the top decile ===")
    for lo, hi in [(0, 2), (2, 3), (3, 4), (4, 100)]:
        sub = top[(top["ATR_PCT"] >= lo) & (top["ATR_PCT"] < hi)]
        if len(sub) > 200:
            print(f"  ATR% [{lo},{hi}): n={len(sub):>6}  ex10={sub['ex10'].mean():+.2f}%")


if __name__ == "__main__":
    main()
