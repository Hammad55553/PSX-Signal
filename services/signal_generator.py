"""
Mean-reversion signal engine, calibrated on PSX history.

Why this model and not a trend model
------------------------------------
The first version of this file scored trend confluence (SMA alignment, MACD
state, ADX). Measured against 5 years of PSX data across 30 tickers
(analyze_edge.py), every one of those inputs had |Spearman rho| < 0.03 against
forward excess returns — statistically detectable at n=31,862, economically
meaningless. Worse, the resulting score was mildly INVERTED: its most bearish
decile returned +0.61% excess over 10 days while its most bullish decile
returned -0.23%.

What does work on PSX is reversion. A sharp, volatility-adjusted decline is
followed by a bounce over the next 5-20 sessions, and the effect strengthens
when the name is volatile and in an established trend.

Validation (validate_oos.py), with the decile cutoff frozen on 2022-2024 and
applied to unseen 2025-2026 data:

    rule                                  train ex10    test ex10
    top decile, no filter                     +0.15%       +2.43%
    top decile + ADX 30-45                    +0.63%       +6.93%
    top decile + ATR% >= 4                    +1.20%       +6.26%
    top decile + ADX 30-45 + ATR% >= 4        +1.80%      +12.89%

It also survives a ticker split (both halves positive), a bootstrap test
(p < 0.001), and is spread across 20 of 28 contributing tickers rather than
driven by a few names.

Honest caveats, deliberately recorded here:
  * The out-of-sample period scored far better than the in-sample one. That is
    a property of the 2025-26 market, not evidence the rule improves with age.
    Plan around the TRAIN figure (~+2%), not the test figure.
  * The short side is much weaker than the long side: the bottom decile is only
    about -0.3% excess. SELL here means "exit / avoid", not "short with size".
  * ~55-60% win rate with returns skewed by a few large winners. Position
    sizing and the stop matter more than the entry.

All inputs are causal columns, and evaluate() works at any historical index,
so backtest and live use identical code.
"""
from typing import Dict, Any, List, Optional
import pandas as pd
import numpy as np

# --- Regime boundaries (ADX) ---
ADX_TREND = 25.0     # at or above: a real directional trend
ADX_RANGE = 18.0     # below: chop / consolidation

# --- Reversion composite weights (research_composite.py) ---
W_STRETCH = 1.00     # 5-day move, ATR-normalised — the dominant factor
W_MACDH = 0.70
W_DIST20 = 0.40
W_RSI_Z = 0.30
Z_CLIP = 3.0
# Raw composite range is +-(sum of weights * clip) = +-7.2; scaled to +-10.
_COMP_MAX = (W_STRETCH + W_MACDH + W_DIST20 + W_RSI_Z) * Z_CLIP
SCORE_SCALE = 10.0 / _COMP_MAX

# --- Decision thresholds ---
# BUY_THRESHOLD is the train-set top-decile cutoff (composite 2.619) carried
# onto the display scale. The short side is held to a stricter bar because its
# measured edge is far weaker.
BUY_THRESHOLD = round(2.619 * SCORE_SCALE, 2)      # ~3.64
SELL_THRESHOLD = -round(3.2 * SCORE_SCALE, 2)      # ~-4.44
MIN_CONFIDENCE = 45
MIN_RISK_REWARD = 1.3

# --- Confidence boosters, validated in validate_oos.py ---
ADX_SWEET_LO, ADX_SWEET_HI = 30.0, 45.0
ATR_STRONG = 4.0

# --- ATR multiples for risk management (risk_sweep.py) ---
# The sweep is unambiguous that on this strategy every stop costs money, and
# tighter stops cost more:
#
#     stop      avg 10-bar return    % stopped out
#     1.5 ATR         +1.34%             44.5
#     2.5 ATR         +1.55%             23.9
#     4.0 ATR         +1.73%              8.8
#     none            +1.92%              0.0
#
# That is inherent to reversion: you are buying something still falling, it
# overshoots, then recovers — a tight stop exits at exactly the worst point.
#
# We deliberately do NOT ship the backtest-optimal "no stop". An average hides
# tail risk, and one delisting or -40% gap would erase years of edge. 3.5 ATR
# keeps most of the measured edge while capping the worst case.
STOP_ATR = 3.5
TARGET_ATR = 6.0

