import { useState } from 'react';
import { API } from '../lib/api';
import { notify } from '../lib/notices';

/**
 * Sign in by SMS, for a machine with no Clubdeck to borrow a session from. Two steps: the number
 * asks Clubhouse for a code, the code completes the login. A session made this way carries no
 * Agora App ID — the server takes CLUBHOUSE_AGORA_APP_ID from .env for that.
 */
export function PhoneLogin({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const post = async (path: string, body: object): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/login/phone/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.body?.error_message || d?.error || `Clubhouse answered ${r.status}`);
      return true;
    } catch (err: any) {
      notify.error(`Sign-in failed — ${err.message}`);
      return false;
    } finally { setBusy(false); }
  };

  const field = 'w-44 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none';
  const button = 'rounded bg-neutral-700 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-600 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={async e => {
        e.preventDefault();
        if (!sent) { if (await post('start', { phoneNumber: phone.trim() })) setSent(true); return; }
        if (await post('complete', { phoneNumber: phone.trim(), code: code.trim() })) onDone();
      }}
    >
      <input className={field} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 010 0000" disabled={sent || busy} />
      {sent && <input className={field} value={code} onChange={e => setCode(e.target.value)} placeholder="SMS code" autoFocus disabled={busy} />}
      <button type="submit" className={button} disabled={busy || (sent ? !code.trim() : !phone.trim())}>
        {busy ? 'Working…' : sent ? 'Sign in' : 'Text me a code'}
      </button>
      {sent && <button type="button" className="text-xs text-neutral-500 hover:text-neutral-300" onClick={() => { setSent(false); setCode(''); }}>Change number</button>}
    </form>
  );
}
