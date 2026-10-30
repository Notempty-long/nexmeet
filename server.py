import json
import os
import re
import secrets
import ssl
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory
from flask_sock import Sock

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS).resolve()
else:
    BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
MAX_PARTICIPANTS = int(os.getenv("MAX_PARTICIPANTS", "8"))
MAX_CHAT_HISTORY = 100
MAX_CHAT_LEN = 1000
MAX_NAME_LEN = 40
CHAT_BURST = 12
CHAT_BURST_WINDOW = 10.0

ROOM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

CSP = (
    "default-src 'self'; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "connect-src 'self' ws: wss:; "
    "worker-src 'self' blob:; "
    "font-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
sock = Sock(app)
