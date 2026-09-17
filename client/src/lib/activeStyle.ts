// ONE active look, for every panel in the app. "Active" means the thing is on air / on / running
// right now: the live OBS scene, the live RCV source, the BLE scene the pads are holding, the PTZ
// position the camera was last sent to, the Scene collection that fired, a Source Move mid-travel.
//
// Panels keep their own accents for everything else (sky for OBS, rose for RCV, fuchsia for the
// camera, and the per-name tile hues) — but the moment something is live it drops that accent and
// takes the emerald skin below, so "what is on right now" is one colour the operator learns once
// and can find on any screen. Sky is spoken for: it means PREVIEW / staged, never active.
import type { CSSProperties } from 'react';

/** Hue tiles carry an inline skin, which beats any class — so their active state is inline too. */
export const ACTIVE_TILE_STYLE: CSSProperties = {
  background: 'linear-gradient(140deg, hsl(152 62% 30%), hsl(152 56% 16%))',
  borderColor: 'hsl(152 72% 55%)',
  color: 'hsl(152 85% 92%)',
};

/** Row-shaped controls (tables, lists, the Move cards). Composes with the row's own layout classes.
 *  Split, because a table draws its border on the cells and its tint on the row — applying both to
 *  both double-tints the row. */
export const ACTIVE_BORDER = 'border-emerald-500/70';
export const ACTIVE_TINT = 'bg-emerald-500/10';
export const ACTIVE_ROW = `${ACTIVE_BORDER} ${ACTIVE_TINT}`;

/** The slim marker bar at the head of an active row. */
export const ACTIVE_BAR = 'bg-emerald-500';

/** The badge that names the state — "Live", "On", "Running". Same skin, panel picks the word. */
export const ACTIVE_PILL = 'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300';

// ── Tally ─────────────────────────────────────────────────────────────────────
//
// The one exception to "active is emerald", and it is the broadcast convention rather than a new
// idea: a tally light is RED when the audience is receiving the picture, AMBER when the source is
// armed and would be on air the moment the show starts, and dark when it is not in the shot at
// all. Emerald says "this is the one that is on" inside the app; red says "this is leaving the
// building". A control that can be armed while nobody is watching needs both words.
//
// It is here, beside the active skin, for the same reason that skin is: one vocabulary, learned
// once, so a future panel reuses it instead of inventing a fourth colour for on air. Whether the
// show is live comes from `useLiveState()` and nowhere else.

/** `off` — not in the programme · `armed` — in it, nobody watching · `air` — going out live. */
export type Tally = 'off' | 'armed' | 'air';

/** What the three states mean, for a button's `title`. */
export const TALLY_WORD: Record<Tally, string> = { off: 'Off', armed: 'Armed', air: 'On air' };

/** A bordered control (button, chip). Composes with the control's own layout classes. */
export const TALLY_BTN: Record<Tally, string> = {
  off: 'bg-[#0d1117] text-slate-500 border-slate-700 hover:text-slate-300 hover:border-slate-500',
  armed: 'bg-amber-600/25 text-amber-100 border-amber-500',
  air: 'bg-red-600/35 text-red-100 border-red-500',
};

/** The dot or bar that marks a tallied row where a whole button would be too loud. */
export const TALLY_DOT: Record<Tally, string> = {
  off: 'bg-slate-700', armed: 'bg-amber-400', air: 'bg-red-500',
};

/** The one place the two facts are combined, so no panel can decide it differently. */
export const tallyOf = (armed: boolean, live: boolean): Tally =>
  !armed ? 'off' : live ? 'air' : 'armed';
