import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { API } from '../lib/api';
import { ws } from '../ws';
import { notify } from '../lib/notices';
import { ACTIVE_PILL } from '../lib/activeStyle';
import { useControlNumber } from '../lib/studioCallControls';
import type { RoomHere } from './StudioCallRooms';

type FlagKey = 'autoInvite' | 'autoMute' | 'floorNotice' | 'muteNotice' | 'topicNotice' | 'unmuteDrop' | 'kickAnon' | 'bridgeYtToRoom' | 'bridgeRoomToYt';

/** One boolean control, read once and followed on the controls broadcast so every window agrees. */
function useControlFlag(key: FlagKey): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    fetch(`${API}/api/studiocall/controls`).then(r => r.json()).then(d => setOn(!!d?.[key])).catch(() => {});
    return ws.onBroadcast(msg => {
      if (msg.type === 'studiocall-controls') setOn(!!(msg as Record<string, unknown>)[key]);
    });
  }, [key]);
  const toggle = useCallback(() => {
    setOn(v => {
      fetch(`${API}/api/studiocall/controls`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: !v }),
      }).catch(() => {});
      return !v;
    });
  }, [key]);
  return [on, toggle];
}

/**
 * One text control, saved when the field is left rather than per keystroke: a half-typed line must
 * never reach a room, and a broadcast landing mid-word must not overwrite what is being typed.
 */
function useControlText(key: 'inviteMessage' | 'topicMessage', label: string): [string, (v: string) => void, () => void] {
  const [text, setText] = useState('');
  const editing = useRef(false);
  const saved = useRef('');
  useEffect(() => {
    fetch(`${API}/api/studiocall/controls`).then(r => r.json()).then(d => { saved.current = String(d?.[key] ?? ''); setText(saved.current); }).catch(() => {});
    return ws.onBroadcast(msg => {
      if (msg.type === 'studiocall-controls' && !editing.current) { saved.current = String((msg as Record<string, unknown>)[key] ?? ''); setText(saved.current); }
    });
  }, [key]);
  const edit = useCallback((v: string) => { editing.current = true; setText(v); }, []);
  const save = useCallback(() => {
    editing.current = false;
    setText(v => {
      if (v.trim() === saved.current) return v;
      fetch(`${API}/api/studiocall/controls`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: v }),
      }).then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error ?? 'save failed');
        saved.current = String(d?.[key] ?? v.trim());
        notify.info(saved.current ? `${label} saved.` : `${label} cleared — nothing will be posted.`);
      }).catch(err => notify.error(`${label} was not saved — ${err.message}`));
      return v;
    });
  }, [key, label]);
  return [text, edit, save];
}

function SettingRow({ label, note, on, onToggle, disabled, disabledNote }: {
  label: string; note: string; on: boolean; onToggle: () => void; disabled?: boolean; disabledNote?: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-800 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-slate-200">{label}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{disabled ? (disabledNote ?? note) : note}</div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        title={disabled ? disabledNote : note}
        className={`mt-0.5 shrink-0 rounded transition disabled:opacity-40 ${
          on ? ACTIVE_PILL : 'bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-700 hover:text-slate-300'
        }`}
      >
        {on ? 'On' : 'Off'}
      </button>
    </div>
  );
}

function MessageField({ label, note, value, onChange, onSave, enabled, placeholder }: {
  label: string; note: string; value: string; onChange: (v: string) => void; onSave: () => void; enabled: boolean; placeholder: string;
}) {
  return (
    <label className={`block border-b border-slate-800 px-3 py-2.5 ${enabled ? '' : 'opacity-40'}`}>
      <div className="text-[12px] font-semibold text-slate-200">{label}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{note}</div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onSave}
        disabled={!enabled}
        rows={2}
        maxLength={500}
        placeholder={placeholder}
        className="mt-1.5 w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed"
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3 break-inside-avoid overflow-hidden rounded-lg border border-slate-800 bg-slate-900/40 [&>*:last-child]:border-b-0">
      <div className="border-b border-slate-800 bg-slate-900/70 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</div>
      {children}
    </section>
  );
}

const NOT_MOD = 'Clubhouse refuses this to anybody but a moderator, so it stays off in a room you do not moderate.';

/**
 * How the room is RUN: the automations. Every switch is server state, so they keep working with
 * this page closed. `hostConnected` shows the chat bridge, which only exists with a host app.
 */
