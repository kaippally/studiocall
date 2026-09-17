# Clubhouse field notes

Clubhouse has no public API. What it has is the API its phone app uses, which nobody documented
and everybody reverse-engineered. These are the notes from building a desk on top of it, a
diary of small betrayals.

Base URL: `https://www.clubhouseapi.com/api`. Headers: `CH-UserID`, `CH-DeviceId`, `CH-AppBuild`,
`CH-AppVersion`, `CH-Languages`, `CH-Locale`, `Authorization: Token <token>`.

## 1. The ground rules nobody tells you

### 1.1 IDs are too big for JavaScript

House and user ids are snowflakes larger than `Number.MAX_SAFE_INTEGER`:

```
on the wire   6106309341783081985
JSON.parse    6106309341783082000   ← a different house. No error. Good luck.
```

Parse every response with `json-bigint` (`storeAsString`) and keep ids as strings end to end.

### 1.2 The app version is a password

`CH-AppVersion` / `CH-AppBuild` must look like a real, recent phone app. When they go stale, you get
a `401` and no explanation. StudioCall pretends to be `24.01.02` / `3375`, and those numbers will
eventually stop working.

### 1.3 An empty error message means "your request is shaped wrong"

`400 {"success": false, "error_message": ""}` isn't the room refusing you. It's the endpoint
refusing your *body*. Classic example: joining a room from the hallway with `attribution_source`
but without its partner `attribution_details`. They travel as a pair:

```json
{ "channel": "AbCd1234",
  "attribution_source": "feed",
  "attribution_details": "eyJpc19leHBsb3JlIjpmYWxzZSwicmFuayI6MX0=" }
```

(That base64 is `{"is_explore":false,"rank":1}`, which is what the phone sends when you tap a room.)

### 1.4 Probe with `OPTIONS`, never with `POST {}`

It's a Django REST Framework API, and `OPTIONS /some_endpoint` answers with the endpoint's
human-readable name and does nothing else. It's a free, safe existence check.

