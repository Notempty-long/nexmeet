"use strict";

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
  const setIcon = (el, name) => {
    const use = el && el.querySelector("svg.icon use");
    if (use) use.setAttribute("href", `#icon-${name}`);
  };
  const initials = (name) => {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  };
  const colorFor = (name) => {
    let hash = 0;
    for (const ch of String(name || "?")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 62% 44%)`;
  };
  const clock = (seconds) => {
    const d = new Date((seconds || Date.now() / 1000) * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  const duration = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  const state = {
    config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
    roomId: null,
    name: localStorage.getItem("nexmeet:name") || "",
    ws: null,
    selfId: null,
    hostId: null,
    role: "participant",
    mode: "meeting",
    webinarRole: "",
    pendingMode: null,
    joined: false,
    joining: false,
    ending: false,
    remote: new Map(),
    chat: [],
    pcs: new Map(),
    tiles: new Map(),
    analysers: new Map(),
    audioCtx: null,
    raf: 0,
    micOn: true,
    camOn: true,
    handRaised: false,
    sharing: false,
    presentKind: null,
    present: null,
    mixer: null,
    micTrack: null,
    cameraTrack: null,
    screenTrack: null,
    screenStream: null,
    outgoingStream: null,
    micFallback: false,
    cameraFallback: false,
    fallbackAudio: null,
    fallbackVideo: null,
    previewMic: null,
    previewCam: null,
    previewStream: null,
    previewToken: 0,
    previewPromise: null,
    startedAt: null,
    timer: 0,
    unread: 0,
    panel: null,
    modalOpen: false,
    connectionModal: false,
    screenPrompt: false,
  };

  const selfPeer = () => ({
    id: state.selfId,
    name: state.name,
    role: state.role,
    webinarRole: state.webinarRole,
    mic: state.micOn,
    cam: state.camOn,
    hand: state.handRaised,
    sharing: state.sharing,
  });

  const participant = (id) => (id === state.selfId ? selfPeer() : state.remote.get(id));

  const isWebinar = () => state.mode === "webinar";
  const canSpeak = () => !isWebinar() || (state.webinarRole !== "audience" && !!state.webinarRole);

  // -------------------------------------------------------------------------
  // UI basics
  // -------------------------------------------------------------------------

  function showView(id) {
    for (const view of ["landingView", "prejoinView", "roomView"]) {
      $(`#${view}`).classList.toggle("hidden", view !== id);
    }
    document.body.dataset.view = id;
  }

  function toast(text, tone = "info", timeout = 3500) {
    const box = $("#toasts");
    while (box.children.length >= 4) box.firstElementChild.remove();
    const el = document.createElement("div");
    el.className = `toast${tone !== "info" ? ` toast-${tone}` : ""}`;
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 220);
    }, timeout);
  }

  function showModal({ title, message, iconName = "phone-off", tone = "danger", actions = [], dismissible = false }) {
    const backdrop = $("#modalBackdrop");
    const iconBox = $("#modalIcon");
    iconBox.className = `modal-icon${tone === "info" ? " is-info" : ""}`;
    iconBox.innerHTML = icon(iconName);
    $("#modalTitle").textContent = title;
    $("#modalMessage").textContent = message || "";
    const box = $("#modalActions");
    box.innerHTML = "";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${action.style || "btn-secondary"}`;
      btn.textContent = action.label;
      btn.addEventListener("click", action.onClick);
      box.appendChild(btn);
    }
    backdrop.classList.remove("hidden");
    state.modalOpen = true;
    state.modalDismissible = dismissible;
    setTimeout(() => box.querySelector("button")?.focus(), 40);
  }

  function hideModal() {
    $("#modalBackdrop").classList.add("hidden");
    state.modalOpen = false;
    state.modalDismissible = false;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  function roomFromLocation() {
    const hash = location.hash.match(/^#\/room\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/);
    if (hash) return hash[1];
    const path = location.pathname.match(/^\/room\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/);
    return path ? path[1] : null;
  }

  function parseRoomInput(raw) {
    let value = String(raw || "").trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        const match = url.hash.match(/room\/([^/?#]+)/) || url.pathname.match(/\/room\/([^/?#]+)/);
        if (match) value = match[1];
      } catch {
        return null;
      }
    }
    value = value.replace(/^.*(?:#|\/)room\//, "").split(/[?#]/)[0].replace(/\/+$/, "");
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ? value : null;
  }

  function newRoomCode() {
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const part = (n) => {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    };
    return `${part(3)}-${part(4)}-${part(3)}`;
  }

  function startWebinar() {
    const code = newRoomCode();
    sessionStorage.setItem(`nexmeet:mode:${code}`, "webinar");
    goToRoom(code);
  }

  function goToRoom(code) {
    location.hash = `#/room/${code}`;
  }

  function goHome() {
    hideModal();
    state.connectionModal = false;
    state.ending = false;
    history.replaceState({}, "", "/");
    route();
  }

  function route() {
    if (state.joined || state.joining) return;
    const room = roomFromLocation();
    if (room) enterPrejoin(room);
    else showLanding();
  }

  function showLanding() {
    stopPreview();
    state.roomId = null;
    state.pendingMode = null;
    state.previewToken++;
    $("#prejoinModeNote").classList.add("hidden");
    showView("landingView");
    document.title = "NexMeet — meetings that stay yours";
    $("#joinError").classList.add("hidden");
  }

  function enterPrejoin(room) {
    if (state.joined) return;
    state.roomId = room;
    state.previewToken++;
    state.pendingMode = sessionStorage.getItem(`nexmeet:mode:${room}`) || null;
    const webinar = state.pendingMode === "webinar";
    $("#prejoinRoomCode").textContent = room;
    $("#prejoinError").classList.add("hidden");
    $("#deviceNote").textContent = "";
    $("#prejoinTitle").textContent = webinar ? "Start the webinar" : "Join the meeting";
    $("#prejoinSub").textContent = webinar
      ? "You'll be the host. Share the link once you're in; everyone else joins the audience."
      : "Check your camera and mic, then jump in. No account needed.";
    $("#prejoinModeNote").classList.toggle("hidden", !webinar);
    $("#nameInput").value = state.name;
    updatePreviewName();
    setJoinLoading(false);
    showView("prejoinView");
    document.title = `Join ${room} · NexMeet`;
    state.previewPromise = acquirePreview();
  }

  function updatePreviewName() {
    $("#previewName").textContent = state.name || "Your name";
    $("#previewInitials").textContent = initials(state.name || "You");
  }

  // -------------------------------------------------------------------------
  // Preview + local media
  // -------------------------------------------------------------------------

  async function getMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return stream.getAudioTracks()[0] || null;
    } catch {
      return null;
    }
  }

  async function getCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
      return stream.getVideoTracks()[0] || null;
    } catch {
      return null;
    }
  }

  async function acquirePreview() {
    const token = state.previewToken;
    let mic = null;
    let cam = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
      mic = stream.getAudioTracks()[0] || null;
      cam = stream.getVideoTracks()[0] || null;
    } catch {
      if (token !== state.previewToken) return;
      mic = await getMic();
      cam = await getCamera();
    }
    if (token !== state.previewToken) {
      mic?.stop();
      cam?.stop();
      return;
    }
    state.previewMic = mic;
    state.previewCam = cam;
    state.previewStream = new MediaStream([mic, cam].filter(Boolean));
    state.micOn = !!mic;
    state.camOn = !!cam;

    const note = $("#deviceNote");
    if (!mic && !cam) note.textContent = "No camera or microphone found. You can still join and listen.";
    else if (!cam) note.textContent = "Camera unavailable — you can still join with audio.";
    else if (!mic) note.textContent = "Microphone unavailable — you can still join and watch.";

    updatePreviewMedia();
    updatePreviewControls();
  }

  function updatePreviewMedia() {
    const video = $("#previewVideo");
    const live = !!state.previewCam && state.camOn;
    if (live) {
      if (video.srcObject?.getVideoTracks()[0] !== state.previewCam) {
        video.srcObject = new MediaStream([state.previewCam]);
      }
      video.play().catch(() => {});
    } else {
      video.srcObject = null;
    }
    $("#previewStage").classList.toggle("camera-off", !live);
    $("#previewAvatar").classList.toggle("hidden", live);
    $("#previewBadge").textContent = live ? "Live preview" : "Camera off";
    $("#previewHint").textContent = state.micOn ? "Mic on" : "Mic muted";
    updatePreviewName();
  }

  function updatePreviewControls() {
    const micBtn = $("#previewMicBtn");
    const camBtn = $("#previewCamBtn");
    micBtn.classList.toggle("off", !state.micOn);
    camBtn.classList.toggle("off", !state.camOn);
    setIcon(micBtn, state.micOn ? "mic" : "mic-off");
    setIcon(camBtn, state.camOn ? "camera" : "camera-off");
    micBtn.setAttribute("aria-pressed", String(!state.micOn));
    camBtn.setAttribute("aria-pressed", String(!state.camOn));
  }

  async function togglePreviewMic() {
    if (state.micOn) {
      state.micOn = false;
      if (state.previewMic) state.previewMic.enabled = false;
    } else {
      let track = state.previewMic;
      if (!track) {
        track = await getMic();
        if (!track) {
          toast("Microphone unavailable", "danger");
          return;
        }
        state.previewMic = track;
        state.previewStream = new MediaStream([track, state.previewCam].filter(Boolean));
      }
      state.micOn = true;
      track.enabled = true;
    }
    updatePreviewMedia();
    updatePreviewControls();
  }

  async function togglePreviewCamera() {
    if (state.camOn) {
      state.camOn = false;
      if (state.previewCam) state.previewCam.enabled = false;
    } else {
      let track = state.previewCam;
      if (!track) {
        track = await getCamera();
        if (!track) {
          toast("Camera unavailable", "danger");
          return;
        }
        state.previewCam = track;
        state.previewStream = new MediaStream([state.previewMic, track].filter(Boolean));
      }
      state.camOn = true;
      track.enabled = true;
    }
    updatePreviewMedia();
    updatePreviewControls();
  }

  function stopPreview() {
    if (state.joined) return;
    state.previewToken++;
    state.previewMic?.stop();
    state.previewCam?.stop();
    state.previewStream?.getTracks().forEach((t) => t.stop());
    state.previewMic = null;
    state.previewCam = null;
    state.previewStream = null;
    state.previewPromise = null;
    const video = $("#previewVideo");
    if (video) video.srcObject = null;
  }

  function createFallbackAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      gain.gain.value = 0;
      osc.connect(gain).connect(dest);
      osc.start();
      const track = dest.stream.getAudioTracks()[0];
      state.fallbackAudio = { ctx, osc, track };
      return track;
    } catch {
      return null;
    }
  }

  function createFallbackVideo() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0b1020";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(1);
      const track = stream.getVideoTracks()[0];
      state.fallbackVideo = { canvas, stream, track };
      return track;
    } catch {
      return null;
    }
  }

  async function prepareOutgoingTracks() {
    if (state.previewPromise) {
      await state.previewPromise.catch(() => {});
      state.previewPromise = null;
    }
    let mic = state.previewMic;
    let cam = state.previewCam;

    if (!mic && state.micOn) mic = await getMic();
    if (!cam && state.camOn) cam = await getCamera();

    if (!mic) {
      mic = createFallbackAudio();
      state.micFallback = !!mic;
      if (state.micOn) state.micOn = false;
    }
    if (!cam) {
      cam = createFallbackVideo();
      state.cameraFallback = !!cam;
      if (state.camOn) state.camOn = false;
    }
    if (mic) mic.enabled = state.micOn;
    if (cam) cam.enabled = state.camOn;

    state.micTrack = mic;
    state.cameraTrack = cam;
    state.outgoingStream = new MediaStream([mic, cam].filter(Boolean));
    state.previewMic = null;
    state.previewCam = null;
    state.previewStream = null;
    const preview = $("#previewVideo");
    if (preview) preview.srcObject = null;
  }

  function resetOutgoingMedia() {
    const tracks = new Set(
      [state.micTrack, state.cameraTrack].filter(Boolean)
    );
    state.outgoingStream?.getTracks().forEach((track) => tracks.add(track));
    for (const track of tracks) {
      try { track.stop(); } catch {}
    }
    if (state.fallbackAudio) {
      try {
        state.fallbackAudio.osc.stop();
        state.fallbackAudio.ctx.close();
      } catch {}
      state.fallbackAudio = null;
    }
    if (state.fallbackVideo) {
      state.fallbackVideo.stream.getTracks().forEach((track) => {
        try { track.stop(); } catch {}
      });
      state.fallbackVideo = null;
    }
    state.micTrack = null;
    state.cameraTrack = null;
    state.outgoingStream = null;
    state.micFallback = false;
    state.cameraFallback = false;
  }

  // -------------------------------------------------------------------------
  // Webinar speaking roles
  // -------------------------------------------------------------------------

  function disposeFallbackAudio() {
    if (!state.fallbackAudio) return;
    try {
      state.fallbackAudio.osc.stop();
      state.fallbackAudio.ctx.close();
    } catch {}
    state.fallbackAudio = null;
  }

  function disposeFallbackVideo() {
    if (!state.fallbackVideo) return;
    state.fallbackVideo.stream.getTracks().forEach((track) => {
      try { track.stop(); } catch {}
    });
    state.fallbackVideo = null;
  }

  function rebuildOutgoingStream() {
    const previous = state.outgoingStream;
    state.outgoingStream = new MediaStream([state.micTrack, state.cameraTrack].filter(Boolean));
    if (!previous) return;
    for (const track of previous.getTracks()) {
      if (track === state.micTrack || track === state.cameraTrack) continue;
      try { track.stop(); } catch {}
    }
  }

  // Audience members keep their sender slots alive with a silent audio track
  // and a blank video track, so a later promotion only needs replaceTrack()
  // instead of a full renegotiation.
  function swapToAudienceMedia() {
    const previous = { mic: state.micTrack, cam: state.cameraTrack };
    if (state.present) teardownPresentResources(state.present);
    state.presentKind = null;
    state.present = null;
    teardownMixer();
    state.micOn = false;
    state.camOn = false;
    state.handRaised = false;
    state.sharing = false;
    state.screenStream?.getTracks().forEach((track) => {
      try { track.stop(); } catch {}
    });
    state.screenTrack = null;
    state.screenStream = null;
    disposeFallbackAudio();
    disposeFallbackVideo();
    state.micTrack = createFallbackAudio();
    state.cameraTrack = createFallbackVideo();
    state.micFallback = !!state.micTrack;
    state.cameraFallback = !!state.cameraTrack;
    if (state.micTrack) state.micTrack.enabled = false;
    if (state.cameraTrack) state.cameraTrack.enabled = false;
    rebuildOutgoingStream();
    return previous;
  }

  function applyAudienceMedia() {
    const previous = swapToAudienceMedia();
    for (const track of [previous.mic, previous.cam]) {
      try { track?.stop(); } catch {}
    }
    detachAnalyser(state.selfId);
    syncLocalVideo();
    syncMediaButtons();
  }

  async function becomeAudience() {
    if (state.webinarRole === "audience") return;
    if (state.presentKind) await stopPresenting({ silent: true });
    state.webinarRole = "audience";
    const previous = swapToAudienceMedia();
    await replaceEverywhere("audio", state.micTrack);
    await replaceEverywhere("video", state.cameraTrack);
    for (const track of [previous.mic, previous.cam]) {
      try { track?.stop(); } catch {}
    }
    detachAnalyser(state.selfId);
    syncLocalVideo();
    syncMediaButtons();
    updateModeUi();
    sendState();
    toast("The host moved you to the audience", "warning");
  }

  async function becomePanelist(role = "panelist") {
    state.webinarRole = role;
    state.handRaised = false;
    if (state.micFallback || !state.micTrack) {
      const track = await getMic();
      if (track) {
        state.micTrack = track;
        state.micFallback = false;
        disposeFallbackAudio();
        rebuildOutgoingStream();
        await replaceEverywhere("audio", track);
      }
    }
    if (state.micTrack && !state.micFallback) {
      state.micOn = true;
      applyMicGain();
      ensureAudioContext();
      syncSelfAnalyser();
    }
    syncLocalVideo();
    syncMediaButtons();
    updateModeUi();
    updateTile(state.selfId);
    sendState();
    if (state.micOn) toast("You're now a panelist — your mic is live", "success");
    else toast("Microphone unavailable — press Unmute to try again", "warning");
  }

  function handleWebinarRole(msg) {
    const isSelf = msg.peerId === state.selfId;
    if (isSelf) {
      if (msg.role === "audience") {
        becomeAudience();
        addSystem("You moved to the audience");
      } else {
        becomePanelist(state.role === "host" ? "host" : "panelist");
        addSystem("You're now a panelist");
      }
      return;
    }
    const peer = state.remote.get(msg.peerId);
    if (peer) peer.webinarRole = msg.role;
    updateTile(msg.peerId);
    updateModeUi();
    const name = msg.name || peer?.name || "A participant";
    addSystem(msg.role === "audience" ? `${name} moved to the audience` : `${name} is now a panelist`);
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  async function loadConfig() {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length) state.config.iceServers = data.iceServers;
      }
    } catch {
      /* defaults are fine */
    }
  }

  function send(payload) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
  }

  function connectSocket() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      state.ws = ws;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error("The server took too long to respond."));
      }, 12000);

      ws.onopen = () => {
        send({
          type: "join",
          room: state.roomId,
          name: state.name,
          mode: state.pendingMode || undefined,
          state: { mic: state.micOn, cam: state.camOn },
        });
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!settled) {
          if (msg.type === "joined") {
            settled = true;
            clearTimeout(timeout);
            handleJoined(msg).catch(() => {});
            resolve();
          } else if (msg.type === "error") {
            settled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            reject(new Error(msg.message || "Could not join the meeting."));
          }
          return;
        }
        try { handleMessage(msg); } catch (err) { console.warn(err); }
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Could not connect to the meeting server."));
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Connection closed before joining."));
          return;
        }
        if (state.joined && !state.ending && !state.connectionModal) handleConnectionLost();
      };
    });
  }

  async function joinMeeting() {
    if (state.joining) return;
    const name = $("#nameInput").value.trim();
    if (!name) {
      showPrejoinError("Please enter your name.");
      return;
    }
    state.name = name.slice(0, 40);
    localStorage.setItem("nexmeet:name", state.name);
    state.joining = true;
    state.connectionModal = false;
    hidePrejoinError();
    setJoinLoading(true);
    try {
      await prepareOutgoingTracks();
      try {
        await connectSocket();
      } catch (err) {
        // Flask's dev server can drop a rejoin handshake now and then; retry once.
        const transient = /Could not connect|took too long|closed before joining/i.test(err.message || "");
        if (!transient || state.joined) throw err;
        if (state.ws) {
          state.ws.onclose = null;
          try { state.ws.close(); } catch {}
          state.ws = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (!state.joined) await connectSocket();
      }
    } catch (err) {
      state.joining = false;
      setJoinLoading(false);
      showPrejoinError(err.message || "Could not join the meeting.");
      toast(err.message || "Could not join the meeting.", "danger");
      if (!state.joined) {
        const micWanted = state.micOn;
        const camWanted = state.camOn;
        resetOutgoingMedia();
        if (state.ws) {
          state.ws.onclose = null;
          try { state.ws.close(); } catch {}
          state.ws = null;
        }
        state.previewPromise = acquirePreview().then(() => {
          if (!micWanted && state.previewMic) {
            state.previewMic.enabled = false;
            state.micOn = false;
          }
          if (!camWanted && state.previewCam) {
            state.previewCam.enabled = false;
            state.camOn = false;
          }
          updatePreviewMedia();
          updatePreviewControls();
        });
      }
    }
  }

  async function handleJoined(msg) {
    state.selfId = msg.selfId;
    state.hostId = msg.hostId;
    state.role = msg.role;
    state.mode = msg.mode === "webinar" ? "webinar" : "meeting";
    state.webinarRole = typeof msg.webinarRole === "string" ? msg.webinarRole : "";
    state.joined = true;
    state.joining = false;
    state.ending = false;
    state.remote = new Map((msg.participants || []).map((p) => [p.id, p]));
    state.chat = Array.isArray(msg.chat) ? msg.chat : [];
    state.startedAt = (msg.startedAt || Date.now() / 1000) * 1000;
    state.micOn = state.micTrack?.enabled ?? state.micOn;
    state.camOn = state.cameraTrack?.enabled ?? state.camOn;
    state.handRaised = false;
    state.sharing = false;
    if (isWebinar() && state.webinarRole === "audience") applyAudienceMedia();

    setJoinLoading(false);
    showView("roomView");
    document.title = `${state.roomId} · NexMeet`;
    $("#roomTitle").textContent = state.roomId;

    buildTile(state.selfId, selfPeer());
    for (const peer of state.remote.values()) buildTile(peer.id, peer);
    renderPeople();
    renderChatHistory();
    updateHeader();
    updateGridCount();
    updateModeUi();
    syncMediaButtons();
    syncLocalVideo();
    ensureAudioContext();
    attachAnalyser(state.selfId, state.outgoingStream);
    startSpeakingLoop();
    startTimer();
    send({ type: "state", state: stateSnapshot() });
    if (isWebinar() && state.webinarRole === "audience") {
      toast("You're in the audience — the host can invite you to speak", "info", 5000);
    } else if (isWebinar()) {
      toast("Your webinar is live — share the room link to invite people", "success", 5000);
    } else {
      toast("You joined the meeting", "success");
    }
    for (const id of state.remote.keys()) {
      createPeer(id, true).catch((err) => console.warn("peer", id, err));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "peer-joined": {
        const p = msg.participant;
        if (!p) return;
        state.remote.set(p.id, p);
        buildTile(p.id, p);
        updateHeader();
        updateGridCount();
        updateModeUi();
        renderPeople();
        addSystem(`${p.name} joined the ${isWebinar() ? "webinar" : "meeting"}`);
        toast(`${p.name} joined`, "info");
        break;
      }
      case "peer-left": {
        const peer = state.remote.get(msg.peerId);
        closePeer(msg.peerId);
        state.remote.delete(msg.peerId);
        removeTile(msg.peerId);
        updateHeader();
        updateGridCount();
        updateModeUi();
        renderPeople();
        if (peer) {
          addSystem(`${peer.name} left the ${isWebinar() ? "webinar" : "meeting"}`);
          toast(`${peer.name} left`);
        }
        break;
      }
      case "host-changed": {
        state.hostId = msg.hostId;
        state.role = state.hostId === state.selfId ? "host" : "participant";
        if (typeof msg.mode === "string" && msg.mode) {
          state.mode = msg.mode === "webinar" ? "webinar" : "meeting";
        }
        if (isWebinar()) {
          if (state.hostId === state.selfId) {
            const wasAudience = state.webinarRole === "audience";
            state.webinarRole = "host";
            if (wasAudience) becomePanelist("host");
          } else if (state.remote.has(state.hostId)) {
            state.remote.get(state.hostId).webinarRole = msg.webinarRole || "panelist";
          }
        }
        for (const id of state.tiles.keys()) updateTile(id);
        updateModeUi();
        renderPeople();
        const isMe = msg.hostId === state.selfId;
        addSystem(isMe ? "You are now the host" : `${msg.hostName || "A participant"} is now the host`);
        if (!isMe) toast(`${msg.hostName || "The host"} is now the host`, "warning");
        break;
      }
      case "signal":
        handleSignal(msg.from, msg.data).catch((err) => console.warn("signal", err));
        break;
      case "webinar-role":
        handleWebinarRole(msg);
        break;
      case "state": {
        const peer = state.remote.get(msg.peerId);
        if (!peer) return;
        Object.assign(peer, msg.state || {});
        updateTile(msg.peerId);
        if (state.panel === "people") renderPeople();
        break;
      }
      case "chat": {
        const message = msg.message;
        if (!message) return;
        state.chat.push(message);
        appendChat(message);
        if (!(state.panel === "chat" && !$("#sidePanel").classList.contains("hidden"))) {
          if (message.peerId !== state.selfId) {
            state.unread++;
            updateUnread();
          }
        }
        break;
      }
      case "force-mute":
        state.micOn = false;
        applyMicGain();
        updateTile(state.selfId);
        syncMediaButtons();
        toast("The host muted your microphone", "warning");
        break;
      case "removed":
        onRemoved(msg.reason);
        break;
      case "meeting-ended":
        if (state.ending) {
          state.ending = false;
          leaveMeeting("You ended the meeting");
          break;
        }
        onMeetingEnded(msg.by);
        break;
      case "error":
        toast(msg.message || "Something went wrong.", "danger");
        break;
    }
  }

  function stateSnapshot() {
    return {
      mic: state.micOn,
      cam: state.camOn,
      hand: state.handRaised,
      sharing: state.sharing,
    };
  }

  function sendState() {
    if (state.joined) send({ type: "state", state: stateSnapshot() });
  }

  // -------------------------------------------------------------------------
  // Presentation helpers
  // -------------------------------------------------------------------------

  const PRESENT_VIDEO_WIDTH = 1280;
  const PRESENT_VIDEO_HEIGHT = 720;
  const PRESENT_PDF_WIDTH = 1600;
  const PRESENT_PDF_HEIGHT = 900;

  // While a video is presenting, the mic and the video's own audio are mixed
  // into one track by Web Audio, so peers only ever need a single audio sender.
  function outgoingAudioTrack() {
    return state.mixer?.track || state.micTrack;
  }

  function outgoingVideoTrack() {
    return state.presentKind && state.screenTrack ? state.screenTrack : state.cameraTrack;
  }

  function applyMicGain() {
    if (state.mixer) {
      // The mixer owns on/off through gain, so the source track stays enabled.
      if (state.micTrack) state.micTrack.enabled = true;
      state.mixer.micGain.gain.value = state.micOn ? 1 : 0;
      return;
    }
    if (state.micTrack) state.micTrack.enabled = state.micOn;
  }

  function attachMixerMic() {
    const mixer = state.mixer;
    if (!mixer || !state.micTrack) return;
    try { mixer.micSource?.disconnect(); } catch {}
    try {
      state.micTrack.enabled = true;
      mixer.micSource = mixer.ctx.createMediaStreamSource(new MediaStream([state.micTrack]));
      mixer.micSource.connect(mixer.micGain);
    } catch {
      mixer.micSource = null;
    }
    mixer.micGain.gain.value = state.micOn ? 1 : 0;
  }

  function teardownMixer() {
    const mixer = state.mixer;
    if (!mixer) return;
    try { mixer.micSource?.disconnect(); } catch {}
    try { mixer.videoSource?.disconnect(); } catch {}
    try { mixer.micGain.disconnect(); } catch {}
    try { mixer.videoGain.disconnect(); } catch {}
    try { mixer.track.stop(); } catch {}
    state.mixer = null;
  }

  function syncSelfAnalyser() {
    const track = outgoingAudioTrack();
    if (track) attachAnalyser(state.selfId, new MediaStream([track]));
    else detachAnalyser(state.selfId);
  }

  function drawContain(ctx, source, sourceWidth, sourceHeight, width, height, background = "#05070d") {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    if (!sourceWidth || !sourceHeight) return;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  function teardownPresentResources(present) {
    if (!present) return;
    if (present.kind === "video") {
      cancelAnimationFrame(present.raf);
      try { present.video.pause(); } catch {}
      try {
        present.video.removeAttribute("src");
        present.video.load();
      } catch {}
      if (present.objectUrl) URL.revokeObjectURL(present.objectUrl);
      try { present.stream?.getTracks().forEach((track) => track.stop()); } catch {}
    } else if (present.kind === "pdf") {
      present.token++;
      try { present.doc?.destroy(); } catch {}
      try { present.stream?.getTracks().forEach((track) => track.stop()); } catch {}
    } else if (present.kind === "screen") {
      try { present.stream?.getTracks().forEach((track) => track.stop()); } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // WebRTC
  // -------------------------------------------------------------------------

  async function createPeer(peerId, initiator) {
    if (state.pcs.has(peerId)) return state.pcs.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
    const ctx = {
      pc,
      audioSender: null,
      videoSender: null,
      candidates: [],
      stream: new MediaStream(),
      initiator,
      restarted: false,
    };
    state.pcs.set(peerId, ctx);

    const audioTrack = outgoingAudioTrack();
    if (audioTrack) ctx.audioSender = pc.addTrack(audioTrack);
    const outgoingVideo = outgoingVideoTrack();
    if (outgoingVideo) ctx.videoSender = pc.addTrack(outgoingVideo);

    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: "signal", to: peerId, data: { type: "candidate", candidate: event.candidate } });
    };
    pc.ontrack = (event) => {
      if (!ctx.stream.getTracks().some((t) => t.id === event.track.id)) ctx.stream.addTrack(event.track);
      const tile = state.tiles.get(peerId);
      if (tile) {
        tile.video.srcObject = ctx.stream;
        tile.video.play().catch(showAudioPrompt);
      }
      attachAnalyser(peerId, ctx.stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && initiator && !ctx.restarted) {
        ctx.restarted = true;
        restartPeer(peerId, ctx);
      }
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "signal", to: peerId, data: { type: "offer", sdp: pc.localDescription } });
      } catch (err) {
        console.warn("offer failed", err);
      }
    }
    return ctx;
  }

  async function restartPeer(peerId, ctx) {
    try {
      const offer = await ctx.pc.createOffer({ iceRestart: true });
      await ctx.pc.setLocalDescription(offer);
      send({ type: "signal", to: peerId, data: { type: "offer", sdp: ctx.pc.localDescription } });
    } catch {
      /* ignore */
    }
  }

  async function handleSignal(from, data) {
    if (!data || !from) return;
    if (data.type === "offer") {
      const ctx = state.pcs.get(from) || (await createPeer(from, false));
      await ctx.pc.setRemoteDescription(data.sdp);
      for (const candidate of ctx.candidates) {
        try { await ctx.pc.addIceCandidate(candidate); } catch {}
      }
      ctx.candidates = [];
      const answer = await ctx.pc.createAnswer();
      await ctx.pc.setLocalDescription(answer);
      send({ type: "signal", to: from, data: { type: "answer", sdp: ctx.pc.localDescription } });
    } else if (data.type === "answer") {
      const ctx = state.pcs.get(from);
      if (!ctx) return;
      await ctx.pc.setRemoteDescription(data.sdp);
      for (const candidate of ctx.candidates) {
        try { await ctx.pc.addIceCandidate(candidate); } catch {}
      }
      ctx.candidates = [];
    } else if (data.type === "candidate") {
      const ctx = state.pcs.get(from);
      if (!ctx) return;
      if (ctx.pc.remoteDescription) {
        try { await ctx.pc.addIceCandidate(data.candidate); } catch {}
      } else {
        ctx.candidates.push(data.candidate);
      }
    }
  }

  function closePeer(peerId) {
    const ctx = state.pcs.get(peerId);
    if (!ctx) return;
    try {
      ctx.pc.onicecandidate = null;
      ctx.pc.ontrack = null;
      ctx.pc.close();
    } catch {}
    state.pcs.delete(peerId);
    detachAnalyser(peerId);
  }

  async function replaceEverywhere(kind, track) {
    for (const ctx of state.pcs.values()) {
      const sender = kind === "audio" ? ctx.audioSender : ctx.videoSender;
      if (sender) {
        try { await sender.replaceTrack(track); } catch {}
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tiles
  // -------------------------------------------------------------------------

  function buildTile(id, peer) {
    if (state.tiles.has(id)) {
      updateTile(id);
      return;
    }
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.peer = id;
    el.style.setProperty("--avatar-color", colorFor(peer.name));

    const avatar = document.createElement("div");
    avatar.className = "tile-avatar";
    const avatarSpan = document.createElement("span");
    avatarSpan.textContent = initials(peer.name);
    avatar.appendChild(avatarSpan);

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    if (id === state.selfId) video.muted = true;

    const top = document.createElement("div");
    top.className = "tile-top";
    const hand = document.createElement("span");
    hand.className = "hand-badge hidden";
    hand.innerHTML = `${icon("hand")}Hand`;
    top.appendChild(hand);

    const status = document.createElement("div");
    status.className = "tile-status hidden";
    status.textContent = "Presenting";

    const bottom = document.createElement("div");
    bottom.className = "tile-bottom";
    const name = document.createElement("span");
    name.className = "tile-name";
    const host = document.createElement("span");
    host.className = "host-badge hidden";
    host.innerHTML = `${icon("crown")}Host`;
    const mic = document.createElement("span");
    mic.className = "tile-mic";
    mic.innerHTML = icon("mic");

    bottom.append(name, host, mic);
    el.append(avatar, video, top, status, bottom);
    $("#videoGrid").appendChild(el);
    state.tiles.set(id, { el, video, avatar, avatarSpan, name, host, mic, hand, status });
    updateTile(id);
    if (id === state.selfId) syncLocalVideo();
  }

  function updateTile(id) {
    const tile = state.tiles.get(id);
    const peer = participant(id);
    if (!tile || !peer) return;
    const isSelf = id === state.selfId;
    tile.el.style.setProperty("--avatar-color", colorFor(peer.name));
    tile.avatarSpan.textContent = initials(peer.name);
    tile.name.textContent = `${peer.name}${isSelf ? " (you)" : ""}`;
    tile.host.classList.toggle("hidden", peer.id !== state.hostId);
    tile.hand.classList.toggle("hidden", !peer.hand);
    tile.mic.classList.toggle("is-muted", !peer.mic);
    tile.mic.innerHTML = icon(peer.mic ? "mic" : "mic-off");
    tile.status.classList.toggle("hidden", !peer.sharing);
    tile.el.classList.toggle("presenting", !!peer.sharing);
    tile.el.classList.toggle("cam-off", !peer.cam && !peer.sharing);
    tile.el.title = peer.name;
  }

  function removeTile(id) {
    const tile = state.tiles.get(id);
    if (!tile) return;
    tile.video.srcObject = null;
    tile.el.remove();
    state.tiles.delete(id);
  }

  function syncLocalVideo() {
    const tile = state.tiles.get(state.selfId);
    if (!tile) return;
    if (state.presentKind && state.screenTrack) {
      tile.video.srcObject = new MediaStream([state.screenTrack]);
      tile.video.classList.remove("mirror");
    } else {
      tile.video.srcObject = state.cameraTrack ? new MediaStream([state.cameraTrack]) : null;
      tile.video.classList.add("mirror");
    }
    tile.video.play().catch(() => {});
    updateTile(state.selfId);
  }

  function updateGridCount() {
    if (!state.joined) return;
    const count = 1 + state.remote.size;
    $("#participantCountLabel").textContent = count;
    $("#peopleTabCount").textContent = count;
    $("#peopleCount").textContent = isWebinar()
      ? `${count} in the room`
      : `${count} participant${count === 1 ? "" : "s"}`;
    applyTileVisibility();
    updateWebinarBar();
  }

  function applyTileVisibility() {
    if (!state.joined) return;
    let visible = 0;
    for (const [id, tile] of state.tiles) {
      const peer = participant(id);
      const away = isWebinar() && peer?.webinarRole === "audience" && id !== state.selfId;
      tile.el.classList.toggle("is-away", away);
      if (!away) visible += 1;
    }
    const count = Math.max(1, visible);
    $("#videoGrid").dataset.count = count <= 2 ? String(count) : "many";
  }

  function updateWebinarBar() {
    const bar = $("#webinarBar");
    if (!bar) return;
    bar.classList.toggle("hidden", !isWebinar());
    if (!isWebinar()) return;
    let audience = state.webinarRole === "audience" ? 1 : 0;
    for (const peer of state.remote.values()) {
      if (peer.webinarRole === "audience") audience += 1;
    }
    const total = 1 + state.remote.size;
    const speakers = Math.max(0, total - audience);
    $("#webinarBarText").textContent = state.webinarRole === "audience"
      ? "You're in the audience — raise your hand to ask to speak"
      : `Webinar · ${speakers} speaker${speakers === 1 ? "" : "s"} · ${audience} watching`;
  }

  function updateModeUi() {
    if (!state.joined) return;
    $("#modeBadge").classList.toggle("hidden", !isWebinar());
    applyTileVisibility();
    updateWebinarBar();
    syncMediaButtons();
    renderPeople();
  }

  function updateHeader() {
    updateGridCount();
    if (state.joined) $("#roomTitle").textContent = state.roomId;
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  function syncMediaButtons() {
    const micBtn = $("#micBtn");
    const camBtn = $("#camBtn");
    const shareBtn = $("#shareBtn");
    const handBtn = $("#handBtn");
    const allowed = canSpeak();

    for (const [btn, title] of [
      [micBtn, "Mute (M)"],
      [camBtn, "Camera (V)"],
      [shareBtn, "Share screen"],
    ]) {
      btn.disabled = !allowed;
      btn.title = allowed ? title : "Only panelists can do that in a webinar";
    }

    micBtn.classList.toggle("is-off", !state.micOn);
    micBtn.setAttribute("aria-pressed", String(!state.micOn));
    setIcon(micBtn, state.micOn ? "mic" : "mic-off");
    micBtn.querySelector(".control-label").textContent = !allowed
      ? "Mic off"
      : state.micOn ? "Mute" : "Unmute";

    camBtn.classList.toggle("is-off", !state.camOn);
    camBtn.setAttribute("aria-pressed", String(!state.camOn));
    setIcon(camBtn, state.camOn ? "camera" : "camera-off");
    camBtn.querySelector(".control-label").textContent = !allowed
      ? "Camera off"
      : state.camOn ? "Camera" : "Camera off";

    shareBtn.classList.toggle("is-active", !!state.presentKind);
    shareBtn.setAttribute("aria-pressed", String(!!state.presentKind));
    setIcon(shareBtn, state.presentKind ? "screen-off" : "screen");
    shareBtn.querySelector(".control-label").textContent = state.presentKind ? "Stop" : "Present";
    shareBtn.setAttribute("aria-label", state.presentKind ? "Stop presenting" : "Present screen, video or PDF");
    shareBtn.title = allowed
      ? state.presentKind ? "Stop presenting" : "Present screen, video or PDF"
      : "Only panelists can do that in a webinar";

    handBtn.classList.toggle("is-raised", state.handRaised);
    handBtn.setAttribute("aria-pressed", String(state.handRaised));
    handBtn.querySelector(".control-label").textContent = state.handRaised ? "Lower hand" : "Raise hand";
  }

  async function toggleMic() {
    if (!canSpeak()) {
      toast("The host hasn't invited you to speak yet — raise your hand", "warning");
      return;
    }
    const next = !state.micOn;
    if (next && (!state.micTrack || state.micFallback)) {
      const track = await getMic();
      if (!track) {
        toast("Microphone unavailable", "danger");
        return;
      }
      const old = state.micTrack;
      state.micTrack = track;
      state.micFallback = false;
      state.outgoingStream?.removeTrack(old).addTrack(track);
      try { old?.stop(); } catch {}
      if (state.fallbackAudio) {
        try { state.fallbackAudio.osc.stop(); state.fallbackAudio.ctx.close(); } catch {}
        state.fallbackAudio = null;
      }
      if (state.mixer) attachMixerMic();
      await replaceEverywhere("audio", outgoingAudioTrack());
      syncSelfAnalyser();
    }
    if (!state.micTrack) return;
    state.micOn = next;
    applyMicGain();
    if (next) ensureAudioContext();
    updateTile(state.selfId);
    syncMediaButtons();
    sendState();
  }

  async function toggleCamera() {
    if (!canSpeak()) {
      toast("The host hasn't invited you to speak yet — raise your hand", "warning");
      return;
    }
    const next = !state.camOn;
    if (next && (!state.cameraTrack || state.cameraFallback)) {
      const track = await getCamera();
      if (!track) {
        toast("Camera unavailable", "danger");
        return;
      }
      const old = state.cameraTrack;
      state.cameraTrack = track;
      state.cameraFallback = false;
      state.outgoingStream?.removeTrack(old).addTrack(track);
      try { old?.stop(); } catch {}
      if (state.fallbackVideo) {
        state.fallbackVideo.stream.getTracks().forEach((t) => t.stop());
        state.fallbackVideo = null;
      }
      if (!state.presentKind) await replaceEverywhere("video", track);
      syncLocalVideo();
    }
    if (!state.cameraTrack) return;
    state.camOn = next;
    state.cameraTrack.enabled = next;
    syncLocalVideo();
    syncMediaButtons();
    sendState();
  }

  function toggleHand() {
    state.handRaised = !state.handRaised;
    updateTile(state.selfId);
    syncMediaButtons();
    sendState();
    if (state.handRaised) toast("Your hand is raised", "warning");
  }

  // -------------------------------------------------------------------------
  // Presenting: screen, video file, PDF
  // -------------------------------------------------------------------------

  function ensureMixer() {
    ensureAudioContext();
    const ctx = state.audioCtx;
    if (!ctx) return null;
    if (state.mixer) return state.mixer;
    const destination = ctx.createMediaStreamDestination();
    const micGain = ctx.createGain();
    const videoGain = ctx.createGain();
    micGain.gain.value = state.micOn ? 1 : 0;
    // Video audio is monitored locally and sent to peers through one mixed track.
    videoGain.connect(destination);
    videoGain.connect(ctx.destination);
    state.mixer = {
      ctx,
      destination,
      micGain,
      videoGain,
      micSource: null,
      videoSource: null,
      track: destination.stream.getAudioTracks()[0],
    };
    attachMixerMic();
    return state.mixer;
  }

  function updatePresentBar() {
    const bar = $("#presentBar");
    if (!bar) return;
    const kind = state.presentKind;
    bar.classList.toggle("hidden", !kind);
    if (!kind) return;
    const present = state.present;
    const isVideo = kind === "video";
    const isPdf = kind === "pdf";
    $("#presentLabel").textContent = isVideo ? "Video" : isPdf ? "PDF" : "Screen";
    $("#presentPlayBtn").classList.toggle("hidden", !isVideo);
    $("#presentSeek").classList.toggle("hidden", !isVideo);
    $("#presentTime").classList.toggle("hidden", !isVideo);
    $("#presentPrevBtn").classList.toggle("hidden", !isPdf);
    $("#presentPage").classList.toggle("hidden", !isPdf);
    $("#presentNextBtn").classList.toggle("hidden", !isPdf);
    if (isVideo) updatePresentPlayback();
    if (isPdf) {
      const page = present?.page || 1;
      const pages = present?.pages || 1;
      $("#presentPage").textContent = `${page} / ${pages}`;
      $("#presentPrevBtn").disabled = page <= 1;
      $("#presentNextBtn").disabled = page >= pages;
    }
  }

  function updatePresentPlayback() {
    const present = state.present;
    if (!present || present.kind !== "video") return;
    const video = present.video;
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    const ratio = total ? Math.min(1, Math.max(0, video.currentTime / total)) : 0;
    $("#presentSeek").value = String(Math.round(ratio * 1000));
    $("#presentSeek").disabled = !total;
    const elapsed = duration(video.currentTime * 1000);
    $("#presentTime").textContent = total ? `${elapsed} / ${duration(total * 1000)}` : elapsed;
    setIcon($("#presentPlayBtn"), video.paused ? "play" : "pause");
    $("#presentPlayBtn").title = video.paused ? "Play" : "Pause";
    $("#presentPlayBtn").setAttribute("aria-label", video.paused ? "Play video" : "Pause video");
  }

  async function activatePresentation(kind, track, stream, present) {
    state.presentKind = kind;
    state.present = present;
    state.screenTrack = track;
    state.screenStream = stream;
    state.sharing = true;
    await replaceEverywhere("video", track);
    const audio = outgoingAudioTrack();
    if (audio) await replaceEverywhere("audio", audio);
    syncSelfAnalyser();
    syncLocalVideo();
    syncMediaButtons();
    updatePresentBar();
    sendState();
  }

  async function stopPresenting({ silent = false, fromBrowser = false } = {}) {
    if (!state.presentKind) return;
    const kind = state.presentKind;
    const present = state.present;
    state.presentKind = null;
    state.present = null;
    state.sharing = false;
    teardownPresentResources(present);
    state.screenStream?.getTracks().forEach((track) => {
      try { track.stop(); } catch {}
    });
    state.screenTrack = null;
    state.screenStream = null;
    teardownMixer();
    applyMicGain();
    if (state.cameraTrack) await replaceEverywhere("video", state.cameraTrack);
    const audio = outgoingAudioTrack();
    if (audio) await replaceEverywhere("audio", audio);
    syncSelfAnalyser();
    syncLocalVideo();
    syncMediaButtons();
    updatePresentBar();
    sendState();
    if (silent) return;
    if (fromBrowser) toast("Screen sharing ended");
    else if (kind === "screen") toast("You stopped presenting your screen");
    else toast("Presentation ended");
  }

  async function presentScreen() {
    if (!canSpeak()) {
      toast("The host hasn't invited you to speak yet", "warning");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast("Screen sharing is not supported in this browser", "danger");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await stopPresenting({ silent: true });
      const present = { kind: "screen", stream, track };
      track.addEventListener("ended", () => {
        if (state.present === present) stopPresenting({ fromBrowser: true });
      });
      await activatePresentation("screen", track, stream, present);
      toast("You are presenting your screen", "success");
    } catch (err) {
      if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") {
        toast("Could not start screen sharing", "danger");
      }
    }
  }

  function loadVideoFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "auto";
      video.playsInline = true;
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
      };
      const onLoaded = () => { cleanup(); resolve({ video, url }); };
      const onError = () => {
        cleanup();
        URL.revokeObjectURL(url);
        reject(new Error("Could not open that video"));
      };
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
      video.src = url;
      video.load();
    });
  }

  // Chrome reports Infinity for some WebM files (notably MediaRecorder output)
  // until the media is scanned. Seeking far ahead forces it to resolve.
  async function primeVideoDuration(video) {
    if (Number.isFinite(video.duration) && video.duration > 0) return;
    try {
      if (video.readyState < 2) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          video.addEventListener("loadeddata", finish, { once: true });
          video.addEventListener("canplay", finish, { once: true });
          setTimeout(finish, 1200);
        });
      }
      const resolved = new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        video.addEventListener("durationchange", finish, { once: true });
        video.addEventListener("timeupdate", finish, { once: true });
        video.addEventListener("seeked", finish, { once: true });
        setTimeout(finish, 1500);
      });
      video.currentTime = 1e7;
      await resolved;
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = 0;
    } catch {
      /* The bar falls back to elapsed time without a duration. */
    }
  }

  async function presentVideo(file) {
    if (!canSpeak()) {
      toast("The host hasn't invited you to speak yet", "warning");
      return;
    }
    let loaded;
    try {
      loaded = await loadVideoFile(file);
    } catch (err) {
      toast(err.message || "Could not open that video", "danger");
      return;
    }
    const { video, url } = loaded;
    await primeVideoDuration(video);
    await stopPresenting({ silent: true });

    const canvas = document.createElement("canvas");
    canvas.width = PRESENT_VIDEO_WIDTH;
    canvas.height = PRESENT_VIDEO_HEIGHT;
    const ctx = canvas.getContext("2d");
    drawContain(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height);
    const stream = canvas.captureStream(15);
    const track = stream.getVideoTracks()[0];
    const present = {
      kind: "video",
      video,
      objectUrl: url,
      canvas,
      ctx,
      stream,
      track,
      raf: 0,
      lastFrame: 0,
    };

    const mixer = ensureMixer();
    if (mixer) {
      try {
        const source = mixer.ctx.createMediaElementSource(video);
        source.connect(mixer.videoGain);
        mixer.videoSource = source;
      } catch {
        /* Fall back to the element's own audio output. */
      }
    }

    const tick = (time) => {
      if (state.present !== present) return;
      if (!present.lastFrame || time - present.lastFrame >= 60) {
        present.lastFrame = time;
        drawContain(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height);
      }
      present.raf = requestAnimationFrame(tick);
    };
    present.raf = requestAnimationFrame(tick);

    const refresh = () => { if (state.present === present) updatePresentBar(); };
    video.addEventListener("timeupdate", () => {
      if (state.present === present) updatePresentPlayback();
    });
    video.addEventListener("play", refresh);
    video.addEventListener("pause", refresh);
    video.addEventListener("durationchange", refresh);
    video.addEventListener("ended", () => {
      if (state.present === present) stopPresenting();
    });

    await activatePresentation("video", track, stream, present);
    try { await video.play(); } catch {}
    updatePresentPlayback();
    toast("Video is live — use the bar to play, pause or seek", "success", 4200);
  }

  function pdfLibrary() {
    const lib = window.pdfjsLib;
    if (!lib) return null;
    lib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.js";
    return lib;
  }

  async function renderPdfPage(present, pageNumber) {
    const token = ++present.token;
    const page = await present.doc.getPage(pageNumber);
    if (token !== present.token) return;
    const base = page.getViewport({ scale: 1 });
    const margin = 40;
    const scale = Math.min(
      (present.canvas.width - margin * 2) / base.width,
      (present.canvas.height - margin * 2) / base.height
    );
    const viewport = page.getViewport({ scale });
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = Math.max(1, Math.ceil(viewport.width));
    pageCanvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvasContext: pageCanvas.getContext("2d"), viewport }).promise;
    if (token !== present.token) return;
    const ctx = present.ctx;
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, present.canvas.width, present.canvas.height);
    ctx.drawImage(
      pageCanvas,
      (present.canvas.width - pageCanvas.width) / 2,
      (present.canvas.height - pageCanvas.height) / 2
    );
    present.page = pageNumber;
    if (state.present === present) updatePresentBar();
  }

  async function presentPdf(file) {
    if (!canSpeak()) {
      toast("The host hasn't invited you to speak yet", "warning");
      return;
    }
    const pdfjsLib = pdfLibrary();
    if (!pdfjsLib) {
      toast("PDF support could not load in this browser", "danger");
      return;
    }
    let doc;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      doc = await pdfjsLib.getDocument({ data }).promise;
    } catch {
      toast("Could not open that PDF", "danger");
      return;
    }
    await stopPresenting({ silent: true });

    const canvas = document.createElement("canvas");
    canvas.width = PRESENT_PDF_WIDTH;
    canvas.height = PRESENT_PDF_HEIGHT;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(5);
    const track = stream.getVideoTracks()[0];
    const present = {
      kind: "pdf",
      doc,
      canvas,
      ctx,
      stream,
      track,
      page: 1,
      pages: doc.numPages || 1,
      token: 0,
    };
    try {
      await renderPdfPage(present, 1);
    } catch {
      teardownPresentResources(present);
      toast("Could not render that PDF", "danger");
      return;
    }
    await activatePresentation("pdf", track, stream, present);
    toast(`Presenting PDF · ${present.pages} page${present.pages === 1 ? "" : "s"}`, "success", 4200);
  }

  async function stepPdf(delta) {
    const present = state.present;
    if (!present || present.kind !== "pdf") return;
    const next = Math.min(present.pages, Math.max(1, present.page + delta));
    if (next === present.page) return;
    try {
      await renderPdfPage(present, next);
    } catch {
      toast("Could not render that page", "danger");
    }
  }

  function togglePresentPlayback() {
    const present = state.present;
    if (!present || present.kind !== "video") return;
    if (present.video.paused) present.video.play().catch(() => {});
    else present.video.pause();
  }

  function seekPresent(value) {
    const present = state.present;
    if (!present || present.kind !== "video") return;
    const total = Number.isFinite(present.video.duration) ? present.video.duration : 0;
    if (!total) return;
    const ratio = Math.min(1000, Math.max(0, Number(value) || 0)) / 1000;
    present.video.currentTime = ratio * total;
    updatePresentPlayback();
  }

  function openPresentPicker() {
    if (!canSpeak()) {
      toast("The host hasn't invited you to speak yet — raise your hand", "warning");
      return;
    }
    showModal({
      title: "Present",
      message: "Share your screen, play a video file, or present a PDF. Everyone sees it in your tile.",
      iconName: "screen",
      tone: "info",
      dismissible: true,
      actions: [
        { label: "Screen", style: "btn-primary", onClick: () => { hideModal(); presentScreen(); } },
        { label: "Video file", style: "btn-secondary", onClick: () => { hideModal(); $("#presentVideoInput").click(); } },
        { label: "PDF", style: "btn-secondary", onClick: () => { hideModal(); $("#presentPdfInput").click(); } },
        { label: "Cancel", style: "btn-ghost", onClick: hideModal },
      ],
    });
  }

  function togglePresent() {
    if (state.presentKind) stopPresenting();
    else openPresentPicker();
  }

  function requestLeave() {
    if (state.modalOpen) return;
    const others = state.remote.size;
    const webinar = isWebinar();
    const noun = webinar ? "webinar" : "meeting";
    if (!others) {
      leaveMeeting(`You left the ${noun}`);
      return;
    }
    const actions = [
      { label: "Stay", style: "btn-ghost", onClick: hideModal },
      { label: "Leave", style: "btn-secondary", onClick: () => { hideModal(); leaveMeeting(`You left the ${noun}`); } },
    ];
    if (state.role === "host") {
      actions.push({
        label: "End for all",
        style: "btn-danger",
        onClick: () => { hideModal(); endMeetingForAll(); },
      });
    }
    showModal({
      title: webinar ? "Leave the webinar?" : "Leave the meeting?",
      message: state.role === "host"
        ? webinar
          ? "You are the host. You can leave and hand the webinar to a panelist, or end it for everyone."
          : "You are the host. You can leave and keep the meeting going, or end it for everyone."
        : "You can always rejoin with the same link.",
      iconName: "phone-off",
      tone: "info",
      actions,
      dismissible: true,
    });
  }

  function leaveMeeting(notice) {
    hideModal();
    teardown();
    goHome();
    if (notice) toast(notice, "success", 4500);
  }

  function endMeetingForAll() {
    state.ending = true;
    send({ type: "host", action: "end" });
    // The server echoes meeting-ended back to the host, which leaves the room.
    // If that reply is lost, leave locally rather than trapping the host.
    setTimeout(() => {
      if (state.ending && state.joined) {
        state.ending = false;
        leaveMeeting("You ended the meeting");
      }
    }, 2000);
  }

  function sendHost(action, target) {
    if (state.role !== "host") return false;
    send({ type: "host", action, target });
    return true;
  }

  function muteEveryone() {
    const anyOn = [...state.remote.values()].some((p) => p.mic);
    if (!anyOn) {
      toast("Everyone is already muted");
      return;
    }
    sendHost("mute-all");
    toast("Muted everyone", "success");
  }

  function muteParticipant(id) {
    const peer = state.remote.get(id);
    if (!peer) return;
    sendHost("mute", id);
    toast(`Muted ${peer.name}`, "success");
  }

  function askRemoveParticipant(id) {
    const peer = state.remote.get(id);
    if (!peer) return;
    showModal({
      title: `Remove ${peer.name}?`,
      message: "They will be disconnected from the meeting.",
      iconName: "phone-off",
      actions: [
        { label: "Cancel", style: "btn-ghost", onClick: hideModal },
        { label: "Remove", style: "btn-danger", onClick: () => { hideModal(); sendHost("remove", id); } },
      ],
      dismissible: true,
    });
  }

  // -------------------------------------------------------------------------
  // Audio analyser
  // -------------------------------------------------------------------------

  function ensureAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!state.audioCtx) state.audioCtx = new AC();
    state.audioCtx.resume().catch(() => {});
  }

  function attachAnalyser(id, stream) {
    if (!state.audioCtx || !stream || !stream.getAudioTracks().length) return;
    detachAnalyser(id);
    try {
      const source = state.audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const analyser = state.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      const sink = state.audioCtx.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(state.audioCtx.destination);
      state.analysers.set(id, { source, analyser, sink, data: new Uint8Array(analyser.fftSize) });
    } catch {}
  }

  function detachAnalyser(id) {
    const item = state.analysers.get(id);
    if (!item) return;
    try {
      item.source.disconnect();
      item.analyser.disconnect();
      item.sink.disconnect();
    } catch {}
    state.analysers.delete(id);
  }

  function startSpeakingLoop() {
    cancelAnimationFrame(state.raf);
    let last = 0;
    const tick = (ts) => {
      if (!state.joined) return;
      if (ts - last > 110) {
        last = ts;
        for (const [id, item] of state.analysers) {
          item.analyser.getByteTimeDomainData(item.data);
          let sum = 0;
          for (let i = 0; i < item.data.length; i++) {
            const v = (item.data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / item.data.length);
          state.tiles.get(id)?.el.classList.toggle("speaking", rms > 0.045);
        }
      }
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }

  function showAudioPrompt() {
    if (state.joined) $("#audioPrompt").classList.remove("hidden");
  }

  async function enableAudio() {
    ensureAudioContext();
    for (const tile of state.tiles.values()) {
      if (!tile.video.muted) await tile.video.play().catch(() => {});
    }
    $("#audioPrompt").classList.add("hidden");
  }

  // -------------------------------------------------------------------------
  // Chat + people
  // -------------------------------------------------------------------------

  function isChatOpen() {
    return state.panel === "chat" && !$("#sidePanel").classList.contains("hidden");
  }

  function updateUnread() {
    const count = state.unread;
    for (const el of [$("#chatUnread"), $("#chatTabBadge")]) {
      el.textContent = count > 99 ? "99+" : String(count);
      el.classList.toggle("hidden", count === 0);
    }
  }

  function chatEmpty() {
    const box = document.createElement("div");
    box.className = "chat-empty";
    box.innerHTML = `${icon("chat")}<strong>No messages yet</strong><span>Say hello — messages are only visible to people in this room.</span>`;
    return box;
  }

  function renderChatHistory() {
    const list = $("#chatList");
    list.innerHTML = "";
    if (!state.chat.length) {
      list.appendChild(chatEmpty());
      return;
    }
    for (const message of state.chat) appendChatElement(message, false);
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function appendChat(message) {
    appendChatElement(message, true);
  }

  function appendChatElement(message, animated) {
    const list = $("#chatList");
    list.querySelector(".chat-empty")?.remove();
    if (message.kind === "system") {
      const wrap = document.createElement("div");
      wrap.className = "chat-system";
      const span = document.createElement("span");
      span.textContent = message.text;
      wrap.appendChild(span);
      list.appendChild(wrap);
      if (animated) list.scrollTop = list.scrollHeight;
      return;
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    const item = document.createElement("div");
    item.className = "chat-item";
    if (!animated) item.style.animation = "none";
    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.style.setProperty("--avatar-color", colorFor(message.name));
    avatar.textContent = initials(message.name);
    const body = document.createElement("div");
    body.className = "chat-body";
    const head = document.createElement("div");
    head.className = "chat-head";
    const author = document.createElement("span");
    author.className = "chat-author";
    author.textContent = message.peerId === state.selfId ? `${message.name} (you)` : message.name;
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = clock(message.ts);
    head.append(author, time);
    const text = document.createElement("div");
    text.className = "chat-text";
    text.textContent = message.text;
    body.append(head, text);
    item.append(avatar, body);
    list.appendChild(item);
    if (animated && (nearBottom || message.peerId === state.selfId)) list.scrollTop = list.scrollHeight;
  }

  function addSystem(text) {
    const message = { id: `sys-${Date.now()}-${Math.random()}`, kind: "system", text, ts: Date.now() / 1000 };
    state.chat.push(message);
    appendChatElement(message, true);
  }

  function sendChat(text) {
    const value = text.trim();
    if (!value) return;
    send({ type: "chat", text: value });
  }

  function renderPeople() {
    const list = $("#peopleList");
    if (!list) return;
    list.innerHTML = "";
    const ids = [state.selfId, ...state.remote.keys()].filter(Boolean);
    const people = ids.map((id) => participant(id)).filter(Boolean);
    people.sort((a, b) => {
      const aHost = a.id === state.hostId ? 0 : 1;
      const bHost = b.id === state.hostId ? 0 : 1;
      if (aHost !== bHost) return aHost - bHost;
      if (a.id === state.selfId) return -1;
      if (b.id === state.selfId) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const peer of people) {
      const isSelf = peer.id === state.selfId;
      const row = document.createElement("div");
      row.className = "person";

      const avatar = document.createElement("div");
      avatar.className = "person-avatar";
      avatar.style.setProperty("--avatar-color", colorFor(peer.name));
      avatar.textContent = initials(peer.name);

      const main = document.createElement("div");
      main.className = "person-main";
      const name = document.createElement("div");
      name.className = "person-name";
      const nameText = document.createElement("span");
      nameText.className = "person-name-text";
      nameText.textContent = peer.name;
      name.appendChild(nameText);
      if (peer.id === state.hostId) {
        const host = document.createElement("span");
        host.className = "host-badge";
        host.innerHTML = `${icon("crown")}Host`;
        name.appendChild(host);
      } else if (isWebinar()) {
        const role = document.createElement("span");
        const panelist = peer.webinarRole === "panelist";
        role.className = `role-tag ${panelist ? "role-panelist" : "role-audience"}`;
        role.textContent = panelist ? "Panelist" : "Audience";
        name.appendChild(role);
      }
      if (isSelf) {
        const you = document.createElement("span");
        you.className = "you-tag";
        you.textContent = "(you)";
        name.appendChild(you);
      }
      const sub = document.createElement("div");
      sub.className = "person-sub";
      sub.textContent = isWebinar() && peer.webinarRole === "audience"
        ? "Audience"
        : `${peer.mic ? "Mic on" : "Muted"}${peer.cam ? "" : " · Camera off"}${peer.sharing ? " · Presenting" : ""}`;

      const flags = document.createElement("div");
      flags.className = "person-flags";
      const mic = document.createElement("span");
      mic.className = `icon ${peer.mic ? "" : "flag-off"}`;
      mic.innerHTML = icon(peer.mic ? "mic" : "mic-off");
      const cam = document.createElement("span");
      cam.className = `icon ${peer.cam ? "" : "flag-off"}`;
      cam.innerHTML = icon(peer.cam ? "camera" : "camera-off");
      flags.append(mic, cam);
      if (peer.hand) {
        const hand = document.createElement("span");
        hand.className = "icon flag-hand";
        hand.innerHTML = icon("hand");
        flags.appendChild(hand);
      }

      main.append(name, sub);
      row.append(avatar, main, flags);

      if (state.selfId === state.hostId && !isSelf) {
        const actions = document.createElement("div");
        actions.className = "person-actions";
        if (isWebinar()) {
          const promote = document.createElement("button");
          promote.type = "button";
          promote.className = "person-action";
          promote.dataset.action = peer.webinarRole === "audience" ? "promote" : "demote";
          promote.dataset.id = peer.id;
          if (peer.webinarRole === "audience") {
            promote.title = "Invite to speak";
            promote.setAttribute("aria-label", `Invite ${peer.name} to speak`);
            promote.innerHTML = icon("mic");
          } else {
            promote.title = "Move to audience";
            promote.setAttribute("aria-label", `Move ${peer.name} to the audience`);
            promote.innerHTML = icon("audience");
          }
          actions.appendChild(promote);
        }
        if (peer.mic) {
          const mute = document.createElement("button");
          mute.type = "button";
          mute.className = "person-action";
          mute.dataset.action = "mute";
          mute.dataset.id = peer.id;
          mute.title = "Mute";
          mute.setAttribute("aria-label", `Mute ${peer.name}`);
          mute.innerHTML = icon("mic-off");
          actions.appendChild(mute);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "person-action danger";
        remove.dataset.action = "remove";
        remove.dataset.id = peer.id;
        remove.title = "Remove";
        remove.setAttribute("aria-label", `Remove ${peer.name}`);
        remove.innerHTML = icon("phone-off");
        actions.appendChild(remove);
        row.appendChild(actions);
      }

      list.appendChild(row);
    }

    const host = state.selfId === state.hostId;
    $("#hostTools").classList.toggle("hidden", !host || state.remote.size === 0);
    $("#endMeetingBtn").innerHTML = isWebinar()
      ? `${icon("phone-off")}<span>End webinar for all</span>`
      : `${icon("phone-off")}<span>End meeting for all</span>`;
  }

  function openPanel(tab) {
    state.panel = tab;
    $("#sidePanel").classList.remove("hidden");
    for (const btn of $$(".panel-tab")) {
      const active = btn.dataset.panel === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    }
    $("#chatPanel").classList.toggle("hidden", tab !== "chat");
    $("#peoplePanel").classList.toggle("hidden", tab !== "people");
    if (tab === "chat") {
      state.unread = 0;
      updateUnread();
      const list = $("#chatList");
      requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
      setTimeout(() => $("#chatInput")?.focus(), 80);
    } else {
      renderPeople();
    }
  }

  function closePanel() {
    state.panel = null;
    $("#sidePanel").classList.add("hidden");
  }

  function togglePanel(tab) {
    if (state.panel === tab && !$("#sidePanel").classList.contains("hidden")) closePanel();
    else openPanel(tab);
  }

  // -------------------------------------------------------------------------
  // Invite, timer, teardown
  // -------------------------------------------------------------------------

  function inviteLink() {
    return `${location.origin}/#/room/${state.roomId}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Invite link copied", "success");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        toast("Invite link copied", "success");
      } catch {
        toast("Could not copy the link", "danger");
      }
      area.remove();
    }
  }

  function startTimer() {
    clearInterval(state.timer);
    const update = () => {
      const start = state.startedAt || Date.now();
      $("#callTimer").textContent = duration(Date.now() - start);
    };
    update();
    state.timer = setInterval(update, 1000);
  }

  function setJoinLoading(loading) {
    const btn = $("#joinBtn");
    const webinar = state.pendingMode === "webinar";
    btn.disabled = loading;
    const label = loading ? "Connecting…" : webinar ? "Start webinar" : "Join now";
    btn.innerHTML = `${icon(webinar ? "broadcast" : "video-logo")}<span>${label}</span>`;
  }

  function showPrejoinError(message) {
    const box = $("#prejoinError");
    box.textContent = message;
    box.classList.remove("hidden");
  }

  function hidePrejoinError() {
    $("#prejoinError").classList.add("hidden");
    $("#prejoinError").textContent = "";
  }

  function onRemoved(reason) {
    teardown();
    showModal({
      title: "Removed from the meeting",
      message: reason || "The host removed you from this meeting.",
      actions: [{ label: "Back to home", style: "btn-primary", onClick: goHome }],
    });
  }

  function onMeetingEnded(by) {
    teardown();
    showModal({
      title: "Meeting ended",
      message: by ? `${by} ended the meeting for everyone.` : "The host ended this meeting.",
      iconName: "phone-off",
      tone: "danger",
      actions: [{ label: "Back to home", style: "btn-primary", onClick: goHome }],
    });
  }

  function handleConnectionLost() {
    if (state.connectionModal) return;
    state.connectionModal = true;
    teardown();
    showModal({
      title: "Connection lost",
      message: "We lost the connection to the meeting server. Check your network and try again.",
      actions: [
        { label: "Rejoin", style: "btn-primary", onClick: () => location.reload() },
        { label: "Leave", style: "btn-secondary", onClick: goHome },
      ],
    });
  }

  function teardown() {
    state.joined = false;
    state.joining = false;
    state.ending = false;
    clearInterval(state.timer);
    cancelAnimationFrame(state.raf);

    for (const id of [...state.pcs.keys()]) closePeer(id);
    for (const id of [...state.analysers.keys()]) detachAnalyser(id);

    if (state.present) teardownPresentResources(state.present);
    teardownMixer();

    const tracks = new Set();
    for (const track of [state.micTrack, state.cameraTrack, state.screenTrack, state.previewMic, state.previewCam]) {
      if (track) tracks.add(track);
    }
    state.screenStream?.getTracks().forEach((t) => tracks.add(t));
    state.previewStream?.getTracks().forEach((t) => tracks.add(t));
    for (const track of tracks) {
      try { track.stop(); } catch {}
    }

    if (state.ws) {
      state.ws.onclose = null;
      try { state.ws.close(); } catch {}
    }
    state.ws = null;

    if (state.audioCtx) {
      state.audioCtx.close().catch(() => {});
      state.audioCtx = null;
    }
    if (state.fallbackAudio) {
      try { state.fallbackAudio.osc.stop(); state.fallbackAudio.ctx.close(); } catch {}
    }
    if (state.fallbackVideo) {
      state.fallbackVideo.stream.getTracks().forEach((t) => t.stop());
    }

    state.fallbackAudio = null;
    state.fallbackVideo = null;
    state.micTrack = null;
    state.cameraTrack = null;
    state.screenTrack = null;
    state.screenStream = null;
    state.presentKind = null;
    state.present = null;
    state.mixer = null;
    state.outgoingStream = null;
    state.previewMic = null;
    state.previewCam = null;
    state.previewStream = null;
    state.previewPromise = null;
    state.remote.clear();
    state.chat = [];
    state.tiles.clear();
    state.selfId = null;
    state.hostId = null;
    state.role = "participant";
    state.mode = "meeting";
    state.webinarRole = "";
    state.pendingMode = null;
    state.micOn = true;
    state.camOn = true;
    state.micFallback = false;
    state.cameraFallback = false;
    state.handRaised = false;
    state.sharing = false;
    state.startedAt = null;
    state.unread = 0;
    state.panel = null;

    $("#videoGrid").innerHTML = "";
    $("#chatList").innerHTML = "";
    $("#peopleList").innerHTML = "";
    $("#sidePanel").classList.add("hidden");
    $("#audioPrompt").classList.add("hidden");
    $("#presentBar").classList.add("hidden");
    $("#callTimer").textContent = "00:00";
    $("#participantCountLabel").textContent = "1";
    $("#peopleTabCount").textContent = "1";
    $("#peopleCount").textContent = "1 participant";
    $("#hostTools").classList.add("hidden");
    $("#modeBadge").classList.add("hidden");
    $("#webinarBar").classList.add("hidden");
    $("#videoGrid").dataset.count = "1";
    $("#endMeetingBtn").innerHTML = `${icon("phone-off")}<span>End meeting for all</span>`;
    updateUnread();
    syncMediaButtons();
    document.title = "NexMeet — meetings that stay yours";
    const preview = $("#previewVideo");
    if (preview) preview.srcObject = null;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function bindEvents() {
    $("#brandHome").addEventListener("click", (e) => { e.preventDefault(); goHome(); });
    $("#prejoinBrand").addEventListener("click", (e) => { e.preventDefault(); goHome(); });
    $("#roomBrand").addEventListener("click", (e) => e.preventDefault());
    $("#newMeetingBtn").addEventListener("click", () => goToRoom(newRoomCode()));
    $("#newMeetingBtn2").addEventListener("click", () => goToRoom(newRoomCode()));
    $("#newWebinarBtn").addEventListener("click", startWebinar);
    $("#newWebinarBtn2").addEventListener("click", startWebinar);

    $("#joinForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = parseRoomInput($("#joinCodeInput").value);
      if (!code) {
        $("#joinError").textContent = "Enter a valid room code or invite link.";
        $("#joinError").classList.remove("hidden");
        return;
      }
      $("#joinError").classList.add("hidden");
      goToRoom(code);
    });

    window.addEventListener("hashchange", () => { if (!state.joined) route(); });

    $("#prejoinBackBtn").addEventListener("click", goHome);
    $("#nameInput").addEventListener("input", (e) => {
      state.name = e.target.value;
      localStorage.setItem("nexmeet:name", state.name);
      updatePreviewName();
    });
    $("#nameInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); joinMeeting(); }
    });
    $("#previewMicBtn").addEventListener("click", togglePreviewMic);
    $("#previewCamBtn").addEventListener("click", togglePreviewCamera);
    $("#joinBtn").addEventListener("click", joinMeeting);
    $("#prejoinCopyBtn").addEventListener("click", () => {
      if (state.roomId) copyText(`${location.origin}/#/room/${state.roomId}`);
    });

    $("#micBtn").addEventListener("click", toggleMic);
    $("#camBtn").addEventListener("click", toggleCamera);
    $("#shareBtn").addEventListener("click", togglePresent);
    $("#presentStopBtn").addEventListener("click", () => stopPresenting());
    $("#presentPlayBtn").addEventListener("click", togglePresentPlayback);
    $("#presentPrevBtn").addEventListener("click", () => stepPdf(-1));
    $("#presentNextBtn").addEventListener("click", () => stepPdf(1));
    $("#presentSeek").addEventListener("input", (e) => seekPresent(e.target.value));
    $("#presentVideoInput").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) presentVideo(file);
    });
    $("#presentPdfInput").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) presentPdf(file);
    });
    $("#handBtn").addEventListener("click", toggleHand);
    $("#chatBtn").addEventListener("click", () => togglePanel("chat"));
    $("#peopleBtn").addEventListener("click", () => togglePanel("people"));
    $("#participantCount").addEventListener("click", () => togglePanel("people"));
    $("#leaveBtn").addEventListener("click", requestLeave);
    $("#closePanelBtn").addEventListener("click", closePanel);
    $("#copyLinkBtn").addEventListener("click", () => copyText(inviteLink()));
    $("#enableAudioBtn").addEventListener("click", enableAudio);

    for (const tab of $$(".panel-tab")) {
      tab.addEventListener("click", () => openPanel(tab.dataset.panel));
    }

    $("#chatForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#chatInput");
      sendChat(input.value);
      input.value = "";
      input.style.height = "auto";
      input.focus();
    });
    $("#chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("#chatForm").requestSubmit();
      }
    });
    $("#chatInput").addEventListener("input", (e) => {
      e.target.style.height = "auto";
      e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
    });

    $("#muteAllBtn").addEventListener("click", muteEveryone);
    $("#endMeetingBtn").addEventListener("click", () => {
      showModal({
        title: "End the meeting?",
        message: "Everyone will be disconnected. This cannot be undone.",
        actions: [
          { label: "Cancel", style: "btn-ghost", onClick: hideModal },
          { label: "End for all", style: "btn-danger", onClick: () => { hideModal(); endMeetingForAll(); } },
        ],
        dismissible: true,
      });
    });

    $("#peopleList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "mute") muteParticipant(btn.dataset.id);
      if (btn.dataset.action === "remove") askRemoveParticipant(btn.dataset.id);
      if (btn.dataset.action === "promote") sendHost("promote", btn.dataset.id);
      if (btn.dataset.action === "demote") sendHost("demote", btn.dataset.id);
    });

    $("#modalBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#modalBackdrop") && state.modalDismissible) hideModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (state.modalOpen && state.modalDismissible) hideModal();
        else if (!state.modalOpen) closePanel();
        return;
      }
      if (!state.joined || state.modalOpen) return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (state.presentKind === "pdf" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        stepPdf(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (state.presentKind === "video" && e.key === " ") {
        e.preventDefault();
        togglePresentPlayback();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "m") { e.preventDefault(); toggleMic(); }
      if (key === "v") { e.preventDefault(); toggleCamera(); }
      if (key === "h") { e.preventDefault(); toggleHand(); }
      if (key === "c") { e.preventDefault(); togglePanel("chat"); }
      if (key === "p") { e.preventDefault(); togglePanel("people"); }
    });

    window.addEventListener("beforeunload", (e) => {
      if (state.joined) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    document.addEventListener("pointerdown", () => {
      if (state.audioCtx?.state === "suspended") state.audioCtx.resume().catch(() => {});
    }, { passive: true });
  }

  async function init() {
    bindEvents();
    $("#nameInput").value = state.name;
    updatePreviewName();
    updatePreviewControls();
    syncMediaButtons();
    updateUnread();
    await loadConfig();
    route();
  }

  init();
})();
