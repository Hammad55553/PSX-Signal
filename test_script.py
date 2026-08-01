from services.stock_service import get_stock_analysis
from services.signal_generator import generate_trade_signal

def test():
    print("Testing stock service fetching for SYS.KA...")
    analysis = get_stock_analysis("SYS.KA")
    if "error" in analysis:
        print(f"Error fetching data: {analysis['error']}")
        return

    print(f"Current Price: {analysis['current_price']}")
    print(f"RSI: {analysis['rsi']}")
    print(f"SMA 20: {analysis['sma_20']}")
    print(f"SMA 50: {analysis['sma_50']}")
    print(f"MACD: {analysis['macd']}")
    
    print("\nGenerating signal...")
    signal_res = generate_trade_signal(analysis)
    print(f"Ticker: {signal_res['ticker']}")
    print(f"Signal: {signal_res['signal']}")
    print(f"Reasons: {signal_res['reasons']}")

if __name__ == "__main__":
    test()
