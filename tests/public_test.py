#!/usr/bin/env python3
"""Check a *public* NexMeet deployment over HTTPS and WSS.

Usage:

    .venv\\Scripts\\python tests\\public_test.py https://example.trycloudflare.com

It verifies the landing page, the JSON endpoints and a real signalling session
(two peers, roster, SDP relay and chat) through the public tunnel.
"""

from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.request

from simple_websocket import Client

ROOM = f"public-{int(time.time())}"


def check(condition: bool, label: str) -> None:
    if condition:
        print(f"  ok  {label}")
        return
    print(f"FAIL  {label}")
    raise SystemExit(1)


def get(url: str) -> bytes:
    context = ssl.create_default_context()
    request = urllib.request.Request(url, headers={"User-Agent": "NexMeet-public-test"})
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        return response.read()


def send(ws, payload: dict) -> None:
    ws.send(json.dumps(payload))


def recv(ws, kind: str, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    seen: list[str] = []
    while time.time() < deadline:
        raw = ws.receive(timeout=max(0.05, deadline - time.time()))
        if raw is None:
            break
        message = json.loads(raw)
        seen.append(message.get("type", "?"))
        if message.get("type") == kind:
            return message
        if message.get("type") == "error":
            raise AssertionError(f"unexpected error: {message} (wanted {kind})")
    raise AssertionError(f"timed out waiting for {kind}; saw {seen}")


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: public_test.py https://<name>.trycloudflare.com")
        raise SystemExit(2)

    base = sys.argv[1].rstrip("/")
    ws_url = base.replace("https://", "wss://").replace("http://", "ws://") + "/ws"
    print(f"Testing {base}")

    check(json.loads(get(f"{base}/api/health")).get("ok") is True, "HTTPS health endpoint")
    config = json.loads(get(f"{base}/api/config"))
    check(config.get("maxParticipants") == 8, "config over HTTPS")
    page = get(f"{base}/").decode("utf-8", "replace")
    check("NexMeet" in page, "landing page is served through the tunnel")

    alice = Client(ws_url)
    send(
        alice,
        {
            "type": "join",
            "room": ROOM,
            "name": "Alice",
            "state": {"mic": True, "cam": True},
        },
    )
    joined = recv(alice, "joined")
    check(joined.get("selfId") is not None, "WSS join over the tunnel")

    bob = Client(ws_url)
    send(
        bob,
        {
            "type": "join",
            "room": ROOM,
            "name": "Bob",
            "state": {"mic": True, "cam": False},
        },
    )
    joined = recv(bob, "joined")
    check(len(joined.get("participants", [])) == 1, "roster contains the other peer")

    alice_bob_joined = recv(alice, "peer-joined")
    check(alice_bob_joined.get("participant", {}).get("name") == "Bob", "peer-joined reaches the first peer")

    send(
        alice,
        {
            "type": "signal",
            "to": joined["selfId"],
            "data": {"type": "offer", "sdp": "v=0\r\npublic-test"},
        },
    )
    relayed = recv(bob, "signal")
    check(relayed["data"].get("sdp") == "v=0\r\npublic-test", "SDP relay over the tunnel")

    send(bob, {"type": "chat", "text": "hello over the tunnel"})
    chat = recv(alice, "chat")
    check(chat.get("message", {}).get("text") == "hello over the tunnel", "chat over the tunnel")

    for ws in (bob, alice):
        try:
            ws.close()
        except Exception:
            pass

    print("Public tunnel test passed.")


if __name__ == "__main__":
    main()