export function DeskRules({ room, hostConnected }: { room: RoomHere; hostConnected: boolean }) {
  const notMod = room.live && !room.iAmModerator;
  const [autoInvite, toggleAutoInvite] = useControlFlag('autoInvite');
  const [inviteMessage, editInviteMessage, saveInviteMessage] = useControlText('inviteMessage', 'Invite message');
  const [topicNotice, toggleTopicNotice] = useControlFlag('topicNotice');
  const [topicMessage, editTopicMessage, saveTopicMessage] = useControlText('topicMessage', 'Topic message');
  const [floorNotice, toggleFloorNotice] = useControlFlag('floorNotice');
  const [autoMute, toggleAutoMute] = useControlFlag('autoMute');
  const [muteNotice, toggleMuteNotice] = useControlFlag('muteNotice');
  const [unmuteDrop, toggleUnmuteDrop] = useControlFlag('unmuteDrop');
  const [unmuteDropCount, editUnmuteDropCount, saveUnmuteDropCount] = useControlNumber('unmuteDropCount');
  const [kickAnon, toggleKickAnon] = useControlFlag('kickAnon');
  const [bridgeYtToRoom, toggleBridgeYtToRoom] = useControlFlag('bridgeYtToRoom');
  const [bridgeRoomToYt, toggleBridgeRoomToYt] = useControlFlag('bridgeRoomToYt');

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="columns-[22rem] gap-3">
        <Section title="Welcoming people">
          <SettingRow
            label="Invite everybody who walks in up to the stage"
            note="Each arrival is asked up without a click. They still have to accept, so nobody is put on air by this."
            on={autoInvite} onToggle={toggleAutoInvite} disabled={notMod} disabledNote={NOT_MOD}
          />
          <MessageField
            label="Say something when somebody is invited"
            note="Posted in the room chat with each automatic invite. {speaker} is their name, {name} their username (write @{name} for the handle). Empty means the invite is silent."
            value={inviteMessage} onChange={editInviteMessage} onSave={saveInviteMessage} enabled={autoInvite}
            placeholder="Welcome {speaker} @{name} — accept the invite to join the conversation."
          />
          <SettingRow
            label="Tell new arrivals what is being discussed"
            note="Whoever walks in after this goes on is told once, in the room chat. Nobody already in the room is messaged. Only in rooms you moderate."
            on={topicNotice} onToggle={toggleTopicNotice}
          />
          <MessageField
            label="The topic message"
            note="{title} is the room's topic (or whatever a host app says is on screen), {speaker} the arrival's name, {name} their username."
            value={topicMessage} onChange={editTopicMessage} onSave={saveTopicMessage} enabled={topicNotice}
            placeholder="We are discussing: {title}"
          />
        </Section>
        <Section title="The floor rule">
          <SettingRow
            label="Say how long the speaker has held the floor"
            note={'Once whoever has the floor passes a minute, a line goes into the room chat — "Sam @sam has been speaking from 1 minute". Once per turn, never about you. Nobody is muted by this.'}
            on={floorNotice} onToggle={toggleFloorNotice}
          />
          <SettingRow
            label="Mute anybody who speaks out of turn"
            note="Whoever took the floor keeps it. Anybody who talks over them has their microphone shut. Moderators are never muted by it."
            on={autoMute} onToggle={toggleAutoMute} disabled={notMod} disabledNote={NOT_MOD}
          />
          <SettingRow
            label="Say why, when somebody is muted"
            note={'Each automatic mute explains itself in the chat — "Sam @sam has been automatically muted, for speaking out of turn." Off, the mic still shuts; the room just is not told.'}
            on={muteNotice} onToggle={toggleMuteNotice} disabled={!autoMute}
            disabledNote="Nothing to explain while nobody is being muted — turn the rule above on first."
          />
        </Section>
        <Section title="Muting and removal">
          <SettingRow
            label="Move a speaker to the audience after too many unmutes in 30 seconds"
            note="Each time a speaker opens their mic counts once. Reaching the number below within 30 seconds takes them off the stage, with a line in the chat saying why. Moderators are never moved."
            on={unmuteDrop} onToggle={toggleUnmuteDrop} disabled={notMod} disabledNote={NOT_MOD}
          />
          <label className={`flex items-center gap-3 border-b border-slate-800 px-3 py-2.5 ${unmuteDrop ? '' : 'opacity-40'}`}>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-slate-200">Unmutes in 30 seconds before they are moved</div>
              <div className="mt-0.5 text-[11px] leading-snug text-slate-500">A mic the desk shut and they opened again counts — that is exactly who this is for.</div>
            </div>
            <input
              type="number" min={1} max={99}
              value={unmuteDropCount || ''}
              onChange={e => editUnmuteDropCount(Number(e.target.value))}
              onBlur={saveUnmuteDropCount}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              disabled={!unmuteDrop}
              className="w-14 shrink-0 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-[12px] tabular-nums text-slate-200 focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed"
            />
          </label>
          <SettingRow
            label="Remove anonymous accounts from the room"
            note={'Anybody with no profile photo, or whose name or username starts with "anon", is removed as soon as the poll finds them and cannot come back in. A real person who never set a photo goes too — which is why this is off by default.'}
            on={kickAnon} onToggle={toggleKickAnon} disabled={notMod} disabledNote={NOT_MOD}
          />
        </Section>
        {hostConnected && (
          <Section title="Bridge to YouTube chat (host app)">
            <SettingRow
              label="Post YouTube chat into the room"
              note={'Each viewer line becomes "[YT][Name] text" in the room chat — only in a room you moderate. Your own account is never relayed.'}
              on={bridgeYtToRoom} onToggle={toggleBridgeYtToRoom}
            />
            <SettingRow
              label="Post room chat into YouTube"
              note={'Each room line is queued into the YouTube live chat as "[CH][Name] text". Costs YouTube API quota per line.'}
              on={bridgeRoomToYt} onToggle={toggleBridgeRoomToYt}
            />
          </Section>
        )}
      </div>
    </div>
  );
}
