"""
Walk-forward backtest for the signal engine.

Purpose: decide the BUY/SELL thresholds from evidence instead of guessing.

No-lookahead guarantees:
  * Indicators are causal (each value uses only bars <= i).
  * A signal is generated from bar i's close.
  * Entry is bar i+1's OPEN — you cannot trade a close you have already seen.
  * Stop/target resolution scans bars i+1..i+H using that bar's High/Low.
  * The live PSX quote override is NOT applied here; it would contaminate the
    final bar of history.

Usage:
    python backtest.py                # run with current thresholds
    python backtest.py --sweep        # grid-search thresholds
"""
import argparse
import os
import pickle
import sys
from typing import Dict, List

import numpy as np
import pandas as pd
import yfinance as yf

from services.indicators import compute_all
from services import signal_generator as sg

# A wider universe than the dashboard's 10, for statistical power.
UNIVERSE = [
    "SYS.KA", "OGDC.KA", "HUBC.KA", "LUCK.KA", "MCB.KA", "EFERT.KA", "PSO.KA",
    "TRG.KA", "PPL.KA", "FFC.KA", "UBL.KA", "HBL.KA", "MARI.KA", "POL.KA",
    "BAHL.KA", "MEBL.KA", "DGKC.KA", "FCCL.KA", "NBP.KA", "AKBL.KA",
    "ATRL.KA", "NRL.KA", "PIOC.KA", "CHCC.KA", "KOHC.KA", "INDU.KA",
    "HCAR.KA", "MTL.KA", "SEARL.KA", "COLG.KA",
]

HOLD_DAYS = 15          # max bars a trade is given to work
WARMUP = 210            # bars needed before SMA_200 and friends are valid
CACHE = os.environ.get("PSX_BT_CACHE", "/tmp/psx_backtest_cache.pkl")


def load_universe(period: str = "5y", refresh: bool = False) -> Dict[str, pd.DataFrame]:
    """Download and cache raw OHLCV for the universe."""
    if not refresh and os.path.exists(CACHE):
        with open(CACHE, "rb") as fh:
            data = pickle.load(fh)
        print(f"Loaded {len(data)} tickers from cache ({CACHE})")
        return data

    data = {}
    for t in UNIVERSE:
        try:
            df = yf.Ticker(t).history(period=period)
            if len(df) < WARMUP + 60:
                print(f"  skip {t}: only {len(df)} bars")
                continue
            df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
            df.index = pd.to_datetime(df.index).tz_localize(None)
            # Feeds ship occasional gap bars (UBL has one). Drop them here so
            # every downstream indicator sees a clean series.
            df = df[df["Close"].notna() & (df["Close"] > 0)]
            data[t] = df
            print(f"  {t}: {len(df)} bars  {df.index[0].date()} -> {df.index[-1].date()}")
        except Exception as e:
            print(f"  skip {t}: {e}")
    with open(CACHE, "wb") as fh:
        pickle.dump(data, fh)
    return data


def simulate_trade(df: pd.DataFrame, i: int, direction: int,
                   stop: float, target: float, horizon: int = HOLD_DAYS) -> Dict:
    """Resolve one trade entered at bar i+1's open.

    direction: +1 long, -1 short.
    Returns realised return in percent and how the trade closed.
    """
    if i + 1 >= len(df):
        return {}
    entry = float(df["Open"].iloc[i + 1])
    if entry <= 0:
        return {}

    # The plan's levels were computed off bar i's close; shift them to the
    # actual fill so the risk/reward being measured is the one taken.
    close_i = float(df["Close"].iloc[i])
    stop = entry + (stop - close_i)
    target = entry + (target - close_i)

    end = min(i + 1 + horizon, len(df))
    for j in range(i + 1, end):
        hi, lo = float(df["High"].iloc[j]), float(df["Low"].iloc[j])
        if direction > 0:
            # Stop checked first: the pessimistic assumption when a single bar
            # spans both levels.
            if lo <= stop:
                return {"ret": (stop - entry) / entry * 100, "exit": "stop", "bars": j - i}
            if hi >= target:
                return {"ret": (target - entry) / entry * 100, "exit": "target", "bars": j - i}
        else:
            if hi >= stop:
                return {"ret": (entry - stop) / entry * 100, "exit": "stop", "bars": j - i}
            if lo <= target:
                return {"ret": (entry - target) / entry * 100, "exit": "target", "bars": j - i}

    last = float(df["Close"].iloc[end - 1])
    ret = (last - entry) / entry * 100 * direction
    return {"ret": ret, "exit": "timeout", "bars": end - 1 - i}


