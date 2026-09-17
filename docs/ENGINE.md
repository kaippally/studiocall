# The audio engine (`engine/`)

The one process that actually *hears* the room. It's an Electron app with no window, because the
Agora SDK is a native module that only loads inside Electron. The server tells it what to do
over HTTP on `127.0.0.1:4018`. It never talks to Clubhouse itself; the server hands it the token and
user id from `/join_channel`.

## 1. Why it has to exist at all

Joining a Clubhouse room over HTTP makes you a *name on a list*. Until something connects to the
Agora voice channel, the room reports zero people, including you. This is that something. It's
also the only place that knows **who** is talking, per person, which is what the whole speaker
overlay runs on.

## 2. How it's built

`engine/main.js` runs the HTTP API. The Agora SDK runs in a **hidden renderer** (`engine/renderer.js`),
because `agora-electron-sdk` 4.x wants `window` the moment it loads. Main and renderer talk over a
small request/response IPC channel.

The hidden window has `backgroundThrottling: false`. Without it, Chromium decides a hidden window
is unimportant and throttles the audio callbacks, and the speaker overlay turns into a slideshow.

### 2.1 GPU switches are not optional

Headless Electron here crash-loops its GPU process and quits with
`GPU process isn't usable. Goodbye.` The working set is:

    disable-gpu, disable-gpu-compositing, disable-software-rasterizer,
    no-sandbox, disable-gpu-sandbox

`in-process-gpu` *looks* like the fix. It isn't: Agora's init then dies with
`Validating command decoder is not supported`. Override the set with `SC_SWITCHES` if your machine
disagrees.

### 2.2 `ELECTRON_RUN_AS_NODE`

VS Code sets this in its terminals. Inherited, Electron starts as plain Node, `require('electron')`
returns a string, and startup dies on
`Cannot read properties of undefined (reading 'disableHardwareAcceleration')`. `start.ps1` clears it.

### 2.3 One engine, and it checks

`app.requestSingleInstanceLock()` runs first, so a second copy exits immediately. And the renderer
checks every 5 s that its parent process still exists, and leaves the channel if it doesn't, so a
force-killed engine can't leave a ghost sitting in your room holding your user id.

## 3. Endpoints

| Method | Path | |
|---|---|---|
| GET | `/health` | engine state, channel, last error, devices, pins, output level, **uplink** |
| GET | `/devices` | recording and playback devices |
| POST | `/devices` | `{ appId?, recordingName, playbackName, stereo? }`: pin **by name** (`null` = back to the default) |
| POST | `/join` | `{ appId, token, channel, uid, asSpeaker }` |
| POST | `/leave` | |
| POST | `/role` | `{ speaker }` |
| POST | `/mute` | `{ muted }`: your microphone |
| POST | `/output` | `{ volume?, muted? }`: the room's playback (Agora 0–400, 100 = unchanged) |
| GET | `/speaking` | `{ joined, active, openMics, levels, muted, uplink }` |

### 3.1 `uplink`: proof, not vibes

A bouncing mic meter only proves the microphone is captured. `uplink.txBytes` (cumulative audio
bytes sent) *growing* proves audio is leaving for Agora. `state` is Agora's connection state
(3 = connected). Connected with no byte growth is the classic "talking to a room that can't hear
you".

### 3.2 `openMics`

Whose microphone is *open*, from Agora's remote-mute callbacks. It changes the instant someone
unmutes, before they make a sound. The server's mute lock and held mutes act on this, so a
re-mute beats the first syllable. `openMics: []` means "every mic is shut", which is not the same
as the field missing (an older engine).

## 4. Device churn

Devices are pinned by **name**, because Windows renumbers audio devices whenever anything is plugged,
unplugged or wakes up. On every `onAudioDeviceStateChanged` the engine re-pins by name. A device
name can also gain a prefix ("Speakers (2- Interface)"), so name matching tolerates that.

This is the event the desktop client this project replaced never handled, which is why a USB
headset reconnecting used to take down the whole show:

```
[WIN_CORE] audio device unplugged: '{0.0.0.00000000}.{…}'
FATAL ahpl: thread<routingChange> stalled for 9 calc cycles, at least 9805ms!
```

## 5. Running it alone

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npx electron .
```

Normally `start.ps1` runs it under PM2 as `studiocall-audio`. Don't restart it during a room.
