from typing import Dict, Any

def generate_trade_signal(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Analyze indicators to generate BUY/SELL/HOLD recommendation"""
    if "error" in analysis:
        return {"signal": "UNKNOWN", "reason": "Error in analysis data"}

    rsi = analysis.get("rsi")
    current_price = analysis.get("current_price")
    sma_20 = analysis.get("sma_20")
    sma_50 = analysis.get("sma_50")
    macd = analysis.get("macd")
    macd_signal = analysis.get("macd_signal")
    macd_hist = analysis.get("macd_hist")

    reasons = []
    
    # Extract 20-day high (resistance) and low (support)
    high_20 = analysis.get("high_20", current_price * 1.1)
    low_20 = analysis.get("low_20", current_price * 0.9)

    # Check if price is near support or resistance
    is_at_support = current_price <= (low_20 * 1.025)  # Within 2.5% of 20-day support
    is_at_resistance = current_price >= (high_20 * 0.975)  # Within 2.5% of 20-day resistance

    # Determine trend and momentum flags
    is_bullish_trend = False
    is_bearish_trend = False
    if sma_20 is not None and sma_50 is not None:
        is_bullish_trend = current_price > sma_20 and sma_20 > sma_50
        is_bearish_trend = current_price < sma_20 and sma_20 < sma_50

    is_bullish_momentum = False
    if macd is not None and macd_signal is not None:
        is_bullish_momentum = macd > macd_signal

    buy_score = 0.0
    sell_score = 0.0

    # 1. Evaluate indicators for Spot Market Rules
    if rsi is not None and rsi <= 35:
        # Stock is heavily oversold. Never SELL at the bottom in Spot trading!
        signal = "BUY" if (is_at_support or rsi < 30) else "HOLD"
        buy_score = 3.0
        if rsi < 30:
            reasons.append(f"RSI is oversold at {rsi:.2f} (under 30) near support. Strong accumulation bounce zone.")
        else:
            reasons.append(f"RSI is low at {rsi:.2f} (under 35). Price is consolidating. Hold position.")
            
    elif rsi is not None and rsi >= 65:
        # Stock is overbought. Profit taking / Exit zone.
        signal = "SELL" if (is_at_resistance or rsi > 70) else "HOLD"
        sell_score = 3.0
        if rsi > 70:
            reasons.append(f"RSI is overbought at {rsi:.2f} (above 70) near resistance. Book profits.")
        else:
            reasons.append(f"RSI is high at {rsi:.2f} (above 65). Upward momentum slowing. Prepare to exit.")
            
    else:
        # Neutral RSI Zone (35 to 65) - base signals on trend and momentum
        if is_bullish_trend and is_bullish_momentum:
            signal = "BUY"
            buy_score = 2.5
            reasons.append("Strong bullish trend (SMA) and upward momentum (MACD) confirmed. Safe entry.")
        elif is_bearish_trend and not is_bullish_momentum:
            if is_at_support:
                signal = "HOLD"
                buy_score = 1.0
                reasons.append("Bearish trend, but price is sitting on critical 20-day support. Hold for bounce.")
            else:
                signal = "SELL"
                sell_score = 2.5
                reasons.append("Bearish trend and negative momentum. Sell/Exit to protect spot capital.")
        else:
            signal = "HOLD"
            reasons.append("Price moving sideways within neutral bands. Hold and wait for trend breakout.")

    # Calculate Day Trading Pivot Point targets (based on yesterday's session OHLC)
    prev_high = analysis.get("prev_high", current_price)
    prev_low = analysis.get("prev_low", current_price)
    prev_close = analysis.get("prev_close", current_price)
    
    if prev_high == prev_low or prev_high == 0:
        # Fallback if no range
        target_buy = current_price * 0.995
        target_sell = current_price * 1.005
        stop_loss = target_buy * 0.99  # Tight 1% stop loss for day trading
    else:
        pivot = (prev_high + prev_low + prev_close) / 3.0
        s1 = (2.0 * pivot) - prev_high
        r1 = (2.0 * pivot) - prev_low
        s2 = pivot - (prev_high - prev_low)
        r2 = pivot + (prev_high - prev_low)
        
        # Determine day trading entry/exit levels
        if signal == "BUY":
            target_buy = current_price
            target_sell = r1 if current_price < r1 else r2
            stop_loss = target_buy * 0.99  # Tight 1% stop loss below entry
        elif signal == "SELL":
            target_buy = s1 if current_price > s1 else s2
            target_sell = current_price
            stop_loss = target_buy * 0.99  # Tight 1% stop loss below target buy
        else: # HOLD
            target_buy = s1 if current_price > s1 else s2
            target_sell = r1 if current_price < r1 else r2
            stop_loss = target_buy * 0.99  # Tight 1% stop loss below target buy

    # Generate written natural language explanation
    reasons_str = ", ".join([r.lower() for r in reasons])
    if signal == "BUY":
        explanation = (
            f"This stock has a BUY recommendation based on strong bullish indicators: {reasons_str}. "
            f"With an active buy rating (score: {buy_score:.1f}), the indicators show the stock has reached "
            f"a significant support level or is beginning an upward breakout. This represents a solid entry "
            f"opportunity near Rs. {target_buy:.2f}."
        )
    elif signal == "SELL":
        explanation = (
            f"This stock is currently a SELL. The analysis shows: {reasons_str}. "
            f"Even if some individual indicators appear oversold, the dominant trend is strongly bearish or showing downward "
            f"momentum (score: {sell_score:.1f}). It is NOT a BUY right now because buying here carries a high risk of catching "
            f"a falling knife. We advise exiting or holding cash, and waiting for a confirmed re-entry buy level near Rs. {target_buy:.2f}."
        )
    else: # HOLD
        explanation = (
            f"This stock is currently a HOLD. The indicators show a mixed or sideways market: {reasons_str}. "
            f"Buy momentum ({buy_score:.1f}) and sell momentum ({sell_score:.1f}) are closely balanced. "
            f"It is NOT a BUY because there is no clear upward trend or breakout confirmation yet, and it is NOT "
            f"a SELL because support levels are holding. We recommend waiting for a clear direction before making a spot trade."
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
