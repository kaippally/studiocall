# How StudioCall works

For developers, the curious, and anyone about to plug this into their own streaming app.

## 1. Three processes, because one wouldn't do

| Process | Folder | Port | Job |
|---|---|---|---|
| `studiocall-server` | `server/` | 4019 | Talks to Clubhouse (REST + PubNub), runs every automation, owns the WebSocket, serves the built UI and overlays |
| `studiocall-audio` | `engine/` | 4018 | Holds the Agora voice connection. Electron. See [ENGINE.md](ENGINE.md) |
| `studiocall-client` | `client/` | 5220 | Dev only: Vite with hot reload |

**Why is the audio a separate Electron app?** `agora-electron-sdk` is a native module compiled
against Electron's ABI. It won't load in plain Node. So the server does everything *except*
audio, and tells the engine what to do over HTTP.

**Why does the server own everything else?** The browser is a remote control, not the brain. The
automations (floor rule, mute locks, auto-invites) have to run while you're looking at another
window, or at no window. The overlays in OBS have no idea you clicked anything unless a server
tells them. And the browser must never talk to Clubhouse directly: tokens stay on the server.

## 2. The server, in one breath

`server/src/routes/studiocall.ts` is the big one. It's long because Clubhouse is weird, not
because we enjoy scrolling. It keeps a handful of loops running while you're in a room:

| Loop | Every | Does |
|---|---|---|
| Active ping | 20 s | `/active_ping`, so Clubhouse doesn't close a room whose creator went quiet |
| Room poll | on request (cached 3 s) | `/get_channel`: roster, then auto-invite, auto-kick, auto-mod, anon removal, people log, stage-role reconcile |
| Speaker pump | 200 ms | Engine `/speaking` becomes `studiocall-speakers` for the overlay, plus floor rule, mute locks, held mutes, gags, unmute counting |
| Talk clock | 500 ms | Who has talked for how long in this room |
| Chat pump | 3 s | `/get_channel_messages`: new lines, gag deletions, link capture, bridge to YouTube |
| Hand pump | 4 s | `/get_handraise_queue`: new raised hands ring the bell |
| Invite poll | 30 s | `/get_activities`: "X pinged you into a room" notices |
| PubNub | long-poll | Reactions, mutes by others, roster changes |

State that has to survive a restart (the room, controls, flags, device pins) is JSON in `data/`.
The people log is SQLite (`data/studiocall.db`, via libSQL).

## 3. The REST API

Everything is under `/api/studiocall`. JSON in, JSON out. Errors come back as
`{ error: 'clubhouse', status, body }` (Clubhouse said no), `{ error: 'audio-engine', message }`
(503, engine unreachable) or `{ error: '...' }`.

### 3.1 Session and rooms

| Method | Path | Body / query | |
|---|---|---|---|
| GET | `/health` | | server up; is a host app configured / connected |
| GET | `/session` | | `{ loggedIn, me, expired?, clubdeckAvailable }` |
| POST | `/login/clubdeck` | `{ profilePath? }` | adopt Clubdeck's session |
| POST | `/login/phone/start` · `/complete` | `{ phoneNumber }` · `{ phoneNumber, code }` | SMS login |
| GET | `/houses` | | houses you can open a room in |
| GET | `/feed` | | the hallway |
| POST | `/room/create` | `{ houseId?, topic?, privacyLevel }` | `house` · `public` · `friend_of_friend` · `friend` |
| POST | `/room/join` · `/room/leave` · `/room/end` · `/room/recover` | `{ channel }` for join | |
| GET | `/room` | | full room state: roster, capabilities, links, hands, details |
| GET | `/room/current` | | `{ channel, mode }` with no Clubhouse call |
| POST | `/room/topic` · `/room/link` · `/room/link/remove` · `/room/stage` · `/room/chat-permission` | | room settings (moderator) |

### 3.2 The stage and people

