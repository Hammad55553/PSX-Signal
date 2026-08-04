"""
Does anything predict INTRADAY returns on PSX?

The daily model in signal_generator.py is validated on daily bars with a 5-10
session hold. None of that carries over automatically: a factor measured on
daily closes says nothing about what a 5-minute bar does next. This asks the
intraday question from scratch, with the same discipline.

Rules that make an intraday test honest:
  * Forward returns never straddle a session boundary. An overnight gap is not
    something a day trader could have captured, and counting it would inflate
    every result.
  * Entry is the NEXT bar's open, never the signalling bar's close.
  * Returns are measured in excess of the same-timestamp cross-sectional mean,
    so a broad market move up does not make every factor look predictive.
  * Train/test split by session, plus a ticker split.

Run:
    python research_intraday.py --collect     # download and cache bars
    python research_intraday.py               # run the study
"""
import argparse
import os
import pickle
from typing import Dict

import numpy as np
import pandas as pd

from services.intraday import fetch, add_session

CACHE = os.environ.get("PSX_INTRADAY_CACHE", "/tmp/psx_intraday_5m.pkl")
RESOLUTION = "5"
DAYS = 55

# Liquid names — an intraday edge that only exists in illiquid stocks is not
# tradeable, so the universe is deliberately restricted to names that trade.
UNIVERSE = [
    "SYS", "OGDC", "HUBC", "LUCK", "MCB", "EFERT", "PSO", "TRG", "PPL",
    "FFC", "UBL", "HBL", "MARI", "POL", "BAHL", "MEBL", "DGKC", "FCCL",
    "NBP", "AKBL", "ATRL", "NRL", "PIOC", "CHCC", "KOHC", "INDU", "HCAR",
    "SEARL", "ENGROH", "PAEL",
]

# Forward horizons in 5-minute bars: 30 min, 1 hour, 2 hours.
HORIZONS = (6, 12, 24)


def collect() -> Dict[str, pd.DataFrame]:
    data = {}
    for i, sym in enumerate(UNIVERSE, 1):
        df = fetch(sym, RESOLUTION, DAYS)
        if len(df) < 500:
            print(f"  [{i:>2}/{len(UNIVERSE)}] {sym}: only {len(df)} bars, skipped")
            continue
        data[sym] = df
        print(f"  [{i:>2}/{len(UNIVERSE)}] {sym}: {len(df)} bars")
    with open(CACHE, "wb") as fh:
        pickle.dump(data, fh)
    print(f"\nCached {len(data)} tickers -> {CACHE}")
    return data


def load() -> Dict[str, pd.DataFrame]:
    if not os.path.exists(CACHE):
        print("No cache; collecting first (this takes a few minutes)...")
        return collect()
    with open(CACHE, "rb") as fh:
        data = pickle.load(fh)
    print(f"Loaded {len(data)} tickers from {CACHE}")
    return data


