# NexMeet

A small, self-hosted video meeting app built with **Python + Flask** and a
vanilla **HTML/CSS/JS** client. No accounts, no API keys, no third-party
services: the server only handles HTTP and WebSocket signalling, while audio,
video and screen sharing travel directly between browsers over WebRTC.

```
browser  <-- WebRTC (audio / video / screen) -->  browser
    \                                             /
     \---- WebSocket signalling (Flask) ---------/
```

## Features

- Instant rooms with shareable links (`/#/room/abc-defg-hij` or `/room/...`)
- Camera/microphone preview before joining
- WebRTC mesh calls (up to 8 people by default)
- Mute/unmute, camera on/off, raise hand
- **Presenting**: share a screen, play a video file (with its audio mixed into
  your mic), or present a PDF page by page
- In-meeting chat with unread badge and history for late joiners
- **Webinar mode**: a host and panelists speak while the audience watches,
  chats and raises a hand; the host can invite audience members to speak
- Participant panel with live mic/camera/hand/presenting state
- Host controls: mute one person, mute everyone, remove someone, promote or
  demote panelists, end the meeting for all
- Automatic host promotion when the host leaves
- Speaking indicator, call timer, invite-link copy, keyboard shortcuts
  (`M`, `V`, `H`, `C`, `P`, `Esc`)
- Responsive dark UI, no build step, no CDN dependencies
- Security headers (CSP, no-sniff, frame deny) and basic chat rate limiting

## Quick start

Requires Python 3.10+.

**Windows**

```bat
python3 -m venv .venv
pip install -r requirements.txt
.venv/bin/python server.py
```

**macOS / Linux**

```bash
python -m venv .venv
pip install -r requirements.txt
python .venv/Scripts\server.py
```

Then open <http://localhost:8000>.

To try a call by yourself, open the room in two browser tabs and join with
different names. Browsers only expose camera/microphone on `localhost` or
HTTPS; on plain HTTP over a LAN IP you can still join and receive media.

## Meetings and webinars

Every room is either a **meeting** or a **webinar**. Choose the type when you
create it: **Start a webinar** (or **New webinar**) creates a webinar room; the
room type is then fixed for everyone who joins.

In a webinar:

- the first person in the room is the **host** and can speak, present and use
  host controls;
- everyone else joins as **audience**: they can watch, listen, chat and raise a
  hand, but their mic, camera and screen share stay off and their controls are
  disabled;
- the host opens **People** and uses the mic button on an audience member to
  invite them to speak (**promote** to panelist) or send them back to the
  audience (**demote**);
- the host can also mute a panelist, remove someone, or end the webinar for
  everyone. If the host leaves, the host role passes to a panelist (or to the
  earliest remaining participant) and the webinar continues.

Audience tiles are hidden from the video grid to keep the stage focused on
speakers; the webinar bar shows how many people are speaking and watching. The
audience member still appears in the People panel and can be promoted by the
host. Chat is shared by everyone.

Because the server owns the room type and speaking roles, a client cannot join
a webinar as a speaker or unmute itself before being promoted.

## Presenting a screen, video or PDF

Press **Present** in the control bar (or **Stop** while presenting) and choose:

- **Screen** — share a window, tab or display. Audio is off by default, matching
  the browser's screen-share picker.
- **Video file** — pick an MP4/WebM (anything the browser can play). The video is
  rendered to a canvas at 15 fps and sent through your normal camera sender, so
  every participant sees it in your tile. Its audio is mixed with your
  microphone by Web Audio and sent as one track. The presenter gets a floating
  bar with play/pause, a seek slider, elapsed time and stop. Muting your mic
  silences only the mic, not the video. The video stops presenting automatically
  when it ends.
- **PDF** — pick a PDF. Pages are rendered locally with the bundled PDF.js
  (v3.11.174, Apache-2.0) to a 1600×900 canvas and sent like a video feed. Use
  the **‹ / ›** buttons, the left/right arrow keys, or the page counter to move
  through the document.

The presentation replaces your camera in the outgoing video sender, so it needs
no extra connection or renegotiation. It is available to meeting participants
and to webinar hosts/panelists; audience members cannot present until promoted.
Stopping a presentation restores your camera. In a webinar, being demoted to the
audience also stops any active presentation.

There are no CDN dependencies: PDF.js ships in `static/vendor/pdfjs/`.


Logs are written to `logs\`. A Quick Tunnel is fine for demos and personal
use, but it has no uptime guarantee. For a stable hostname, configure a named
Cloudflare Tunnel or deploy behind your own reverse proxy instead.



## Configuration

All settings are environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `8000` | HTTP port. |
| `MAX_PARTICIPANTS` | `8` | Room capacity. |
| `ICE_SERVERS` | – | Full JSON array of ICE servers. Overrides all TURN settings. |
| `TURN_URL` | – | e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` | – | TURN username. |
| `TURN_CREDENTIAL` | – | TURN password. |
| `SSL_CERT` | – | Path to a certificate file; enables HTTPS. |
| `SSL_KEY` | – | Path to the matching private key. |

