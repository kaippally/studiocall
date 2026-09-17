// The Agora engine lives here, in a hidden renderer, because agora-electron-sdk 4.x
// reaches for `window` on load and cannot be required from the main process.
// Main relays HTTP calls in over 'rpc' and this replies on 'rpc-result'.

const { ipcRenderer } = require('electron');
const { createAgoraRtcEngine } = require('agora-electron-sdk');

let engine = null;
let joined = null;
let lastError = null;

// Devices are pinned by NAME, never index or id. Windows renumbers audio endpoints
// when anything is plugged, unplugged, or wakes from sleep, and a handle captured at
// join time then addresses the wrong device. Clubdeck never re-pins, which is why
// endpoint churn stalls its routing thread and takes the app down.
let wantRecordingName = null;
let wantPlaybackName = null;

// Mono or stereo on the way OUT — what this machine sends into the room. Stereo is two
// calls, not one: the profile alone still pre-processes the capture down to a single
// channel, so setAdvancedAudioOptions has to agree with it or the choice does nothing.
// Agora also wants the profile set BEFORE joining, which is why join() re-applies it.
let wantStereo = false;

// Agora's client role: 1 = broadcaster (publishes), 2 = audience (cannot be heard no
// matter what the mute button says). A room that lets anyone speak still needs this
// flipped — Clubhouse promoting you on its side does nothing to the RTC leg. Held here
// rather than taken from each join, so a rejoin (every device change) does not quietly
// put you back in the audience.
let asSpeaker = false;

// Whatever Windows/Agora chose before we pinned anything. Clearing a pin has to put
// these back: without them "— not set —" could never be reached again, because
// repin() simply skipped a null name and left the last pinned device in force.
let defaultRecordingId = null;
let defaultPlaybackId = null;

const SPEAK_THRESHOLD = 20;  // 0..255; below this is room noise
const SPEAK_HOLD_MS = 1500;  // hold a face this long past the last syllable
const speaking = new Map();  // uid -> { volume, lastAboveMs }
/**
 * uid -> is their microphone open. Absent means Agora has not said either way yet: only an
 * explicit `true` is treated as an open mic, so nothing acts on a guess.
 */
const openMics = new Map();

// Signal levels, 0..255. `out` is what this machine is sending into the room,
// `in` is the loudest thing arriving from it. Agora reports the local speaker as
// uid 0 in the same callback that carries remote speakers, which is what separates
// the two directions. Both decay to zero when callbacks stop, so a frozen meter
// reads as silence rather than as a stuck signal.
let levels = { out: 0, in: 0, outAt: 0, inAt: 0 };
let muted = false;

/**
 * Is audio actually REACHING Agora's server?
 *
 * `levels.out` above does not answer that and never could: it comes from
 * onAudioVolumeIndication's uid 0, which is the local CAPTURE level. A meter bouncing off a
 * healthy microphone looks identical whether the encoded frames are leaving the machine or
 * piling up against a dead transport — the exact failure that leaves somebody talking to a room
 * that cannot hear them, with every surface in the app reading normal.
 *
 * The proof is bytes: `RtcStats.txAudioBytes` is cumulative audio sent on this connection, so
 * the question "is it moving" is "is that number bigger than the last sample". Agora pushes
 * onRtcStats about every 2s, and `movingAt` is the last time it grew — the consumer compares
 * that against the clock, so a stats stream that STOPS reads as not sending rather than
 * freezing on its last true value.
 *
 * `state` is Agora's ConnectionStateType: 1 disconnected, 2 connecting, 3 connected,
 * 4 reconnecting, 5 failed. Connected with no byte growth is the informative pair — that is
 * a live socket carrying nothing.
 */
let uplink = {
  state: 0,
  txBytes: 0,
  movingAt: 0,
  kbps: 0,
  encKbps: 0,
  lossPct: 0,
  rttMs: 0,
  statsAt: 0,
};

function resetUplink() {
  uplink = { state: 0, txBytes: 0, movingAt: 0, kbps: 0, encKbps: 0, lossPct: 0, rttMs: 0, statsAt: 0 };
}

// What the room sounds like on this end. `muted` above is the microphone — this is the
// other direction: the mix Agora plays out to the pinned playback device, which on this
// rig is what OBS hears. Agora takes 0..400 (100 = unity); anything above ~200 clips.
let outVolume = 100;
let outMuted = false;

