#!/usr/bin/env python3
"""NexMeet - a small, self-hosted WebRTC meeting app built with Quart.

The server has three jobs:
  1. serve the single-page client in ./static
  2. relay WebRTC offers / answers / ICE candidates between browsers
  3. keep lightweight room state (participants, chat, raised hands)

Audio and video never touch the server: browsers talk directly to each other
(a mesh). That keeps the app dependency-light and easy to run. Rooms are
capped at eight people by default.

Run:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8000
    # open http://localhost:8000
"""

from __future__ import annotations

import json
import os
import re
import secrets
import ssl
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from quart import Quart, jsonify, request, send_file, websocket

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

app = Quart(__name__, static_folder="static", static_url_path="/static")

# Quart is async, but the room state is still shared across clients; guard it.
STATE_LOCK = threading.RLock()
ROOMS: dict[str, "Room"] = {}


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


@dataclass
class Peer:
    id: str
    name: str
    ws: Any
    role: str = "participant"
    webinar_role: str = ""
    mic: bool = True
    cam: bool = True
    hand: bool = False
    sharing: bool = False
    joined_at: float = field(default_factory=time.time)
    chat_times: list[float] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "webinarRole": self.webinar_role,
            "mic": self.mic,
            "cam": self.cam,
            "hand": self.hand,
            "sharing": self.sharing,
        }

    def state(self) -> dict[str, bool]:
        return {
            "mic": self.mic,
            "cam": self.cam,
            "hand": self.hand,
            "sharing": self.sharing,
        }


