# StudioCall 🎙️

**A mission-control desk for running Clubhouse rooms live on stream.** Host a room, run the stage,
tame the chat, and put the faces of whoever is talking onto your OBS canvas, bouncing along with
their voices like a very polite karaoke machine.

> ⚠️ **Unofficial. Very unofficial.** StudioCall talks to Clubhouse's *undocumented* mobile API and
> to the Agora audio network Clubhouse runs on. It isn't affiliated with, endorsed by, or known to
> Clubhouse or Agora. APIs like this change without warning, and using one may break a terms of
> service or two. Use it on your own account, at your own risk, and please don't build a spam
> cannon with it. We'll know. (We won't. But your conscience will.)

---

## 1. Why does this exist?

Once upon a time there was **StudioMate**, a homemade broadcast app that sits beside OBS and runs
a live show: lower thirds, news stories, clips, chat, cameras, the works. Every week the show
brought guests on through a **Clubhouse** room, because that's where the conversation lived.

And every week the same problem turned up.

The *audience watching the stream* couldn't tell who was talking. They heard six voices coming
out of one audio feed and got none of the context. Is that the guest? The host? Some person
called "anon_48213" who wandered in from the hallway with a leaf blower running? Nobody knew.
The chat filled up with "who's speaking??" and, once, "is that a goose?"

What the show needed was simple to say and annoying to build:

1. **Put the speaker's face on screen while they talk**, and take it away when they stop. Per
   person. Not "the room is loud", but *this* person, *now*.
2. **Put chosen chat lines and profile cards on screen**, on cue.
3. **Keep the room under control mid-show** without juggling a phone: mute the person
   interrupting, move the unmute-happy person to the audience, invite the guest up, close the
   door on drive-by trolls.

The obvious first try was an OBS "audio move" plugin. It sort of works, until you notice it listens
to *the whole mix*. Every face bounced whenever *anyone* spoke. It looked like a group of
bobbleheads on a bumpy road.

The second try was **Clubdeck**, a desktop Clubhouse client. It's nice, until a USB audio device
reconnects (which a streaming rig does constantly: interfaces, capture cards, headsets, the cat).
Then Clubdeck's audio thread stalls and the app falls over mid-show. Live. On air. With
everyone watching.

So StudioMate grew its own Clubhouse desk. It joins the room itself, holds the Agora audio
connection itself (so it knows *per person* who's speaking and how loudly), and sends that to the
overlay. It survives devices appearing and vanishing like a magician's assistant. Over many shows
it picked up a mute lock, a floor rule, a profile card designer, a people log and a lot of
opinions about rate limits.

Eventually the desk got big enough to leave home. **This is that desk, moved out on its own.** It
runs by itself, and it still plugs into StudioMate (or your own app) when you want the fancy
extras.

## 2. What it does

- 🏠 **Rooms**: log in, browse the hallway, create a room (public, house or friends), join one,
  switch rooms in one click, end or leave.
- 🎤 **The stage**: invite speakers, move people to the audience, make moderators, take the mic in
  someone else's room, raise your hand, see who raised theirs (with a bell 🔔).
- 🔇 **Mutes that stick**: mute one person and *keep* them muted, mute everyone, or lock the whole
  stage muted. Clubhouse lets speakers unmute themselves; StudioCall politely re-mutes them before
  their first syllable gets out.
- ⚖️ **The floor rule**: whoever is speaking holds the floor, and anyone talking over them gets
  muted and told why. Optional "you've been talking for a minute" nudges. Optional "unmute three
  times in 30 seconds and you're in the audience".
- 🧹 **Housekeeping**: auto-invite arrivals to the stage, greet them with the topic, remove
  anonymous drive-by accounts, per-person gag / auto-mute / auto-kick / auto-mod flags.
- 💬 **Room chat**: read it, answer it, delete lines, react, and hold one line on air.
- 📺 **OBS overlays**: three browser sources show *speaking faces*, *the chat* and *a profile
  card*, all driven live from the desk.
- 🗂️ **People log**: who has been in your rooms, how often, for how long on stage, and your notes on
  them. Counts only, never message text.
- 🎧 **Audio desk**: choose input and output devices by *name* (so Windows renumbering them
  doesn't matter), keep device pairs that worked, reset audio in one click, and save an audio log
  when things go quiet.

## 3. Quick start

You need **Windows 10/11**, **Node.js 20+**, **PowerShell 7**, and a Clubhouse account.

```powershell
git clone https://github.com/<you>/studiocall.git
cd studiocall
./start.ps1
```

Then open **http://127.0.0.1:4019/studiocall/**.

`start.ps1` installs everything, builds the UI, creates a `.env` with a fresh encryption key, and
starts the processes under PM2. The first run takes a few minutes, mostly spent downloading
Electron and the Agora SDK.

Full walkthrough, including how to log in: **[docs/SETUP.md](docs/SETUP.md)**.

## 4. The docs

| Doc | Read it when |
|---|---|
| [SETUP.md](docs/SETUP.md) | You're installing it, logging in, or picking audio devices |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | You want to know what every page and switch does |
| [OBS_OVERLAYS.md](docs/OBS_OVERLAYS.md) | You want faces, chat and cards on your stream |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Something's silent, banned, throttled or on fire |
| [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) | You're a developer, or plugging StudioCall into your own app |
| [CLUBHOUSE_FIELD_NOTES.md](docs/CLUBHOUSE_FIELD_NOTES.md) | You enjoy other people's API suffering |
| [ENGINE.md](docs/ENGINE.md) | You need to know how the Electron audio engine works |

## 5. The shape of the thing

```
  your browser ──► studiocall-server (:4019) ──► Clubhouse API + PubNub
   (the desk)          │    ▲
  OBS sources ◄────────┤    │ HTTP
   (overlays)   WebSocket   │
                       ▼    │
                  studiocall-audio (:4018, Electron) ──► Agora (the actual voices)
```

Three folders: `server/` (TypeScript + Express), `client/` (React + Vite + Tailwind), `engine/`
(Electron + the Agora SDK). The details are in [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## 6. License

[MIT](LICENSE). Do nice things with it. Clubhouse, Agora and Clubdeck are their owners' trademarks
and have nothing to do with this project.