// 5 = MusicHighQualityStereo (48 kHz, 128 kbps), 4 = MusicHighQuality (48 kHz mono, 96
// kbps). audioProcessingChannels: 2 = AudioProcessingStereo, 1 = mono — the SDK types it
// as a bare number, so the names live here.
function applyAudioProfile() {
  const e = ensureEngineOrThrow();
  e.setAudioProfile(wantStereo ? 5 : 4);
  e.setAdvancedAudioOptions({ audioProcessingChannels: wantStereo ? 2 : 1 });
}

function applyOutput() {
  const e = ensureEngineOrThrow();
  e.adjustPlaybackSignalVolume(outMuted ? 0 : outVolume);
  e.muteAllRemoteAudioStreams(outMuted);
}

function pushState() {
  ipcRenderer.send('state', {
    engineUp: !!engine, joined, lastError, muted,
    outVolume, outMuted, wantStereo, asSpeaker,
    wantRecordingName, wantPlaybackName,
    devices: safeDevices(),
  });
}

function ensureEngine(appId) {
  if (engine) return engine;
  engine = createAgoraRtcEngine();
  engine.initialize({ appId });
  engine.enableAudio();
  try {
    const m = engine.getAudioDeviceManager();
    defaultRecordingId = m.getRecordingDevice();
    defaultPlaybackId = m.getPlaybackDevice();
  } catch {}
  engine.registerEventHandler({
    onJoinChannelSuccess: (conn) => {
      joined = { channel: conn.channelId, uid: conn.localUid };
      lastError = null;
      pushState();
    },
    onLeaveChannel: () => { joined = null; speaking.clear(); openMics.clear(); pushState(); },
    onError: (err, msg) => { lastError = { err, msg, at: Date.now() }; pushState(); },
    onUserJoined: (_c, uid) => { speaking.set(uid, { volume: 0, lastAboveMs: 0 }); },
    onUserOffline: (_c, uid) => { speaking.delete(uid); openMics.delete(uid); },
    // Who has their microphone OPEN, the moment it opens — not when they first make a sound.
    // Agora fires this on the remote's muteLocalAudioStream, which is what Clubhouse's mute is,
    // so it is the only signal in the rig that sees an unmute before it is audible. StudioMate's
    // mute lock reads it; a level-based trigger can only ever react to the first syllable.
    onUserMuteAudio: (_c, uid, muted) => { openMics.set(uid, !muted); },
    // The non-deprecated half of the same fact. Registered alongside rather than instead of
    // onUserMuteAudio because 4.x still delivers that one and it carries the boolean directly;
    // this keeps working when it is finally removed. Both write one map, so a doubled report
    // is idempotent.
    onRemoteAudioStateChanged: (_c, uid, _state, reason) => {
      if (reason === 5) openMics.set(uid, false);        // RemoteAudioReasonRemoteMuted
      else if (reason === 6) openMics.set(uid, true);    // RemoteAudioReasonRemoteUnmuted
    },
    onAudioVolumeIndication: (_conn, speakers) => {
      const now = Date.now();
      let remoteMax = 0;
      for (const s of speakers ?? []) {
        const vol = s.volume ?? 0;
        if (s.uid === 0) {
          levels.out = vol;
          levels.outAt = now;
        } else if (vol > remoteMax) {
          remoteMax = vol;
        }
        // Agora reports the local speaker as uid 0. Left as 0 it matches nobody on
        // the Clubhouse roster, so you would never appear in your own overlay.
        const uid = s.uid === 0 ? (joined?.uid ?? 0) : s.uid;
        const prev = speaking.get(uid) ?? { volume: 0, lastAboveMs: 0 };
        speaking.set(uid, {
          volume: vol,
          lastAboveMs: vol >= SPEAK_THRESHOLD ? now : prev.lastAboveMs,
        });
      }
      if (remoteMax > 0 || (speakers ?? []).some((s) => s.uid !== 0)) {
        levels.in = remoteMax;
        levels.inAt = now;
      }
    },
    // ── uplink proof ──────────────────────────────────────────────────────
    onConnectionStateChanged: (_conn, state) => {
      uplink.state = state ?? 0;
      pushState();
    },
    // ~2s. txAudioBytes is cumulative, so growth — not the value — is the signal.
    onRtcStats: (_conn, stats) => {
      const bytes = stats?.txAudioBytes ?? 0;
      if (bytes > uplink.txBytes) uplink.movingAt = Date.now();
      uplink.txBytes = bytes;
      uplink.kbps = stats?.txAudioKBitRate ?? 0;
      uplink.lossPct = stats?.txPacketLossRate ?? 0;
      uplink.rttMs = stats?.lastmileDelay ?? 0;
      uplink.statsAt = Date.now();
    },
    // The encoder's own view. Zero here with a healthy capture level means the frames are not
    // even being produced, which separates a device fault from a transport one.
    onLocalAudioStats: (_conn, stats) => {
      if (typeof stats?.sentBitrate === 'number') uplink.encKbps = stats.sentBitrate;
    },
    // The event Clubdeck never subscribes to.
    onAudioDeviceStateChanged: () => { repin(); },
  });
  return engine;
}