Example with a TURN server:

```bash
# macOS / Linux
TURN_URL=turn:turn.example.com:3478 \
TURN_USERNAME=nexmeet \
TURN_CREDENTIAL=secret \
MAX_PARTICIPANTS=6 \
python server.py
```

```bat
:: Windows cmd
set TURN_URL=turn:turn.example.com:3478
set TURN_USERNAME=nexmeet
set TURN_CREDENTIAL=secret
set MAX_PARTICIPANTS=6
.venv\Scripts\python server.py
```

`ICE_SERVERS` accepts anything the browser's `RTCPeerConnection` accepts:

```json
[
  {"urls": ["stun:stun.l.google.com:19302"]},
  {"urls": "turn:turn.example.com:3478", "username": "u", "credential": "p"}
]
```

## HTTPS and LAN access

Browsers require a secure context for `getUserMedia`/`getDisplayMedia`. That is
automatic on `localhost`. For other machines, put NexMeet behind a TLS reverse
proxy (Caddy, nginx) or run it with a certificate:

```bash
SSL_CERT=/path/fullchain.pem SSL_KEY=/path/privkey.pem python server.py
```

The client automatically uses `wss://` when the page is loaded over HTTPS.
Without HTTPS, remote participants can join and receive media, but they cannot
publish their own camera/microphone.

Example Caddyfile:

```
meet.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Make sure the proxy forwards WebSocket upgrades for `/ws`.

## Tests

With the server running on port 8000:

```bash
.venv\Scripts\python tests\smoke_test.py     # Windows
# or: .venv/bin/python tests/smoke_test.py   # macOS / Linux
```

The smoke test opens several WebSocket clients and checks HTTP health, join and
roster messages, SDP/ICE relay, chat, state sync, host mute, removal, host
promotion, ending a meeting, and the webinar rules (audience restrictions,
promote/demote, host handover).

To verify a public tunnel instead:

```bash
.venv\Scripts\python tests\public_test.py https://your-name.trycloudflare.com
```

## How it works

- `server.py` exposes `/` and `/room/<code>` (the single-page client),
  `/api/health`, `/api/config` (ICE servers and room limit) and `/ws`.
- Room state lives in memory behind a lock: peers, chat history and timestamps.
  The first peer in a room becomes host; when the host leaves the earliest
  remaining peer is promoted. Rooms also carry a `mode` (`meeting`/`webinar`)
  and, in webinars, each peer has a `webinarRole` (`host`/`panelist`/`audience`).
- The client joins over WebSocket, then creates an `RTCPeerConnection` to each
  existing participant. The new participant sends offers; existing peers
  answer. ICE candidates and renegotiation offers are relayed by the server.
- `getUserMedia` / `getDisplayMedia` tracks are added to every peer connection
  and swapped with `RTCRtpSender.replaceTrack` for mute/camera/presentation
  changes. Screen, video-file and PDF presentations all reuse the outgoing video
  sender; video audio is mixed with the microphone by Web Audio.
- Host actions are validated server-side before being applied.

### Protocol (WebSocket JSON)

Client → server: `join` (optional `mode`), `signal`, `state`, `chat`, `host`
(`promote`/`demote` in webinar rooms).

Server → client: `joined`, `peer-joined`, `peer-left`, `host-changed`,
`webinar-role`, `signal`, `state`, `chat`, `force-mute`, `removed`,
`meeting-ended`, `error`.

## Limitations

- **Mesh topology**: every participant uploads one stream per peer, so upload
  bandwidth and CPU grow quickly. Eight people is a sensible ceiling; for
  larger calls use an SFU (LiveKit, mediasoup, Janus) instead.
- **TURN is required** for reliable connectivity between strict NATs/firewalls.
  The default only uses public STUN servers.
- **In-memory state**: rooms, chat and host roles disappear on restart. There is
  no database and no persistence.
- **No accounts or auth**: anyone with a room code can join. Treat room codes as
  secrets, use HTTPS, and run it on a network you trust.
- **No recording or transcription.**
- Media is encrypted in transit by WebRTC (DTLS-SRTP), but this is not a
  multi-party end-to-end encrypted messenger design beyond that.

## Production notes

The built-in Flask server is fine for small self-hosted use. For anything
larger, put it behind a TLS reverse proxy. Because room state is in memory, run
a **single process** (or share state externally); with Gunicorn:

```bash
gunicorn -w 1 --threads 100 -b 127.0.0.1:8000 server:app
```

## Files

```
server.py              Flask app, room state, WebSocket signalling
static/index.html      UI markup and SVG icon sprite
static/styles.css      responsive dark theme
static/app.js          routing, media, WebRTC mesh, chat, host controls
static/vendor/pdfjs/   bundled PDF.js used for PDF presenting
static/favicon.svg     favicon
tests/smoke_test.py    end-to-end signalling + webinar test
tests/public_test.py   HTTPS/WSS check through a public tunnel
requirements.txt       Flask + flask-sock
tools/                 downloaded cloudflared.exe (created on first run)
logs/                  server and tunnel logs (created on first run)
```
