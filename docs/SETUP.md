# Setting up StudioCall

Grab a coffee. Most of this is watching npm download half the internet.

## 1. What you need

| Thing | Why |
|---|---|
| **Windows 10 or 11** | The audio engine and its device handling are tested on Windows only. Mac and Linux users: brave, but untested. |
| **Node.js 20+** | Runs the server and the build. |
| **PowerShell 7** (`pwsh`) | `start.ps1` uses it. Windows PowerShell 5.1 will get confused and cry. |
| **A Clubhouse account** | Obviously. |
| **OBS Studio** (optional) | Only if you want the overlays on a stream. |

PM2 (the process manager) is fetched on demand with `npx`, so there's nothing to install
globally.

## 2. Install and start

```powershell
cd studiocall
./start.ps1
```

On the first run it:

1. runs `npm install` at the root (Electron + Agora SDK), in `server/` and in `client/`,
2. writes `.env` from `.env.example` with a freshly generated `KMS_MASTER_KEY`,
3. builds the UI into `client/dist`,
4. starts `studiocall-audio` (the Electron engine) and `studiocall-server` under PM2.

Open **http://127.0.0.1:4019/studiocall/**.

Run `./start.ps1` again any time. It starts only what's missing and **never restarts something
that's already running**, because restarting the audio engine mid-room drops everyone's audio.
Useful PM2 commands:

```powershell
npx pm2 list                       # what's running
npx pm2 logs studiocall-server     # what it's muttering about
npx pm2 restart studiocall-server  # safe; the room survives a server restart
```

> 🛑 **Don't run it from an elevated ("Run as administrator") terminal.** A PM2 daemon started as
> admin refuses to talk to a normal terminal afterwards, and you'll get `connect EPERM` errors
> until you reboot or clean up.

## 3. Logging in to Clubhouse

The Room page offers two ways in while you are signed out.

### 3.1 Sign in from Clubdeck (easiest)

If **Clubdeck** (the desktop Clubhouse client) is installed and logged in on this PC, click
**Sign in from Clubdeck**. StudioCall reads Clubdeck's profile, takes the session token and the
Agora App ID, encrypts the token into `data/session.json`, and you're in.

It borrows the session rather than logging in again, so Clubdeck stays logged in too. But see
[TROUBLESHOOTING §2](TROUBLESHOOTING.md#2-error-123--banned-by-server): **don't have both apps in
a room at the same time.**

### 3.2 Log in by SMS

Under the Clubdeck button: enter your number, press **Text me a code**, type the code, **Sign in**. This path works but has had very little
testing, and an SMS session **doesn't include the Agora App ID** the audio needs. Put it in `.env`:

```ini
CLUBHOUSE_AGORA_APP_ID=<the agoraKey value>
```

(It's the same for every Clubhouse user. Clubdeck's `profile.json` has it as `agoraKey`, if you
know someone with Clubdeck.)

## 4. Picking audio devices

Open the **Audio** page.

- **Into the room**: the microphone (or mix) the room hears.
- **Out of the room**: where the room's voices come out. If you're streaming, make this a device
  OBS can capture (a virtual cable, an interface's loopback, whatever your rig uses).

Devices are pinned **by name**, not by number, because Windows renumbers audio devices whenever
something is plugged in, unplugged, or wakes up from sleep.

Changing a device while you're in a room makes StudioCall **rejoin the audio**, which leaves a
second or two of silence. That's normal. See
[TROUBLESHOOTING §1](TROUBLESHOOTING.md#1-im-in-the-room-and-nobody-can-hear-me) for why.

When you find a pair that works, press **Keep pairing**. Future you, at 11pm, mid-show, with a
silent room, will be grateful.

## 5. Settings (`.env`)

| Variable | Default | What it's for |
|---|---|---|
| `KMS_MASTER_KEY` | generated | Encrypts the stored Clubhouse token. Lose it and you log in again. |
| `CLUBHOUSE_AGORA_APP_ID` | empty | Audio for SMS logins (above). |
| `STUDIOMATE_URL` | empty | A host app to integrate with ([HOW_IT_WORKS §5](HOW_IT_WORKS.md#5-plugging-into-a-host-app)). |
| `STUDIOCALL_PORT` | `4019` | The server's port. |
| `STUDIOCALL_DATA_DIR` | `data` | Where everything is stored. |
| `STUDIOCALL_AUDIO_URL` | `http://127.0.0.1:4018` | Where the engine listens. |
| `STUDIOCALL_LEAVE_ON_ADMIN_CLOSE` | `1` | Close every desk window and, 15 s later, leave any room you *joined* (never one you *run*). `0` stays in. |
| `SC_CERT_DIR` | empty | Folder with `localhost.pem` + `localhost-key.pem` for an https dev server. |

## 6. Hacking on it

```powershell
./start.ps1 -Dev
```

This runs the server under `tsx watch` and adds the Vite dev server with hot reload on
**http://localhost:5220/studiocall/** (https if `SC_CERT_DIR` is set). Server edits reload the
server, and the room survives. Type-check with `npm run typecheck` in `server/` or `client/`.

## 7. What lives in `data/`

Everything is local and gitignored:

| File | Contents |
|---|---|
| `session.json` | Your Clubhouse session (token encrypted) |
| `room.json` | The room you're in, so a restart picks it back up |
| `controls.json` | Every switch on the Rules page and the overlay settings |
| `speaker-status.json` | Gag / auto-mute / auto-kick / auto-mod flags |
| `devices.json`, `audio-pairs.json` | Audio pins and the pairings you kept |
| `invites.json` | Room invites already seen |
| `studiocall.db` | The people log |
| `media/images/` | Cached profile photos |
| `audio-logs/` | Saved audio logs |
| `ui-settings.json` | Layout bits: last page, sizes, sorts |

**Back it up if you care about the people log. Never commit it.** The session in there *is* your
Clubhouse login.
