// Snapping for any box on any layout canvas, in CANVAS pixels. Shared by the StudioMeet seat
// designer and the OBS Move Designer, so both stick to the same lines the same way.
//
// THE BOX SNAPS, NOT THE ANCHOR. What an operator lines up is the rectangle they can see: its
// left, right, top, bottom and centre against the canvas' edges, its centre lines and the safe
// zone. So a drag is bent by however much brings one of THOSE onto a line, and the grid only
// speaks when no guide is in reach — an odd grid step never lands on the centre.

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type DragHandle = Handle | 'body';

export interface Box { x: number; y: number; w: number; h: number }

/** Lines a dragged box sticks to, in canvas pixels. Empty lists = guides off, grid only. */
export interface SnapRules { xs: number[]; ys: number[]; grid: number; tol: number }

/** A guide the drag reached for: the correction to apply, how far it had to reach, and which
 *  line it landed on (undefined when it was the grid). */
export interface Hit { d: number; dist: number; guide?: number }

/** The nearest guide to any of the box's own anchors; the grid when none is in reach. */
export function nearest(anchors: number[], guides: number[], grid: number, tol: number): Hit {
  let best: Hit = { d: 0, dist: Infinity };
  for (const a of anchors) {
    for (const g of guides) {
      const d = g - a, dist = Math.abs(d);
      if (dist <= tol && dist < best.dist) best = { d, dist, guide: g };
    }
  }
  const lead = anchors[0];
  if (best.dist < Infinity || grid <= 0 || lead === undefined) return best;
  const d = Math.round(lead / grid) * grid - lead;
  return { d, dist: Math.abs(d) };
}

/**
 * Which of the box's own lines are looking for a guide. The body offers both edges and its
 * centre on each axis; a corner or edge handle offers only the edge it is dragging — the opposite
 * one is standing still and must not be snapped as if it were moving.
 */
export function anchorsOf(b: Box, handle: DragHandle): { xs: number[]; ys: number[] } {
  const xs: number[] = [], ys: number[] = [];
  if (handle === 'body') {
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  } else {
    if (handle.includes('w')) xs.push(b.x);
    if (handle.includes('e')) xs.push(b.x + b.w);
    if (handle.includes('n')) ys.push(b.y);
    if (handle.includes('s')) ys.push(b.y + b.h);
  }
  return { xs, ys };
}

/** Bend a drag so an axis-aligned box lands on a line. The guides hit come back for drawing. */
export function snapBox(b: Box, handle: DragHandle, dx: number, dy: number, rules: SnapRules):
  { dx: number; dy: number; guideX?: number; guideY?: number } {
  const a = anchorsOf(b, handle);
  const hx = nearest(a.xs.map(v => v + dx), rules.xs, rules.grid, rules.tol);
  const hy = nearest(a.ys.map(v => v + dy), rules.ys, rules.grid, rules.tol);
  return { dx: dx + hx.d, dy: dy + hy.d, guideX: hx.guide, guideY: hy.guide };
}

/** The canvas' own lines — edges and centre — plus the safe zone's when one is drawn. */
export function canvasGuides(canvas: { w: number; h: number }, safe?: { x: number; y: number } | null):
  { xs: number[]; ys: number[] } {
  return {
    xs: [0, canvas.w / 2, canvas.w, ...(safe ? [safe.x, canvas.w - safe.x] : [])],
    ys: [0, canvas.h / 2, canvas.h, ...(safe ? [safe.y, canvas.h - safe.y] : [])],
  };
}

// ── The crop half of the handle contract ──────────────────────────────────────
//
// A frame is a PICTURE of some natural size, a crop rectangle over it, and the box it lands in.
// Corners scale the box; edges move the crop's edges; Shift + a body drag slides the picture
// inside the crop., "The handle contract".
//
// These are the generic forms, for a model whose picture is axis-aligned. The Move Designer keeps
// its own in `moveGeometry.ts` because an OBS item can be ROTATED and can be sized by a bounding
// box rather than a scale, and neither is expressible here — but the rules are the same rules, and
// the comments below are the place they are stated once.

/** A crop, in SOURCE pixels off each side. */
export interface Crop { left: number; top: number; right: number; bottom: number }

export const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 };

/** What is left of the picture after a crop, in source pixels. */
export const croppedSize = (crop: Crop, source: { w: number; h: number }) =>
  ({ w: source.w - crop.left - crop.right, h: source.h - crop.top - crop.bottom });

