/** One labelled slider on a line: label, range, value — the row every settings panel wears. */
export const RANGE_ROW = 'grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-x-2';

export function RangeRow({ label, value, min, max, step, suffix, hint, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  suffix?: string; hint?: string; onChange: (v: number) => void;
}) {
  return (
    <div className={RANGE_ROW} title={hint}>
      <label className="text-[9px] text-slate-500 uppercase tracking-wider truncate">{label}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-rose-500 h-1" />
      <span className="text-[10px] text-slate-400 tabular-nums text-right">{Math.round(value * 10) / 10}{suffix ?? ''}</span>
    </div>
  );
}