`POST {}` is *not* safe. `POST /update_bio {}` answers `200 {"success": true}` and **blanks your
bio**. Ask us how we know. (Don't ask us what the bio said before.)

## 2. Rooms

### 2.1 Creating a room doesn't put you in it

`/create_channel` makes the room. Without an immediate `/join_channel`, it has zero occupants and
is reaped within seconds. After that, `/active_ping` every 20 s or it's reaped anyway.

And being *joined* over HTTP isn't *presence* either. Until the audio actually connects to Agora,
the room reports zero people, including you.

### 2.2 Room chat starts switched off

New rooms have text chat **disabled**. The desk calls `/enable_channel_messages` right after
creating one, because everyone forgets, every single time.

### 2.3 Privacy levels

`privacy_level` is one of `public`, `house`, `friend_of_friend`, `friend`, in lowercase
(`Public` is rejected). `is_private` on a room is vestigial: open house rooms report
`is_private: true` while their own tooltip says "open to everyone".

### 2.4 `get_channel` has no counts

There's no `num_all` on it. Count `users[]` yourself. Reading the absent field is how a room with
four people displays "0 in room".

### 2.5 Endpoints that are gone

| Endpoint | Status |
|---|---|
| `/get_channels` | 404. Use `/get_feed_v3` (POST only) |
| `/make_channel_private` and friends | 404 |
| `/remove_moderator`, `/unmake_moderator` | 404. **Moderator can't be revoked. Ever.** Think before you click the star. |
| `/change_channel_topic` etc. | 404. Rename with `/set_channel_title` |
| `/update_photo` | alive, but refuses everyone: "Clubhouse now has photo histories…" No app version gets past it. |

### 2.6 A failed poll is not a dead room

A room that has really ended answers `/get_channel` with `success: false` / `should_leave`,
sometimes on a 200 and sometimes on a 400. A *timeout* or a *429* means "couldn't ask", not "room
gone". If you treat "couldn't ask" as "gone" and stop pinging, **you end the room yourself**, for
everyone in it, and then blame Clubhouse. We did exactly this. The desk now needs two
`should_leave` answers in a row before it believes it.

## 3. The stage

### 3.1 Every roster action is moderator-only

`/invite_speaker`, `/uninvite_speaker`, `/mute_speaker`, `/block_from_channel`, `/make_moderator`,
`/set_channel_title`. Non-moderators get a refusal, often with no reason. The desk hides the buttons
instead of letting you find out.

### 3.2 Getting on stage yourself: two doors

- **Open room:** `POST /become_speaker { channel }` promotes you and returns a fresh audio token.
- **Hand-raise room:** `POST /audience_reply { channel, raise_hands: true, unraise_hands: false }`.

Send `/audience_reply` to an *open* room and you get the empty-400 treatment (§1.3). A 200 from
`/audience_reply` means **"hand is up"**, not "you're on stage".

When a moderator accepts your hand, your own roster row gets `is_invited_as_speaker: true`. There's
no accept endpoint; `/become_speaker` *is* the accept. (`/reject_speaker_invite` exists, just to
keep things spicy.)

### 3.3 Raised hands aren't in the roster

`users[]` has no hand field at all. `is_invited_as_speaker` is the *moderator's invitation*, which
is the opposite of someone asking. Raised hands live in `GET /get_handraise_queue?channel=`,
which is GET-only and moderator-only.

### 3.4 The audio role is fixed at join time

Agora sets you as *broadcaster* or *audience* when the audio joins. Get promoted on Clubhouse
afterwards and you're a speaker with a microphone that transmits **nothing**: no error, no sound,
a lovely green "live" badge. The audio has to be rejoined as a speaker with a fresh token from
`/join_channel`. The desk watches the roster and does this automatically.

### 3.5 Mutes are suggestions

`/mute_speaker` mutes someone, and Clubhouse gives them an unmute button. So "muted" lasts until
they press it. That's why the desk has *held* mutes and a *lock*: it watches Agora's open-mic
signal (which fires on the unmute, before any sound) and re-mutes within one 200 ms tick.

### 3.6 Throttling: two kinds of 429

- A **plain 429** on a burst of identical calls. Retry with backoff, and better still, don't burst.
  Muting a stage of ten people back to back got ten 429s and muted nobody, so now it's 300 ms apart.
- **Cloudflare 1015**: `{ cloudflare_error: true, retry_after: 30 }`. The whole *account* is blocked,
  and every request inside the window extends it. Stop *everything* until it passes. A desk that
  greets every arrival in a busy room it doesn't even moderate is how you earn one of these.

## 4. Chat, links, reactions

- **Reactions aren't in the message history.** They only arrive over PubNub
  (`new_channel_reaction`). The PubNub token comes from `/join_channel` and works for that room only.
- **Pinned links:** `/add_channel_link { channel, link }` and `/remove_channel_link { channel, link_id }`.
  The PubNub events are called `add_link` / `remove_link`, and endpoints with *those* names also
  exist but aren't what the apps use. Clubhouse keeps a list; every client shows only the last one.
- **Room settings:** `/update_handraise_queue_setting { channel, handraise_queue_setting }` (0 open,
  1 invite only, 2 request to join) and `/set_chat_permission { channel, chat_permission }`.
- **Inviting someone into the room:** `/invite_to_existing_channel`. The body field name is
  unconfirmed, so the desk sends both `user_id` and `user_ids`.
- **Waves:** `/send_wave`, `/get_received_waves`, `/get_initiated_waves` (GET).

## 5. Photos

`/update_photo` is permanently retired (§2.5). What works:

| Endpoint | Body |
|---|---|
| `POST /get_user_photo_history` | `{ user_id }` → `{ photo_history: [{ thumbnail_url, full_photo_url, photo_key }] }` |
| `POST /set_profile_photo` | `{ photo_key }` |

`photo_key` looks like `<userId>#<microseconds>`, **not** the CDN filename. The upload endpoint for
*new* photos isn't in any desktop client and wasn't found by guessing thousands of names. New photos
come from the phone app, and the desk picks from the history.

## 6. Audio (Agora)

- The Agora **user id is the Clubhouse user id**, which is how per-speaker volume maps onto faces.
- Except **your own** voice, which Agora reports as uid `0`. Map it to your real id, or you'll never
  appear as talking.
- **One uid, one connection.** A second client on the same account (another desktop app, your phone,
  a ghost process) gets one of them banned with error 123.
- Changing the capture device on a joined channel **doesn't restart capture**. Rejoin.
- A stereo send needs *both* `AudioProfileMusicHighQualityStereo` and
  `setAdvancedAudioOptions({ audioProcessingChannels: 2 })`, and only takes effect at join.