/**
 * Move one crop edge. The drag arrives in CANVAS pixels and a crop is in SOURCE pixels, so it is
 * divided by the scale the picture is drawn at — drag an edge 40 canvas px on a half-scale source
 * and 80 source pixels go.
 *
 * `uniform` (Ctrl) takes the SAME bite out of the opposite edge: drag North and North+South both
 * close in, which is how a frame is tightened around a subject without walking it off centre. The
 * pair keeps whatever offset it started with — the delta is added to both, never mirrored.
 *
 * Nothing may go below zero, and the two edges together may never eat past `min` of the picture:
 * a crop that leaves nothing is not a crop, it is a source that has vanished on air.
 */
export function cropByEdge(
  crop: Crop, handle: Handle, dx: number, dy: number,
  source: { w: number; h: number }, scale: { x: number; y: number },
  uniform = false, min = 16,
): Crop {
  const n = { ...crop };
  const maxW = Math.max(0, source.w - min), maxH = Math.max(0, source.h - min);
  const sx = Math.abs(scale.x) || 1, sy = Math.abs(scale.y) || 1;

  if (uniform) {
    const vertical = handle === 'n' || handle === 's';
    const a = vertical ? crop.top : crop.left;
    const b = vertical ? crop.bottom : crop.right;
    const raw = handle === 'n' ? dy / sy : handle === 's' ? -dy / sy : handle === 'w' ? dx / sx : -dx / sx;
    const k = Math.max(-Math.min(a, b), Math.min(raw, ((vertical ? maxH : maxW) - a - b) / 2));
    if (vertical) { n.top = Math.round(a + k); n.bottom = Math.round(b + k); }
    else { n.left = Math.round(a + k); n.right = Math.round(b + k); }
    return n;
  }

  if (handle === 'w') n.left   = Math.round(Math.max(0, Math.min(maxW - crop.right,  crop.left   + dx / sx)));
  if (handle === 'e') n.right  = Math.round(Math.max(0, Math.min(maxW - crop.left,   crop.right  - dx / sx)));
  if (handle === 'n') n.top    = Math.round(Math.max(0, Math.min(maxH - crop.bottom, crop.top    + dy / sy)));
  if (handle === 's') n.bottom = Math.round(Math.max(0, Math.min(maxH - crop.top,    crop.bottom - dy / sy)));
  return n;
}

/**
 * Slide the PICTURE behind its crop, leaving the frame exactly where it is — Shift + a body drag.
 *
 * Moving the picture right by `dx` means the crop window travels LEFT across it, so `left` gives
 * up what `right` takes on and the cropped size never changes. Because that size is what places
 * the rectangle, the box does not have to be re-anchored: it simply does not move.
 *
 * The shift is rounded ONCE and applied to both edges — rounding each on its own lets the pair
 * drift a pixel apart, and that pixel is a change in cropped size, so the frame would creep.
 * With no crop on an axis there is nowhere to go and the clamp holds it at zero.
 */
export function panInCrop(crop: Crop, dx: number, dy: number, scale: { x: number; y: number }): Crop {
  const sx = Math.abs(scale.x) || 1, sy = Math.abs(scale.y) || 1;
  const kx = Math.round(Math.max(-crop.right, Math.min(crop.left, dx / sx)));
  const ky = Math.round(Math.max(-crop.bottom, Math.min(crop.top, dy / sy)));
  return {
    left: crop.left - kx, right: crop.right + kx,
    top: crop.top - ky, bottom: crop.bottom + ky,
  };
}

/**
 * Resize an axis-aligned box by a handle, in canvas pixels, keeping the opposite edge still.
 * `lock` is an aspect (w/h) the box must keep: width leads, height follows it, anchored to
 * whichever vertical edge is not moving — or centred when neither is.
 */
export function resizeBox(b: Box, handle: Handle, dx: number, dy: number, min: number, lock?: number | null): Box {
  const n = { ...b };
  if (handle.includes('w')) { const right = b.x + b.w; n.x = Math.min(b.x + dx, right - min); n.w = right - n.x; }
  if (handle.includes('e')) n.w = Math.max(b.w + dx, min);
  if (handle.includes('n')) { const bottom = b.y + b.h; n.y = Math.min(b.y + dy, bottom - min); n.h = bottom - n.y; }
  if (handle.includes('s')) n.h = Math.max(b.h + dy, min);
  if (lock) {
    const h = n.w / lock;
    if (handle.includes('n')) n.y = b.y + b.h - h;
    else if (!handle.includes('s')) n.y = b.y + (b.h - h) / 2;
    n.h = h;
  }
  return n;
}
