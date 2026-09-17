import type { ReactNode } from 'react';

// The toolbar band above a layout canvas — one look for every designer, so grid, snap, safe
// zone and undo read the same wherever the operator meets them.

export const TOOL_FIELD = 'shrink-0 rounded border border-slate-700 bg-[#0d1013] px-2 py-1 text-[12px] text-slate-200 outline-none focus:border-sky-500 disabled:opacity-40';
// `shrink-0 whitespace-nowrap`: this bar is a single row inside panels as narrow as the News
// Desk's Story column, and a flex child with neither will wrap its label and grow TALL — one
// two-line button then sets the height of the whole band and the toolbar reads as broken.
export const TOOL_BTN = 'shrink-0 whitespace-nowrap rounded border border-slate-700 px-2 py-1 text-[12px] text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-30';
/** The engaged tool in a two-way toggle — amber, per the app's selection colour. */
export const TOOL_ON = 'bg-amber-500/15 text-amber-300';
export const TOOL_OFF = 'text-slate-400 hover:bg-slate-800';

export function CanvasToolbar({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-hidden border-b border-slate-800 px-2 py-1.5">
      {children}
      {hint && <span className="min-w-0 truncate text-[10px] text-slate-600">{hint}</span>}
    </div>
  );
}

export function GridPicker({ value, steps, onChange }: { value: number; steps: readonly number[]; onChange: (v: number) => void }) {
  return (
    <select className={`${TOOL_FIELD} w-[84px]`} value={value} title="Snap grid, in canvas pixels"
      onChange={e => onChange(Number(e.target.value))}>
      {steps.map(g => <option key={g} value={g}>{g === 0 ? 'grid off' : `${g}px`}</option>)}
    </select>
  );
}

export function ToolCheck({ checked, onChange, title, accent = 'accent-sky-500', children }: {
  checked: boolean; onChange: (v: boolean) => void; title?: string; accent?: string; children: ReactNode;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-slate-400" title={title}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className={accent} />
      {children}
    </label>
  );
}

export function UndoRedo({ canUndo, canRedo, depth, onUndo, onRedo, limit }: {
  canUndo: boolean; canRedo: boolean; depth: number; onUndo: () => void; onRedo: () => void; limit: number;
}) {
  return (
    <>
      <button onClick={onUndo} disabled={!canUndo} className={TOOL_BTN} title={`Undo — Ctrl+Z (last ${limit} changes)`}>
        ↶{depth ? ` ${depth}` : ''}
      </button>
      <button onClick={onRedo} disabled={!canRedo} className={TOOL_BTN} title="Redo — Ctrl+Y">↷</button>
    </>
  );
}