def run(data: Dict[str, pd.DataFrame], buy_th: float, sell_th: float,
        min_conf: float, verbose: bool = False) -> Dict:
    """Evaluate every bar of every ticker under the given thresholds."""
    old = (sg.BUY_THRESHOLD, sg.SELL_THRESHOLD, sg.MIN_CONFIDENCE)
    sg.BUY_THRESHOLD, sg.SELL_THRESHOLD, sg.MIN_CONFIDENCE = buy_th, sell_th, min_conf

    trades: List[Dict] = []
    counts = {"BUY": 0, "SELL": 0, "HOLD": 0}
    bench: List[float] = []

    try:
        for ticker, raw in data.items():
            df = compute_all(raw)
            for i in range(WARMUP, len(df) - 1):
                res = sg.evaluate(df, i)
                counts[res["signal"]] += 1

                # Benchmark: what a random entry on this bar would have returned
                if i + 1 + HOLD_DAYS < len(df):
                    e = float(df["Open"].iloc[i + 1])
                    x = float(df["Close"].iloc[i + 1 + HOLD_DAYS])  # noqa: E501
                    if e > 0 and np.isfinite(e) and np.isfinite(x):
                        bench.append((x - e) / e * 100)

                if res["signal"] == "HOLD" or res["entry_timing"] != "NOW":
                    continue

                direction = 1 if res["signal"] == "BUY" else -1
                # HOLD_DAYS is read at call time so the --risk sweep can vary it
                tr = simulate_trade(df, i, direction, res["stop_loss"],
                                    res["target"], horizon=HOLD_DAYS)
                if not tr:
                    continue
                tr.update({"ticker": ticker, "signal": res["signal"],
                           "confidence": res["confidence"], "score": res["score"],
                           "regime": res["regime"], "date": df.index[i]})
                trades.append(tr)
    finally:
        sg.BUY_THRESHOLD, sg.SELL_THRESHOLD, sg.MIN_CONFIDENCE = old

    return summarize(trades, counts, bench, verbose)


