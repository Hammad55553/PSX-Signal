import requests

def send_telegram_alert(token: str, chat_id: str, message: str) -> bool:
    """Send immediate notification to Telegram Channel/Group"""
    if not token or not chat_id:
        return False
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML"
        }
        res = requests.post(url, json=payload, timeout=5)
        return res.status_code == 200
    except Exception as e:
        print(f"Telegram notification failed: {e}")
        return False