| Method | Path | Body |
|---|---|---|
| POST | `/room/mic` | take the mic / raise hand / accept an invite |
| POST | `/room/speaker` | `{ userId, onStage }`: invite up / move down |
| POST | `/room/moderator` | `{ userId }`: one-way! |
| POST | `/room/invite` | `{ userId }`: ping someone into the room |
| POST | `/room/remove` | `{ userId }`: remove and block from the room |
| POST | `/room/mute-user` | `{ userId, name, muted }`: held mute (latch) |
| GET | `/room/held-mutes` | |
| POST | `/room/mute-all` | once, 300 ms apart per speaker |
| GET/POST | `/room/keep-muted` | `{ on }`: the stage mute lock |
| GET | `/user/:userId` | profile card data |
| POST | `/user/follow` · `/user/block` `{ userId, on }` · `/wave` `{ userId }` · `/react` `{ userId, emoji }` | |
| GET/POST | `/speaker-status` | `{ userId, name, flag, on }`: `gag` · `autoMute` · `autoKick` · `autoMod` |
| GET | `/people?ids=a,b` · PATCH `/people/:userId` `{ notes }` | people log |
| GET | `/invites` · `/waves` | |
| GET · POST | `/profile/photos` · `/profile/photo/select` `{ photoKey }` | pick from photo history |

### 3.3 Chat and on-air

| Method | Path | Body |
|---|---|---|
| GET | `/room/chat` | recent lines |
| POST | `/room/chat/send` | `{ text }` (split into parts if long) |
| POST | `/room/say` | `{ message }`: a desk line, never put on air |
| POST | `/room/chat/delete` | `{ messageId }` |
| POST | `/room/chat/speaking-time` | `{ userId }`: "X has been speaking for N minutes" |
| POST | `/room/chat` | `{ enabled }`: open / close room chat |
| GET/POST | `/controls` | every switch on the Rules page, plus overlay controls |
| POST | `/chat/pin` | `{ messageId, message? }`: hold a line on air (again = release) |
| GET/POST | `/infocard` | `{ userId, on?, zoom?, panX?, panY? }`: card on / off air |

### 3.4 Audio

| Method | Path | Body |
|---|---|---|
| GET | `/audio/health` · `/audio/devices` · `/audio/speaking` | |
| POST | `/audio/devices` | `{ recordingName, playbackName }`, then rejoin |
| POST | `/audio/reset` · `/audio/reconnect` | |
| POST | `/audio/mute` | `{ muted }` (your mic) |
| POST | `/audio/output` | `{ volume?, muted? }` (the room on your speakers) |
| POST | `/audio/stereo` | `{ stereo }`: mono or stereo into the room (rejoins) |
| GET/POST | `/audio/memory` · `/audio/memory/save` · `/audio/memory/restore` | last known-good pair |
| GET/POST/DELETE | `/audio/pairs` · `/audio/pairs/:id/restore` | kept pairings |
| POST | `/audio/talk/reset` · `/audio/talk/lap` | talk clock |
| POST | `/audio/log` | write an audio log |

Plus `GET/POST /ui/settings` (layout prefs) and `/media/images/<hash>.<ext>` (cached faces).

## 4. The WebSocket

`ws://127.0.0.1:4019/api/studiocall/ws`. Every message is `{ type, ...payload }`. A new connection
immediately receives the current `studiocall-controls`, `studiocall-infocard` and
`studiocall-speaker-status`.

| `type` | Payload | When |
|---|---|---|
| `studiocall-speakers` | `{ channel, speakers: [{ uid, name, photoUrl, isModerator, volume, level }], bounce, turn }` | who is talking (deduplicated: silence is one message, not five a second) |
| `studiocall-reaction` | `{ channel, emoji, targetUid, fromName, ttlMs }` | someone reacted |
| `studiocall-chat` | `{ channel, items: [...] }` | new chat lines; `channel: null, items: []` means the room is gone |
| `studiocall-chat-remove` | `{ ids }` | lines deleted |
| `studiocall-controls` | the controls object + `chatPin` | any switch changed |
| `studiocall-infocard` | `{ card }` | card on / off air |
| `studiocall-hand` | `{ channel, hand }` | a new raised hand |
| `studiocall-invite` | `{ invite }` | pinged into a room |
| `studiocall-keep-muted` | `{ on }` | stage lock changed |
| `studiocall-held-mutes` | `{ people }` | held mutes changed |
| `studiocall-speaker-status` | `{ people, blocked }` | flags changed |
| `studiocall-auto-invited` | `{ channel, userId, name }` | the auto-invite asked someone up |
| `studiocall-auto-left` | `{ channel, reason }` | left because every window closed |
| `studiocall-room-renamed` | `{ channel, topic }` | the room got a new title |
| `ui-settings` | `{ patch }` | layout prefs changed |

