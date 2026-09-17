import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { topZIndex } from '../lib/zIndex';
import { useDialogKeys } from '../lib/escapeStack';

/**
 * Dialog — the app's only modal shell.
 *
 * Every dialog in StudioMate answers the same two keys: Esc cancels, Enter runs the primary
 * action. That was true of about a third of them before this component existed, which meant
 * the operator could not learn the rule — some boxes closed on Esc, some trapped you until
 * you found the × with the mouse, mid-show. The shell owns the contract so a new dialog gets
 * it by construction rather than by remembering.
 *
 * It also owns the two things every modal needs: createPortal to document.body (a Mosaic
 * tile clips its overflow, so a dialog rendered in place is cut off) and topZIndex() rather
 * than a hardcoded number (a dialog opened over a dialog has to win).
 */
export type DialogLevel = 'info' | 'warn' | 'error' | 'confirm';

/** The accent is the level, not the panel — a destructive confirm looks the same everywhere. */
const ACCENT: Record<DialogLevel, { border: string; title: string; confirm: string }> = {
  info:    { border: 'border-slate-700',      title: 'text-slate-200', confirm: 'border-sky-700/60 bg-sky-950/40 text-sky-200 hover:border-sky-500' },
  confirm: { border: 'border-slate-700',      title: 'text-slate-200', confirm: 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200 hover:border-emerald-500' },
  warn:    { border: 'border-amber-900/70',   title: 'text-amber-200', confirm: 'border-amber-700/60 bg-amber-950/40 text-amber-200 hover:border-amber-500' },
  error:   { border: 'border-rose-900/70',    title: 'text-rose-200',  confirm: 'border-rose-700/60 bg-rose-950/40 text-rose-200 hover:border-rose-500' },
};

export function Dialog({
  open,
  title,
  level = 'confirm',
  onCancel,
  onConfirm,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  confirmDisabled = false,
  autoFocusConfirm = true,
  width = 440,
  fill = false,
  children,
  footer,
}: {
  open: boolean;
  title: ReactNode;
  level?: DialogLevel;
  /** Esc, the backdrop and Cancel all run this. Required — every dialog can be left. */
  onCancel: () => void;
  /** Enter and the primary button run this. Omit for a dialog that only reports. */
  onConfirm?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  /** Off when the body owns the caret — a prompt's field must not lose it to the button. */
  autoFocusConfirm?: boolean;
  width?: number;
  /** Take the whole window instead of a centred card: title pinned, body scrolls, footer pinned.
   *  For a pop-out whose only job is this one surface — there is nothing behind it to look at. */
  fill?: boolean;
  children?: ReactNode;
  /** Replaces the default button row when a dialog needs its own choices. */
  footer?: ReactNode;
}) {
  const [z, setZ] = useState(topZIndex());
  useEffect(() => { if (open) setZ(topZIndex()); }, [open]);

  useDialogKeys(open, onConfirm && !confirmDisabled ? onConfirm : null, onCancel);

  if (!open) return null;
  const accent = ACCENT[level];

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/70 ${fill ? '' : 'p-6'}`}
      style={{ zIndex: z }}
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full bg-[#0b0d11] p-5 shadow-2xl ${accent.border} ${
          fill ? 'flex h-full flex-col' : 'max-h-full overflow-auto rounded-lg border'
        }`}
        style={fill ? undefined : { maxWidth: width }}
      >
        <h2 className={`text-[15px] font-semibold ${fill ? 'shrink-0' : ''} ${accent.title}`}>{title}</h2>
        {children && (
          <div className={`mt-2 text-[13px] leading-relaxed text-slate-400 ${
            fill ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : ''
          }`}>
            {children}
          </div>
        )}

        {fill && footer ? <div className="shrink-0">{footer}</div> : footer ?? (
          <div className="mt-4 flex shrink-0 justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-200"
            >
              {cancelLabel} <span className="opacity-60">esc</span>
            </button>
            {onConfirm && (
              <button
                type="button"
                autoFocus={autoFocusConfirm}
                disabled={confirmDisabled}
                onClick={onConfirm}
                className={`rounded border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40 ${accent.confirm}`}
              >
                {confirmLabel} <span className="opacity-60">↵</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
