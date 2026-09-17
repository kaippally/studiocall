import type { ReactNode } from 'react';

/**
 * One person, as a face with their moves either side of it.
 *
 * **The constructive move sits to the LEFT of the face, the one that cannot be taken back sits to
 * the RIGHT, and the face is the gap between them.** They used to be neighbours in a row of 10px
 * buttons under the name — *invite to stage* and *remove from the room*, adjacent, on a tile the
 * width of a thumbnail — so the difference between promoting somebody and throwing them out of the
 * room was about eight pixels of travel, mid-show, one-handed. There is no undo for the second one:
 * Clubhouse offers no re-add, the person has to be invited back and has already seen it happen.
 *
 * The face is deliberately between them rather than the two being merely spaced: a target that has
 * to be crossed is a better guard than a gap that only has to be overshot.
 *
 * The rails **hold their space when hidden** so a tile does not resize under the pointer, and they
 * are `pointer-events-none` until revealed — an invisible ✕ that still answers a click is the
 * exact accident this layout exists to stop.
 *
 * **A rail is two chips tall and then wraps sideways.** It used to be one unbounded column, so the
 * rail — not the face — set the tile's height: four moves on a speaker made a 124px tile around a
 * 58px face, the name plate floated clear of the head it belonged to, and one row of speakers
 * filled the whole stage band. Capping the column at two puts the height back on the face and the
 * fourth move a column further out instead of another head lower.
 */

type Tone = 'go' | 'kill' | 'neutral' | 'mod';

const TONE: Record<Tone, string> = {
  go: 'border-sky-800 text-sky-300 hover:border-sky-500 hover:bg-sky-950/60',
  kill: 'border-rose-900 text-rose-400 hover:border-rose-500 hover:bg-rose-950/60',
  neutral: 'border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800',
  mod: 'border-amber-900 text-amber-300 hover:border-amber-600 hover:bg-amber-950/60',
};

export function ActionChip({ glyph, title, tone = 'neutral', disabled, onClick }: {
  glyph: ReactNode;
  title: string;
  tone?: Tone;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={e => { e.stopPropagation(); onClick(); }}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-neutral-900/80 text-[13px] leading-none transition active:scale-95 disabled:opacity-25 disabled:hover:border-inherit disabled:hover:bg-neutral-900/80 ${TONE[tone]}`}
    >
      {glyph}
    </button>
  );
}

/**
 * The rails hold their width whether or not they carry anything, so faces stay in line — the
 * width comes from the tile's `1fr auto 1fr` row, which gives both rails the same track and
 * leaves the face centred however lopsided the two sets of moves are.
 *
 * The cap is a `max-h` rather than a grid, because a column-wrapping flex takes only the height
 * it uses: one chip is one chip tall, and the empty second row of a `grid-rows-2` was not. The
 * columns pack toward the face (`content-end` on the left, `content-start` on the right) so the
 * move nearest the pointer is always the one nearest the head it acts on.
 */
function Rail({ revealed, side, children }: { revealed: boolean; side: 'left' | 'right'; children: ReactNode }) {
  return (
    <div
      className={`flex max-h-[3.9rem] flex-col flex-wrap items-center gap-1 transition-opacity ${
        side === 'left' ? 'content-end justify-self-end' : 'content-start justify-self-start'
      } ${
        revealed ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
      }`}
    >
      {children}
    </div>
  );
}

export function PersonTile({ face, left, right, name, nameTitle, selected, onName, railCols = 1 }: {
  face: ReactNode;
  /** The moves that give somebody something. Nothing here is destructive. */
  left?: ReactNode;
  /** Removal, and only removal. */
  right?: ReactNode;
  name: ReactNode;
  nameTitle: string;
  /** Selected keeps the rails up — the way to reach them without holding a hover. */
  selected: boolean;
  onName: () => void;
  /** How many chip columns the busiest rail wraps into — the tile's width, and nothing else.
   *  Two moves or fewer is one column; a speaker's four is two. */
  railCols?: 1 | 2;
}) {
  return (
    <div className={`group flex flex-col items-center gap-1.5 ${railCols === 2 ? 'w-[12.25rem]' : 'w-[8.5rem]'}`}>
      {/* `1fr auto 1fr`: the two rails take the same track whatever they carry, so the face sits
          on the tile's centre line and the name plate under it reads as the same object. */}
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-1.5">
        <Rail revealed={selected} side="left">{left}</Rail>
        {face}
        <Rail revealed={selected} side="right">{right}</Rail>
      </div>
      {/* The plate is the select target, because the face is the profile card's button. A row
          rather than one truncating line: the name gives way, the badge beside it does not —
          a floor time clipped to `1` is worse than no floor time. */}
      <button
        type="button"
        onClick={onName}
        title={nameTitle}
        className={`flex w-full min-w-0 items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ${
          selected
            ? 'border-sky-700 bg-sky-950/40 text-sky-200'
            : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
        }`}
      >
        {name}
      </button>
    </div>
  );
}
