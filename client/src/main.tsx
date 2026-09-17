import ReactDOM from 'react-dom/client';
import { Desk } from './components/Desk';
import { StudioCallTab } from './components/StudioCallTab';
import { StudioCallInviteWatch } from './components/StudioCallInviteWatch';
import { flushUiSettings, loadAllUiSettings } from './lib/uiSettings';
import { initFontScale } from './lib/fontScale';
import { ws } from './ws';
import { NoticeHost } from './components/NoticeHost';
import { AskHost } from './lib/ask';
import './index.css';

// The desk. `?popout=1` is the same desk opened from itself for a second screen; `?embedded=1` is
// a host app's tab — just the room page, because the host draws the other panels in its own
// windows and rings its own invite bell.
//
// Every window is an ordinary client of the server: everything it commands is server state, so
// any number of them never disagree.

window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
  e.preventDefault();
});

const params = new URLSearchParams(location.search);
const popout = params.has('popout');
const embedded = params.has('embedded');

ws.connect();
initFontScale();
await loadAllUiSettings();
window.addEventListener('beforeunload', flushUiSettings);

document.title = 'StudioCall';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div className="flex h-screen w-screen flex-col bg-neutral-950 text-neutral-200">
    {embedded ? <StudioCallTab isActive popout={false} /> : <Desk popout={popout} />}
    {!embedded && <StudioCallInviteWatch />}
    <NoticeHost />
    <AskHost />
  </div>,
);
