from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os
import time
from typing import List, Dict, Any
from config import DEFAULT_TICKERS
from services.stock_service import get_stock_analysis, get_enriched
from services.signal_generator import generate_trade_signal
from services.intraday import get_prior_close, gap_fade_signal

app = FastAPI(
    title="PSX Trading Bot API",
    description="FastAPI Backend for Pakistan Stock Exchange (PSX) Analysis and Trade Signals",
    version="1.0.0"
)

# Enable CORS for React Native and frontend apps
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve React build (static files) from /frontend/dist
# Use absolute path resolving from the script file location
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.join(BASE_DIR, "frontend", "dist")

if os.path.exists(FRONTEND_DIST):
    # Mount /assets for Vite-compiled JS/CSS bundles
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

@app.get("/assets/index.js")
def serve_js():
    f = os.path.join(FRONTEND_DIST, "assets", "index.js")
    if os.path.exists(f):
        return FileResponse(f, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="index.js not found")

@app.get("/assets/index.css")
def serve_css():
    f = os.path.join(FRONTEND_DIST, "assets", "index.css")
    if os.path.exists(f):
        return FileResponse(f, media_type="text/css")
    raise HTTPException(status_code=404, detail="index.css not found")

@app.get("/favicon.svg")
def favicon():
    f = os.path.join(FRONTEND_DIST, "favicon.svg")
    return FileResponse(f) if os.path.exists(f) else {"error": "not found"}

@app.get("/icons.svg")
def icons():
    f = os.path.join(FRONTEND_DIST, "icons.svg")
    return FileResponse(f) if os.path.exists(f) else {"error": "not found"}

@app.get("/")
def read_root():
    # Serve React SPA index.html
    index_file = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file, media_type="text/html")
    return {
        "status": "online",
        "message": "PSX Trading Bot API — deploy frontend build to frontend/dist"
    }

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

    enriched = get_enriched(formatted_ticker)
    if "error" in enriched:
        raise HTTPException(status_code=404, detail=enriched["error"])

    return generate_trade_signal(enriched)

def _signal_for(ticker: str):
    """Fetch + score one ticker. Returns None if it has no usable data."""
    enriched = get_enriched(ticker)
    if "error" in enriched:
        return None
    return generate_trade_signal(enriched)

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

async def _scan_all():
    """Score every tracked ticker in parallel, ranked best-first."""
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(executor, _signal_for, t) for t in DEFAULT_TICKERS]
    results = [s for s in await asyncio.gather(*tasks) if s]
    # Highest score first so the UI's top row is the strongest candidate
    results.sort(key=lambda s: -s.get("score", 0))
    return {
        "total_analyzed": len(results),
        "actionable": sum(1 for s in results if s["signal"] != "HOLD"),
        "high_conviction": sum(1 for s in results if s.get("high_conviction")),
        "results": results,
        "scanned_at": time.time(),
    }


# One scan hits the PSX portal once per ticker and takes ~20-40s. Doing that
# per client per tick would both throttle the upstream IP and leave every new
# viewer staring at an empty screen until their own scan finished.
#
# Instead a single background task owns the refresh, every client reads the
# same cached snapshot, and new clients get the latest one immediately.
REFRESH_SECONDS = 45

_cache: Dict[str, Any] = {"data": None, "scanning": False}
_subscribers: "set[asyncio.Queue]" = set()


async def _refresh_loop():
    """Own the scan cadence and fan results out to every connected client."""
    while True:
        try:
            _cache["scanning"] = True
            data = await _scan_all()
            _cache["data"] = data
            for q in list(_subscribers):
                # Never let one slow client stall the loop.
                if not q.full():
                    q.put_nowait(data)
        except Exception as e:
            print(f"[refresh] {e}")
        finally:
            _cache["scanning"] = False
        await asyncio.sleep(REFRESH_SECONDS)


@app.on_event("startup")
async def _start_refresh():
    asyncio.create_task(_refresh_loop())
    asyncio.create_task(_market_loop())
    asyncio.create_task(_intraday_loop())


@app.websocket("/ws/signals")
async def websocket_signals(websocket: WebSocket):
    await websocket.accept()
    queue: asyncio.Queue = asyncio.Queue(maxsize=2)
    _subscribers.add(queue)
    try:
        # Send whatever we already have so the UI paints instantly instead of
        # waiting out a full scan.
        if _cache["data"]:
            await websocket.send_json(_cache["data"])
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        _subscribers.discard(queue)


