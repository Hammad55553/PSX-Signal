"""
Out-of-sample validation of the reversion composite.

research_composite.py found that the top decile, filtered by ADX and ATR,
produced large excess returns. Those filters were discovered BY SEARCHING the
same data they were measured on, which is exactly how backtests lie.

This script re-tests them honestly:

  1. Time split      — fit deciles on 2021-2024, apply to 2025-2026 unseen.
  2. Ticker split    — fit on half the universe, apply to the other half.
  3. Bootstrap       — is the effect distinguishable from luck at this n?

A rule that survives all three is worth shipping. One that only works in
sample is not.
"""
import numpy as np
import pandas as pd

from backtest import load_universe
from research_composite import build, add_cross_sectional, composite

SPLIT_DATE = pd.Timestamp("2025-01-01")
RNG = np.random.default_rng(42)


def prep(data):
    p = add_cross_sectional(build(data))
    p = p.dropna(subset=["ex10", "fwd10"])
    p["comp"] = composite(p, "tz")
    return p.dropna(subset=["comp"])


def evaluate_rule(p: pd.DataFrame, cutoff: float, label: str,
                  adx_lo=None, adx_hi=None, atr_lo=None) -> dict:
    """Apply a fixed rule and report its excess return."""
    sel = p[p["comp"] >= cutoff]
    if adx_lo is not None:
        sel = sel[(sel["ADX"] >= adx_lo) & (sel["ADX"] < adx_hi)]
    if atr_lo is not None:
        sel = sel[sel["ATR_PCT"] >= atr_lo]
    if len(sel) < 30:
        print(f"  {label:44} n={len(sel):>5}  (too few)")
        return {"n": len(sel), "ex10": np.nan}
    ex10 = sel["ex10"].mean()
    raw = sel["fwd10"].mean()
    win = (sel["ex10"] > 0).mean() * 100
    print(f"  {label:44} n={len(sel):>5}  ex10={ex10:>+6.2f}%  "
          f"raw={raw:>+6.2f}%  win={win:>5.1f}%")
    return {"n": len(sel), "ex10": ex10, "raw": raw, "win": win}


def bootstrap_p(sel: pd.Series, pool: pd.Series, iters: int = 2000) -> float:
    """Probability that a random sample of the same size beats the observed mean."""
    n, obs = len(sel), sel.mean()
    pool_v = pool.dropna().values
    if n < 10 or len(pool_v) < n:
        return np.nan
    hits = sum(1 for _ in range(iters)
               if RNG.choice(pool_v, n, replace=False).mean() >= obs)
    return hits / iters


def main():
    data = load_universe()
    print(f"Preparing panel ({len(data)} tickers) ...")
    p = prep(data)
    print(f"{len(p)} rows, {p['date'].min().date()} -> {p['date'].max().date()}\n")

    train = p[p["date"] < SPLIT_DATE]
    test = p[p["date"] >= SPLIT_DATE]
    print(f"TRAIN: {len(train)} rows ({train['date'].min().date()} -> {train['date'].max().date()})")
    print(f"TEST : {len(test)} rows ({test['date'].min().date()} -> {test['date'].max().date()})\n")

    # The cutoff is defined on TRAIN only, then frozen.
    cutoff = train["comp"].quantile(0.9)
    print(f"Top-decile cutoff learned on TRAIN: comp >= {cutoff:.3f}\n")

    print("=" * 74)
    print("TEST 1 — time split (rules fixed on train, measured on unseen test)")
    print("=" * 74)
    for name, sub in (("TRAIN (in-sample)", train), ("TEST  (out-of-sample)", test)):
        print(f"\n{name}:")
        evaluate_rule(sub, cutoff, "top decile, no filter")
        evaluate_rule(sub, cutoff, "top decile + ADX 30-45", adx_lo=30, adx_hi=45)
        evaluate_rule(sub, cutoff, "top decile + ATR% >= 4", atr_lo=4)
        evaluate_rule(sub, cutoff, "top decile + ADX 30-45 + ATR% >= 4",
                      adx_lo=30, adx_hi=45, atr_lo=4)
        evaluate_rule(sub, cutoff, "top decile + ADX >= 25", adx_lo=25, adx_hi=999)
        evaluate_rule(sub, cutoff, "top decile + ATR% >= 3", atr_lo=3)

    print("\n" + "=" * 74)
    print("TEST 2 — ticker split (odd vs even tickers)")
    print("=" * 74)
    tick = sorted(p["ticker"].unique())
    a_set, b_set = set(tick[::2]), set(tick[1::2])
    for name, sub in (("GROUP A", p[p["ticker"].isin(a_set)]),
                      ("GROUP B", p[p["ticker"].isin(b_set)])):
        print(f"\n{name} ({len(sub)} rows):")
        evaluate_rule(sub, cutoff, "top decile, no filter")
        evaluate_rule(sub, cutoff, "top decile + ADX 30-45", adx_lo=30, adx_hi=45)
        evaluate_rule(sub, cutoff, "top decile + ATR% >= 4", atr_lo=4)

    print("\n" + "=" * 74)
    print("TEST 3 — bootstrap significance on the FULL sample")
    print("=" * 74)
    for label, kwargs in [
        ("top decile, no filter", {}),
        ("top decile + ADX 30-45", {"adx_lo": 30, "adx_hi": 45}),
        ("top decile + ATR% >= 4", {"atr_lo": 4}),
        ("top decile + ADX 30-45 + ATR% >= 4", {"adx_lo": 30, "adx_hi": 45, "atr_lo": 4}),
    ]:
        sel = p[p["comp"] >= cutoff]
        if "adx_lo" in kwargs:
            sel = sel[(sel["ADX"] >= kwargs["adx_lo"]) & (sel["ADX"] < kwargs["adx_hi"])]
        if "atr_lo" in kwargs:
            sel = sel[sel["ATR_PCT"] >= kwargs["atr_lo"]]
        pv = bootstrap_p(sel["ex10"], p["ex10"])
        verdict = "significant" if pv is not np.nan and pv < 0.05 else "NOT significant"
        print(f"  {label:44} n={len(sel):>5}  p={pv:.4f}  {verdict}")

    print("\n" + "=" * 74)
    print("TEST 4 — is ATR%>=4 just selecting a few volatile tickers?")
    print("=" * 74)
    sel = p[(p["comp"] >= cutoff) & (p["ATR_PCT"] >= 4)]
    by_t = sel.groupby("ticker")["ex10"].agg(["size", "mean"]).sort_values("size", ascending=False)
    print(f"  {len(by_t)} distinct tickers contribute; top 8 by count:")
    for t, row in by_t.head(8).iterrows():
        print(f"    {t:10} n={int(row['size']):>4}  ex10={row['mean']:>+6.2f}%")
    pos = (by_t["mean"] > 0).sum()
    print(f"  tickers with positive mean: {pos}/{len(by_t)}")


if __name__ == "__main__":
    main()
