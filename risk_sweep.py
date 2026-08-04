"""
Isolated stop/target/horizon sweep for BUY signals.

The sweep built into backtest.py was confounded: _levels() clamps the stop to
the nearest structural level (so "no stop" was still stopping out) and the
risk/reward gate silently dropped trades, so N moved with the parameters and
the columns were not comparable.

This computes stop and target directly from ATR at the swept multiples, takes
every BUY the engine emits, and reports against two benchmarks:

  raw bench    — average forward return of ALL bars over the same horizon
  excess       — signal return minus the same-day cross-sectional mean, which
                 is the quantity the factor research actually measured

Short signals are excluded: the measured short-side edge was ~-0.3%.
"""
import numpy as np
import pandas as pd

from services.indicators import compute_all
from services import signal_generator as sg
from backtest import load_universe, WARMUP


def collect(data):
    """One pass: every bar's signal, ATR, and forward path."""
    rows = []
    for ticker, raw in data.items():
        df = compute_all(raw)
        n = len(df)
        for i in range(WARMUP, n - 21):
            res = sg.evaluate(df, i)
            if res["signal"] != "BUY":
                continue
            rows.append({
                "ticker": ticker, "i": i, "date": df.index[i],
                "confidence": res["confidence"], "score": res["score"],
                "adx": df["ADX"].iloc[i], "atr_pct": df["ATR_PCT"].iloc[i],
                "atr": df["ATR"].iloc[i], "close": df["Close"].iloc[i],
            })
    return pd.DataFrame(rows), {t: compute_all(d) for t, d in data.items()}


def simulate(frames, sig_row, stop_mult, target_mult, hold):
    """Entry at next open; stop/target from ATR only; time exit at `hold`."""
    df = frames[sig_row["ticker"]]
    i = sig_row["i"]
    if i + 1 >= len(df):
        return None
    entry = float(df["Open"].iloc[i + 1])
    if not np.isfinite(entry) or entry <= 0:
        return None
    atr = float(sig_row["atr"])
    stop = entry - stop_mult * atr if stop_mult else -np.inf
    target = entry + target_mult * atr if target_mult else np.inf

    end = min(i + 1 + hold, len(df))
    for j in range(i + 1, end):
        lo, hi = float(df["Low"].iloc[j]), float(df["High"].iloc[j])
        if lo <= stop:
            return ((stop - entry) / entry * 100, "stop")
        if hi >= target:
            return ((target - entry) / entry * 100, "target")
    return ((float(df["Close"].iloc[end - 1]) - entry) / entry * 100, "time")


def benchmarks(data, horizons=(5, 10, 15, 20)):
    """Average forward return of every bar, per horizon."""
    out = {}
    for h in horizons:
        vals = []
        for _, raw in data.items():
            c = raw["Close"]
            r = (c.shift(-h) / c - 1) * 100
            vals.append(r.iloc[WARMUP:-h].dropna())
        out[h] = float(pd.concat(vals).mean())
    return out


def main():
    data = load_universe()
    print("Collecting BUY signals ...")
    sigs, frames = collect(data)
    print(f"{len(sigs)} BUY signals\n")

    bench = benchmarks(data)
    print("Benchmark (average forward return of ALL bars):")
    for h, v in bench.items():
        print(f"  {h:>2}d: {v:+.2f}%")

    print("\n=== No stop, pure time exit — does the raw signal have edge? ===")
    print(f"{'hold':>6}{'N':>7}{'WIN%':>7}{'AVG%':>8}{'BENCH%':>9}{'EDGE%':>8}")
    for hold in (5, 10, 15, 20):
        res = [simulate(frames, r, None, None, hold) for _, r in sigs.iterrows()]
        rets = [x[0] for x in res if x]
        if not rets:
            continue
        avg = float(np.mean(rets))
        # Must compare against the SAME horizon; an earlier version fell back
        # to the 10-day benchmark for 15-day holds and overstated the edge.
        b = bench[hold]
        print(f"{hold:>6}{len(rets):>7}{np.mean([r > 0 for r in rets]) * 100:>7.1f}"
              f"{avg:>8.2f}{b:>9.2f}{avg - b:>8.2f}")

    print("\n=== Stop / target grid (10-bar max hold) ===")
    print(f"{'stop':>6}{'target':>8}{'N':>7}{'WIN%':>7}{'AVG%':>8}{'EDGE%':>8}{'stop%':>7}")
    grid = []
    for stop_m in (1.5, 2.0, 2.5, 3.0, 4.0, None):
        for target_m in (2.0, 3.0, 4.0, 6.0, None):
            res = [simulate(frames, r, stop_m, target_m, 10) for _, r in sigs.iterrows()]
            res = [x for x in res if x]
            if not res:
                continue
            rets = [x[0] for x in res]
            avg = float(np.mean(rets))
            stopped = np.mean([x[1] == "stop" for x in res]) * 100
            edge = avg - bench[10]
            grid.append((stop_m, target_m, avg, edge, len(rets)))
            print(f"{str(stop_m):>6}{str(target_m):>8}{len(rets):>7}"
                  f"{np.mean([r > 0 for r in rets]) * 100:>7.1f}{avg:>8.2f}"
                  f"{edge:>8.2f}{stopped:>7.1f}")

    best = max(grid, key=lambda x: x[3])
    print(f"\nBest: stop={best[0]} ATR, target={best[1]} ATR -> "
          f"avg {best[2]:+.2f}%, edge {best[3]:+.2f}%")

    print("\n=== Best config, split by confidence ===")
    stop_m, target_m = best[0], best[1]
    sigs["ret"] = [x[0] if x else np.nan
                   for x in (simulate(frames, r, stop_m, target_m, 10)
                             for _, r in sigs.iterrows())]
    s = sigs.dropna(subset=["ret"])
    s = s.copy()
    s["bucket"] = pd.cut(s["confidence"], [0, 50, 60, 70, 80, 100])
    for b, grp in s.groupby("bucket", observed=True):
        print(f"  {str(b):12} n={len(grp):>5}  avg={grp['ret'].mean():+6.2f}%  "
              f"win={(grp['ret'] > 0).mean() * 100:5.1f}%")

    print("\n=== Best config, ADX and ATR filters ===")
    for lo, hi in [(0, 20), (20, 30), (30, 45), (45, 100)]:
        g = s[(s["adx"] >= lo) & (s["adx"] < hi)]
        if len(g) > 50:
            print(f"  ADX [{lo:>3},{hi:>3}): n={len(g):>5}  avg={g['ret'].mean():+6.2f}%")
    for lo, hi in [(0, 2), (2, 3), (3, 4), (4, 100)]:
        g = s[(s["atr_pct"] >= lo) & (s["atr_pct"] < hi)]
        if len(g) > 50:
            print(f"  ATR% [{lo},{hi}):   n={len(g):>5}  avg={g['ret'].mean():+6.2f}%")

    g = s[(s["adx"] >= 30) & (s["adx"] < 45) & (s["atr_pct"] >= 4)]
    if len(g) > 20:
        print(f"  ADX 30-45 AND ATR%>=4: n={len(g):>5}  avg={g['ret'].mean():+6.2f}%  "
              f"win={(g['ret'] > 0).mean() * 100:.1f}%")


if __name__ == "__main__":
    main()
