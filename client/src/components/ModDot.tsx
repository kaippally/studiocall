/**
 * The green dot on a moderator's DP — the same mark wherever a face is drawn (roster tile, room
 * chat line, the Chat tab's merged list), so a moderator is told apart at a glance and not only by
 * the ★ before a name that may be truncated. Sits on the face's bottom-right, on a dark ring so it
 * reads against any photo. Green here is a role badge, not the app's "live" skin.
 */
export function ModDot({ size = 'md', corner = 'br' }: {
  size?: 'sm' | 'md';
  /** The roster keeps the bottom-right for the operator's own uplink dot, so its faces use `bl`. */
  corner?: 'br' | 'bl';
}) {
  return (
    <span
      title="Moderator"
      className={`pointer-events-none absolute rounded-full border-2 border-neutral-950 bg-green-500 ${
        size === 'sm' ? '-bottom-0.5 h-2.5 w-2.5' : 'bottom-0.5 h-3.5 w-3.5'
      } ${corner === 'bl' ? (size === 'sm' ? '-left-0.5' : 'left-0.5') : (size === 'sm' ? '-right-0.5' : 'right-0.5')}`}
    />
  );
}
