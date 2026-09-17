import type { Handle } from './snap';

export const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se'];
export const EDGES: Handle[] = ['n', 's', 'e', 'w'];

/** Centred on the box's corners and edge midpoints, so a handle straddles the outline. */
const HANDLE_POS: Record<Handle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
  n:  'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  s:  'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
  w:  'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  e:  'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

/** Sky square — the handle that sizes. */
export const SIZE_HANDLE = 'h-3 w-3 rounded-sm border border-slate-900 bg-sky-400';
/** Amber circle — the handle that crops (Move Designer edges). */
export const CROP_HANDLE = 'h-3 w-3 rounded-full border border-slate-900 bg-amber-400';

export const EDGE_NAME: Record<Handle, string> = {
  n: 'top', s: 'bottom', e: 'right', w: 'left', ne: 'top-right', nw: 'top-left', se: 'bottom-right', sw: 'bottom-left',
};

/** What a corner and an edge say they do, unless the caller says otherwise. */
export const CORNER_TITLE = (h: Handle) => `Scale from the ${EDGE_NAME[h]} corner — Ctrl for uniform`;
export const EDGE_TITLE = (h: Handle) => `Crop the ${EDGE_NAME[h]} edge — Ctrl crops the opposite edge to match`;

/**
 * The eight handles on a selected box. Put inside the box's own positioned element.
 *
 * **THE CONTRACT IS THE SAME ON EVERY CANVAS IN THIS APP** — corners SCALE, edges CROP, Ctrl makes
 * either uniform, and Shift on a body drag pans the picture inside its crop. It is stated once in
 * the app-wide canvas contract and it is not a per-panel choice: an edge that crops
 * on one canvas and resizes on another is the single thing this component exists to prevent. The
 * defaults below therefore carry it — sky squares that scale, amber circles that crop, and titles
 * that say so — and a caller has to go out of its way to disagree.
 *
 * **A model with no crop passes `edges={false}` and draws corners only.** It does NOT keep the
 * edge handles and quietly resize with them: the operator has learnt that an edge crops, and a
 * surface where it silently does something else is worse than one where it is simply absent.
 */
export function BoxHandles({
  onBegin, cornerClass = SIZE_HANDLE, edgeClass = CROP_HANDLE,
  cornerTitle = CORNER_TITLE, edgeTitle = EDGE_TITLE, edges = true,
}: {
  onBegin: (e: React.MouseEvent, handle: Handle) => void;
  cornerClass?: string;
  edgeClass?: string;
  cornerTitle?: (h: Handle) => string;
  edgeTitle?: (h: Handle) => string;
  edges?: boolean;
}) {
  return (
    <>
      {CORNERS.map(h => (
        <div key={h} onMouseDown={e => onBegin(e, h)} title={cornerTitle?.(h)}
          className={`absolute ${cornerClass} ${HANDLE_POS[h]}`} />
      ))}
      {edges && EDGES.map(h => (
        <div key={h} onMouseDown={e => onBegin(e, h)} title={edgeTitle?.(h)}
          className={`absolute ${edgeClass} ${HANDLE_POS[h]}`} />
      ))}
    </>
  );
}
