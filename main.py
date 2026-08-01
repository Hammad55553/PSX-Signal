from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Any
from config import DEFAULT_TICKERS
from services.stock_service import get_stock_analysis
from services.signal_generator import generate_trade_signal

app = FastAPI(
    title="PSX Trading Bot API",
    description="FastAPI Backend for Pakistan Stock Exchange (PSX) Analysis and Trade Signals",
    version="1.0.0"
)

# Enable CORS so the React frontend (on any domain) can call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    """API health check — frontend is served by Vercel static hosting"""
    return {"status": "online", "api": "PSX Trading Bot v1.0"}

@app.get("/tickers", response_model=List[str])
def get_tickers():
    """Get list of supported/tracked PSX tickers"""
    return DEFAULT_TICKERS

@app.get("/analyze/{ticker}")
def analyze_ticker(ticker: str):
    """Retrieve historical data & calculate technical indicators for a specific ticker"""
    # Ensure ticker format matches Yahoo Finance (append .KA if not present)
    formatted_ticker = ticker.upper()
    if not formatted_ticker.endswith(".KA"):
        formatted_ticker = f"{formatted_ticker}.KA"

    result = get_stock_analysis(formatted_ticker)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result

@app.get("/signal/{ticker}")
def get_signal(ticker: str):
    """Get trade signals (BUY/SELL/HOLD) for a specific ticker"""
    formatted_ticker = ticker.upper()
    if not formatted_ticker.endswith(".KA"):
        formatted_ticker = f"{formatted_ticker}.KA"

    analysis = get_stock_analysis(formatted_ticker)
    if "error" in analysis:
        raise HTTPException(status_code=404, detail=analysis["error"])

    signal = generate_trade_signal(analysis)
    return signal

@app.get("/signals/all")
def get_all_signals():
    """Get current signal evaluation for all preconfigured PSX tickers"""
    signals = []
    for ticker in DEFAULT_TICKERS:
        analysis = get_stock_analysis(ticker)
        if "error" not in analysis:
            signal = generate_trade_signal(analysis)
            signals.append(signal)
    return {
        "total_analyzed": len(signals),
        "results": signals
    }

from pydantic import BaseModel
from services.alert_service import send_telegram_alert

class TelegramConfig(BaseModel):
    token: str
    chat_id: str
    message: str

@app.post("/send-alert")
def trigger_alert(config: TelegramConfig):
    success = send_telegram_alert(config.token, config.chat_id, config.message)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to send Telegram alert")
    return {"status": "success", "message": "Alert sent successfully"}

import asyncio
import concurrent.futures

# Create a thread pool executor for parallel scraping of default tickers
executor = concurrent.futures.ThreadPoolExecutor(max_workers=10)

@app.websocket("/ws/signals")
async def websocket_signals(websocket: WebSocket):
    await websocket.accept()
    loop = asyncio.get_event_loop()
    try:
        while True:
            # Run get_stock_analysis concurrently in threads to bypass sequential HTTP blocking
            tasks = [
                loop.run_in_executor(executor, get_stock_analysis, ticker)
                for ticker in DEFAULT_TICKERS
            ]
            analyses = await asyncio.gather(*tasks)
            
            signals = []
            for analysis in analyses:
                if analysis and "error" not in analysis:
                    signal = generate_trade_signal(analysis)
                    signals.append(signal)
            
            await websocket.send_json({
                "total_analyzed": len(signals),
                "results": signals
            })
            # Check for live market updates every 3 seconds
            await asyncio.sleep(3)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")

@app.get("/signals")
async def get_all_signals():
    """Evaluate and return trade signals for all default tickers at once"""
    loop = asyncio.get_event_loop()
    try:
        tasks = [
            loop.run_in_executor(executor, get_stock_analysis, ticker)
            for ticker in DEFAULT_TICKERS
        ]
        analyses = await asyncio.gather(*tasks)
        
        signals = []
        for analysis in analyses:
            if analysis and "error" not in analysis:
                signal = generate_trade_signal(analysis)
                signals.append(signal)
        return {"total_analyzed": len(signals), "results": signals}
    except Exception as e:
        return {"error": str(e)}

import requests

@app.get("/chart/{symbol}")
def get_chart_data(symbol: str):
    """Proxy official intraday timeseries from PSX Data Portal"""
    clean_sym = symbol.replace('.KA', '').upper()
    url = f"https://dps.psx.com.pk/timeseries/int/{clean_sym}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
    try:
        res = requests.get(url, headers=headers, timeout=5)
        if res.status_code == 200:
            return res.json().get("data", [])
    except Exception as e:
        print(f"Chart proxy error: {e}")
    return []

@app.get("/symbols")
def get_symbols():
    """Proxy the official PSX symbols dictionary"""
    url = "https://dps.psx.com.pk/symbols"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            return res.json()
    except Exception as e:
        print(f"Symbols proxy error: {e}")
    return []

from bs4 import BeautifulSoup

@app.get("/market-recommendations")
def get_market_recommendations():
    """Scrape and return daily buy/sell recommendations from psxtechnicalanalysis.com"""
    url = "https://psxtechnicalanalysis.com/buy-sell-signals/"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            soup = BeautifulSoup(res.content, 'html.parser')
            tables = soup.find_all('table')
            
            buy_list = []
            sell_list = []
            
            for table in tables:
                headers_text = [th.get_text().strip() for th in table.find_all('th')]
                
                # Check for Recommended to Buy
                if any('Recommended to Buy' in h for h in headers_text):
                    rows = table.find_all('tr')
                    for row in rows[1:]: # skip header
                        cells = [td.get_text().strip() for td in row.find_all('td')]
                        if len(cells) >= 2:
                            buy_list.append({"symbol": cells[0], "strength": cells[1]})
                
                # Check for Recommended to Sell
                if any('Recommended to Sell' in h for h in headers_text):
                    rows = table.find_all('tr')
                    for row in rows[1:]: # skip header
                        cells = [td.get_text().strip() for td in row.find_all('td')]
                        if len(cells) >= 2:
                            sell_list.append({"symbol": cells[0], "strength": cells[1]})
            
            return {
                "buy_recommendations": buy_list,
                "sell_recommendations": sell_list
            }
    except Exception as e:
        print(f"Error scraping market recommendations: {e}")
    return {"buy_recommendations": [], "sell_recommendations": []}



