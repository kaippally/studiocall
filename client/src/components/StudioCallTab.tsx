import { useCallback, useEffect, useRef, useState } from 'react';
import { API, SM_API } from '../lib/api';
import { ACTIVE_ROW, ACTIVE_PILL, ACTIVE_BORDER } from '../lib/activeStyle';
import { askConfirm } from '../lib/ask';
import { openAdminWindow } from '../lib/adminPopout';
import { PhotoHistoryDialog } from './PhotoHistoryDialog';
import { notify } from '../lib/notices';
import { warnThin } from './StudioCallRoster';
import { confirmEndRoom, leaveRoom } from '../lib/studioCallRoom';
import { EndRoomButton } from './EndRoomButton';
import { PhoneLogin } from './PhoneLogin';
import { ws } from '../ws';
import { RoomList, type FeedRoom } from './StudioCallRooms';
import { RoomChatToggle, RoomDetails, RoomRoster, type Participant, type PinnedLink, type RoomDetailsInfo } from './StudioCallRoster';

interface Me { userId: number; name?: string; username?: string; photoUrl?: string; appVersion: string; appBuild: string }
interface SessionState { loggedIn: boolean; me?: Me; verified?: boolean; expired?: boolean; clubdeckAvailable?: boolean }
interface House { id: string; name: string; slug: string; members: number; liveChannels: number; photoUrl: string | null }
interface RoomState { live: boolean; ended?: string; reason?: string; stale?: boolean; staleReason?: string; mode?: 'host' | 'guest' | null; channel?: string; topic?: string | null; numAll?: number | null; numSpeakers?: number | null; speakers?: Participant[]; listeners?: Participant[]; chatEnabled?: boolean; canPostToChat?: boolean; canDisableChat?: boolean; canSpeak?: boolean; onStage?: boolean; iAmModerator?: boolean; links?: PinnedLink[]; canPinLinks?: boolean; invitedToSpeak?: boolean; handraiseEnabled?: boolean; details?: RoomDetailsInfo }
interface AudioDevice { name: string; id: string }
interface AudioHealth { ok: boolean; ready: boolean; engineUp: boolean; joined: { channel: string; uid: number } | null; lastError: { err?: number; msg: string } | null; wantRecordingName?: string | null; wantPlaybackName?: string | null; outVolume?: number; outMuted?: boolean; devices?: { recording: AudioDevice[]; playback: AudioDevice[] } }
interface Speaker { uid: string; volume: number; sinceMs: number }
interface Controls { bounce: boolean; chatOverlay: boolean }

type PrivacyLevel = 'house' | 'public' | 'friend_of_friend' | 'friend';

// The two friend levels are Clubhouse's private rooms: no house owns them, so they
// open from the button rather than from a house row.
const PRIVACY_OPTIONS: { value: PrivacyLevel; label: string; hint: string }[] = [
  { value: 'house', label: 'House', hint: 'members of the house' },
  { value: 'public', label: 'Public', hint: 'listed in the hallway' },
  { value: 'friend_of_friend', label: 'Friends of friends', hint: 'private — one hop out' },
  { value: 'friend', label: 'Friends only', hint: 'private — people you follow' },
];