def summarize(trades: List[Dict], counts: Dict, bench: List[float], verbose: bool) -> Dict:
    if not trades:
        return {"n": 0, "win_rate": 0, "avg_ret": 0, "expectancy": 0,
                "counts": counts, "bench": float(np.mean(bench)) if bench else 0}

    t = pd.DataFrame(trades)
    wins = t[t["ret"] > 0]
    losses = t[t["ret"] <= 0]

    out = {
        "n": len(t),
        "win_rate": len(wins) / len(t) * 100,
        "avg_ret": t["ret"].mean(),
        "avg_win": wins["ret"].mean() if len(wins) else 0.0,
        "avg_loss": losses["ret"].mean() if len(losses) else 0.0,
        "expectancy": t["ret"].mean(),
        "total_ret": t["ret"].sum(),
        "avg_bars": t["bars"].mean(),
        "stopped_pct": (t["exit"] == "stop").mean() * 100,
        "counts": counts,
        "bench": float(np.mean(bench)) if bench else 0.0,
        "by_signal": t.groupby("signal")["ret"].agg(["count", "mean",
                                                     lambda s: (s > 0).mean() * 100]).to_dict(),
    }

    if verbose:
        print("\n--- By signal ---")
        for sigval, grp in t.groupby("signal"):
            print(f"  {sigval:5} n={len(grp):5}  win={(grp['ret'] > 0).mean() * 100:5.1f}%  "
                  f"avg={grp['ret'].mean():+6.2f}%  total={grp['ret'].sum():+9.1f}%")
        print("\n--- By regime ---")
        for reg, grp in t.groupby("regime"):
            print(f"  {reg:11} n={len(grp):5}  win={(grp['ret'] > 0).mean() * 100:5.1f}%  "
                  f"avg={grp['ret'].mean():+6.2f}%")
        print("\n--- By confidence bucket ---")
        t["bucket"] = pd.cut(t["confidence"], [0, 50, 60, 70, 80, 100])
        for b, grp in t.groupby("bucket", observed=True):
            print(f"  {str(b):12} n={len(grp):5}  win={(grp['ret'] > 0).mean() * 100:5.1f}%  "
                  f"avg={grp['ret'].mean():+6.2f}%")
        print("\n--- Exit reason ---")
        for ex, grp in t.groupby("exit"):
            print(f"  {ex:8} n={len(grp):5}  avg={grp['ret'].mean():+6.2f}%")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true", help="grid-search thresholds")
    ap.add_argument("--risk", action="store_true", help="grid-search stop/target/horizon")
    ap.add_argument("--refresh", action="store_true", help="re-download data")
    args = ap.parse_args()

    data = load_universe(refresh=args.refresh)
    if not data:
        print("No data.")
        sys.exit(1)
    print(f"\nUniverse: {len(data)} tickers, "
          f"{sum(len(d) for d in data.values())} bars total\n")

    if args.risk:
        # The factor research measured a fixed-horizon hold with no stop, and
        # found real edge. The first full backtest stopped out 64% of trades.
        # So the stop is the variable under suspicion, not the signal.
        global HOLD_DAYS
        print("BUY-side only (the short side has no measured edge).\n")
        print(f"{'stop':>6}{'target':>8}{'hold':>6}{'N':>7}{'WIN%':>7}"
              f"{'AVG%':>8}{'vs.BENCH':>10}{'stopped%':>10}")
        base_stop, base_target = sg.STOP_ATR, sg.TARGET_ATR
        rows = []
        for stop_m in (1.5, 2.0, 2.5, 3.0, 4.0, 99.0):
            for target_m in (2.0, 2.75, 4.0, 99.0):
                for hold in (10, 15, 20):
                    if target_m == 99.0 and stop_m == 99.0 and hold != 10:
                        pass  # pure time exit; still worth all horizons
                    sg.STOP_ATR, sg.TARGET_ATR = stop_m, target_m
                    HOLD_DAYS = hold
                    r = run(data, sg.BUY_THRESHOLD, -99, sg.MIN_CONFIDENCE)
                    if r["n"] < 100:
                        continue
                    edge = r["avg_ret"] - r["bench"]
                    rows.append((stop_m, target_m, hold, r, edge))
                    print(f"{stop_m:>6.1f}{target_m:>8.2f}{hold:>6}{r['n']:>7}"
                          f"{r['win_rate']:>7.1f}{r['avg_ret']:>8.2f}{edge:>10.2f}"
                          f"{r.get('stopped_pct', float('nan')):>10.1f}")
        sg.STOP_ATR, sg.TARGET_ATR = base_stop, base_target
        if rows:
            best = max(rows, key=lambda x: x[4])
            print(f"\nBest edge vs benchmark: stop={best[0]} ATR, target={best[1]} ATR, "
                  f"hold={best[2]} bars -> avg {best[3]['avg_ret']:+.2f}% "
                  f"(bench {best[3]['bench']:+.2f}%, edge {best[4]:+.2f}%)")
    elif args.sweep:
        print(f"{'BUY':>5}{'SELL':>6}{'CONF':>6}{'N':>7}{'WIN%':>7}{'AVG%':>8}{'TOTAL%':>10}{'EDGE':>8}")
        rows = []
        for buy_th in (2.0, 2.5, 3.0, 3.5, 4.0, 4.5):
            for conf in (40, 45, 50, 55, 60):
                r = run(data, buy_th, -buy_th, conf)
                if r["n"] < 50:
                    continue
                edge = r["avg_ret"] - r["bench"]
                rows.append((buy_th, conf, r))
                print(f"{buy_th:>5.1f}{-buy_th:>6.1f}{conf:>6}{r['n']:>7}"
                      f"{r['win_rate']:>7.1f}{r['avg_ret']:>8.2f}"
                      f"{r['total_ret']:>10.1f}{edge:>8.2f}")
        if rows:
            best = max(rows, key=lambda x: x[2]["avg_ret"] - x[2]["bench"])
            print(f"\nBest edge: BUY>={best[0]}, SELL<=-{best[0]}, MIN_CONFIDENCE={best[1]}")
    else:
        r = run(data, sg.BUY_THRESHOLD, sg.SELL_THRESHOLD, sg.MIN_CONFIDENCE, verbose=True)
        print(f"\n=== Current settings: BUY>={sg.BUY_THRESHOLD}, "
              f"SELL<={sg.SELL_THRESHOLD}, CONF>={sg.MIN_CONFIDENCE} ===")
        print(f"Trades taken      : {r['n']}")
        print(f"Win rate          : {r['win_rate']:.1f}%")
        print(f"Avg return/trade  : {r['avg_ret']:+.2f}%  (over max {HOLD_DAYS} bars)")
        print(f"Avg win / avg loss: {r['avg_win']:+.2f}% / {r['avg_loss']:+.2f}%")
        print(f"Random-entry bench: {r['bench']:+.2f}%")
        print(f"Edge over random  : {r['avg_ret'] - r['bench']:+.2f}%")
        print(f"Signal mix        : {r['counts']}")


if __name__ == "__main__":
    main()
