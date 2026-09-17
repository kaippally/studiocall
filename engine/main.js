// StudioCall audio engine — main process.
//
// The only process that holds a Clubhouse room's RTC connection. Presence in a
// Clubhouse room is an RTC fact, not an API one: StudioMate can open a room over
// HTTP, but until this process joins the Agora channel the room has no occupants.
//
// Shape: the Agora SDK lives in a hidden renderer (agora-electron-sdk 4.x reaches
// for `window` and cannot run in the main process — 3.x could, which is why
// Clubdeck drives it from main via ipcMain). Main owns the HTTP surface on :4018
// and relays each call to the renderer over a small request/response IPC channel.
// StudioMate drives it exactly like ObsApi on :4015.

const { app, BrowserWindow, ipcMain } = require('electron');
const express = require('express');
const { join } = require('path');

const PORT = process.env.PORT || 4018;

let win = null;
let ready = false;

// Latest state pushed up from the renderer, so /health and /speaking answer without
// a round trip (the volume callback fires several times a second).
let state = { engineUp: false, joined: null, lastError: null, muted: false, outVolume: 100, outMuted: false, wantRecordingName: null, wantPlaybackName: null, devices: { recording: [], playback: [] } };
let active = [];
// uids whose microphone Agora says is OPEN, reported the moment it opens rather than when
// it first makes a sound. StudioMate's mute lock acts on this; `active` is speech, not state.
let openMics = [];
let levels = { out: 0, in: 0 };
// Proof that audio is REACHING Agora, not merely being captured — see renderer.js. Carried
// on both surfaces: /speaking because that is the 250ms poll the tab already runs, /health
// because that is what answers "is this thing working" without one.
let uplink = { sending: false, connected: false, state: 0, txBytes: 0, kbps: 0, encKbps: 0, lossPct: 0, rttMs: 0, asSpeaker: false };

// ── main → renderer RPC ─────────────────────────────────────────────────────
let seq = 0;
const pending = new Map();

function rpc(method, args = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (!win || !ready) return reject(new Error('audio engine not ready'));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send('rpc', { id, method, args });
  });
}

ipcMain.on('rpc-result', (_e, { id, ok, data, error }) => {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  ok ? p.resolve(data) : p.reject(new Error(error));
});

ipcMain.on('state', (_e, next) => { state = { ...state, ...next }; });
ipcMain.on('speaking', (_e, next) => {
  active = next?.active ?? [];
  openMics = Array.isArray(next?.openMics) ? next.openMics : [];
  levels = next?.levels ?? { out: 0, in: 0 };
  if (next?.uplink) uplink = next.uplink;
  if (next && typeof next.muted === 'boolean') state.muted = next.muted;
  if (next && typeof next.outMuted === 'boolean') state.outMuted = next.outMuted;
  if (next && typeof next.outVolume === 'number') state.outVolume = next.outVolume;
});
ipcMain.on('ready', () => { ready = true; });

// ── HTTP ────────────────────────────────────────────────────────────────────
const api = express();
api.use(express.json());

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(ready ? 500 : 503).json({ error: e.message }); }
};

api.get('/health', (_req, res) => res.json({ ok: true, ready, ...state, uplink }));

api.get('/devices', wrap(() => rpc('devices')));

// Pin by name. The name is what survives device churn — an index or id captured at
// join time silently points at the wrong endpoint once Windows renumbers them.
api.post('/devices', wrap((req) => rpc('setDevices', req.body ?? {})));

// StudioMate supplies the appId, token and uid it got from Clubhouse's
// /join_channel. This process never talks to Clubhouse itself.
api.post('/join', wrap((req) => {
  const { appId, token, channel, uid } = req.body ?? {};
  if (!appId || !token || !channel || uid === undefined) {
    throw new Error('appId, token, channel and uid are required');
  }
  return rpc('join', req.body, 20_000);
}));

api.post('/leave', wrap(() => rpc('leave')));

// Broadcaster or audience, switched inside the live channel. An audience client publishes
// nothing whatever its mute button says, so this is what "go on stage" actually needs.
api.post('/role', wrap((req) => rpc('role', req.body ?? {})));
api.post('/mute', wrap((req) => rpc('mute', req.body ?? {})));

// The other direction from /mute: the level of the room mix played out to the pinned
// playback device — i.e. what OBS hears. 0..400, 100 = unity.
api.post('/output', wrap((req) => rpc('output', req.body ?? {})));

// Who is talking right now — the input for the speaker overlay. uids are Clubhouse
// user_ids, so StudioMate can map straight onto the room roster.
api.get('/speaking', (_req, res) => res.json({ joined: state.joined, active, openMics, levels, muted: state.muted, uplink }));

// ── Electron ────────────────────────────────────────────────────────────────
// One engine per machine, enforced before anything else runs. A second instance is not
// a harmless duplicate: there is only one Clubhouse account, so both join Agora with the
// same uid, and Agora bans one of the two connections (error 123). The room then drops
// audio every time the loser reconnects and bans the winner back. Losing the race for
// :4018 does not prevent it — the Agora client lives in the renderer and joins over IPC,
// so a second main with no HTTP surface still holds a live channel nobody can hang up.
if (!app.requestSingleInstanceLock()) {
  console.error('[studiocall-audio] another instance is already running — exiting');
  app.exit(0);
}

// Headless service: no visible window, and nothing for a GPU process to do. Left
// to itself Electron spawns one, it crash-loops, and it takes the whole process
// down ("GPU process isn't usable. Goodbye."). Switches must be set before ready.
app.disableHardwareAcceleration();
const SWITCHES = (process.env.SC_SWITCHES ?? 'disable-gpu,disable-gpu-compositing,disable-software-rasterizer,no-sandbox,disable-gpu-sandbox')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const sw of SWITCHES) app.commandLine.appendSwitch(sw);
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // A hidden window is throttled by default, which would stall the audio
      // callbacks this whole service exists to deliver.
      backgroundThrottling: false,
    },
  });
  win.loadFile(join(__dirname, 'renderer.html'));
  api.listen(PORT, '127.0.0.1', () => {
    console.log(`[studiocall-audio] listening on http://127.0.0.1:${PORT}`);
  });
});