export function StudioCallTab({ isActive, popout }: { isActive: boolean; popout?: boolean }) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [houses, setHouses] = useState<House[]>([]);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [topic, setTopic] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [feed, setFeed] = useState<FeedRoom[]>([]);
  const [audio, setAudio] = useState<AudioHealth | null>(null);
  const [audioDown, setAudioDown] = useState(false);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  /** Floor time per person, ms — kept by the server and carried on the speaking poll. */
  const [talkMs, setTalkMs] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState(false);
  const [openMicIds, setOpenMicIds] = useState<Set<string> | null>(null);
  const [outVolume, setOutVolume] = useState(100);
  const [outMuted, setOutMuted] = useState(false);
  const [controls, setControls] = useState<Controls>({ bounce: true, chatOverlay: false });
  const [cardUserId, setCardUserId] = useState<string | null>(null);
  // Whose profile is open in front of the operator. A face in the roster opens the card here;
  // only the button inside it broadcasts, so looking somebody up is no longer an on-air act.
  // Who the operator has picked out of the roster. A pick is not a broadcast: the info
  // card only goes on air from the explicit button, so a mis-click costs nothing.
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmMod, setConfirmMod] = useState<Participant | null>(null);
  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>('house');
  // The show on air, else the next one scheduled — the same reading the Scene tab's
  // headline follows, offered here as a room title rather than typing it twice.
  const [showTitle, setShowTitle] = useState<string | null>(null);

  // A drag on the output slider must not be fought by the health poll putting the
  // engine's older value back mid-gesture.
  const outVolumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/studiocall/session`);
      setSession(await r.json());
    } catch (e) {
      notify.error('Cannot reach the StudioCall server.');
    }
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const [h, r, f] = await Promise.all([
        fetch(`${API}/api/studiocall/houses`).then(x => x.json()),
        fetch(`${API}/api/studiocall/room`).then(x => x.json()),
        fetch(`${API}/api/studiocall/feed`).then(x => x.json()),
      ]);
      setHouses(h?.houses ?? []);
      setRoom(r ?? { live: false });
      if (r?.ended && r?.reason) notify.error(`Room ${r.ended} closed — ${r.reason}.`);
      setFeed(f?.rooms ?? []);
    } catch {}
  }, []);

  const loadAudio = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/studiocall/audio/health`);
      if (!r.ok) { setAudioDown(true); return; }
      const d = await r.json();
      setAudio(d);
      setAudioDown(false);
      // The engine holds the output level, so a reload or a re-opened pop-out shows the
      // level that is actually in force. The device pins are the Live Chat window's Settings
      // view now — see StudioCallAudioRouting.
      if (!outVolumeTimer.current) {
        if (typeof d?.outVolume === 'number') setOutVolume(d.outVolume);
        if (typeof d?.outMuted === 'boolean') setOutMuted(d.outMuted);
      }
    } catch { setAudioDown(true); }
  }, []);

  useEffect(() => { if (isActive) { void refresh(); void loadAudio(); } }, [isActive, refresh, loadAudio]);

  useEffect(() => {
    if (!isActive) return;
    fetch(`${SM_API}/api/youtube/show`)
      .then(r => r.json())
      .then(d => setShowTitle(d?.show?.title ?? null))
      .catch(() => {});
  }, [isActive]);

  // Who is talking, for the speaker overlay. Only worth polling while in a room.
  useEffect(() => {
    if (!isActive || !room?.live) { setSpeakers([]); setOpenMicIds(null); setTalkMs({}); return; }
    const t = setInterval(async () => {
      try {
        const d = await fetch(`${API}/api/studiocall/audio/speaking`).then(x => x.json());
        setSpeakers(d?.active ?? []);
        setOpenMicIds(prev => {
          if (!Array.isArray(d?.openMics)) return null;
          const next = new Set<string>(d.openMics.map(String));
          return prev && prev.size === next.size && [...next].every(x => prev.has(x)) ? prev : next;
        });
        if (d?.talk?.totals) setTalkMs(d.talk.totals as Record<string, number>);
        if (typeof d?.muted === 'boolean') setMuted(d.muted);
        // `joined` rides along on this poll, and it is the only live reading of it:
        // /audio/health is fetched on tab open and after an action, never on a timer.
        // Without this the "no audio" banner latches on the drop that was true when
        // the tab was last loaded and keeps claiming silence while the meters run.
        setAudio(a => (a && (a.joined?.channel ?? null) !== (d?.joined?.channel ?? null)
          ? { ...a, joined: d?.joined ?? null, lastError: d?.joined ? null : a.lastError }
          : a));
      } catch {}
    }, 250);
    return () => clearInterval(t);
  }, [isActive, room?.live]);

  useEffect(() => { if (isActive) void refresh(); }, [isActive, refresh]);
  useEffect(() => { if (isActive && session?.loggedIn) void loadRooms(); }, [isActive, session?.loggedIn, loadRooms]);

  // While a room is open the counts move; poll them rather than showing a stale stage.
  useEffect(() => {
    if (!isActive || !room?.live) return;
    const t = setInterval(() => { void loadRooms(); }, 5_000);
    return () => clearInterval(t);
  }, [isActive, room?.live, loadRooms]);

  const createRoom = useCallback(async (houseId?: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ houseId, topic: topic.trim() || undefined, privacyLevel }),
      });
      const d = await r.json();
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Could not open the room.');
      else await loadRooms();
    } catch {
      notify.error('Room request failed.');
    } finally {
      setBusy(false);
    }
  }, [topic, privacyLevel, loadRooms]);

  /**
   * Step onto the stage of a room we are only listening to.
   *
   * The audio leg is rejoined server-side as part of this, because Agora fixes the client role at
   * join: without it Clubhouse shows us as a speaker and the microphone transmits nothing. If that
   * half fails the room is still ours — say so rather than pretending the mic is live.
   *
   * There is no way back down through the API, so leaving the stage means leaving the room.
   */
  const takeMic = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/mic`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Could not take the mic.');
      else if (d?.queued) notify.info('Your hand is up — the moderators have it.');
      else if (d?.audio && d.audio.connected === false) notify.error(`On the stage, but the audio leg did not rejoin: ${d.audio.reason}`);
      await loadRooms();
    } catch {
      notify.error('Mic request failed.');
    } finally {
      setBusy(false);
    }
  }, [loadRooms]);

  const joinRoom = useCallback(async (channel: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const d = await r.json();
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Could not join the room.');
      else await loadRooms();
    } catch {
      notify.error('Join request failed.');
    } finally {
      setBusy(false);
    }
  }, [loadRooms]);

  // What StudioCall is putting on the OBS canvas. Server-owned, because the surfaces
  // that obey it are browser sources: a click here has to reach them, not just this tab.
  const loadControls = useCallback(async () => {
    try {
      const [c, i] = await Promise.all([
        fetch(`${API}/api/studiocall/controls`).then(x => x.json()),
        fetch(`${API}/api/studiocall/infocard`).then(x => x.json()),
      ]);
      setControls({ bounce: c?.bounce !== false, chatOverlay: !!c?.chatOverlay });
      setCardUserId(i?.card?.userId ?? null);
    } catch {}
  }, []);

  const setControl = useCallback(async (patch: Partial<Controls>) => {
    setControls(prev => ({ ...prev, ...patch }));   // the switch answers the click, not the round trip
    try {
      const d = await fetch(`${API}/api/studiocall/controls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(x => x.json());
      setControls({ bounce: d?.bounce !== false, chatOverlay: !!d?.chatOverlay });
    } catch { void loadControls(); }
  }, [loadControls]);

  // Clicking a face puts their Clubhouse profile on air; clicking the same one takes it off.
  const showInfoCard = useCallback(async (userId: string) => {
    try {
      const d = await fetch(`${API}/api/studiocall/infocard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      }).then(x => x.json());
      setCardUserId(d?.card?.userId ?? null);
      warnThin(d);
    } catch {}
  }, []);

  useEffect(() => { if (isActive) void loadControls(); }, [isActive, loadControls]);

  // The CHinfocard layer's duration takes the card down without anyone clicking, so the
  // server's own broadcast is what this follows — otherwise the row keeps saying "On" and
  // the profile keeps offering "Take off air" for a canvas that is already empty.
  useEffect(() => ws.onBroadcast(msg => {
    if (msg.type === 'studiocall-infocard') setCardUserId((msg as any).card?.userId ?? null);
  }), []);

  // Through the shared leave, so this button behaves like the roster's and the pop-out's — it goes
  // on the press — and, unlike the bare fetch it replaces, says so when the server refuses.
  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await leaveRoom();
      await loadRooms();
    } finally {
      setBusy(false);
    }
  }, [loadRooms]);

  // Re-adopt a room the server lost track of (a content-server reload orphans it).
  const recoverRoom = useCallback(async () => {
    setBusy(true);
    try {
      const d = await fetch(`${API}/api/studiocall/room/recover`, { method: 'POST' }).then(x => x.json());
      if (!d?.live) notify.error(d?.reason ?? 'No live room found for your account.');
      await loadRooms();
    } finally {
      setBusy(false);
    }
  }, [loadRooms]);

  // Re-attach audio when the RTC leg drops but the room is still open.
  const reconnectAudio = useCallback(async () => {
    setBusy(true);
    try {
      const d = await fetch(`${API}/api/studiocall/audio/reconnect`, { method: 'POST' }).then(x => x.json());
      if (!d?.connected) notify.error(d?.reason ?? d?.error ?? 'Could not reconnect audio.');
      await loadAudio();
    } finally {
      setBusy(false);
    }
  }, [loadAudio]);

  // Room control. Every one of these acts on somebody else in a live room, so the
  // result is surfaced rather than assumed.
  const act = useCallback(async (path: string, body: unknown, after?: () => void) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d?.ok === false) {
        notify.error(d?.body?.error_message || d?.error || d?.message || 'That did not work.');
      } else {
        after?.();
        await loadRooms();
      }
      return d;
    } catch {
      notify.error('Request failed.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [loadRooms]);

  const muteAll = useCallback(async () => {
    const d = await act('room/mute-all', {});
    if (d?.failed?.length) notify.error(`Muted ${d.muted}; could not mute: ${d.failed.join(', ')}.`);
  }, [act]);

  /**
   * The mute lock — mute everyone, and keep them muted. Server state, so it
   * is read rather than remembered: the status-bar chip arms the same latch.
   */
  const [micLock, setMicLock] = useState(false);
  useEffect(() => {
    let stop = false;
    fetch(`${API}/api/studiocall/room/keep-muted`).then(r => r.json())
      .then(d => { if (!stop) setMicLock(!!d?.on); }).catch(() => {});
    const off = ws.onBroadcast(msg => {
      if ((msg as any)?.type === 'studiocall-keep-muted') setMicLock(!!(msg as any).on);
    });
    return () => { stop = true; off(); };
  }, []);
  const toggleMicLock = useCallback(async () => {
    const want = !micLock;
    if (want && !await askConfirm({
      title: 'Keep everyone muted?',
      body: 'Every speaker but you is muted now, and anyone who unmutes is muted again within a few seconds. It stays on until you release it or the room ends.',
      confirmLabel: 'Lock mics',
    })) return;
    const d = await act('room/keep-muted', { on: want });
    if (d) setMicLock(!!d.on);
    if (want && d?.failed?.length) notify.error(`Lock on; could not mute: ${d.failed.join(', ')}.`);
  }, [act, micLock]);


  // Changing the DP is a PICK from the account's photo history, not an upload — Clubhouse
  // retired the uploader for every desktop client.
  const [photoPicker, setPhotoPicker] = useState(false);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next); // optimistic; the poll corrects it if the engine disagrees
    try {
      const d = await fetch(`${API}/api/studiocall/audio/mute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ muted: next }),
      }).then(x => x.json());
      if (typeof d?.muted === 'boolean') setMuted(d.muted);
    } catch {
      setMuted(!next);
      notify.error('Could not reach the audio engine to mute.');
    }
  }, [muted]);

  // The other direction: how loud the room plays out of the pinned playback device,
  // which is what OBS hears. The slider answers the drag locally and the engine is told
  // once the hand stops, or a drag would fire twenty round trips.
  const sendOutput = useCallback(async (patch: { volume?: number; muted?: boolean }) => {
    try {
      const r = await fetch(`${API}/api/studiocall/audio/output`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      // An engine that answers but has no /output is one built before this control
      // existed — a silent no-op here reads as a dead slider, so name it.
      if (!r.ok) {
        notify.error(String(d?.message ?? d?.error ?? '').includes('404')
          ? 'This audio engine is too old for the room level — restart the engine (start.ps1).'
          : (d?.message ?? d?.error ?? 'Could not set the output level.'));
        return;
      }
      if (typeof d?.outVolume === 'number') setOutVolume(d.outVolume);
      if (typeof d?.outMuted === 'boolean') setOutMuted(d.outMuted);
    } catch {
      notify.error('Could not reach the audio engine to set the output level.');
    }
  }, []);

  const dragOutVolume = useCallback((v: number) => {
    setOutVolume(v);
    if (outVolumeTimer.current) clearTimeout(outVolumeTimer.current);
    outVolumeTimer.current = setTimeout(() => {
      outVolumeTimer.current = null;
      void sendOutput({ volume: v });
    }, 120);
  }, [sendOutput]);

  const toggleOutMute = useCallback(() => {
    const next = !outMuted;
    setOutMuted(next);
    void sendOutput({ muted: next });
  }, [outMuted, sendOutput]);

  // Through the shared ask, so the question and its refusals are worded the same here and in the
  // Live Chat pop-out, which can end the room too.
  const endRoom = useCallback(async () => {
    setBusy(true);
    try {
      await confirmEndRoom();
      await loadRooms();
    } finally {
      setBusy(false);
    }
  }, [loadRooms]);

  const login = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/login/clubdeck`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) notify.error(d?.error === 'clubhouse' ? `Clubhouse rejected the credential (${d.status}).` : (d?.error ?? 'Login failed.'));
      else setSession(d);
    } catch {
      notify.error('Login request failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const speakingIds = new Set(speakers.map(sp => sp.uid));

  // An audience client publishes nothing, so Agora sends no local volume report and there is
  // no `mic → room` level to draw and no ring to light. A meter sitting at zero reads as a
  // broken meter, so the panel names the reason instead. `onStage` comes off the roster; a host
  // is a speaker from the moment the room opens, which is what the fallback covers.
  const publishing = room?.onStage ?? room?.mode === 'host';

  // Clubhouse refuses every roster action to a non-moderator: inviting somebody to the
  // stage, moving them off it, muting them, removing them, and handing over the star. The
  // room's own creator is one; anyone else is one only if the roster says so. Showing the
  // buttons anyway meant a click that came back as a Clubhouse error for no stated reason.
  // The server answers it off our own roster row (`GET /room`), so the tab, the pop-out's bar and
  // the hallway banner all gate on one reading rather than three that can disagree.
  const iAmModerator = !!room?.iAmModerator;

  return (
    <div className="h-full overflow-auto bg-neutral-950 text-neutral-200 p-6">
      <div className="w-full">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-neutral-100">StudioCall</h2>
          {!popout && (
            <button
              type="button"
              onClick={() => { if (!openAdminWindow('studiocall')) notify.error('The browser blocked the pop-out — allow pop-ups for this site.'); }}
              title="Open StudioCall in its own window"
              className="ml-auto rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
            >
              ⧉ Pop out
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-neutral-400">Clubhouse rooms, run from your desk.</p>


        {/* One column on a laptop, up to four on the studio monitor. Multi-column rather than a
            grid because half these cards come and go with the room, and a grid leaves a hole
            where an absent card's cell was; a column flow just closes up. */}
        <div className="mt-5 columns-1 gap-4 lg:columns-2 2xl:columns-3 min-[2200px]:columns-4">
        <div className="mb-4 break-inside-avoid rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          {session === null ? (
            <div className="text-sm text-neutral-500">Checking session…</div>
          ) : session.loggedIn && session.me ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPhotoPicker(true)}
                disabled={busy}
                className="group relative shrink-0"
                title="Change profile picture — pick one of your photos"
              >
                {session.me.photoUrl
                  ? <img src={`${API}${session.me.photoUrl}`} alt="" className="h-12 w-12 rounded-full border border-neutral-700 object-cover" />
                  : <div className="h-12 w-12 rounded-full border border-neutral-700 bg-neutral-800" />}
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  change
                </span>
              </button>
              {photoPicker && (
                <PhotoHistoryDialog
                  current={session.me.photoUrl ?? null}
                  onClose={() => setPhotoPicker(false)}
                  onPicked={() => void refresh()}
                />
              )}
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-neutral-100">{session.me.name}</div>
                <div className="truncate text-xs text-neutral-500">@{session.me.username} · {session.me.userId}</div>
              </div>
              <div className="ml-auto flex items-center gap-1.5 text-xs text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {session.verified ? 'Signed in' : 'Stored'}
              </div>
            </div>
          ) : (
            <div>
              <div className="text-sm text-neutral-300">
                {session.expired ? 'The stored credential expired.' : 'Not signed in.'}
              </div>
              <div className="mt-1 text-xs text-neutral-500">
                {session.clubdeckAvailable
                  ? 'A Clubdeck profile was found on this machine. Signing in adopts its credential — no SMS code needed.'
                  : 'No Clubdeck profile found on this machine.'}
              </div>
              <button
                type="button"
                onClick={login}
                disabled={busy || !session.clubdeckAvailable}
                className="mt-3 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Signing in…' : 'Sign in from Clubdeck'}
              </button>
              <div className="mt-4 text-xs text-neutral-500">Or sign in with your phone number:</div>
              <PhoneLogin onDone={() => void refresh()} />
            </div>
          )}
        </div>

        {session?.loggedIn && (
          <div className="mb-4 break-inside-avoid rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            {room?.live ? (
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
                  {/* The room's NAME, not "Hosting · <code>" — the mode and the channel code are
                      nothing the operator reads mid-show. The click opens the details below,
                      where every piece of the room a moderator can change is edited in place. */}
                  <button
                    type="button"
                    onClick={() => setDetailsOpen(v => !v)}
                    title={detailsOpen ? 'Hide the room details' : 'Show the room details'}
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-neutral-100 hover:text-white"
                  >
                    {room.topic || '(no title)'}
                    <span className="ml-1.5 text-xs text-neutral-500">{detailsOpen ? '▴' : '▾'}</span>
                  </button>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {room.numAll ?? 0} in room · {room.numSpeakers ?? 0} on stage
                  </span>
                  {/* Also at the TOP of the card, not only under the roster: the pair down there
                      is below the fold the moment a room has a stage and 28 listeners, which is
                      every room worth ending. Same button as the rail's and the top bar's. */}
                  <EndRoomButton onEnded={() => void loadRooms()} />
                </div>
                {/* A poll that could not reach Clubhouse. The room is still up and the ping is
                    still running — what is shown below it is simply the last answer we got. It
                    is a status line, not a notice: it persists until it clears, and a
                    toast every 5s would bury everything else. */}
                {room.stale && (
                  <div className="mt-1 text-[11px] text-amber-400">
                    {room.staleReason ?? 'Could not reach Clubhouse'} · showing the last roster
                  </div>
                )}
                {detailsOpen && <RoomDetails room={room} iAmModerator={iAmModerator} onChanged={() => void loadRooms()} />}
                {audioDown ? (
                  <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300">
                    Audio engine unreachable — run start.ps1. You are in the room but silent.
                  </div>
                ) : audio?.joined ? (
                  <div className="mt-2 rounded border border-emerald-900/60 bg-emerald-950/30 px-2.5 py-1.5 text-xs text-emerald-300">
                    Audio connected · uid {audio.joined.uid}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2 rounded border border-amber-900/60 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300">
                    <span className="flex-1">
                      In the room but no audio
                      {audio?.lastError?.err === 123
                        ? ' — another client joined with your account and Agora dropped this one.'
                        : audio?.lastError?.msg ? ` — ${audio.lastError.msg}` : '.'}
                    </span>
                    <button
                      type="button"
                      onClick={reconnectAudio}
                      disabled={busy}
                      className="shrink-0 rounded bg-amber-700 px-2 py-0.5 font-medium text-white hover:bg-amber-600 disabled:opacity-40"
                    >
                      Reconnect
                    </button>
                  </div>
                )}

                <RoomRoster
                  room={room}
                  meUserId={session.me?.userId}
                  speakingIds={speakingIds}
                  openMicIds={openMicIds}
                  myMuted={muted}
                  talkMs={talkMs}
                  cardUserId={cardUserId}
                  selected={selected}
                  busy={busy}
                  iAmModerator={iAmModerator}
                  onProfile={id => { openAdminWindow('profile', { user: id }); }}
                  onSelect={setSelected}
                  onAct={(path, body) => void act(path, body)}
                  onMakeMod={setConfirmMod}
                />
                {/* The three audio controls read as one instrument, not as loose rows above a pile
                    of buttons: both directions of signal and the room fader that reaches OBS. */}
                <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-neutral-400">Audio</span>
                    {/* Emerald is reserved for what is actually on air — a muted mic is not, so it
                        takes the amber the mute button already wears. */}
                    {publishing && !muted
                      ? <span className={ACTIVE_PILL}>Mic live</span>
                      : <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${publishing ? 'bg-amber-500/20 text-amber-300' : 'bg-neutral-800 text-neutral-500'}`}>
                          {publishing ? 'Mic muted' : 'Listening only'}
                        </span>}
                  </div>

                  {/* One grid, not three loose rows: label, track and readout are columns, so the
                      room fader lines up under the meters it belongs with and a long label can
                      never wrap and shove a track out of line with the one above it. */}
                  {/* The two meters moved up to the Audio routing panel, each above the select it
                      measures. What is left here is the room fader and the mic's own mute. */}
                  <div className="mt-3 grid grid-cols-[auto_1fr_2.75rem] items-center gap-x-2.5 gap-y-2">
                    {/* How loud the room plays out of the pinned playback device — what OBS hears.
                        Muting here silences the room without leaving it; the mic button below is
                        the other direction. */}
                    <button
                      type="button"
                      onClick={toggleOutMute}
                      title={outMuted ? 'Let the room be heard again' : 'Silence the room without leaving it'}
                      className={`flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${outMuted ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
                    >
                      <span aria-hidden>{outMuted ? '🔇' : '🔈'}</span>
                      {outMuted ? 'Room muted' : 'Room level'}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={5}
                      value={outVolume}
                      disabled={outMuted}
                      onChange={e => dragOutVolume(Number(e.target.value))}
                      className="h-2.5 w-full accent-emerald-500 disabled:opacity-40"
                    />
                    <span className="text-right text-[11px] tabular-nums text-neutral-600">
                      {outMuted ? '—' : `${outVolume}%`}
                    </span>
                  </div>

                  {/* Your own microphone lives with the meter that shows it, and is offered only
                      when there is a microphone to mute: an audience client publishes nothing, so
                      the way up is Take the mic, not a mute button that toggles a silent stream. */}
                  {/* The action and the sentence that explains it are one block: the button keeps
                      its size, the copy takes the rest of the line and wraps under itself rather
                      than pushing the button onto a row of its own in a narrow panel. Emerald fill
                      stays reserved for a mic that is actually open — the way onto the
                      stage is outlined, so the brightest green in the panel is never a state the
                      operator is not in yet. */}
                  <div className="mt-3 flex items-center gap-3 border-t border-neutral-800 pt-3">
                    {publishing ? (
                      <button
                        type="button"
                        onClick={toggleMute}
                        title="Your microphone into the room"
                        className={`shrink-0 rounded px-3 py-1.5 text-sm font-medium text-white ${muted ? 'bg-amber-600 hover:bg-amber-500' : 'bg-neutral-700 hover:bg-neutral-600'}`}
                      >
                        {muted ? 'Unmute mic' : 'Mute mic'}
                      </button>
                    ) : room.canSpeak ? (
                      <button
                        type="button"
                        onClick={takeMic}
                        disabled={busy}
                        title={room.invitedToSpeak
                          ? 'Your request was accepted — take the stage'
                          : room.handraiseEnabled
                            ? 'Ask the moderators for the stage'
                            : 'This room lets anyone speak — step onto the stage'}
                        className="shrink-0 rounded border border-emerald-600 bg-emerald-600/15 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40"
                      >
                        {busy ? 'Working…'
                          : room.invitedToSpeak ? 'Join room'
                          : room.handraiseEnabled ? 'Raise hand'
                          : 'Take the mic'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-neutral-500">This room does not let the audience speak.</span>
                    )}
                    <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-600">
                      {publishing
                        ? 'Speak and the meter moves; your photo blinks on the stage above.'
                        : 'Nothing from this machine reaches the room until you are on stage.'}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={muteAll}
                    disabled={busy}
                    className="rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-600 disabled:opacity-40"
                  >
                    Mute everyone
                  </button>
                  {/* The standing version of the button beside it: that one is a one-shot anybody
                      can undo for themselves, this one keeps shutting mics until it is released. */}
                  <button
                    type="button"
                    onClick={() => void toggleMicLock()}
                    disabled={busy}
                    title={micLock
                      ? 'Mic lock is ON — anyone who unmutes is muted again. Press to release it; nobody is unmuted.'
                      : 'Keep everyone muted: mute the stage now, and mute anyone who unmutes'}
                    className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
                      micLock
                        ? `border ${ACTIVE_BORDER} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25`
                        : 'bg-neutral-700 text-white hover:bg-neutral-600'
                    }`}
                  >
                    {micLock ? '🔒 Mics locked' : '🔓 Keep muted'}
                  </button>
                  <RoomChatToggle room={room} onChanged={loadRooms} />
                  <button
                    type="button"
                    onClick={leave}
                    disabled={busy}
                    title="Walk out now — no question. The room stays up for everybody in it."
                    className="ml-auto rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40"
                  >
                    {busy ? 'Working…' : 'Leave room'}
                  </button>
                  {/* Two buttons, not one that changes its mind: this used to be End for a room we
                      created and Leave for any other, which meant the host of a room re-joined
                      after a restart was offered no way to close it at all. */}
                  {iAmModerator && (
                    <button
                      type="button"
                      onClick={endRoom}
                      disabled={busy}
                      className="rounded border border-rose-600 px-3 py-1.5 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-40"
                    >
                      End room
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm font-medium text-neutral-300">Start a room</div>
                <input
                  value={topic}
                  onChange={e => setTopic(e.target.value)}
                  placeholder="Room title (optional)"
                  className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600"
                />
                {showTitle && showTitle !== topic && (
                  <button
                    type="button"
                    onClick={() => setTopic(showTitle)}
                    title="The show on air, or the next one scheduled on the channel — the same reading the Scene tab follows"
                    className="mt-1 block w-full truncate text-left text-xs text-sky-400 hover:text-sky-300"
                  >
                    Use the show title: {showTitle}
                  </button>
                )}
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-400">
                  {PRIVACY_OPTIONS.map(o => (
                    <label key={o.value} className="flex items-center gap-1.5">
                      <input type="radio" name="sc-privacy" checked={privacyLevel === o.value} onChange={() => setPrivacyLevel(o.value)} />
                      {o.label} — {o.hint}
                    </label>
                  ))}
                </div>
                {privacyLevel === 'house' || privacyLevel === 'public' ? (
                  <div className="mt-3 max-h-72 overflow-auto rounded border border-neutral-800">
                    {houses.map(h => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => createRoom(h.id)}
                        disabled={busy}
                        className="flex w-full items-center gap-3 border-b border-neutral-800 px-3 py-2 text-left last:border-b-0 hover:bg-neutral-800/60 disabled:opacity-40"
                      >
                        {h.photoUrl
                          ? <img src={`${API}${h.photoUrl}`} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                          : <div className="h-8 w-8 shrink-0 rounded bg-neutral-800" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-neutral-200">{h.name}</span>
                          <span className="block text-xs text-neutral-500">{h.members.toLocaleString()} members</span>
                        </span>
                        <span className="shrink-0 text-xs text-sky-400">Open →</span>
                      </button>
                    ))}
                    {!houses.length && <div className="px-3 py-2 text-xs text-neutral-600">No houses loaded.</div>}
                  </div>
                ) : (
                  <div className="mt-3">
                    <div className="text-xs text-neutral-500">
                      A private room belongs to no house — it is open only to
                      {privacyLevel === 'friend' ? ' the people you follow' : ' your follows and theirs'}, and does not appear in the hallway.
                    </div>
                    <button
                      type="button"
                      onClick={() => createRoom()}
                      disabled={busy}
                      className="mt-2 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                    >
                      {busy ? 'Opening…' : 'Open private room'}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="mt-3 text-[11px] text-neutral-600">
              Client {session.me?.appVersion} ({session.me?.appBuild})
            </div>
          </div>
        )}

        {confirmMod && (
          <div className="mb-4 break-inside-avoid rounded-lg border border-amber-800 bg-amber-950/40 p-4">
            <div className="text-sm text-amber-200">
              Make <span className="font-medium">{confirmMod.name}</span> a moderator?
            </div>
            <div className="mt-1 text-xs text-amber-400/90">
              This cannot be undone. Clubhouse has no API to revoke moderator — only they can step down.
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => { const u = confirmMod; setConfirmMod(null); void act('room/moderator', { userId: u.userId }); }}
                className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-40"
              >
                Make moderator
              </button>
              <button
                type="button"
                onClick={() => setConfirmMod(null)}
                className="rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {session?.loggedIn && (
          <div className="mb-4 break-inside-avoid rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="text-sm font-medium text-neutral-300">Controls</div>
            <div className="mt-0.5 text-xs text-neutral-500">What StudioCall puts on the OBS canvas.</div>
            <div className="mt-3 space-y-2">
              {([
                { key: 'bounce' as const, label: 'Speaker bounce', hint: 'faces hop with the voice' },
                { key: 'chatOverlay' as const, label: 'Room chat on air', hint: 'the room’s text chat, drawn on the canvas' },
              ]).map(t => (
                <div
                  key={t.key}
                  className={`flex items-center gap-3 rounded border px-3 py-2 ${controls[t.key] ? ACTIVE_ROW : 'border-neutral-800 bg-neutral-950/40'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-neutral-200">{t.label}</div>
                    <div className="truncate text-xs text-neutral-500">{t.hint}</div>
                  </div>
                  {controls[t.key] && <span className={ACTIVE_PILL}>On</span>}
                  <button
                    type="button"
                    onClick={() => void setControl({ [t.key]: !controls[t.key] } as Partial<Controls>)}
                    className={`shrink-0 rounded px-3 py-1 text-sm font-medium text-white ${controls[t.key] ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-neutral-700 hover:bg-neutral-600'}`}
                  >
                    {controls[t.key] ? 'Disable' : 'Enable'}
                  </button>
                </div>
              ))}
              <div className={`flex items-center gap-3 rounded border px-3 py-2 ${cardUserId ? ACTIVE_ROW : 'border-neutral-800 bg-neutral-950/40'}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-200">Info card</div>
                  <div className="truncate text-xs text-neutral-500">
                    {cardUserId ? 'clear it here, or from the card behind their face' : 'click a face in the roster to open their card, then Show in overlay'}
                  </div>
                </div>
                {cardUserId && <span className={ACTIVE_PILL}>On</span>}
                {cardUserId && (
                  <button
                    type="button"
                    onClick={() => void showInfoCard(cardUserId)}
                    className="shrink-0 rounded bg-neutral-700 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-600"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {session?.loggedIn && (
          <div className="mb-4 break-inside-avoid rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="flex items-center">
              <div className="text-sm font-medium text-neutral-300">Live rooms</div>
              <button type="button" onClick={() => void recoverRoom()} disabled={busy} className="ml-auto text-xs text-amber-400 hover:text-amber-300 disabled:opacity-40">
                Recover my room
              </button>
              <button type="button" onClick={() => void loadRooms()} className="ml-3 text-xs text-sky-400 hover:text-sky-300">
                Refresh
              </button>
            </div>
            <div className="mt-2">
              <RoomList feed={feed} currentChannel={room?.channel ?? null} busy={busy} onJoin={joinRoom} />
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