function devices() {
  const m = ensureEngineOrThrow().getAudioDeviceManager();
  const norm = (d) => ({
    name: d?.deviceName ?? d?.devicename ?? String(d ?? ''),
    id: d?.deviceId ?? d?.deviceid ?? '',
  });
  return {
    recording: (m.enumerateRecordingDevices() ?? []).map(norm),
    playback: (m.enumeratePlaybackDevices() ?? []).map(norm),
  };
}

function safeDevices() {
  try { return engine ? devices() : { recording: [], playback: [] }; }
  catch { return { recording: [], playback: [] }; }
}

function ensureEngineOrThrow() {
  if (!engine) throw new Error('engine not initialised — call /join first, or POST /devices with an appId');
  return engine;
}

// Windows writes an instance number INTO the endpoint's own name — the same box is
// "Speakers (RODECaster Video S Chat)" one day and "Speakers (4- RODECaster Video S Chat)"
// the next — so an exact name match is not the renumbering-proof pin it was meant to be.
// Compare again with the number taken out, but only after an exact match has failed: two
// identical boxes plugged into one machine differ by nothing but that number.
const unnumbered = (name) => String(name ?? '').replace(/\((\d+)- /g, '(').trim();

function findDevice(list, want) {
  const exact = list.find((x) => x.name === want);
  if (exact) return exact;
  const w = unnumbered(want);
  return list.find((x) => unnumbered(x.name) === w) ?? null;
}

function repin() {
  if (!engine) return;
  const missing = [];
  try {
    const m = engine.getAudioDeviceManager();
    const d = devices();
    // A pin that resolved through the number-blind pass is rewritten to the name the device
    // answers to TODAY. Every surface upstream reads these back — the panel's two selects,
    // the remembered pair — and a name Windows no longer uses reads there as "not set" while
    // the engine is in fact pinned. Canonicalise once, here, where the truth is.
    if (wantRecordingName) {
      const hit = findDevice(d.recording, wantRecordingName);
      if (hit) { m.setRecordingDevice(hit.id); wantRecordingName = hit.name; }
      else missing.push(`capture "${wantRecordingName}"`);
    } else if (defaultRecordingId) {
      m.setRecordingDevice(defaultRecordingId);
    }
    if (wantPlaybackName) {
      const hit = findDevice(d.playback, wantPlaybackName);
      if (hit) { m.setPlaybackDevice(hit.id); wantPlaybackName = hit.name; }
      else missing.push(`playback "${wantPlaybackName}"`);
    } else if (defaultPlaybackId) {
      m.setPlaybackDevice(defaultPlaybackId);
    }
    // A pin that matches nothing used to do nothing and say nothing, which left the engine
    // on whatever it had — on a fresh one, the Windows default. That is how the room ends
    // up playing out of the wrong box with every panel reporting the right one. Leave the
    // device alone (switching a live capture on a failed pin is a bigger move than saying
    // so) but never leave it silent.
    if (missing.length) {
      lastError = { err: -1, msg: `no device matches ${missing.join(' or ')} — still on the previous one`, at: Date.now() };
    } else if (lastError && lastError.err === -1 && lastError.msg.startsWith('no device matches')) {
      lastError = null;
    }
  } catch (e) {
    lastError = { err: -1, msg: `repin failed: ${e.message}`, at: Date.now() };
  }
  pushState();
}

const methods = {
  devices: () => devices(),

  setDevices: ({ appId, recordingName, playbackName, stereo }) => {
    if (appId) ensureEngine(appId);
    if (recordingName !== undefined) wantRecordingName = recordingName || null;
    if (playbackName !== undefined) wantPlaybackName = playbackName || null;
    if (stereo !== undefined) {
      wantStereo = !!stereo;
      // Takes effect on the next join, which is what the caller arranges after a device
      // change anyway — the profile is not a live setting.
      try { applyAudioProfile(); } catch {}
    }
    repin();
    return { wantRecordingName, wantPlaybackName, wantStereo };
  },

  // Going on or off stage inside a live channel. setClientRole is a live switch — this is
  // what it is for — so no rejoin, and no gap in the room audio.
  role: (args) => {
    asSpeaker = !!args?.speaker;
    ensureEngineOrThrow().setClientRole(asSpeaker ? 1 : 2);
    pushState();
    return { asSpeaker };
  },

  join: ({ appId, token, channel, uid, asSpeaker: speaker = false }) => {
    const e = ensureEngine(appId);
    asSpeaker = !!speaker;
    // 1 = broadcaster (can speak), 2 = audience.
    e.setClientRole(asSpeaker ? 1 : 2);
    e.enableAudioVolumeIndication(300, 3, true);
    // Before joinChannel, because Agora reads the profile at join and ignores it after.
    try { applyAudioProfile(); } catch {}
    repin();
    // Playback settings are engine-level, but a device change rejoins the channel and a
    // fresh engine starts at unity — re-assert them here so the operator's level survives.
    try { applyOutput(); } catch {}
    const rc = e.joinChannel(token, String(channel), Number(uid), {});
    return { joining: true, rc, channel: String(channel), uid: Number(uid), asSpeaker };
  },

  leave: () => {
    if (engine) engine.leaveChannel();
    joined = null;
    speaking.clear();
    levels = { out: 0, in: 0, outAt: 0, inAt: 0 };
    resetUplink();
    pushState();
    return { left: true };
  },

  mute: (args) => {
    const next = args?.muted ?? !muted;
    ensureEngineOrThrow().muteLocalAudioStream(!!next);
    muted = !!next;
    if (muted) { levels.out = 0; levels.outAt = 0; }
    pushState();
    return { muted };
  },

  output: (args) => {
    if (args?.volume !== undefined) outVolume = Math.max(0, Math.min(400, Math.round(Number(args.volume))));
    if (args?.muted !== undefined) outMuted = !!args.muted;
    applyOutput();
    if (outMuted) { levels.in = 0; levels.inAt = 0; }
    pushState();
    return { outVolume, outMuted };
  },
};

ipcRenderer.on('rpc', (_e, { id, method, args }) => {
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`unknown method ${method}`);
    ipcRenderer.send('rpc-result', { id, ok: true, data: fn(args ?? {}) });
  } catch (err) {
    ipcRenderer.send('rpc-result', { id, ok: false, error: err.message });
  }
});

