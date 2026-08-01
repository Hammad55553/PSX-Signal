from typing import Dict, Any

def generate_trade_signal(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """
    Analyze indicators to generate professional BUY/SELL/HOLD recommendations
    using a Weighted Confluence Scoring system.
    
    Category Weights:
    - Trend (SMA Cross, Price vs SMA): 40% (Max 4.0 points)
    - Momentum (RSI Levels): 30% (Max 3.0 points)
    - Momentum Crossover (MACD Histogram): 20% (Max 2.0 points)
    - Support / Resistance Proximity: 10% (Max 1.0 point)
    
    Decision Rules:
    - Net Score >= 2.0 -> BUY
    - Net Score <= -2.0 -> SELL
    - -2.0 < Net Score < 2.0 -> HOLD
    """
    if "error" in analysis:
        return {"signal": "UNKNOWN", "reason": "Error in analysis data"}

    rsi = analysis.get("rsi")
    current_price = analysis.get("current_price")
    sma_20 = analysis.get("sma_20")
    sma_50 = analysis.get("sma_50")
    macd = analysis.get("macd")
    macd_signal = analysis.get("macd_signal")
    macd_hist = analysis.get("macd_hist")
    
    high_20 = analysis.get("high_20", current_price * 1.1)
    low_20 = analysis.get("low_20", current_price * 0.9)

    reasons = []
    net_score = 0.0

    # --- 1. TREND CONFLUENCE (Max 4.0 Points) ---
    if sma_20 is not None and sma_50 is not None:
        # Golden Cross (Bullish) or Death Cross (Bearish)
        if sma_20 > sma_50:
            net_score += 2.0
            reasons.append("SMA Golden Cross (20-day SMA is above 50-day SMA) confirms long-term uptrend.")
        else:
            net_score -= 2.0
            reasons.append("SMA Death Cross (20-day SMA is below 50-day SMA) confirms long-term downtrend.")

        # Price position relative to SMA 20
        if current_price > sma_20:
            net_score += 2.0
            reasons.append("Price is trading above 20-day SMA, indicating short-term bullish control.")
        else:
            net_score -= 2.0
            reasons.append("Price is trading below 20-day SMA, indicating short-term bearish pressure.")

    # --- 2. MOMENTUM CONFLUENCE: RSI (Max 3.0 Points) ---
    if rsi is not None:
        if rsi < 30:
            net_score += 3.0
            reasons.append(f"RSI is oversold at {rsi:.2f} (under 30), suggesting a price bounce is highly probable.")
        elif rsi < 40:
            net_score += 1.5
            reasons.append(f"RSI is low at {rsi:.2f} (30-40 zone), indicating strong accumulation interest.")
        elif rsi > 70:
            net_score -= 3.0
            reasons.append(f"RSI is overbought at {rsi:.2f} (above 70), indicating profit-taking / overstretched conditions.")
        elif rsi > 60:
            net_score -= 1.5
            reasons.append(f"RSI is elevated at {rsi:.2f} (60-70 zone), suggesting upward momentum is slowing down.")
        else:
            reasons.append(f"RSI is neutral at {rsi:.2f}, representing a balanced distribution of power.")

    # --- 3. MOMENTUM CONFLUENCE: MACD (Max 2.0 Points) ---
    if macd is not None and macd_signal is not None and macd_hist is not None:
        if macd > macd_signal:
            # Bullish MACD Crossover
            if macd_hist > 0:
                net_score += 2.0
                reasons.append("MACD is positive and histogram is expanding upwards, indicating strong bullish velocity.")
            else:
                net_score += 1.0
                reasons.append("MACD line is above signal line but momentum is softening.")
        else:
            # Bearish MACD Crossover
            if macd_hist < 0:
                net_score -= 2.0
                reasons.append("MACD is negative and histogram is expanding downwards, indicating heavy distribution velocity.")
            else:
                net_score -= 1.0
                reasons.append("MACD line is below signal line but downward pressure is plateauing.")

    # --- 4. SUPPORT & RESISTANCE CONFLUENCE (Max 1.0 Point) ---
    is_at_support = current_price <= (low_20 * 1.025)
    is_at_resistance = current_price >= (high_20 * 0.975)

    if is_at_support:
        net_score += 1.0
        reasons.append("Price is testing critical 20-day support band. High probability bounce zone.")
    elif is_at_resistance:
        net_score -= 1.0
        reasons.append("Price is testing key 20-day resistance ceiling. High risk of profit-taking rejection.")

    # --- 5. SIGNAL DECISION ---
    # With a maximum possible score range of -9.0 to +10.0,
    # we set thresholds higher to prevent normal market noise from triggering constant BUY/SELL.
    # Score >= 4.0 -> BUY (Clear strong bullish confluence)
    # Score <= -4.0 -> SELL (Clear strong bearish confluence)
    # Otherwise -> HOLD (Sideways, consolidation or minor correction)
    if net_score >= 4.0:
        signal = "BUY"
    elif net_score <= -4.0:
        signal = "SELL"
    else:
        signal = "HOLD"

    # Map scores for UI dials (0 to 10 scale)
    buy_score = min(10.0, max(0.0, net_score))
    sell_score = min(10.0, max(0.0, -net_score))

    # Calculate Day Trading Pivot Point targets (based on yesterday's session OHLC)
    prev_high = analysis.get("prev_high", current_price)
    prev_low = analysis.get("prev_low", current_price)
    prev_close = analysis.get("prev_close", current_price)
    
    if prev_high == prev_low or prev_high == 0:
        target_buy = current_price * 0.995
        target_sell = current_price * 1.005
        stop_loss = target_buy * 0.99
    else:
        pivot = (prev_high + prev_low + prev_close) / 3.0
        s1 = (2.0 * pivot) - prev_high
        r1 = (2.0 * pivot) - prev_low
        s2 = pivot - (prev_high - prev_low)
        r2 = pivot + (prev_high - prev_low)
        
        if signal == "BUY":
            target_buy = current_price
            target_sell = r1 if current_price < r1 else r2
            stop_loss = target_buy * 0.99
        elif signal == "SELL":
            target_buy = s1 if current_price > s1 else s2
            target_sell = current_price
            stop_loss = target_buy * 0.99
        else: # HOLD
            target_buy = s1 if current_price > s1 else s2
            target_sell = r1 if current_price < r1 else r2
            stop_loss = target_buy * 0.99

    # Generate professional written rationale explanation
    reasons_str = " ".join(reasons)
    if signal == "BUY":
        explanation = (
            f"Technical Confluence points to a BUY (Net Score: +{net_score:.1f}). "
            f"The bullish recommendation is confirmed by multiple vectors: {reasons_str} "
            f"A long entry is recommended at or above Rs. {target_buy:.2f} with a profit target of Rs. {target_sell:.2f} "
            f"and a strict risk management Stop Loss set at Rs. {stop_loss:.2f}."
        )
    elif signal == "SELL":
        explanation = (
            f"Technical Confluence points to a SELL (Net Score: {net_score:.1f}). "
            f"The bearish recommendation is triggered by the following setup: {reasons_str} "
            f"Buying in this zone carries extreme risk. We advise closing long positions or waiting in cash "
            f"until a clean accumulation re-entry forms around Rs. {target_buy:.2f}."
        )
    else: # HOLD
        explanation = (
            f"Technical Confluence indicates a HOLD / Neutral bias (Net Score: {net_score:.1f}). "
            f"Bullish indicators and bearish indicators are balanced: {reasons_str} "
            f"Sideways consolidation is dominant. Standard trading boundaries are established: Buy bounce near Rs. {target_buy:.2f} "
            f"and Sell breakout rejection near Rs. {target_sell:.2f}."
        )

    return {
        "ticker": analysis.get("ticker"),
        "name": analysis.get("name", f"{analysis.get('ticker', '').replace('.KA', '')} Limited"),
        "current_price": current_price,
        "signal": signal,
        "reasons": reasons,
        "buy_score": buy_score,
        "sell_score": sell_score,
        "rsi": rsi,
        "sma_20": sma_20,
        "sma_50": sma_50,
        "target_buy_price": float(target_buy),
        "target_sell_price": float(target_sell),
        "stop_loss": float(stop_loss),
        "macd": analysis.get("macd"),
        "macd_signal": analysis.get("macd_signal"),
        "macd_hist": analysis.get("macd_hist"),
        "change": analysis.get("change"),
        "change_percent": analysis.get("change_percent"),
        "volume": analysis.get("volume"),
        "updated_at": analysis.get("updated_at"),
        "explanation": explanation
    }