# The primary exit is TIME, not the target. Measured against a same-horizon
# benchmark, the edge is:
#
#     hold      signal     benchmark     edge
#      5d        +1.21%      +0.75%     +0.46%
#     10d        +1.92%      +1.44%     +0.48%
#     15d        +2.22%      +2.15%     +0.07%
#     20d        +2.34%      +2.88%     -0.54%
#
# Holding longer raises the absolute return but gives all of the edge back to
# market drift, so the position must be closed on schedule.
HOLD_SESSIONS = "5-10"

# Above this, the historical subset performed far better (+2.8% to +12.6% per
# trade vs +0.8% below it). Surfaced to the UI as "high conviction".
HIGH_CONVICTION = 70

MAX_RAW = 10.0


def _v(row, key, default=None):
    """Read a column, mapping NaN to a default."""
    val = row.get(key, default)
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return default
    return val


def classify_regime(row) -> str:
    adx = _v(row, "ADX")
    if adx is None:
        return "UNKNOWN"
    if adx >= ADX_TREND:
        return "TREND"
    if adx < ADX_RANGE:
        return "RANGE"
    return "TRANSITION"


def _reversion_composite(row, reasons: List[str]) -> Optional[Dict[str, float]]:
    """The validated core score.

    Each factor is a causal z-score of the stock against its OWN trailing 120
    sessions, so no cross-sectional context is needed and a single ticker can
    be scored alone. Signs are negative because the effect is reversion: the
    more stretched DOWN a name is, the higher its score.
    """
    z_stretch = _v(row, "Z_STRETCH_5")
    z_macdh = _v(row, "Z_MACDH")
    z_dist = _v(row, "Z_DIST20")
    z_rsi = _v(row, "Z_RSI")

    # The dominant factor is required; the rest degrade gracefully.
    if z_stretch is None:
        return None

    def clip(z):
        return float(np.clip(z, -Z_CLIP, Z_CLIP)) if z is not None else 0.0

    zs, zm, zd, zr = clip(z_stretch), clip(z_macdh), clip(z_dist), clip(z_rsi)
    composite = -(W_STRETCH * zs + W_MACDH * zm + W_DIST20 * zd + W_RSI_Z * zr)

    ret_5 = _v(row, "RET_5")
    atr_pct = _v(row, "ATR_PCT")
    if ret_5 is not None and atr_pct:
        moves = abs(ret_5) / atr_pct
        if zs <= -1.5:
            reasons.append(
                f"Down {abs(ret_5):.1f}% over 5 sessions — {moves:.1f}x its own "
                f"average daily range, a {abs(zs):.1f}-sigma stretch. This is the "
                f"condition that historically preceded a bounce.")
        elif zs >= 1.5:
            reasons.append(
                f"Up {ret_5:.1f}% over 5 sessions — {moves:.1f}x its average daily "
                f"range, a {zs:.1f}-sigma extension. Stretched moves like this "
                f"tended to give back ground.")
        else:
            reasons.append(f"5-day move of {ret_5:+.1f}% is within its normal range.")

    if zm <= -1.5:
        reasons.append("MACD histogram is unusually deep below zero — selling "
                       "pressure is at an extreme rather than building.")
    elif zm >= 1.5:
        reasons.append("MACD histogram is unusually high — momentum is already "
                       "spent rather than starting.")

    return {"composite": composite, "z_stretch": zs, "z_macdh": zm,
            "z_dist": zd, "z_rsi": zr}


def _trend_context(row, reasons: List[str]) -> None:
    """Descriptive context for the reader.

    Deliberately does NOT feed the score: measured against 5 years of PSX data
    these readings had |rho| < 0.03 versus forward excess returns. They are
    kept because they tell a human what the chart looks like.
    """
    price = _v(row, "Close")
    sma20, sma50, sma200 = _v(row, "SMA_20"), _v(row, "SMA_50"), _v(row, "SMA_200")
    rsi = _v(row, "RSI")

    if sma20 is not None and sma50 is not None:
        reasons.append("20-day SMA is above the 50-day — medium-term structure is up."
                       if sma20 > sma50 else
                       "20-day SMA is below the 50-day — medium-term structure is down.")
    if price is not None and sma200 is not None:
        reasons.append("Price is above the 200-day SMA." if price > sma200
                       else "Price is below the 200-day SMA.")
    if rsi is not None:
        reasons.append(f"RSI is {rsi:.0f}.")


