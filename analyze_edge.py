"""
Factor research: which indicators actually predict forward returns on PSX?

Method
------
Build one panel of (ticker, date, every indicator, forward returns). Returns
are measured EXCESS of the same-day cross-sectional mean, which strips out the
market-wide drift that made a 2021-2026 bull run flatter every long strategy.

Ranking is done cross-sectionally per day (z-scored across the universe), so a
factor is judged on "did it pick the right stock TODAY", not on whether the
whole market happened to rise.

Spearman is computed by ranking then correlating — no scipy dependency.
"""
import numpy as np
import pandas as pd

from services.indicators import compute_all
from services import signal_generator as sg
from backtest import load_universe, WARMUP

HORIZONS = (5, 10, 20)

# Candidate factors already present on the enriched frame, plus a few derived
# below. Sign convention is left raw; the correlation tells us the direction.
FACTORS = [
    "RSI", "ADX", "MACD_Hist", "BB_PCT", "VOL_RATIO", "SMA20_SLOPE", "ATR_PCT",
    "DIST_SMA20", "DIST_SMA50", "DIST_SMA200", "RET_5", "RET_10", "RET_20",
    "RET_60", "RANGE_POS", "OBV_SLOPE", "DI_SPREAD", "VOL_TREND",
]


def spearman(a: pd.Series, b: pd.Series) -> float:
    """Rank correlation without scipy."""
    m = a.notna() & b.notna()
    if m.sum() < 30:
        return np.nan
    return a[m].rank().corr(b[m].rank())


def derive(df: pd.DataFrame) -> pd.DataFrame:
    """Add the derived factors that are not part of the live indicator set."""
    out = df.copy()
    c = out["Close"]
    out["DIST_SMA20"] = (c / out["SMA_20"] - 1) * 100
    out["DIST_SMA50"] = (c / out["SMA_50"] - 1) * 100
    out["DIST_SMA200"] = (c / out["SMA_200"] - 1) * 100
    for n in (5, 10, 20, 60):
        out[f"RET_{n}"] = (c / c.shift(n) - 1) * 100
    span = (out["RESISTANCE"] - out["SUPPORT"]).replace(0, np.nan)
    out["RANGE_POS"] = (c - out["SUPPORT"]) / span
    out["DI_SPREAD"] = out["PLUS_DI"] - out["MINUS_DI"]
    out["VOL_TREND"] = out["Volume"].rolling(5).mean() / out["Volume"].rolling(60).mean()
    return out


def build_panel(data, with_score: bool = True) -> pd.DataFrame:
    frames = []
    for ticker, raw in data.items():
        df = derive(compute_all(raw))
        rec = df[[f for f in FACTORS if f in df.columns]].copy()
        rec["ticker"] = ticker
        rec["date"] = df.index
        rec["Close"] = df["Close"]
        for h in HORIZONS:
            rec[f"fwd{h}"] = (df["Close"].shift(-h) / df["Close"] - 1) * 100

        if with_score:
            scores, sigs, regimes = [], [], []
            for i in range(len(df)):
                if i < WARMUP:
                    scores.append(np.nan); sigs.append(None); regimes.append(None)
                    continue
                r = sg.evaluate(df, i)
                scores.append(r["score"]); sigs.append(r["signal"]); regimes.append(r["regime"])
            rec["score"] = scores
            rec["signal"] = sigs
            rec["regime"] = regimes
        frames.append(rec.iloc[WARMUP:])
    return pd.concat(frames, ignore_index=True)


def add_excess(panel: pd.DataFrame) -> pd.DataFrame:
    for h in HORIZONS:
        panel[f"ex{h}"] = panel[f"fwd{h}"] - panel.groupby("date")[f"fwd{h}"].transform("mean")
    return panel


def decile_table(panel: pd.DataFrame, col: str, target: str = "ex10") -> pd.DataFrame:
    sub = panel[[col, target]].dropna()
    if len(sub) < 500:
        return pd.DataFrame()
    sub = sub.copy()
    try:
        sub["d"] = pd.qcut(sub[col], 10, labels=False, duplicates="drop")
    except ValueError:
        return pd.DataFrame()
    return sub.groupby("d").agg(lo=(col, "min"), hi=(col, "max"),
                                n=(target, "size"), mean=(target, "mean"))


def main():
    data = load_universe()
    print(f"Building factor panel over {len(data)} tickers ...")
    panel = add_excess(build_panel(data))
    panel = panel.dropna(subset=["ex10"])
    print(f"{len(panel)} rows, {panel['date'].nunique()} trading days\n")

    print("=== Factor predictive power (Spearman vs forward EXCESS return) ===")
    print(f"{'factor':14}{'rho_5d':>9}{'rho_10d':>9}{'rho_20d':>9}")
    results = []
    for f in FACTORS + ["score"]:
        if f not in panel.columns:
            continue
        r5 = spearman(panel[f], panel["ex5"])
        r10 = spearman(panel[f], panel["ex10"])
        r20 = spearman(panel[f], panel["ex20"])
        results.append((f, r5, r10, r20))
        print(f"{f:14}{r5:>+9.4f}{r10:>+9.4f}{r20:>+9.4f}")

    print("\n=== Strongest factors by |rho_10d| ===")
    for f, r5, r10, r20 in sorted(results, key=lambda x: -abs(x[2] if not np.isnan(x[2]) else 0))[:6]:
        print(f"\n--- {f} (rho_10d={r10:+.4f}) deciles vs ex10 ---")
        tbl = decile_table(panel, f)
        if not tbl.empty:
            for d, row in tbl.iterrows():
                bar = "#" * int(abs(row["mean"]) * 8)
                print(f"  d{int(d)}  [{row['lo']:>8.2f} .. {row['hi']:>8.2f}]  "
                      f"n={int(row['n']):>6}  ex10={row['mean']:>+6.2f}%  {bar}")

    print("\n=== Current engine score: signal distribution vs outcome ===")
    for s, grp in panel.dropna(subset=["signal"]).groupby("signal"):
        print(f"  {s:5} n={len(grp):6}  ex5={grp['ex5'].mean():+6.2f}%  "
              f"ex10={grp['ex10'].mean():+6.2f}%  ex20={grp['ex20'].mean():+6.2f}%")


if __name__ == "__main__":
    main()
