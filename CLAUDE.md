# StudioCall — notes for AI coding assistants

StudioCall is a standalone Clubhouse room desk: a TypeScript server (`server/`), a React UI
(`client/`) and an Electron audio engine (`engine/`). Read [README.md](README.md), then the doc for
the area you're touching: [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for architecture and API,
[CLUBHOUSE_FIELD_NOTES.md](docs/CLUBHOUSE_FIELD_NOTES.md) before calling any Clubhouse endpoint,
[ENGINE.md](docs/ENGINE.md) before touching audio.

## 1. Rules

1. **Never stop or restart `studiocall-audio` while a room is live.** It drops the room's audio.
   `studiocall-server` is safe to restart; the room is saved and resumed. In dev it runs
   `tsx watch`, so a server edit reloads it.
2. **The browser never calls another origin.** `client/src/**` fetches only relative
   `/api/studiocall/*`. A host app is reached through `/api/studiocall/studiomate/*`.
3. **Clubhouse ids are strings** (they exceed `Number.MAX_SAFE_INTEGER`).
4. **Probe Clubhouse with `OPTIONS`, never `POST {}`**. Empty bodies can overwrite account data.
5. **A failed request is not a dead room.** Only `should_leave` / `success:false` counts.
6. **Space out repeated Clubhouse writes.** Bursts get throttled; Cloudflare 1015 blocks the account.
7. **Faces are cached, never hotlinked:** `localAvatar()` → `data/media/images`.
8. **Host-app integration is optional.** Anything in `server/src/studiomate.ts` must be a no-op
   without `STUDIOMATE_URL` and a logged no-op when the host is down.
9. **Never commit `data/` or `.env`.** They hold a live Clubhouse session and its key.
10. **Number headings in docs** (`## 3.`, `### 3.2`).
11. **Scratch files go in `review/`** (gitignored).
12. Type-check before committing: `npm run typecheck` in `server/` and `client/`.
