#!/usr/bin/env python3
"""check_flash_api.py — Alert via Brevo if Flash Intel API is down."""

import os, requests, pathlib

API_URL = "http://localhost:4330/"
BREVO_KEY = os.getenv("BREVO_API_KEY", "YOUR_BREVO_API_KEY")
LOCK = pathlib.Path("/tmp/flash_api_alert_sent")
TO = "fredericd@gmail.com"

def check():
    try:
        r = requests.get(API_URL, timeout=5)
        is_down = False
    except Exception:
        is_down = True

    if is_down and not LOCK.exists():
        requests.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={"api-key": BREVO_KEY, "Content-Type": "application/json"},
            json={
                "sender": {"name": "AgoraIQ Monitor", "email": "noreply@agoraiq.net"},
                "to": [{"email": TO}],
                "subject": "⚠ Flash Intel API is DOWN",
                "textContent": f"Flash Intel API at {API_URL} is not returning 200. Check immediately."
            }
        )
        LOCK.touch()
        print("ALERT SENT")

    elif not is_down and LOCK.exists():
        LOCK.unlink()
        print("API BACK — lock cleared")

    else:
        print(f"{'DOWN (already alerted)' if is_down else 'OK'}")

if __name__ == "__main__":
    check()
