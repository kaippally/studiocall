# Troubleshooting

Every entry here happened at least once, usually live, usually at the worst possible moment.

## 1. "I'm in the room and nobody can hear me"

Check these in order. Seriously, in order: the last one on the list is never the answer.

1. **Are you on stage?** Audio page meter says *not on stage*, or the Room page badge says
   *Listening only*? Listeners transmit nothing. Take the mic.
2. **Is the engine in the room as a speaker?** `http://127.0.0.1:4018/health`: look at `joined`
   and `uplink.asSpeaker`. On stage in Clubhouse but `asSpeaker: false` in the engine means the
   audio joined as audience. StudioCall notices this and rejoins by itself within a couple of room
   polls. **Take the mic** again forces it.
3. **Is audio actually leaving the machine?** `uplink.txBytes` should be climbing. If it isn't,
   the mic is being captured and going nowhere.
4. **Did you just change a device?** Changing the capture device on a joined channel changes the
   *setting* but not the *running capture*. That's why StudioCall rejoins on every change. If it
   still sounds wrong: **Reset audio**.
5. **Picked the same device again and nothing changed?** Setting a device to the one it already is
   does nothing inside the SDK. **Reset audio** goes via the Windows default and back, which is
   the fix.
6. **The "Chat" output of your audio interface** may carry nothing unless you route the mic to it
   in the interface's own settings. Try the main mix output, and watch for feedback loops if the
   room audio also goes back into that interface.

Then press **Save log** and read it: every step, what the engine said back, and a second reading a
few seconds later.

## 2. Error 123 / "banned by server"

Agora allows **one connection per user id**. Clubhouse uses your account id as that id, so:

- **Clubdeck and StudioCall in a room at the same time** means one of them gets kicked, then the
  other reconnects and kicks the first, forever. Close one.
- **Two engines running** gives the same fight, with both of them on your own PC. Look:

```powershell
Get-NetTCPConnection -LocalPort 4018 -State Listen | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } |
  Select-Object ProcessId, ParentProcessId, CreationDate
```

  There should be exactly one. An `electron.exe` whose parent is gone is a ghost still in your
  room: kill it, then `npx pm2 restart studiocall-audio`.
- **Your phone** joining the same room with the same account does it too.

## 3. "This audio engine is too old…" / the port lies

PM2 says `studiocall-audio` is online, but features 404? An **older engine process is holding
port 4018** and PM2's copy never got the port. PM2 happily reports `online` the whole time.
Restarting through PM2 does nothing, because the process answering isn't PM2's. Use the commands
in §2, kill the elder, restart.

## 4. 429 / "Clubhouse is rate-limiting this account"

Two flavours:

- **A plain 429.** A burst of identical calls. StudioCall waits and retries on its own, and spaces
  out things like "mute everyone" (300 ms per person) so it doesn't trigger this in the first place.
- **Cloudflare error 1015.** The *whole account* is blocked for ~30 s, and every request inside
  the window extends it. StudioCall stops sending anything until the window passes and tells you
  how long. Don't mash buttons: each press extends the block.

A room poll that fails because of a rate limit **doesn't mean the room ended**. The desk shows an
amber "the room is still up" line and keeps the room alive.

## 5. The engine won't start

- **`Cannot read properties of undefined (reading 'disableHardwareAcceleration')`**: the
  `ELECTRON_RUN_AS_NODE` environment variable is set (VS Code sets it in its terminals), so
  Electron started as plain Node. `start.ps1` clears it. If you start the engine some other way,
  clear it yourself.
- **`GPU process isn't usable. Goodbye.`**: the engine runs headless with a specific set of GPU
  switches. See [ENGINE.md §2.1](ENGINE.md#21-gpu-switches-are-not-optional). Override with
  `SC_SWITCHES` if your machine needs a different set.

## 6. Logged out / 401

The session expired, or Clubhouse started rejecting the app version the desk pretends to be.
Log in again. If a fresh login *also* gets 401s, the pretend version (`CH-AppVersion` /
`CH-AppBuild` in `server/src/studiocall/client.ts`) has probably gone stale. Bump it to a current
mobile build.

## 7. Can't change my profile photo

Not a bug on our side. Clubhouse retired its photo upload endpoint for **everyone**. You can pick
from photos already in your photo history (**Change profile picture**). A brand-new photo has to be
uploaded from the phone app once, and then the desk can select it forever after.

## 8. The room ended by itself

- **Did you close every desk window while in someone else's room?** That leaves after 15 s (set
  `STUDIOCALL_LEAVE_ON_ADMIN_CLOSE=0` to stop it). Rooms you *run* are never left this way.
- **Was the server down for a while while you hosted?** Clubhouse closes a room whose creator
  stops checking in (every 20 s). A quick restart is fine, since the room is saved and resumed. A
  long outage isn't.
- Otherwise, Clubhouse ended it, and the desk says so with Clubhouse's own reason.

## 9. PM2 says `connect EPERM \\.\pipe\rpc.sock`

The PM2 daemon was started from an **elevated** terminal and a normal one can't talk to it. Stop
it from an elevated terminal (`npx pm2 kill`), then start everything again from a normal one.
