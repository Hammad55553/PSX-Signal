# Signal engine — how it was calibrated

Every number below comes from the scripts in this repo. Re-run them to check.

```bash
python analyze_edge.py       # which factors predict anything
python research_composite.py # build the composite
python validate_oos.py       # out-of-sample validation
python risk_sweep.py         # stop / target / horizon
python backtest.py           # end-to-end, shipped settings
```

Universe: 30 PSX tickers, 2021-08 → 2026-07, ~38,000 daily bars from Yahoo
Finance. Cached to `/tmp/psx_backtest_cache.pkl` (override with `PSX_BT_CACHE`).

---

## 1. The original algorithm was inverted

The engine scored trend confluence — SMA alignment, MACD state, RSI thresholds,
support/resistance. Sorted by that score, forward 10-day returns in excess of
the same-day market average came out **backwards**:

| score decile | 10-day excess return |
|---|---|
| 0 (most bearish) | **+0.61%** |
| 4 | −0.07% |
| 9 (most bullish) | **−0.23%** |

Its `SELL` bucket returned +0.61% excess and its `BUY` bucket −0.13%. It was
mildly anti-predictive.

## 2. No classic indicator predicts much on PSX

Spearman rho against forward excess returns, n = 31,862:

| factor | rho (10d) | factor | rho (10d) |
|---|---|---|---|
| RSI | +0.006 | DIST_SMA20 | −0.009 |
| ADX | +0.017 | RET_5 | −0.019 |
| MACD_Hist | −0.016 | OBV_SLOPE | −0.022 |
| BB_PCT | +0.005 | VOL_TREND | −0.024 |

All |rho| < 0.03. Detectable at this sample size, economically negligible.
Anyone shipping a daily trend-following PSX bot is shipping noise.

## 3. What does work: volatility-adjusted reversion

The one economically meaningful pattern. Deciles of the 5-day return:

| RET_5 decile | 10-day excess return |
|---|---|
| 0 (worst 5-day performers) | **+1.05%** |
| 9 (best 5-day performers) | −0.40% |

Same effect in MACD histogram: most-negative decile +0.64%, most-positive
**−1.27%**. Sharp declines bounce; stretched advances give back ground.

### The composite

Each factor is z-scored against the stock's **own** trailing 120 sessions
(time-series, not cross-sectional) so a single ticker can be scored alone —
the live app has no universe context. Raw factors are divided by the stock's
ATR% first, so a 4% drop in a 4%-ATR name is not equated with a 4% drop in a
2%-ATR name.

```
composite = -( 1.00·z(RET_5/ATR%)
             + 0.70·z(MACD_Hist/Close)
             + 0.40·z(dist to SMA20 / ATR%)
             + 0.30·z(RSI) )
```

Cross-sectional and time-series versions both work (top-decile +1.14% and
+1.07% excess), so the shippable time-series form loses little.

## 4. Out-of-sample validation

Decile cutoff frozen on **2022-2024**, applied to unseen **2025-2026**:

| rule | train ex10 | test ex10 |
|---|---|---|
| top decile, no filter | +0.15% | +2.43% |
| top decile + ADX 30-45 | +0.63% | +6.93% |
| top decile + ATR% ≥ 4 | +1.20% | +6.26% |
| top decile + both | +1.80% | **+12.89%** |

Also passes:
- **Ticker split** — both halves of the universe positive (+5.09% / +1.62% on the ADX filter).
- **Bootstrap** — p < 0.001 for all four rules.
- **Concentration** — 20 of 28 contributing tickers positive; not a one-stock artefact.

> **Read the train column, not the test column.** Out-of-sample scoring far
> better than in-sample is a property of the 2025-26 market, not evidence the
> rule improves with age. Plan around ~+2%.

## 5. Stops cost money on this strategy

10-bar hold, BUY signals only, stop/target measured directly from ATR:

| stop | avg return | % stopped out |
|---|---|---|
| 1.5 ATR | +1.34% | 44.5 |
| 2.5 ATR | +1.55% | 23.9 |
| 4.0 ATR | +1.73% | 8.8 |
| none | **+1.92%** | 0.0 |

Inherent to reversion: you buy something still falling, it overshoots, then
recovers. A tight stop exits at exactly the worst point.

**Shipped: 3.5 ATR — deliberately not the backtest optimum.** An average hides
tail risk; one delisting or −40% gap would erase years of edge. 3.5 ATR keeps
most of the measured edge while capping the worst case.

A separate bug mattered here: `_levels()` used to clamp the stop to the nearest
support/resistance, which silently converted the wide stop back to ~1 ATR.
Removing that clamp moved BUY from +1.33% to +1.61% and win rate from 37.5% to
52.3%.

## 6. Exit on time, not on target

Compared against a **same-horizon** benchmark:

| hold | signal | benchmark | edge |
|---|---|---|---|
| 5d | +1.21% | +0.75% | +0.46% |
| 10d | +1.92% | +1.44% | **+0.48%** |
| 15d | +2.22% | +2.15% | +0.07% |
| 20d | +2.34% | +2.88% | −0.54% |

Holding longer raises the absolute return but hands all the edge back to market
drift. `HOLD_SESSIONS = "5-10"`.

*(An earlier version of `risk_sweep.py` compared 15-day returns to the 10-day
benchmark and made 15 days look good. Fixed — the horizon guidance changed from
"10-15" to "5-10" as a result.)*

## 7. Confidence is a real filter

BUY signals, 10-bar hold, no stop:

| confidence | n | avg return | win rate |
|---|---|---|---|
| ≤50 | 608 | +0.97% | 50.7% |
| 50-60 | 974 | +0.76% | 55.4% |
| 60-70 | 723 | +1.64% | 58.0% |
| 70-80 | 324 | +2.78% | 53.1% |
| **80-100** | 154 | **+12.56%** | 61.0% |

`HIGH_CONVICTION = 70`. The regime filters, applied together:

| filter | n | avg return |
|---|---|---|
| ADX 30-45 | 1100 | +3.13% |
| ATR% ≥ 4 | 989 | +4.12% |
| **both** | 427 | **+6.62%** (58.8% win) |

## 8. The short side does not work

Traded as actual shorts, SELL signals return **−1.52% per trade**. The bottom
decile's excess return is only about −0.3%, and PSX short selling is restricted
anyway.

`SELL` is therefore emitted with `tradeable: "EXIT_ONLY"` — useful to someone
already holding the stock, never presented as a short entry.

---

## Shipped configuration

| constant | value | source |
|---|---|---|
| `BUY_THRESHOLD` | 3.64 | train-set top-decile cutoff (composite 2.619) |
| `SELL_THRESHOLD` | −4.44 | stricter; weak measured edge |
| `MIN_CONFIDENCE` | 45 | below this, no directional call |
| `HIGH_CONVICTION` | 70 | §7 |
| `STOP_ATR` | 3.5 | §5, chosen over the optimum for tail safety |
| `TARGET_ATR` | 6.0 | §5 |
| `HOLD_SESSIONS` | 5-10 | §6 |
| `ADX_SWEET_LO/HI` | 30 / 45 | §7 |
| `ATR_STRONG` | 4.0 | §7 |

## What this is not

- **Not a money printer.** The unfiltered edge is ~+0.5% per 10 sessions before
  brokerage, spread and slippage. PSX round-trip costs can eat most of that.
  The high-conviction subset is where the return lives, and it is rare.
- **Not validated across market regimes.** The sample covers one long bull
  market. Reversion strategies typically behave differently in sustained
  declines, and nothing here tests that.
- **Not risk-managed for you.** Position sizing is not modelled at all. The
  return distribution is skewed — a few large winners carry the average — so
  equal sizing across signals is what was measured.
- **Not investment advice.**
