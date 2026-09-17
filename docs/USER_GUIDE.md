# The StudioCall user guide

A tour of the desk, page by page. The golden rule first:

> **Everything you switch on is server state.** Close the browser tab and the rules keep running,
> the overlays keep updating and the room stays up. Open the desk in three windows and they all
> agree. The desk is a remote control, and the server is the TV.

(One exception, on purpose: close *every* desk window and, 15 seconds later, StudioCall leaves any
room you only *joined*. It never leaves a room you *run*, because Clubhouse closes a room when its
creator stops checking in. See `STUDIOCALL_LEAVE_ON_ADMIN_CLOSE` in [SETUP.md](SETUP.md).)

## 1. The top bar

Pages: **Room · Chat · Audio · Rules · OBS overlays**. On the right: the room you're in, how many
people are in it, and **Speaker status**.

## 2. Room

Where rooms happen.

### 2.1 Not logged in

**Sign in from Clubdeck**, or type your phone number and press **Text me a code**. [SETUP §3](SETUP.md#3-logging-in-to-clubhouse)
has the details.

### 2.2 Starting a room

**Start a room** asks for a title and who it's for:

| Audience | Meaning |
|---|---|
| **House** | Members of the house you pick |
| **Public** | Anyone, listed in the hallway |
| **Friends of friends** | Private, one hop out |
| **Friends only** | Private, people you follow |

StudioCall creates the room, joins it immediately (a room nobody joins is reaped in seconds),
**turns room chat on** (Clubhouse opens new rooms with chat off, which nobody ever remembers),
and connects the audio as a speaker.

### 2.3 Joining a room

**Live rooms** is the hallway. Filter it by how full the rooms are, then click one to join. Already
in a room? Clicking another switches: you leave the old one and join the new one in one go.
Rooms you *host* are left, not ended, so the people inside keep talking.

### 2.4 In a room

- **The title.** Click it to rename the room (moderators only). Click the little arrow for the
  room details: pinned link, who may take the stage, who may chat, house, language, and a copy
  link button. Most of those rows can be edited in place.
- **The roster.** Speakers on top, listeners below. A face with a **pulsing green ring** is talking
  *right now*, and that includes you, which is the quickest way to check your mic is reaching the
  room. Each face shows how long that person has talked in this room.
- **Click a face** to open their **profile card**: bio, follower counts, what the people log knows
  about them, and buttons to invite them up, move them down, make them a moderator (⚠️ Clubhouse
  has *no way to undo this*, so it asks first), follow, block, wave 👋, remove them from the room,
  or hold a mute on them. **Click the picture** to put the card on air.
- **Take the mic / Raise hand / Join room.** In someone else's room, the button shows whatever the
  room allows. "Join room" means a moderator accepted your raised hand and the stage is waiting
  for you.
- **Audio.** The room level slider (how loud the room plays out; 100% is unchanged), **Mute mic**,
  and a *Mic live* / *Listening only* badge. "Listening only" means you're in the audience, and an
  audience member transmits nothing however hard they shout.
- **Controls.** **Speaker bounce** (faces move with voices, or just appear) and **Room chat on air**.
- **End room / Leave.** Ending closes the room for everyone, so it asks first.

## 3. Chat

The room's text chat, live.

- **Type to answer.** Long messages are split at word boundaries so nothing gets cut off.
- **Click a line to hold it on air.** It becomes the only line on the chat overlay. Click it again
  to let it go. Lines the desk posted itself (rule notices, bridged lines) are never put on air,
  however hard you click.
- **On air / mode.** Show *all* chat rolling, or only the *selected* line, plus entrance and exit
  animations (fade, blur, zip, sink…).
- **✕** deletes a line from the room (moderators only).
- **Reactions** ("Sam reacted 💯 to Alex") appear as lines too.

## 4. Audio

The two device pickers (*into the room* / *out of the room*), each with a live meter above it.
Plus:

| Button | Does |
|---|---|
| **Reset audio** | The "unplug it and plug it back in" of audio: clears both devices, rejoins, sets the same pair again, rejoins again. Fixes the "everything looks right but it's silent" case more often than it has any right to. |
| **Keep pairing** | Saves the current input + output pair with how long it has *actually carried audio*. Kept pairs list below, each with **Use** and ✕. |
| **Restore** | Returns to the last pair that proved it works. |
| **Save log** | Writes a Markdown audio log to `data/audio-logs/` (every audio step taken today, what the engine reported back, who owns the engine's port) and copies the path. Attach it to your bug report / therapy session. |

A meter that says **not on stage** is telling the truth: listeners don't send audio.

## 5. Rules

The automations. All of them are **off by default** except "say why", because each one does
something to other people without asking.

### 5.1 Welcoming people

- **Invite everybody who walks in up to the stage.** Handy for panels. They still have to accept.
  Anyone who was moved *down* isn't invited back up; that decision sticks for the room.
- **Invite message.** An optional line posted with each invite. `{speaker}` = their name,
  `{name}` = their username (write `@{name}` for the handle).
- **Tell new arrivals what is being discussed.** Each arrival *after* you switch it on gets the
  topic message once. Only in rooms you moderate, because greeting everyone in someone else's room
  is how you earn a rate limit (and a reputation).

### 5.2 The floor rule

Whoever is speaking **holds the floor**. The floor survives the little pauses in their own
sentences, and a cough or a "yeah" doesn't count as an interruption.

- **Say how long the speaker has held the floor.** A friendly "Sam @sam has been speaking from 1
  minute" in the chat, once per turn. Never about you. Moderators *do* get it, because a monologue
  can't see itself.
- **Mute anybody who speaks out of turn.** Talk over the floor holder and your mic shuts.
  Moderators and you are never muted by it.
- **Say why, when somebody is muted.** On by default, because a mic that dies with no explanation
  looks like a dropped connection, and "CAN YOU HEAR ME?" is louder than the original interruption.

### 5.3 Muting and removal

- **Move a speaker to the audience after too many unmutes in 30 seconds.** For the person who
  treats the mute button like a fidget spinner. Default threshold: 3.
- **Remove anonymous accounts.** No profile photo, or a name starting with "anon", means removed
  and blocked from coming back. A real friend who never set a photo also gets removed, which is why
  this is off until you mean it.

### 5.4 Bridge to YouTube chat

Only shown when a host app is connected ([HOW_IT_WORKS §5](HOW_IT_WORKS.md#5-plugging-into-a-host-app)).
Relays YouTube chat into the room as `[YT][Name] text`, and room chat into YouTube as
`[CH][Name] text`. Tagged lines are never relayed again, so two bridges can't play ping-pong forever.

## 6. Speaker status

A floating window listing everyone with a flag, everyone you've blocked, and everyone on stage
right now. Five toggles per person:

| Flag | Effect |
|---|---|
| **Gag** | Every line they type is deleted as it arrives, and their mic is shut whenever it opens. Lasts across rooms. |
| **Automute** | Just the mic half of a gag. |
| **Block** | The real Clubhouse account block. |
| **Autokick** | Removed from any room once they've been in it longer than *Autokick after* minutes. |
| **Automod** | Made a moderator whenever they're on stage in your room. Clubhouse can't un-moderate anyone, so it asks. |

Each row also shows the **people log**: listener since, rooms attended, time on stage, lines
posted, times dropped, followers, and a 📝 note button for your own notes. It records counts,
never message text. A 📺 button puts the person's card on air.

Turning a flag off **unmutes nobody**. The desk simply stops shutting that mic.

## 7. Mutes, in one table

Because there are several and they are *not* the same thing:

| Control | Who | How long |
|---|---|---|
| **Mute mic** (Room page) | You | Until you unmute |
| **Room muted / room level** | The room's sound on *your* speakers / stream | Until you change it |
| **Mute** on a profile card | One person | *Held*: re-muted every time they unmute, until you release it or the room ends |
| **Mute everyone** | Every speaker but you, once | They can unmute themselves |
| **Keep everyone muted** (lock) | Every speaker but you | Re-muted on every unmute until you unlock or the room ends |
| **Gag / Automute** | One person | Across rooms, until you clear the flag |

The held mutes and the lock act on the *open-mic signal*, not on sound, so the mic is shut before
the first syllable goes out to the room.

## 8. OBS overlays

Its own page: [OBS_OVERLAYS.md](OBS_OVERLAYS.md).