def _volume_note(row, reasons: List[str]) -> None:
    """Participation colour. Also descriptive only."""
    vr = _v(row, "VOL_RATIO")
    if vr is None:
        return
    if vr >= 2.0:
        reasons.append(f"Volume is {vr:.1f}x its 20-day average — heavy participation.")
    elif vr < 0.6:
        reasons.append(f"Volume is only {vr:.1f}x average — thin participation.")


def _levels(row, signal: str) -> Dict[str, float]:
    """ATR-based entry, stop and target.

    Risk is sized in units of the stock's own volatility. The old fixed 1%
    stop was noise-level for TRG (ATR 4.3%) and enormous for MCB (ATR 2.1%).
    """
    price = float(_v(row, "Close"))
    atr = _v(row, "ATR")
    sup, res = _v(row, "SUPPORT"), _v(row, "RESISTANCE")

    if atr is None or atr <= 0:
        atr = price * 0.02  # last-resort 2% proxy

    entry = price
    next_level = None

    # Structural levels are reported as context (next_level) but deliberately
    # do NOT move the stop. An earlier version tightened the stop to the
    # nearest support/resistance, which quietly reverted the wide 3.5 ATR stop
    # to a ~1 ATR one and reintroduced the 54%-stop-out behaviour the sweep
    # showed was costing roughly 0.6% per trade.
    if signal == "SELL":
        stop = price + STOP_ATR * atr
        target = price - TARGET_ATR * atr
        if sup is not None and sup < price:
            next_level = sup
    elif signal == "BUY":
        stop = price - STOP_ATR * atr
        target = price + TARGET_ATR * atr
        if res is not None and res > price:
            next_level = res
    else:  # HOLD — show the boundaries worth watching
        stop = price - STOP_ATR * atr
        target = price + TARGET_ATR * atr

    risk = abs(entry - stop)
    reward = abs(target - entry)
    rr = reward / risk if risk > 0 else 0.0

    # How far the first structural level is, in ATR. Under ~1 ATR the obvious
    # level is in the way and a fresh entry here has little room to work.
    room_atr = abs(next_level - price) / atr if next_level is not None else None

    return {
        "entry": round(entry, 2),
        "stop_loss": round(stop, 2),
        "target": round(target, 2),
        "next_level": round(float(next_level), 2) if next_level is not None else None,
        "room_atr": round(float(room_atr), 2) if room_atr is not None else None,
        "risk_reward": round(rr, 2),
        "atr": round(float(atr), 2),
    }