@app.get("/signals")
async def get_signals():
    """Trade signals for every tracked ticker, ranked by score."""
    try:
        if _cache["data"]:
            return _cache["data"]
        # First caller before the background loop has finished: scan inline.
        data = await _scan_all()
        _cache["data"] = data
        return data
    except Exception as e:
        return {"error": str(e)}


@app.get("/signals/all")
async def get_signals_all():
    """Backwards-compatible alias for /signals."""
    return await get_signals()


# --- Market-wide scan -------------------------------------------------------
#
# Scanning the whole exchange is a different problem from the watchlist: ~500
# listed symbols, each needing a history fetch, and the upstream sources will
# throttle a burst that size. So it runs on its own slower cycle, over a capped
# universe of the liquid names, and is served purely from cache.

MARKET_UNIVERSE_CAP = int(os.environ.get("PSX_MARKET_CAP", "150"))
MARKET_REFRESH_SECONDS = 15 * 60
MARKET_CONCURRENCY = 8

_market: Dict[str, Any] = {"data": None, "scanning": False, "progress": 0, "total": 0}


def _market_universe() -> List[str]:
    """Symbols to sweep. Defaults first, then the official PSX list."""
    universe = list(DEFAULT_TICKERS)
    try:
        res = requests.get("https://dps.psx.com.pk/symbols", headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }, timeout=10)
        if res.status_code == 200:
            for row in res.json():
                sym = (row.get("symbol") or "").strip().upper()
                # Skip debt/index rows and anything non-alphabetic
                if sym and sym.isalpha() and len(sym) <= 8:
                    t = f"{sym}.KA"
                    if t not in universe:
                        universe.append(t)
    except Exception as e:
        print(f"[market] symbol list unavailable: {e}")
    return universe[:MARKET_UNIVERSE_CAP]


async def _scan_market():
    loop = asyncio.get_event_loop()
    universe = _market_universe()
    _market.update({"scanning": True, "progress": 0, "total": len(universe)})

    sem = asyncio.Semaphore(MARKET_CONCURRENCY)
    results: List[Dict[str, Any]] = []

    async def one(ticker: str):
        async with sem:
            sig = await loop.run_in_executor(executor, _signal_for, ticker)
            _market["progress"] += 1
            if sig:
                results.append(sig)

    await asyncio.gather(*(one(t) for t in universe), return_exceptions=True)
    results.sort(key=lambda s: -s.get("score", 0))

    _market["data"] = {
        "total_analyzed": len(results),
        "universe": len(universe),
        "actionable": sum(1 for s in results if s["signal"] != "HOLD"),
        "high_conviction": sum(1 for s in results if s.get("high_conviction")),
        "results": results,
        "scanned_at": time.time(),
    }
    _market["scanning"] = False
    print(f"[market] scanned {len(results)}/{len(universe)} symbols")


async def _market_loop():
    while True:
        try:
            await _scan_market()
        except Exception as e:
            _market["scanning"] = False
            print(f"[market] {e}")
        await asyncio.sleep(MARKET_REFRESH_SECONDS)


@app.get("/market/scan")
async def market_scan():
    """Signals across the whole tracked market, so filters can span the
    exchange rather than only the user's watchlist."""
    if _market["data"]:
        return _market["data"]
    return {
        "results": [],
        "total_analyzed": 0,
        "scanning": _market["scanning"],
        "progress": _market["progress"],
        "universe": _market["total"],
        "message": "First market sweep in progress — this takes a few minutes.",
    }


@app.get("/market/status")
def market_status():
    data = _market["data"]
    return {
        "scanning": _market["scanning"],
        "progress": _market["progress"],
        "universe": _market["total"],
        "scanned_at": data.get("scanned_at") if data else None,
        "count": data.get("total_analyzed") if data else 0,
    }


# --- Intraday gap-fade scan -------------------------------------------------
#
# Validated separately from the daily model (see research_intraday.py):
# a big overnight gap DOWN on PSX has historically closed back up ~1.5-2% by
# end of session (72-80% win rate, out-of-sample). Nothing else tested on
# 5-min bars cleared the round-trip cost. Runs on its own fast loop against
# the PSX Data Portal's live tick feed, separate from the daily signal cache.
INTRADAY_REFRESH_SECONDS = 120
_intraday: Dict[str, Any] = {"data": None, "scanning": False}
# Keyed by (ticker, today's date) so a long-lived process (unlike Vercel's
# cold-started functions) still refetches "prior close" once the session
# rolls over, instead of quoting yesterday's number forever.
_prior_close_cache: Dict[tuple, float] = {}


