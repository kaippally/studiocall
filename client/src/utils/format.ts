// Shared time/byte formatters — consolidated from BullTrackTab.tsx (msToTimecode/p,
// msToTime, fmtBytes, fmtClock).

export function pad2(n: number): string { return String(n).padStart(2, '0'); }

// MM:SS:FF (or H:MM:SS:FF) — frames at ~30fps. Timeline ruler / timecode display.
export function msToTimecode(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const f = Math.floor((ms % 1000) / 33);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}:${pad2(f)}`;
  return `${pad2(m)}:${pad2(sec)}:${pad2(f)}`;
}

// MM:SS (or H:MM:SS) — segment/marker labels.
export function msToTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${pad2(m % 60)}:${pad2(s % 60)}`;
  return `${pad2(m)}:${pad2(s % 60)}`;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export const fmtClock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
