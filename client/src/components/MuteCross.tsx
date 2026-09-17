/**
 * A red cross over a face whose mic the desk shuts whenever it opens — gagged, auto-muted, or
 * held muted this room. The person can press unmute all they like; the pump closes it on the
 * next tick, so to the operator this face is silent no matter what the roster's mute flag says.
 * Drawn over the photo rather than as a corner dot because it has to read at a glance across a
 * stage of nine: a corner mark competes with the moderator dot and the uplink dot.
 */
export function MuteCross({ why }: { why: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0.5 h-[3.6rem] w-[3.6rem] rounded-full"
    >
      <title>{why}</title>
      <circle cx="50" cy="50" r="49" fill="rgba(0,0,0,0.35)" />
      <path d="M22 22 L78 78 M78 22 L22 78" stroke="#ef4444" strokeWidth="11" strokeLinecap="round" />
    </svg>
  );
}