def evaluate(df: pd.DataFrame, i: int = -1, meta: Optional[Dict] = None) -> Dict[str, Any]:
    """Score a single bar. Works on the live bar or any historical index."""
    row = df.iloc[i]
    meta = meta or {}
    reasons: List[str] = []

    # A missing close makes every downstream number meaningless. Feeds do ship
    # the occasional gap bar, so fail closed rather than propagating garbage.
    if _v(row, "Close") is None:
        return {
            "signal": "HOLD", "entry_timing": "WAIT", "timing_note": None,
            "score": 0.0, "confidence": 0.0, "regime": "UNKNOWN",
            "reasons": ["No valid price for this bar."],
            "components": {}, "veto": "missing price",
            "entry": None, "stop_loss": None, "target": None,
            "next_level": None, "room_atr": None, "risk_reward": 0.0, "atr": None,
        }

    regime = classify_regime(row)
    comp = _reversion_composite(row, reasons)
    if comp is None:
        return {
            "signal": "HOLD", "entry_timing": "WAIT", "timing_note": None,
            "score": 0.0, "confidence": 0.0, "regime": regime,
            "reasons": ["Not enough history to normalise this stock's own "
                        "behaviour — no signal until ~40 more sessions."],
            "components": {}, "veto": "insufficient history",
            "entry": None, "stop_loss": None, "target": None,
            "next_level": None, "room_atr": None, "risk_reward": 0.0, "atr": None,
        }

    raw = float(np.clip(comp["composite"] * SCORE_SCALE, -MAX_RAW, MAX_RAW))

    # Context. These no longer drive the score — measurement showed they carry
    # almost no standalone information — but they explain the setup to a reader
    # and two of them legitimately modulate confidence.
    _trend_context(row, reasons)
    _volume_note(row, reasons)
    adx = _v(row, "ADX")
    atr_pct = _v(row, "ATR_PCT", 0) or 0

    # Confidence starts from how far past the threshold the score sits, then
    # applies only the modulators that survived out-of-sample testing.
    edge = max(0.0, abs(raw) - BUY_THRESHOLD) / (MAX_RAW - BUY_THRESHOLD)
    confidence = 100.0 * (0.45 + 0.35 * min(edge, 1.0))

    if adx is not None and ADX_SWEET_LO <= adx < ADX_SWEET_HI:
        confidence *= 1.20
        reasons.append(f"ADX {adx:.0f} sits in the 30-45 band where this setup "
                       f"historically worked best.")
    elif adx is not None and adx < 20:
        confidence *= 0.85
        reasons.append(f"ADX {adx:.0f} — directionless tape weakens the setup.")

    if atr_pct >= ATR_STRONG:
        confidence *= 1.15
        reasons.append(f"Daily range {atr_pct:.1f}% of price — volatile enough "
                       f"for a reversion move to pay.")
    elif atr_pct < 2.0:
        confidence *= 0.85
        reasons.append(f"Daily range only {atr_pct:.1f}% — moves are too small "
                       f"to clear costs comfortably.")

    if meta.get("thin_history"):
        confidence *= 0.8
    if meta.get("stale_days", 0) > 3:
        confidence *= 0.85
    confidence = float(np.clip(confidence, 0, 100))

    # --- Decision ---
    if raw >= BUY_THRESHOLD:
        signal = "BUY"
    elif raw <= SELL_THRESHOLD:
        signal = "SELL"
    else:
        signal = "HOLD"

    # Confidence gate: with no clear consensus there is no directional call.
    veto = None
    if signal in ("BUY", "SELL") and confidence < MIN_CONFIDENCE:
        veto = f"Confidence {confidence:.0f}% is below the {MIN_CONFIDENCE}% floor."
        signal = "HOLD"
        reasons.append(f"Downgraded to HOLD: {veto}")

    levels = _levels(row, signal)

    # Entry timing is a SEPARATE question from direction. "SELL" tells a holder
    # to get out; whether this exact price is a good place to open a NEW
    # position depends on payoff and how much room there is to the next level.
    entry_timing, timing_note = "NOW", None
    if signal in ("BUY", "SELL"):
        if levels["risk_reward"] < MIN_RISK_REWARD:
            entry_timing = "WAIT"
            timing_note = (f"Risk/reward {levels['risk_reward']:.2f} is below "
                           f"{MIN_RISK_REWARD} — direction is right, price is not.")
        elif levels["room_atr"] is not None and levels["room_atr"] < 1.0:
            entry_timing = "WAIT"
            side = "support" if signal == "SELL" else "resistance"
            timing_note = (f"Only {levels['room_atr']:.1f} ATR of room to the next "
                           f"{side} at Rs. {levels['next_level']:.2f} — wait for a "
                           f"break or a pullback before opening a new position.")
        if timing_note:
            reasons.append(timing_note)

    return {
        "signal": signal,
        "entry_timing": entry_timing,
        "timing_note": timing_note,
        "score": round(raw, 2),
        "confidence": round(confidence, 1),
        "high_conviction": bool(signal != "HOLD" and confidence >= HIGH_CONVICTION),
        "hold_sessions": HOLD_SESSIONS,
        # Backtested as an actual short, SELL returns -1.52% per trade. It is
        # informative for someone already holding the stock and must never be
        # presented as a short entry.
        "tradeable": {"BUY": "LONG", "SELL": "EXIT_ONLY"}.get(signal, "NONE"),
        "regime": regime,
        "reasons": reasons,
        "components": {
            "stretch_5d": round(comp["z_stretch"], 2),
            "macd_hist_z": round(comp["z_macdh"], 2),
            "dist_sma20_z": round(comp["z_dist"], 2),
            "rsi_z": round(comp["z_rsi"], 2),
            "composite": round(comp["composite"], 2),
        },
        "veto": veto,
        **levels,
    }


