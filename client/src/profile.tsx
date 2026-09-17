import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ProfileCard } from './components/StudioCallRoster';
import { API } from './lib/api';
import { loadAllUiSettings } from './lib/uiSettings';
import { initFontScale } from './lib/fontScale';
import { NoticeHost } from './components/NoticeHost';
import { AskHost } from './lib/ask';
import { ws } from './ws';
import './index.css';

// One person's profile card in its own window: `?user=<id>`. Opened from any DP in the
// roster, so the card can sit on the second screen while the room stays where it was.
// The card IS the window — closing the card (Esc, Close) closes it, and the card's own
// "take it off air on close" rule still applies, because that is what ProfileCard does.

window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
  e.preventDefault();
});

document.title = 'StudioCall Profile';
ws.connect();
initFontScale();
void loadAllUiSettings();

const userId = new URLSearchParams(location.search).get('user') ?? '';

function ProfileWindow() {
  const [onAir, setOnAir] = useState<string | null>(null);
  const [me, setMe] = useState<string | undefined>();

  useEffect(() => {
    fetch(`${API}/api/studiocall/infocard`)
      .then(r => r.json())
      .then(d => setOnAir(d?.card?.userId ?? null))
      .catch(() => {});
    fetch(`${API}/api/studiocall/session`)
      .then(r => r.json())
      .then(d => setMe(d?.me?.userId === undefined ? undefined : String(d.me.userId)))
      .catch(() => {});
  }, []);

  if (!userId) return <div className="p-4 text-sm text-neutral-500">No profile asked for.</div>;

  return (
    <div className="h-screen w-screen bg-neutral-950 text-neutral-200">
      <ProfileCard
        userId={userId}
        onAirUserId={onAir}
        onAirChange={setOnAir}
        onClose={() => window.close()}
        fill
        mine={me !== undefined && String(userId) === me}
      />
      <NoticeHost />
      <AskHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<ProfileWindow />);
