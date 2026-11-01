# AGENTS.md — NexMeet

Guidance for coding agents working in this repository.

## What this is

NexMeet is a self-hosted video meeting and webinar app:

- Backend: Python 3, Flask, Flask-Sock (`server.py`).
- Frontend: vanilla HTML + CSS + JS, no build step (`static/`).
- Media: WebRTC mesh. The server only relays signalling; audio, video and presentations travel directly between browsers.
- Public access: not bundled into this repo; if you need a public tunnel, run your own tunnel tool outside the repo.
- No accounts, no database, no CDN, no Node/npm. Keep it dependency-light.

## Run locally

This repository does not include a `run.bat`/`run.ps1` launcher or a matching `stop.bat`/`stop.ps1` pair. Run the app directly with Python instead.

Windows:

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python server.py
```

macOS / Linux:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Then open http://localhost:8000.

- Browsers only expose camera/microphone on `localhost` or HTTPS.
- For a public demo, run a reverse proxy or a tunnel externally; do not assume the repo handles it automatically.

## Tests

The server must be running first.

```powershell
.\.venv\Scripts\python tests\smoke_test.py
```

```bash
python tests/smoke_test.py
```

- `smoke_test.py` covers join/roster, SDP relay, chat, participant state, host mute/remove/end, host promotion and webinar role enforcement.
- Run this after any change to `server.py` or the signalling protocol.
- Frontend changes: verify in a browser with no camera/mic available too. The app falls back to a blank 640×360 video track and silent audio track, so joining and presenting must still work in that environment.

## File map

```
server.py                  Flask app, HTTP routes, WebSocket signalling, roles
static/index.html          single page: landing, pre-join, room, modals, SVG sprite
static/app.js              all client logic (IIFE, no modules/bundler)
static/styles.css          all styles, CSS variables at the top
static/vendor/pdfjs/       bundled PDF.js v3.11.174 (do not load from a CDN)
static/favicon.svg
requirements.txt           Flask + flask-sock
tests/smoke_test.py        signalling/webinar end-to-end test
```

## Protocol (WebSocket `/ws`)

Client → server: `join`, `signal` (target + payload relayed verbatim), `chat`, `state` (mic/cam/hand/presenting), `host` (`mute`, `mute-all`, `remove`, `promote`, `demote`, `handover`, `end`).

Server → client: `joined`, `peer-joined`, `roster`, `signal`, `chat`, `state`, `peer-left`, `force-mute`, `promoted`, `demoted`, `meeting-ended`, `removed`, `error`.

Rules:

- The server owns room `mode` (`meeting` | `webinar`) and peer `webinar_role` (`host` | `panelist` | `audience`). Never trust client claims for these.
- Audience media and presenting are rejected server-side; the client mirrors that only for UX.
- All shared room state is guarded by `STATE_LOCK`; keep it that way.
- Keep signalling payloads opaque — do not inspect or rewrite SDP/ICE.

## Media invariants (important)

- Each peer connection has exactly one audio sender and one video sender. Changes use `RTCRtpSender.replaceTrack`; do not add tracks or renegotiate for mute, camera, screen, video or PDF changes.
- Audience members keep their senders alive with silent-audio/blank-video fallback tracks, so promotion only needs `replaceTrack`.
- Helpers in `app.js`: `outgoingAudioTrack()`, `outgoingVideoTrack()`, `applyMicGain()`, `attachMixerMic()`, `teardownMixer()`, `activatePresentation()`, `stopPresenting()`, `teardownPresentResources()`. Route media decisions through them.
- While a video file is presented, the mic and the video's audio are mixed by Web Audio into one outgoing audio track (`state.mixer`). Mic mute controls only the mic gain, never the video audio.
- Screen, video file and PDF all reuse the outgoing video sender and set `state.presentKind` / `state.present` / `state.screenTrack`. The presenter's own tile and all remote tiles show the presentation.
- Always restore the camera track when a presentation stops, including on teardown, demotion to audience, and meeting leave.
- Browser autoplay may block a video with sound until the user interacts; the present bar's Play button is the fallback. Don't remove it.
- Chrome reports `Infinity` duration for some WebM files without duration metadata. `primeVideoDuration()` plus the `durationchange` listener handle that; the seek bar is disabled until a duration exists.

## Frontend conventions

- `app.js` is one IIFE with module-like sections. Match the existing naming and section banners; no framework, no imports, no transpiler.
- Keep all user-visible strings in English and consistent with existing copy.
- UI state lives in the `state` object. Update `sendState()` whenever media, hand or presenting state changes so other clients stay in sync.
- Use the SVG sprite (`#icon-*`) for icons; add a `<symbol>` in `index.html` if a new icon is needed.
- Styles use the CSS variables defined at the top of `styles.css`; avoid hard-coded colors that bypass the theme.
- Responsive behavior matters: test narrow layouts and the control bar.

## CSP and security constraints

`server.py` sends a strict Content-Security-Policy. If you add a dependency or API, update the policy deliberately:

- No inline `<script>`/`onclick`; scripts must be same-origin files.
- No CDN or remote fonts; vendor assets under `static/vendor/`.
- `media-src`/`img-src` allow `blob:`; `connect-src` allows `ws:`/`wss:`; `worker-src` allows `self` and `blob:` (PDF.js worker).
- Do not weaken `frame-ancestors 'none'`, `base-uri 'none'` or `form-action` without a concrete reason.
- Escape/sanitize anything interpolated into HTML. Chat and names are user-controlled.

## Don'ts

- Don't add a database.
- Don't rely on internet access at runtime (no CDN links, no remote PDF.js).
- Don't change the signalling protocol without updating both tests and the protocol section above.
- Don't commit `.venv/`, `logs/`, or `*.log`.
- Don't modify `..\_next` (the original reference bundle).
