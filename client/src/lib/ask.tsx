/**
 * ask.tsx — the replacement for window.confirm() and window.prompt().
 *
 * The native pair had to go for three reasons, all of them show-time reasons: they block the
 * event loop (a confirm() sitting open freezes the SSE reader and the WS heartbeat behind
 * it), they are drawn by Chrome so they cannot be captured by OBS and cannot be styled, and
 * they answer to Enter/Esc with browser semantics that the rest of the app cannot see — the
 * escape stack has no idea one is open.
 *
 * These return a promise instead, render through the ordinary Dialog shell, and therefore
 * obey the same Esc-cancels / Enter-accepts contract as everything else. A caller becomes
 * async, which is the whole cost:
 *
 *   if (!(await askConfirm({ title: 'Delete this clip?' }))) return;
 *
 * For a message that needs no answer, use notify() — an alert() that only reports is a
 * notice, not a dialog.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Dialog, type DialogLevel } from '../components/Dialog';

interface ConfirmRequest {
  kind: 'confirm';
  id: number;
  title: string;
  body?: string;
  level: DialogLevel;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (ok: boolean) => void;
}

interface PromptRequest {
  kind: 'prompt';
  id: number;
  title: string;
  body?: string;
  level: DialogLevel;
  confirmLabel: string;
  cancelLabel: string;
  initial: string;
  placeholder?: string;
  suggestions?: string[];
  /** Blocks the primary action while it returns false — no dialog that accepts junk. */
  validate?: (value: string) => boolean;
  resolve: (value: string | null) => void;
}

type Request = ConfirmRequest | PromptRequest;

let seq = 0;
let queue: Request[] = [];
const listeners = new Set<() => void>();

function emit() { for (const fn of listeners) fn(); }
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function snapshot() { return queue; }

function enqueue(req: Request) {
  queue = [...queue, req];
  emit();
}

function settle(id: number) {
  queue = queue.filter(r => r.id !== id);
  emit();
}

/**
 * A message written for window.confirm() is one string with its detail after a blank line.
 * Splitting it here means a call site can stay a single sentence and still land as a heading
 * over its explanation, which is the shape the Dialog wants.
 */
function split(message: string): { title: string; body?: string } {
  const i = message.indexOf('\n\n');
  if (i < 0) return { title: message };
  return { title: message.slice(0, i).trim(), body: message.slice(i + 2).trim() };
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  level?: DialogLevel;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Yes/no. Resolves false on Esc, the backdrop and Cancel. */
export function askConfirm(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === 'string' ? split(opts) : opts;
  return new Promise(resolve => enqueue({
    kind: 'confirm',
    id: ++seq,
    title: o.title,
    body: o.body,
    level: (o as ConfirmOptions).level ?? 'confirm',
    confirmLabel: (o as ConfirmOptions).confirmLabel ?? 'OK',
    cancelLabel: (o as ConfirmOptions).cancelLabel ?? 'Cancel',
    resolve,
  }));
}

export interface PromptOptions {
  title: string;
  body?: string;
  initial?: string;
  placeholder?: string;
  level?: DialogLevel;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * One-click fills for the field, drawn under it. For a box that is usually answered with
   * something said before — a stock reply, the last few answers — so the common case is a
   * click and the field stays there for the case that is not.
   */
  suggestions?: string[];
  /** Blocks the primary action while it returns false — no dialog that accepts junk. */
  validate?: (value: string) => boolean;
}

/**
 * One line of text. Resolves null when cancelled — never an empty string for a cancel, so
 * `if (name === null) return;` and `if (!name) return;` both read correctly.
 * The string form mirrors window.prompt(message, initial) so a call site can be lifted as-is.
 */
export function askPrompt(opts: PromptOptions | string, initial?: string): Promise<string | null> {
  const o: PromptOptions = typeof opts === 'string' ? { ...split(opts), initial } : opts;
  return new Promise(resolve => enqueue({
    kind: 'prompt',
    id: ++seq,
    title: o.title,
    body: o.body,
    level: o.level ?? 'confirm',
    confirmLabel: o.confirmLabel ?? 'OK',
    cancelLabel: o.cancelLabel ?? 'Cancel',
    initial: o.initial ?? '',
    placeholder: o.placeholder,
    suggestions: o.suggestions,
    validate: o.validate,
    resolve,
  }));
}

/**
 * Mounted once by App. Renders the whole queue stacked, so a second question raised while
 * the first is open lands on top of it and is answered first — topZIndex() and the escape
 * stack both already work that way.
 */
export function AskHost() {
  const requests = useSyncExternalStore(subscribe, snapshot);
  return <>{requests.map(req => <AskDialog key={req.id} request={req} />)}</>;
}

function AskDialog({ request }: { request: Request }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.initial : '');
  useEffect(() => { if (request.kind === 'prompt') setValue(request.initial); }, [request]);

  const close = (answer: boolean) => {
    settle(request.id);
    if (request.kind === 'prompt') request.resolve(answer ? value : null);
    else request.resolve(answer);
  };

  const invalid = request.kind === 'prompt' && !!request.validate && !request.validate(value);

  return (
    <Dialog
      open
      title={request.title}
      level={request.level}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      confirmDisabled={invalid}
      autoFocusConfirm={request.kind !== 'prompt'}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    >
      {request.body}
      {request.kind === 'prompt' && (
        <input
          autoFocus
          value={value}
          placeholder={request.placeholder}
          onChange={e => setValue(e.target.value)}
          className="mt-3 w-full rounded border border-slate-700 bg-[#0d1117] px-2 py-1.5 text-[13px] text-slate-200 outline-none focus:border-slate-500"
        />
      )}
      {request.kind === 'prompt' && !!request.suggestions?.length && (
        <div className="mt-2 flex flex-col gap-1">
          {request.suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              title={s}
              onClick={() => setValue(s)}
              className={`truncate rounded border px-2 py-1 text-left text-[11px] transition ${
                s === value
                  ? 'border-amber-600/60 bg-amber-950/30 text-amber-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