@dataclass
class Room:
    id: str
    mode: str = "meeting"
    peers: dict[str, Peer] = field(default_factory=dict)
    chat: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)

    def host(self) -> Peer | None:
        for peer in self.peers.values():
            if peer.role == "host":
                return peer
        return None

    def promote_host(self) -> Peer | None:
        candidates = sorted(self.peers.values(), key=lambda p: p.joined_at)
        speakers = [p for p in candidates if p.webinar_role == "panelist"]
        pool = speakers or candidates
        if not pool:
            return None
        promoted = pool[0]
        promoted.role = "host"
        if self.mode == "webinar":
            promoted.webinar_role = "host"
        return promoted


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def ice_servers() -> list[dict[str, Any]]:
    """Return ICE servers, configurable through environment variables."""
    raw = os.getenv("ICE_SERVERS", "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass

    servers: list[dict[str, Any]] = [
        {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
    ]
    turn_url = os.getenv("TURN_URL", "").strip()
    if turn_url:
        turn: dict[str, Any] = {"urls": turn_url}
        username = os.getenv("TURN_USERNAME", "").strip()
        credential = os.getenv("TURN_CREDENTIAL", "").strip()
        if username:
            turn["username"] = username
        if credential:
            turn["credential"] = credential
        servers.append(turn)
    return servers


async def safe_send(ws: Any, payload: dict[str, Any]) -> None:
    try:
        await ws.send(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


async def send_error(ws: Any, code: str, message: str) -> None:
    await safe_send(ws, {"type": "error", "code": code, "message": message})


async def broadcast(
    room: Room, payload: dict[str, Any], exclude: str | None = None
) -> None:
    for peer in list(room.peers.values()):
        if peer.id == exclude:
            continue
        await safe_send(peer.ws, payload)


def clean_name(raw: Any) -> str:
    name = " ".join(str(raw or "").split())
    return name[:MAX_NAME_LEN]


async def leave_room(room: Room, peer: Peer) -> None:
    """Remove a peer once, promote a new host, and tell the room."""
    if room.peers.get(peer.id) is not peer:
        return

    del room.peers[peer.id]
    was_host = peer.role == "host"

    if not room.peers:
        ROOMS.pop(room.id, None)
        return

    if was_host or not any(p.role == "host" for p in room.peers.values()):
        promoted = room.promote_host()
        if promoted is not None:
            await broadcast(
                room,
                {
                    "type": "host-changed",
                    "hostId": promoted.id,
                    "hostName": promoted.name,
                    "mode": room.mode,
                    "webinarRole": promoted.webinar_role,
                },
            )

    await broadcast(room, {"type": "peer-left", "peerId": peer.id, "name": peer.name})


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


@app.after_request
async def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Content-Security-Policy", CSP)
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
async def index():
    return await send_file(STATIC_DIR / "index.html")


@app.get("/room/<room>")
async def room_page(room: str):
    if not ROOM_RE.match(room):
        return "Room not found", 404
    return await send_file(STATIC_DIR / "index.html")


@app.get("/api/config")
async def config():
    return jsonify(
        {
            "iceServers": ice_servers(),
            "maxParticipants": MAX_PARTICIPANTS,
        }
    )


@app.get("/api/health")
async def health():
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# WebSocket signalling
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_handler():
    peer: Peer | None = None
    room: Room | None = None
    ws = websocket

    try:
        while True:
            raw = await websocket.receive()
            if raw is None:
                break

            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(data, dict):
                continue

            kind = data.get("type")

            with STATE_LOCK:
                if kind == "join":
                    if peer is not None:
                        await send_error(ws, "ALREADY_JOINED", "You are already in a room.")
                        continue

                    room_id = str(data.get("room", "")).strip()
                    name = clean_name(data.get("name"))
                    if not ROOM_RE.match(room_id):
                        await send_error(ws, "INVALID_ROOM", "That room code is not valid.")
                        continue
                    if not name:
                        await send_error(ws, "INVALID_NAME", "Please enter your name.")
                        continue

                    target = ROOMS.get(room_id)
                    if target is None:
                        requested_mode = str(data.get("mode", "")).strip().lower()
                        target = Room(
                            id=room_id,
                            mode="webinar" if requested_mode == "webinar" else "meeting",
                        )
                        ROOMS[room_id] = target
                    if len(target.peers) >= MAX_PARTICIPANTS:
                        await send_error(
                            ws,
                            "ROOM_FULL",
                            "This room is full. Try again in a moment.",
                        )
                        continue

                    initial = data.get("state")
                    initial = initial if isinstance(initial, dict) else {}
                    is_first = not target.peers
                    if target.mode == "webinar":
                        webinar_role = "host" if is_first else "audience"
                        mic = is_first and bool(initial.get("mic", True))
                        cam = is_first and bool(initial.get("cam", True))
                    else:
                        webinar_role = ""
                        mic = bool(initial.get("mic", True))
                        cam = bool(initial.get("cam", True))
                    peer = Peer(
                        id=secrets.token_urlsafe(9),
                        name=name,
                        ws=ws,
                        role="host" if is_first else "participant",
                        webinar_role=webinar_role,
                        mic=mic,
                        cam=cam,
                    )
                    target.peers[peer.id] = peer
                    room = target

                    host = room.host()
                    await safe_send(
                        ws,
                        {
                            "type": "joined",
                            "selfId": peer.id,
                            "room": room.id,
                            "mode": room.mode,
                            "role": peer.role,
                            "webinarRole": peer.webinar_role,
                            "hostId": host.id if host else peer.id,
                            "startedAt": room.created_at,
                            "participants": [
                                p.public()
                                for p in room.peers.values()
                                if p.id != peer.id
                            ],
                            "chat": room.chat[-MAX_CHAT_HISTORY:],
                        },
                    )
                    await broadcast(
                        room,
                        {"type": "peer-joined", "participant": peer.public()},
                        exclude=peer.id,
                    )
                    continue

                if peer is None or room is None:
                    await send_error(ws, "NOT_JOINED", "Join a room first.")
                    continue

                if kind == "signal":
                    target = room.peers.get(str(data.get("to", "")))
                    payload = data.get("data")
                    if target is not None and isinstance(payload, dict):
                        await safe_send(
                            target.ws,
                            {"type": "signal", "from": peer.id, "data": payload},
                        )
                    continue

                if kind == "state":
                    incoming = data.get("state")
                    if not isinstance(incoming, dict):
                        continue
                    if room.mode == "webinar" and peer.webinar_role == "audience":
                        incoming = {"hand": incoming.get("hand")}
                    for key in ("mic", "cam", "hand", "sharing"):
                        if isinstance(incoming.get(key), bool):
                            setattr(peer, key, incoming[key])
                    await broadcast(
                        room,
                        {
                            "type": "state",
                            "peerId": peer.id,
                            "state": peer.state(),
                        },
                        exclude=peer.id,
                    )
                    continue

                if kind == "chat":
                    now = time.time()
                    peer.chat_times = [
                        t for t in peer.chat_times if now - t < CHAT_BURST_WINDOW
                    ]
                    if len(peer.chat_times) >= CHAT_BURST:
                        await send_error(
                            ws,
                            "CHAT_RATE_LIMIT",
                            "You are sending messages too quickly.",
                        )
                        continue

                    text = str(data.get("text", "")).strip()
                    if not text:
                        continue
                    text = text[:MAX_CHAT_LEN]
                    peer.chat_times.append(now)

                    entry = {
                        "id": secrets.token_urlsafe(6),
                        "peerId": peer.id,
                        "name": peer.name,
                        "text": text,
                        "ts": now,
                    }
                    room.chat.append(entry)
                    if len(room.chat) > MAX_CHAT_HISTORY:
                        del room.chat[:-MAX_CHAT_HISTORY]
                    await broadcast(room, {"type": "chat", "message": entry})
                    continue

                if kind == "host":
                    host = room.host()
                    if host is None or host.id != peer.id:
                        await send_error(ws, "FORBIDDEN", "Only the host can do that.")
                        continue

                    action = data.get("action")

                    if action == "mute-all":
                        for target in room.peers.values():
                            if target.id == peer.id or not target.mic:
                                continue
                            if target.webinar_role == "audience":
                                continue
                            target.mic = False
                            await safe_send(target.ws, {"type": "force-mute"})
                            await broadcast(
                                room,
                                {
                                    "type": "state",
                                    "peerId": target.id,
                                    "state": target.state(),
                                },
                                exclude=target.id,
                            )
                        continue

                    if action == "mute":
                        target = room.peers.get(str(data.get("target", "")))
                        if target is None or target.id == peer.id:
                            continue
                        if target.webinar_role == "audience":
                            continue
                        target.mic = False
                        await safe_send(target.ws, {"type": "force-mute"})
                        await broadcast(
                            room,
                            {
                                "type": "state",
                                "peerId": target.id,
                                "state": target.state(),
                            },
                            exclude=target.id,
                        )
                        continue

                    if action in ("promote", "demote"):
                        if room.mode != "webinar":
                            await send_error(
                                ws,
                                "NOT_WEBINAR",
                                "Only webinar participants have speaking roles.",
                            )
                            continue
                        target = room.peers.get(str(data.get("target", "")))
                        if target is None or target.id == peer.id:
                            continue
                        if target.role == "host":
                            continue
                        new_role = "panelist" if action == "promote" else "audience"
                        if target.webinar_role == new_role:
                            continue
                        target.webinar_role = new_role
                        if new_role == "audience":
                            target.mic = False
                            target.cam = False
                            target.sharing = False
                        else:
                            target.hand = False
                            target.mic = True
                            target.cam = False
                        await broadcast(
                            room,
                            {
                                "type": "webinar-role",
                                "peerId": target.id,
                                "name": target.name,
                                "role": new_role,
                            },
                        )
                        await broadcast(
                            room,
                            {
                                "type": "state",
                                "peerId": target.id,
                                "state": target.state(),
                            },
                            exclude=target.id,
                        )
                        continue

                    if action == "remove":
                        target = room.peers.get(str(data.get("target", "")))
                        if target is None or target.id == peer.id:
                            continue
                        del room.peers[target.id]
                        await safe_send(
                            target.ws,
                            {
                                "type": "removed",
                                "reason": "The host removed you from the meeting.",
                            },
                        )
                        await broadcast(
                            room,
                            {
                                "type": "peer-left",
                                "peerId": target.id,
                                "name": target.name,
                            },
                        )
                        try:
                            await target.ws.close()
                        except Exception:
                            pass
                        continue

                    if action == "end":
                        peers = list(room.peers.values())
                        ROOMS.pop(room.id, None)
                        room.peers.clear()
                        for target in peers:
                            await safe_send(
                                target.ws,
                                {"type": "meeting-ended", "by": peer.name},
                            )
                        for target in peers:
                            try:
                                await target.ws.close()
                            except Exception:
                                pass
                        continue

    finally:
        with STATE_LOCK:
            if peer is not None and room is not None:
                await leave_room(room, peer)
        try:
            await websocket.close()
        except Exception:
            pass


def main() -> None:
    ssl_cert = os.getenv("SSL_CERT", "").strip()
    ssl_key = os.getenv("SSL_KEY", "").strip()
    scheme = "https" if ssl_cert and ssl_key else "http"
    print()
    print("  NexMeet is running")
    print(f"  -> {scheme}://localhost:{PORT}")
    print(f"  Max participants per room: {MAX_PARTICIPANTS}")
    print("  Press Ctrl+C to stop.")
    print()

    if ssl_cert and ssl_key:
        import uvicorn

        uvicorn.run(
            app,
            host=HOST,
            port=PORT,
            ssl_certfile=ssl_cert,
            ssl_keyfile=ssl_key,
            log_level="info",
        )
        return

    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
