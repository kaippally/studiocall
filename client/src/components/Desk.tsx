import { useEffect, useState } from 'react';
import { API } from '../lib/api';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';
import { StudioCallTab } from './StudioCallTab';
import { StudioCallChatPanel } from './StudioCallChatPanel';
import { StudioCallAudioRouting } from './StudioCallAudioRouting';
import { SpeakerStatusPanel } from './SpeakerStatusPanel';
import { DeskRules } from './DeskRules';
import type { RoomHere } from './StudioCallRooms';

type Page = 'room' | 'chat' | 'audio' | 'rules' | 'overlays';

const PAGES: { id: Page; label: string }[] = [
  { id: 'room', label: 'Room' },
  { id: 'chat', label: 'Chat' },
  { id: 'audio', label: 'Audio' },
  { id: 'rules', label: 'Rules' },
  { id: 'overlays', label: 'OBS overlays' },
];

const PAGE_KEY = 'desk:page';
const ROOM_POLL_MS = 5_000;

/** The overlay URLs to paste into OBS, served by whatever origin this page came from. */
function OverlayHelp() {
  const base = `${location.origin}${import.meta.env.BASE_URL}overlay.html`;
  const rows = [
    { layer: 'speakers', what: 'Whoever is talking, as faces that move with their voice. Size the source wide and short (e.g. 760 × 300).' },
    { layer: 'chat', what: 'The room chat — the rolling list, or the one line you held from the Chat page. Tall and narrow (e.g. 460 × 660).' },
    { layer: 'card', what: 'One person’s profile card, put up from their profile. Roughly 720 × 340.' },
  ];
  return (
    <div className="h-full overflow-y-auto p-4 text-sm text-slate-300">
      <p className="mb-3 text-slate-400">
        Add each as a <b>Browser</b> source in OBS, sized as suggested. Any layer style goes on the URL —
        for example <code className="text-slate-200">&amp;color=%23f59e0b&amp;speakerAnim=blink&amp;titleSize=28</code>.
      </p>
      {rows.map(r => {
        const url = `${base}?layer=${r.layer}`;
        return (
          <div key={r.layer} className="mb-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-slate-100">{url}</code>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(url)}
                className="shrink-0 rounded bg-slate-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-slate-600"
              >Copy</button>
            </div>
            <div className="mt-1 text-[12px] text-slate-500">{r.what}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The standalone desk: the room page is the StudioCall tab a host app embeds, and the rest are the
 * panels a host app spreads across its own windows — here they are pages of one window.
 */
export function Desk({ popout }: { popout: boolean }) {
  const [page, setPage] = useState<Page>(() => (getUiSetting(PAGE_KEY) as Page | null) ?? 'room');
  const [room, setRoom] = useState<RoomHere>({ live: false });
  const [statusOpen, setStatusOpen] = useState(false);
  const [hostConnected, setHostConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch(`${API}/api/studiocall/room`).then(r => r.json()).then(d => { if (alive) setRoom(d); }).catch(() => {});
      fetch(`${API}/api/studiocall/health`).then(r => r.json()).then(d => { if (alive) setHostConnected(!!d?.studiomate?.connected); }).catch(() => {});
    };
    poll();
    const t = setInterval(poll, ROOM_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const go = (p: Page) => { setPage(p); setUiSetting(PAGE_KEY, p); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="nav-tab-bar flex h-9 shrink-0 items-stretch">
        {PAGES.map(p => (
          <button key={p.id} type="button" onClick={() => go(p.id)} className={`nav-tab ${page === p.id ? 'nav-tab--active' : ''}`}>
            {p.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 px-3">
          {room.live && <span className="max-w-[18rem] truncate text-[11px] text-slate-400">{room.topic || '(no title)'} · {room.numAll ?? 0} in room</span>}
          <button
            type="button"
            onClick={() => setStatusOpen(true)}
            className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-700"
          >Speaker status</button>
        </div>
      </nav>
      <div className="min-h-0 flex-1">
        <div className={`h-full flex-col ${page === 'room' ? 'flex' : 'hidden'}`}><StudioCallTab isActive={page === 'room'} popout={popout} /></div>
        {page === 'chat' && <StudioCallChatPanel />}
        {page === 'audio' && (
          <div className="h-full overflow-y-auto p-3">
            <div className="max-w-xl rounded-lg border border-slate-800 bg-slate-900/40">
              <StudioCallAudioRouting live={room.live} publishing={room.onStage ?? room.mode === 'host'} />
            </div>
          </div>
        )}
        {page === 'rules' && <DeskRules room={room} hostConnected={hostConnected} />}
        {page === 'overlays' && <OverlayHelp />}
      </div>
      <SpeakerStatusPanel open={statusOpen} onClose={() => setStatusOpen(false)} room={room} />
    </div>
  );
}
