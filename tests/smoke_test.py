#!/usr/bin/env python3
"""End-to-end smoke test for the NexMeet signalling server.

Start the server first (python server.py), then run:

    .venv\\Scripts\\python tests\\smoke_test.py

It uses three websocket clients and exercises join, roster sync, SDP relay,
chat, host mute, peer leave, host promotion and ending the meeting.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

from simple_websocket import Client

BASE = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000/ws"
ROOM = f"smoke-{int(time.time())}"


def check(condition: bool, label: str) -> None:
    if condition:
        print(f"  ok  {label}")
        return
    print(f"FAIL  {label}")
    raise SystemExit(1)


def send(ws: Client, payload: dict) -> None:
    ws.send(json.dumps(payload))


def safe_close(ws: Client) -> None:
    try:
        ws.close()
    except Exception:
        pass


def recv(ws: Client, kind: str, timeout: float = 3.0) -> dict:
    """Read messages until one of `kind` arrives."""
    deadline = time.time() + timeout
    seen: list[str] = []
    while time.time() < deadline:
        try:
            raw = ws.receive(timeout=max(0.05, deadline - time.time()))
        except Exception:
            continue
        if raw is None:
            break
        message = json.loads(raw)
        seen.append(message.get("type", "?"))
        if message.get("type") == kind:
            return message
        if message.get("type") == "error":
            raise AssertionError(f"unexpected error: {message} (wanted {kind}, saw {seen})")
    raise AssertionError(f"timed out waiting for {kind}; saw {seen}")


def connect(
    name: str,
    state: dict | None = None,
    mode: str | None = None,
    room: str = ROOM,
) -> tuple[Client, dict]:
    ws = Client(WS)
    payload: dict = {
        "type": "join",
        "room": room,
        "name": name,
        "state": state or {"mic": True, "cam": True},
    }
    if mode:
        payload["mode"] = mode
    send(ws, payload)
    joined = recv(ws, "joined")
    return ws, joined


def recv_error(ws: Client, timeout: float = 3.0) -> dict:
    """Read messages until an error arrives."""
    deadline = time.time() + timeout
    seen: list[str] = []
    while time.time() < deadline:
        raw = ws.receive(timeout=max(0.05, deadline - time.time()))
        if raw is None:
            break
        message = json.loads(raw)
        seen.append(message.get("type", "?"))
        if message.get("type") == "error":
            return message
    raise AssertionError(f"timed out waiting for error; saw {seen}")


def main() -> None:
    with urllib.request.urlopen(f"{BASE}/api/health", timeout=5) as response:
        health = json.load(response)
    check(health.get("ok") is True, "HTTP health endpoint")

    with urllib.request.urlopen(f"{BASE}/api/config", timeout=5) as response:
        config = json.load(response)
    check(config.get("maxParticipants") == 8, "config exposes the room limit")
    check(bool(config.get("iceServers")), "config exposes ICE servers")

    with urllib.request.urlopen(f"{BASE}/", timeout=5) as response:
        index = response.read().decode("utf-8")
    check("NexMeet" in index and "/static/app.js" in index, "landing page is served")

    with urllib.request.urlopen(f"{BASE}/room/test-room", timeout=5) as response:
        check(response.status == 200, "room deep link is served")

    print("join / roster")
    alice, a = connect("Alice")
    check(a["role"] == "host", "first participant is host")
    check(a["participants"] == [], "first participant sees an empty roster")

    bob, b = connect("Bob", {"mic": False, "cam": True})
    check(b["role"] == "participant", "second participant is not host")
    check(b["hostId"] == a["selfId"], "second participant sees the host")
    check([p["name"] for p in b["participants"]] == ["Alice"], "roster contains Alice")
    check(b["participants"][0]["mic"] is True, "roster carries Alice's mic state")

    joined = recv(alice, "peer-joined")
    check(joined["participant"]["id"] == b["selfId"], "Alice is told Bob joined")
    check(joined["participant"]["mic"] is False, "join message carries initial mic state")

    print("WebRTC signalling relay")
    send(
        bob,
        {
            "type": "signal",
            "to": a["selfId"],
            "data": {"type": "offer", "sdp": {"type": "offer", "sdp": "v=0 smoke"}},
        },
    )
    relayed = recv(alice, "signal")
    check(relayed["from"] == b["selfId"], "offer carries the sender id")
    check(relayed["data"]["sdp"]["sdp"] == "v=0 smoke", "offer payload is unchanged")

    print("chat")
    send(alice, {"type": "chat", "text": "  hello room  "})
    for label, ws in (("Alice", alice), ("Bob", bob)):
        chat = recv(ws, "chat")
        check(chat["message"]["text"] == "hello room", f"{label} receives trimmed chat")
        check(chat["message"]["name"] == "Alice", f"{label} sees the author")

    print("participant state")
    send(bob, {"type": "state", "state": {"mic": True, "hand": True}})
    state = recv(alice, "state")
    check(state["peerId"] == b["selfId"], "state update names the peer")
    check(state["state"]["hand"] is True and state["state"]["mic"] is True, "state is applied")

    print("host mute")
    send(alice, {"type": "host", "action": "mute", "target": b["selfId"]})
    force = recv(bob, "force-mute")
    check(force["type"] == "force-mute", "target receives force-mute")
    roster_state = recv(alice, "state")
    check(roster_state["state"]["mic"] is False, "host sees the muted state")

    print("peer leave")
    safe_close(bob)
    left = recv(alice, "peer-left")
    check(left["peerId"] == b["selfId"], "remaining peer sees peer-left")

    carol, c = connect("Carol")
    check([p["name"] for p in c["participants"]] == ["Alice"], "new roster after leave")
    check(c["hostId"] == a["selfId"], "Alice keeps the host role")
    check(recv(alice, "peer-joined")["participant"]["id"] == c["selfId"], "peer-joined for Carol")

    print("host removes participant")
    send(alice, {"type": "host", "action": "remove", "target": c["selfId"]})
    removed = recv(carol, "removed")
    check("removed" in removed["reason"].lower(), "removed participant gets a reason")
    safe_close(carol)

    dave, d = connect("Dave")
    check(d["role"] == "participant", "Dave joins as participant")
    recv(alice, "peer-joined")

    print("host leaves / promotion / end")
    safe_close(alice)
    promoted = recv(dave, "host-changed")
    check(promoted["hostId"] == d["selfId"], "host is promoted when the host leaves")
    check(recv(dave, "peer-left")["peerId"] == a["selfId"], "promotion is followed by peer-left")

    send(dave, {"type": "host", "action": "end"})
    ended = recv(dave, "meeting-ended")
    check(ended["by"] == "Dave", "meeting-ended names the host")
    safe_close(dave)

    print("webinar mode")
    webinar_room = f"webinar-{int(time.time())}"
    wendy, w = connect("Wendy", mode="webinar", room=webinar_room)
    check(w["mode"] == "webinar", "first participant creates a webinar room")
    check(w["role"] == "host", "webinar creator is host")
    check(w["webinarRole"] == "host", "webinar host can speak")

    uma, u = connect("Uma", mode="meeting", room=webinar_room)
    check(u["mode"] == "webinar", "the server room mode wins over a join request")
    check(u["role"] == "participant", "webinar joiner is not host")
    check(u["webinarRole"] == "audience", "webinar joiner starts in the audience")
    check(u["participants"][0]["webinarRole"] == "host", "roster exposes the host role")
    check(
        recv(wendy, "peer-joined")["participant"]["webinarRole"] == "audience",
        "peer-joined exposes the audience role",
    )

    send(uma, {"type": "state", "state": {"mic": True, "cam": True, "hand": True}})
    state = recv(wendy, "state")
    check(state["state"]["mic"] is False, "audience cannot unmute themselves")
    check(state["state"]["cam"] is False, "audience cannot start their camera")
    check(state["state"]["hand"] is True, "audience can raise a hand")

    send(uma, {"type": "host", "action": "mute", "target": w["selfId"]})
    check(recv_error(uma).get("code") == "FORBIDDEN", "audience cannot use host controls")

    send(wendy, {"type": "host", "action": "promote", "target": u["selfId"]})
    role = recv(uma, "webinar-role")
    check(role["role"] == "panelist", "promoted audience becomes a panelist")
    check(recv(wendy, "webinar-role")["peerId"] == u["selfId"], "host sees the promotion")
    state = recv(wendy, "state")
    check(state["state"]["mic"] is True, "a promoted panelist is unmuted by default")

    send(uma, {"type": "state", "state": {"mic": True, "cam": True}})
    state = recv(wendy, "state")
    check(state["state"]["mic"] is True and state["state"]["cam"] is True, "panelists control their own media")

    send(wendy, {"type": "host", "action": "demote", "target": u["selfId"]})
    check(recv(uma, "webinar-role")["role"] == "audience", "panelist can be moved back to the audience")
    recv(wendy, "webinar-role")
    state = recv(wendy, "state")
    check(state["state"]["mic"] is False and state["state"]["sharing"] is False, "demotion clears media state")

    send(wendy, {"type": "host", "action": "promote", "target": u["selfId"]})
    recv(uma, "webinar-role")
    recv(wendy, "webinar-role")
    recv(wendy, "state")

    print("webinar host handover")
    safe_close(wendy)
    promoted = recv(uma, "host-changed")
    check(promoted["hostId"] == u["selfId"], "webinar host passes to a panelist")
    check(promoted["mode"] == "webinar", "handover keeps webinar mode")
    check(promoted["webinarRole"] == "host", "the new webinar host can speak")
    check(recv(uma, "peer-left")["peerId"] == w["selfId"], "handover is followed by peer-left")

    send(uma, {"type": "host", "action": "end"})
    check(recv(uma, "meeting-ended")["by"] == "Uma", "new webinar host can end the webinar")
    safe_close(uma)

    print("\nAll smoke tests passed.")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"\nFAILED: {exc}")
        sys.stdout.flush()
        os._exit(1)
    except Exception as exc:  # noqa: BLE001 - make failures exit cleanly
        print(f"\nERROR: {exc!r}")
        sys.stdout.flush()
        os._exit(1)
    sys.stdout.flush()
    os._exit(0)