def _narrate(signal: str, score: float, confidence: float, regime: str,
             reasons: List[str], lv: Dict[str, float], name: str) -> str:
    body = " ".join(reasons)
    regime_label = {
        "TREND": "a trending market", "RANGE": "a range-bound market",
        "TRANSITION": "a market in transition", "UNKNOWN": "an unclear market",
    }.get(regime, "the market")

    timing = lv.get("entry_timing", "NOW")
    if signal == "BUY":
        plan = (
            f"Entry around Rs. {lv['entry']:.2f}, target Rs. {lv['target']:.2f}, "
            f"stop loss Rs. {lv['stop_loss']:.2f} (risk/reward {lv['risk_reward']:.2f}:1). "
            f"This setup is measured over {HOLD_SESSIONS} sessions — close it on time "
            f"even if neither level is reached, because the edge decays after that."
            if timing == "NOW" else
            f"Bias is bullish but this is a poor entry price — wait for a better level "
            f"before buying. Reference plan: target Rs. {lv['target']:.2f}, "
            f"stop Rs. {lv['stop_loss']:.2f}."
        )
        return (f"BUY {name} — score {score:+.1f}, confidence {confidence:.0f}%, "
                f"in {regime_label}. {body} {plan}")
    if signal == "SELL":
        plan = (
            f"If you hold this, close the position near Rs. {lv['entry']:.2f}. "
            f"Do NOT short it: taken as an actual short, signals like this lost "
            f"1.5% per trade in testing. This is an exit and avoid flag only."
            if timing == "NOW" else
            f"If you hold this, plan your exit — the bias is negative. Do not short "
            f"it; this is an exit and avoid flag, not a short entry."
        )
        return (f"SELL {name} — score {score:+.1f}, confidence {confidence:.0f}%, "
                f"in {regime_label}. {body} {plan}")
    return (
        f"HOLD {name} — score {score:+.1f}, confidence {confidence:.0f}%, in {regime_label}. "
        f"{body} No edge worth trading right now. Watch Rs. {lv['stop_loss']:.2f} on the "
        f"downside and Rs. {lv['target']:.2f} on the upside for the next clean setup."
    )


def generate_trade_signal(enriched: Dict[str, Any]) -> Dict[str, Any]:
    """Public entry point. Takes the dict from stock_service.get_enriched()."""
    if "error" in enriched:
        return {"signal": "UNKNOWN", "error": enriched["error"],
                "reasons": [enriched["error"]], "confidence": 0}

    df, meta = enriched["df"], enriched["meta"]
    row = df.iloc[-1]
    res = evaluate(df, -1, meta)

    price = float(row["Close"])
    change = meta.get("live_change")
    change_pct = meta.get("live_change_percent")
    if change is None:
        prev = float(df["Close"].iloc[-2])
        change = price - prev
        change_pct = (change / prev * 100) if prev else 0.0

    def _n(v):
        return None if v is None or pd.isna(v) else float(v)

    return {
        "ticker": meta["ticker"],
        "symbol": meta["symbol"],
        "name": meta["name"],
        "current_price": round(price, 2),
        "change": round(float(change), 2),
        "change_percent": round(float(change_pct), 2),

        "signal": res["signal"],
        "entry_timing": res["entry_timing"],
        "timing_note": res["timing_note"],
        "score": res["score"],
        # How far this is from firing a BUY. A screen full of HOLDs is honest
        # but useless on its own — this lets the UI still answer "what is
        # closest?" without pretending anything crossed the line.
        "distance_to_buy": round(max(0.0, BUY_THRESHOLD - res["score"]), 2),
        "rank_score": res["score"],
        "confidence": res["confidence"],
        "high_conviction": res["high_conviction"],
        "hold_sessions": res["hold_sessions"],
        "tradeable": res["tradeable"],
        "regime": res["regime"],
        "reasons": res["reasons"],
        "components": res["components"],
        "veto": res["veto"],

        "entry": res["entry"],
        "target_buy_price": res["entry"],
        "target_sell_price": res["target"],
        "target": res["target"],
        "next_level": res["next_level"],
        "stop_loss": res["stop_loss"],
        "risk_reward": res["risk_reward"],
        "atr": res["atr"],

        "rsi": _n(row["RSI"]),
        "sma_20": _n(row["SMA_20"]),
        "sma_50": _n(row["SMA_50"]),
        "sma_200": _n(row["SMA_200"]),
        "adx": _n(row["ADX"]),
        "macd": _n(row["MACD"]),
        "macd_signal": _n(row["MACD_Signal"]),
        "macd_hist": _n(row["MACD_Hist"]),
        "support": _n(row["SUPPORT"]),
        "resistance": _n(row["RESISTANCE"]),
        "vol_ratio": _n(row["VOL_RATIO"]),
        "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,

        "updated_at": meta["last_bar"],
        "data_source": meta["source"],
        "stale_days": meta["stale_days"],
        "bars": meta["bars"],

        # UI dials
        "buy_score": round(max(0.0, res["score"]), 2),
        "sell_score": round(max(0.0, -res["score"]), 2),

        "explanation": _narrate(res["signal"], res["score"], res["confidence"],
                                res["regime"], res["reasons"], res, meta["name"]),
    }