def spearman(a: pd.Series, b: pd.Series) -> float:
    m = a.notna() & b.notna()
    if m.sum() < 200:
        return np.nan
    return a[m].rank().corr(b[m].rank())


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Causal intraday factors, all computed within the session."""
    s = add_session(df)
    c, h, l, v = s["Close"], s["High"], s["Low"], s["Volume"]
    g = s.groupby("session")

    # Volatility unit: rolling true range, in percent
    prev = c.shift(1)
    tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    s["ATR"] = tr.rolling(24, min_periods=6).mean()
    s["ATR_PCT"] = s["ATR"] / c * 100

    # Short-horizon moves, volatility-normalised
    for n in (3, 6, 12, 24):
        s[f"RET_{n}"] = (c / c.shift(n) - 1) * 100
        s[f"STRETCH_{n}"] = s[f"RET_{n}"] / s["ATR_PCT"].replace(0, np.nan)
        # A move must not be measured across an overnight gap
        s.loc[s["bar_in_session"] < n, [f"RET_{n}", f"STRETCH_{n}"]] = np.nan

    # Session VWAP and deviation from it
    pv = (c * v).groupby(s["session"]).cumsum()
    vv = v.groupby(s["session"]).cumsum().replace(0, np.nan)
    s["VWAP"] = pv / vv
    s["VWAP_DEV"] = (c / s["VWAP"] - 1) * 100
    s["VWAP_DEV_N"] = s["VWAP_DEV"] / s["ATR_PCT"].replace(0, np.nan)

    # Position within the session's range so far
    span = (s["session_high"] - s["session_low"]).replace(0, np.nan)
    s["RANGE_POS"] = (c - s["session_low"]) / span

    # Opening-range breakout: where price sits vs the first 6 bars
    first6_hi = g["High"].transform(lambda x: x.iloc[:6].max())
    first6_lo = g["Low"].transform(lambda x: x.iloc[:6].min())
    s["ORB"] = np.where(c > first6_hi, 1.0, np.where(c < first6_lo, -1.0, 0.0))
    s.loc[s["bar_in_session"] < 6, "ORB"] = np.nan

    # Gap from the prior session's close
    prev_close = g["Close"].transform("last").shift(1)
    s["GAP"] = (s["session_open"] / prev_close - 1) * 100

    # Participation
    s["VOL_RATIO"] = v / v.rolling(24, min_periods=6).mean().replace(0, np.nan)

    # Time of day
    s["TOD"] = s["bar_in_session"] / s["bars_this_session"].replace(0, np.nan)

    # --- Forward returns, entry at NEXT bar's open, same session only ---
    nxt_open = s["Open"].shift(-1)
    for hz in HORIZONS:
        fwd = (c.shift(-1 - hz) / nxt_open - 1) * 100
        # Require the whole holding window to sit inside this session
        fwd = fwd.where(s["bars_to_close"] >= hz + 1)
        s[f"fwd{hz}"] = fwd

    # Hold to the session close
    close_px = g["Close"].transform("last")
    s["fwd_close"] = (close_px / nxt_open - 1) * 100
    s.loc[s["bars_to_close"] < 2, "fwd_close"] = np.nan

    return s


def build_panel(data) -> pd.DataFrame:
    frames = []
    for sym, df in data.items():
        f = build_features(df)
        f["ticker"] = sym
        f["ts"] = f.index
        frames.append(f)
    panel = pd.concat(frames, ignore_index=True)

    # Excess of the same-timestamp cross-section
    for hz in list(HORIZONS) + ["_close"]:
        col = f"fwd{hz}"
        panel[f"ex{hz}"] = panel[col] - panel.groupby("ts")[col].transform("mean")
    return panel


FACTORS = [
    "STRETCH_3", "STRETCH_6", "STRETCH_12", "STRETCH_24",
    "RET_6", "RET_12", "VWAP_DEV_N", "RANGE_POS", "ORB", "GAP",
    "VOL_RATIO", "ATR_PCT", "TOD",
]


def decile_report(panel, col, target):
    sub = panel[[col, target]].dropna()
    if len(sub) < 2000:
        return None
    sub = sub.copy()
    try:
        sub["d"] = pd.qcut(sub[col], 10, labels=False, duplicates="drop")
    except ValueError:
        return None
    return sub.groupby("d").agg(lo=(col, "min"), hi=(col, "max"),
                                n=(target, "size"), mean=(target, "mean"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collect", action="store_true")
    args = ap.parse_args()

    data = collect() if args.collect else load()
    if not data:
        return

    print("\nBuilding intraday factor panel ...")
    panel = build_panel(data)
    panel = panel.dropna(subset=["ex12"])
    print(f"{len(panel)} usable observations, "
          f"{panel['ticker'].nunique()} tickers, "
          f"{panel['session'].nunique()} sessions\n")

    print("=== Factor vs forward EXCESS return (Spearman) ===")
    print(f"{'factor':14}{'30min':>9}{'1hr':>9}{'2hr':>9}{'to close':>10}")
    rows = []
    for f in FACTORS:
        r6 = spearman(panel[f], panel["ex6"])
        r12 = spearman(panel[f], panel["ex12"])
        r24 = spearman(panel[f], panel["ex24"])
        rc = spearman(panel[f], panel["ex_close"])
        rows.append((f, r12))
        print(f"{f:14}{r6:>+9.4f}{r12:>+9.4f}{r24:>+9.4f}{rc:>+10.4f}")

    print("\n=== Deciles for the three strongest (1hr excess) ===")
    for f, r in sorted(rows, key=lambda x: -abs(x[1] if not np.isnan(x[1]) else 0))[:3]:
        tbl = decile_report(panel, f, "ex12")
        if tbl is None:
            continue
        print(f"\n--- {f} (rho={r:+.4f}) ---")
        for d, row in tbl.iterrows():
            bar = "#" * int(min(abs(row["mean"]) * 200, 40))
            print(f"  d{int(d)}  [{row['lo']:>8.2f} .. {row['hi']:>8.2f}]  "
                  f"n={int(row['n']):>6}  ex1h={row['mean']:>+6.3f}%  {bar}")
        spread = tbl["mean"].iloc[-1] - tbl["mean"].iloc[0]
        print(f"  top-bottom spread: {spread:+.3f}%")

    print("\n=== Out-of-sample check: split by session ===")
    sessions = sorted(panel["session"].unique())
    cut = sessions[len(sessions) // 2]
    train = panel[panel["session"] < cut]
    test = panel[panel["session"] >= cut]
    print(f"train {train['session'].nunique()} sessions, "
          f"test {test['session'].nunique()} sessions")
    print(f"{'factor':14}{'train rho':>12}{'test rho':>12}{'same sign':>11}")
    for f in FACTORS:
        a = spearman(train[f], train["ex12"])
        b = spearman(test[f], test["ex12"])
        same = "yes" if (not np.isnan(a) and not np.isnan(b)
                         and np.sign(a) == np.sign(b)) else "NO"
        print(f"{f:14}{a:>+12.4f}{b:>+12.4f}{same:>11}")

    print("\n=== Economic size check: best factor's extreme decile ===")
    best = max(rows, key=lambda x: abs(x[1] if not np.isnan(x[1]) else 0))
    f = best[0]
    sub = panel[[f, "ex12", "fwd12", "ATR_PCT"]].dropna()
    lo_cut, hi_cut = sub[f].quantile(0.1), sub[f].quantile(0.9)
    for label, sel in (("bottom 10%", sub[sub[f] <= lo_cut]),
                       ("top 10%", sub[sub[f] >= hi_cut])):
        print(f"  {f} {label:11} n={len(sel):>6}  "
              f"excess={sel['ex12'].mean():+.3f}%  raw={sel['fwd12'].mean():+.3f}%  "
              f"win={(sel['ex12'] > 0).mean() * 100:.1f}%")

    print("\nTypical 5-min ATR: "
          f"{panel['ATR_PCT'].median():.3f}% of price")
    print("PSX round-trip cost is roughly 0.3-0.5% (commission + spread + FED).")


if __name__ == "__main__":
    main()