// Publish who is currently speaking. Smoothed here so the overlay does not strobe
// on every volume callback.
setInterval(() => {
  const now = Date.now();
  const out = [];
  for (const [uid, s] of speaking) {
    if (s.lastAboveMs && now - s.lastAboveMs < SPEAK_HOLD_MS) {
      out.push({ uid: String(uid), volume: s.volume, sinceMs: now - s.lastAboveMs });
    }
  }
  out.sort((a, b) => b.volume - a.volume);
  // A meter that holds its last value when the stream stops reads as signal when
  // there is none, so decay both directions once the callbacks go quiet.
  const DECAY_MS = 600;
  const level = (v, at) => (at && now - at < DECAY_MS ? v : 0);
  ipcRenderer.send('speaking', {
    active: out,
    // Every uid Agora has told us is unmuted, whether or not they are making a sound. This is
    // the list StudioMate's mute lock acts on; `active` cannot serve, because a mic that is open
    // and silent is exactly the case a level-based trigger misses.
    openMics: [...openMics].filter(([, open]) => open).map(([uid]) => String(uid)),
    levels: {
      out: muted ? 0 : level(levels.out, levels.outAt),
      in: outMuted ? 0 : level(levels.in, levels.inAt),
    },
    muted,
    outVolume,
    outMuted,
    // Two stats intervals of slack: onRtcStats lands every ~2s, so one late sample must not
    // read as a dead uplink. Muted and audience are reported separately rather than folded in
    // here — both legitimately stop the bytes, and "you muted yourself" and "the room cannot
    // hear you" must never draw the same.
    uplink: {
      ...uplink,
      sending: !!uplink.movingAt && now - uplink.movingAt < 6000,
      connected: uplink.state === 3,
      asSpeaker,
    },
  });
}, 250);

// A force-killed main leaves this renderer alive, and it keeps the Agora channel open
// with the account's one uid — a ghost client with no HTTP surface to hang it up, which
// then bans the real engine's connection (error 123) every time that one reconnects.
// Nothing in Electron reports the loss, so watch for the parent going away.
setInterval(() => {
  try { process.kill(process.ppid, 0); }
  catch {
    try { engine?.leaveChannel(); } catch {}
    process.exit(0);
  }
}, 5000);

ipcRenderer.send('ready');
pushState();