## 5. Plugging into a host app

StudioCall grew up inside a streaming app (StudioMate), and it still speaks to one. The host app is
**optional**: without `STUDIOMATE_URL`, every integration below is a quiet no-op.

### 5.1 StudioCall calls the host (HTTP)

Set `STUDIOMATE_URL=https://your-host:port`. Self-signed localhost certificates are accepted.
The host implements whichever of these it wants; a 404 is logged and shrugged off.

| Host endpoint | Body | StudioCall uses it to |
|---|---|---|
| `POST /api/obs/headline` | `{ text }` | keep an on-screen headline on the room topic (`''` clears) |
| `POST /api/studiocall-bridge/browser-refresh` | `{ reason }` | reload the host's OBS pages when a room starts or ends |
| `POST /api/studiocall-bridge/telegram-announce` | `{ text }` → `{ ok, reachable, error? }` | post "X is being discussed" to a group |
| `GET /api/studiocall-bridge/room-link?channel=` | → `{ link }` | a short public link to the room |
| `POST /api/studiocall-bridge/chat-links` | `{ items: [{ id, text, author, feed }] }` | capture links posted in the room |
| `POST /api/studiocall-bridge/yt-chat` | `{ text }` → `{ queued, reason? }` | send a line into YouTube live chat |
| `GET /api/studiocall-bridge/layer/:id` | → `{ duration }` | auto-hide time for the profile card |

### 5.2 The host connects to StudioCall (WebSocket)

The host opens `ws://127.0.0.1:4019/api/studiocall/ws?role=studiomate`, re-broadcasts the
`studiocall-*` events to its own overlays, and sends:

| Message | Why |
|---|---|
| `{ type: 'studiomate-admins', n }` | its number of open admin windows, so "every window closed" counts them too |
| `{ type: 'livechat-messages', items: [{ id, author, text, isOwner }] }` | YouTube chat, for the bridge into the room |
| `{ type: 'popout-content', title }` | what the host is showing, for the `{title}` placeholder |

### 5.3 Embedding the UI

The client is served under `/studiocall/`, so a host can proxy it same-origin and put it in an
iframe. `index.html?embedded=1` shows just the Room page (no page bar, no invite bell, since the
host rings its own). The UI calls only relative `/api/studiocall/*` URLs, so the host proxies that
path too (with WebSocket upgrade). When the UI wants something from the host, it goes through
`/api/studiocall/studiomate/*` on the StudioCall server, which forwards to `STUDIOMATE_URL`.

## 6. House rules for contributors

1. **The browser never calls another origin.** Clubhouse, PubNub, Agora and every CDN are the
   server's business. Faces are cached to `data/media/images` and served locally.
2. **Clubhouse ids are strings.** They're bigger than `Number.MAX_SAFE_INTEGER`. `JSON.parse`
   silently rounds them to someone else's id. `call()` parses with `json-bigint`.
3. **A failed request is not a dead room.** Only a response saying `should_leave` /
   `success: false` (twice in a row) means the room is gone. Tearing down on a timeout stops the
   keepalive, and *that* kills the room.
4. **Space out repeated writes.** Clubhouse throttles bursts; Cloudflare blocks the account.
5. **Never restart the engine during a room** unless you mean to drop the audio.
6. **Number the headings in docs** (`## 3.`, `### 3.2`), so "see §3.2" always lands.
