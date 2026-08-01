import yfinance as yf
import pandas as pd
import numpy as np
import requests
import re
from bs4 import BeautifulSoup
from typing import Dict, Any

def scrape_live_price(symbol: str) -> Dict[str, Any]:
    """Scrape live price, change and company name from official PSX Data Portal"""
    clean_sym = symbol.replace('.KA', '').upper()
    url = f"https://dps.psx.com.pk/company/{clean_sym}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
    try:
        res = requests.get(url, headers=headers, timeout=5)
        if res.status_code == 200:
            soup = BeautifulSoup(res.content, 'html.parser')
            
            # Extract company name from title
            title_str = soup.title.string if soup.title else ""
            name_match = re.search(r"Stock quote for\s+(.*?)\s+-", title_str)
            company_name = name_match.group(1).strip() if name_match else f"{clean_sym} Limited"
            
            price_div = soup.find(class_=re.compile("quote__close|price|close"))
            if price_div:
                text = price_div.get_text().replace('Rs.', '').strip()
                text = re.sub(r'\s+', ' ', text)
                match = re.search(r'([\d\.,]+)\s+([-\+\d\.,]+)\s+\(?([-\+\d\.,]+)%?\)?', text)
                if match:
                    return {
                        "price": float(match.group(1).replace(',', '')),
                        "change": float(match.group(2).replace(',', '')),
                        "change_percent": float(match.group(3).replace(',', '')),
                        "name": company_name
                    }
    except Exception as e:
        print(f"Scraper error for {symbol}: {e}")
    return {}


def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Calculate Relative Strength Index (RSI)"""
    delta = series.diff()
    gain = (delta.where(delta > 0, 0)).copy()
    loss = (-delta.where(delta < 0, 0)).copy()

    # Use exponential moving average
    avg_gain = gain.ewm(com=period - 1, adjust=False).mean()
    avg_loss = loss.ewm(com=period - 1, adjust=False).mean()

    rs = avg_gain / (avg_loss + 1e-10) # Avoid division by zero
    rsi = 100 - (100 / (1 + rs))
    return rsi

def calculate_macd(series: pd.Series, fast_period: int = 12, slow_period: int = 26, signal_period: int = 9) -> Dict[str, pd.Series]:
    """Calculate MACD (Moving Average Convergence Divergence)"""
    ema_fast = series.ewm(span=fast_period, adjust=False).mean()
    ema_slow = series.ewm(span=slow_period, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal_period, adjust=False).mean()
    macd_hist = macd_line - signal_line
    return {
        "macd": macd_line,
        "signal": signal_line,
        "hist": macd_hist
    }

def get_stock_analysis(ticker: str, period: str = "3mo") -> Dict[str, Any]:
    """Fetch history from yfinance, override with live PSX scraped quotes, and calculate indicators"""
    try:
        stock = yf.Ticker(ticker)
        df = stock.history(period=period)
        
        if df.empty:
            return {"error": f"No data found for ticker {ticker}"}

        # Override last record with official scraped PSX price to prevent delays/differences
        live = scrape_live_price(ticker)
        if live:
            df.iloc[-1, df.columns.get_loc('Close')] = live["price"]
            df.iloc[-1, df.columns.get_loc('High')] = max(df.iloc[-1]['High'], live["price"])
            df.iloc[-1, df.columns.get_loc('Low')] = min(df.iloc[-1]['Low'], live["price"])

        # Calculate indicators
        close_prices = df['Close']
        df['RSI'] = calculate_rsi(close_prices)
        df['SMA_20'] = close_prices.rolling(window=20).mean()
        df['SMA_50'] = close_prices.rolling(window=50).mean()
        
        # Support and Resistance estimates
        df['High_20'] = df['High'].rolling(window=20).max()
        df['Low_20'] = df['Low'].rolling(window=20).min()
        
        macd_data = calculate_macd(close_prices)
        df['MACD'] = macd_data['macd']
        df['MACD_Signal'] = macd_data['signal']
        df['MACD_Hist'] = macd_data['hist']

        # Get latest record
        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else latest

        return {
            "ticker": ticker,
            "name": live.get("name", f"{ticker.replace('.KA', '')} Limited"),
            "current_price": float(live.get("price", latest['Close'])),
            "change": float(live.get("change", latest['Close'] - prev['Close'])),
            "change_percent": float(live.get("change_percent", ((latest['Close'] - prev['Close']) / prev['Close']) * 100)) if float(prev['Close']) != 0 else 0.0,
            "rsi": float(latest['RSI']) if not pd.isna(latest['RSI']) else None,
            "sma_20": float(latest['SMA_20']) if not pd.isna(latest['SMA_20']) else None,
            "sma_50": float(latest['SMA_50']) if not pd.isna(latest['SMA_50']) else None,
            "high_20": float(latest['High_20']) if not pd.isna(latest['High_20']) else None,
            "low_20": float(latest['Low_20']) if not pd.isna(latest['Low_20']) else None,
            "macd": float(latest['MACD']) if not pd.isna(latest['MACD']) else None,
            "macd_signal": float(latest['MACD_Signal']) if not pd.isna(latest['MACD_Signal']) else None,
            "macd_hist": float(latest['MACD_Hist']) if not pd.isna(latest['MACD_Hist']) else None,
            "volume": int(latest['Volume']),
            "updated_at": latest.name.strftime('%Y-%m-%d %H:%M:%S') if hasattr(latest.name, 'strftime') else str(latest.name),
            "prev_high": float(prev['High']),
            "prev_low": float(prev['Low']),
            "prev_close": float(prev['Close'])
        }
    except Exception as e:
        return {"error": str(e)}