def _gap_fade_for(ticker: str):
    cache_key = (ticker, time.strftime("%Y-%m-%d"))
    pc = _prior_close_cache.get(cache_key)
    if pc is None:
        pc = get_prior_close(ticker)
        if pc:
            _prior_close_cache[cache_key] = pc
    if not pc:
        return None
    return gap_fade_signal(ticker, pc)


async def _scan_intraday():
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(executor, _gap_fade_for, t) for t in DEFAULT_TICKERS]
    results = [s for s in await asyncio.gather(*tasks) if s]
    results.sort(key=lambda s: s["gap_pct"])  # deepest gap-down first
    return {
        "strategy": "gap_fade",
        "opportunities": results,
        "scanned_at": time.time(),
    }


async def _intraday_loop():
    while True:
        try:
            _intraday["scanning"] = True
            _intraday["data"] = await _scan_intraday()
        except Exception as e:
            print(f"[intraday] {e}")
        finally:
            _intraday["scanning"] = False
        await asyncio.sleep(INTRADAY_REFRESH_SECONDS)


@app.get("/intraday/scan")
async def intraday_scan():
    """Today's gap-fade opportunities — long-only, hold-to-close, day-trade signal."""
    if _intraday["data"]:
        return _intraday["data"]
    # Serverless deployments don't guarantee the background loop gets to run
    # between cold starts, same reasoning as /signals below.
    data = await _scan_intraday()
    _intraday["data"] = data
    return data


@app.get("/status")
def get_status():
    """Freshness of the cached scan, for the UI's live indicator."""
    data = _cache["data"]
    return {
        "scanning": _cache["scanning"],
        "scanned_at": data.get("scanned_at") if data else None,
        "age_seconds": (time.time() - data["scanned_at"]) if data else None,
        "refresh_seconds": REFRESH_SECONDS,
    }

import requests

@app.get("/chart/{symbol}")
def get_chart_data(symbol: str):
    """Proxy TradingView OHLC history from EK Global Capital for candle charts"""
    clean_sym = symbol.replace('.KA', '').upper()
    # Fetch 90 days of daily history for rendering beautiful candlesticks
    import time
    to_time = int(time.time())
    from_time = to_time - (90 * 24 * 60 * 60) # 90 days ago
    url = f"https://api.ekglobalcapital.com/tvfeed/history?symbol={clean_sym}&resolution=D&from={from_time}&to={to_time}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            return _sanitize_ohlc(res.json())
    except Exception as e:
        print(f"TradingView chart proxy error: {e}")
    return {"s": "no_data"}


def _sanitize_ohlc(data: dict) -> dict:
    """Drop corrupt bars from the upstream feed.

    The EK/TradingView feed occasionally returns a bar with a high several
    times the real price (SYS, normally ~130, came back with a 665 high).
    A single bar like that destroys the chart's y-scale and would poison any
    indicator computed from it, so bars more than 5x off the median close are
    discarded rather than displayed.
    """
    if data.get("s") != "ok" or not data.get("c"):
        return data

    closes = sorted(c for c in data["c"] if c and c > 0)
    if not closes:
        return data
    median = closes[len(closes) // 2]
    series_lo, series_hi = median / 5.0, median * 5.0

    def is_sane(i: int) -> bool:
        o, h, l, c = data["o"][i], data["h"][i], data["l"][i], data["c"][i]
        if any(v is None or v <= 0 for v in (o, h, l, c)):
            return False
        # The close must sit in the same universe as the rest of the series.
        if not series_lo <= c <= series_hi:
            return False
        if h < l:
            return False
        # Per-bar consistency is what actually catches the real corruption:
        # SYS printed a 626 high against its own ~135 close, which passes any
        # series-wide band but is obviously not a real wick.
        body_hi, body_lo = max(o, c), min(o, c)
        if h > body_hi * 1.5 or l < body_lo / 1.5:
            return False
        return True

    keep = [i for i in range(len(data["c"])) if is_sane(i)]

    if len(keep) == len(data["c"]):
        return data

    print(f"[chart] dropped {len(data['c']) - len(keep)} corrupt bar(s)")
    out = {"s": "ok"}
    for key in ("t", "o", "h", "l", "c", "v"):
        if key in data:
            out[key] = [data[key][i] for i in keep]
    return out

@app.get("/analyst/{symbol}")
def get_analyst_company_info(symbol: str):
    """Proxy Company info and Analyst opinion from EK Global Capital askanalyst API"""
    clean_sym = symbol.replace('.KA', '').upper()
    url = f"https://api.ekglobalcapital.com/market/askanalyst/company/{clean_sym}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            return res.json()
    except Exception as e:
        print(f"Analyst proxy error: {e}")
    return {"status": "error", "message": "Company data not available"}

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
