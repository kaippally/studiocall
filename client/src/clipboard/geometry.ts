import type { ActiveState, CropState, PortraitGeometry, Screen } from './types';
export type { CropState };

export type Orientation = 'landscape' | 'portrait';

export const LANDSCAPE_SCREEN: Screen = { id: '1080p-wide', name: 'Landscape', width: 1920, height: 1080 };
export const PORTRAIT_SCREEN:  Screen = { id: '1080x1920',  name: 'Portrait',  width: 1080, height: 1920 };
export const ORIENTATION_ACCENT: Record<Orientation, string> = { landscape: '#0ea5e9', portrait: '#8b5cf6' };
export function screenFor(orientation: Orientation): Screen {
  return orientation === 'portrait' ? PORTRAIT_SCREEN : LANDSCAPE_SCREEN;
}

export type ItemGeometry = {
  x: number; y: number; width: number; height: number; rotation: number;
  crop?: CropState; perspective?: number; rotateX?: number; rotateY?: number;
  // Visual look, persisted per-slot alongside geometry so an applied style sticks to State A/B
  // across A↔B toggles (the toggle handlers rebuild the active state from getGeometry).
  shadowBlur?: number; shadowX?: number; shadowY?: number; shadowColor?: string;
  borderWidth?: number; borderRadius?: number; borderColor?: string;
  // Surface reflection — persisted per-slot too, so a reflection applied while editing survives
  // closing/reopening the item (toggleItem/nav restore the whole look via getGeometry → ...geo).
  reflection?: boolean; reflectionOpacityMain?: number; reflectionOpacity?: number;
  reflectionDistance?: number; reflectionFeather?: number;
};
export type SlotIndex = 0 | 1;

import { getUiSetting, setUiSetting } from '../lib/uiSettings';

// Landscape (1920×1080) and Portrait (1080×1920) each keep their own per-item A/B geometry pair.
// The slot index store is SHARED — one A↔B toggle moves both canvases, which is what keeps a
// timeline chip (which locks its slot at placement) coherent across the two outputs.
const GEOMETRY_KEY: Record<Orientation, string> = {
  landscape: 'clipboard:item-geometry',
  portrait:  'clipboard:item-geometry-portrait',
};
const SLOT_KEY = 'clipboard:item-slot';

const DEFAULT_GEO: ItemGeometry = { x: 0, y: 0, width: 400, height: 300, rotation: 0, perspective: 0, rotateX: 0, rotateY: 0 };

// 3D-tilt transform for the inner "tilt" layer (perspective + rotateX/Y + Z-rotation), kept
// SEPARATE from the FLIP translate/scale on the outer layer. Mixing scale + perspective +
// rotation in one transform makes the browser matrix-interpolate the whole thing, which can
// momentarily flatten the tilt mid-tween; on its own layer the tilt interpolates per-function
// (a clean card-flip). perspective(0) is invalid, so 0 ("off") maps to a large no-op depth.
export function clipTransform(g: { rotation?: number; perspective?: number; rotateX?: number; rotateY?: number }): string {
  const p = g.perspective && g.perspective > 0 ? g.perspective : 1200;
  return `perspective(${p}px) rotateX(${g.rotateX ?? 0}deg) rotateY(${g.rotateY ?? 0}deg) rotate(${g.rotation ?? 0}deg)`;
}

type GeometryStore = Record<string, [ItemGeometry, ItemGeometry]>;
type SlotStore = Record<string, SlotIndex>;

function loadStore(orientation: Orientation = 'landscape'): GeometryStore {
  try { const v = getUiSetting(GEOMETRY_KEY[orientation]); return v ? JSON.parse(v) : {}; } catch { return {}; }
}

function loadSlots(): SlotStore {
  try { const v = getUiSetting(SLOT_KEY); return v ? JSON.parse(v) : {}; } catch { return {}; }
}

export function getActiveSlot(itemId: string): SlotIndex {
  return (loadSlots()[itemId] ?? 0) as SlotIndex;
}

export function setActiveSlot(itemId: string, slot: SlotIndex): void {
  const s = loadSlots();
  s[itemId] = slot;
  setUiSetting(SLOT_KEY, JSON.stringify(s));
}

export function toggleSlot(itemId: string): SlotIndex {
  const next: SlotIndex = getActiveSlot(itemId) === 0 ? 1 : 0;
  setActiveSlot(itemId, next);
  return next;
}

export function getGeometry(itemId: string, slot: SlotIndex, orientation: Orientation = 'landscape'): ItemGeometry {
  return peekGeometry(itemId, slot, orientation) ?? { ...DEFAULT_GEO };
}

// As getGeometry but distinguishes "never positioned" from a real saved layout — getGeometry's
// 0,0/400×300 default is indistinguishable from a genuine top-left placement, and capturing it into
// a style/preset would later stamp that default over a slot the operator had actually laid out.
export function peekGeometry(itemId: string, slot: SlotIndex, orientation: Orientation = 'landscape'): ItemGeometry | undefined {
  return loadStore(orientation)[itemId]?.[slot];
}

export function saveGeometry(itemId: string, slot: SlotIndex, geo: ItemGeometry, orientation: Orientation = 'landscape'): void {
  const store = loadStore(orientation);
  if (!store[itemId]) store[itemId] = [{ ...DEFAULT_GEO }, { ...DEFAULT_GEO }];
  store[itemId]![slot] = geo;
  setUiSetting(GEOMETRY_KEY[orientation], JSON.stringify(store));
}


// ── Console helper ────────────────────────────────────────────────────────
export function registerMoveAsset(onSwitch?: () => void) {
  (window as any).moveAsset = () => onSwitch?.();
}

// Returns the position/size to use when activating a newly uploaded item: dead-centre on the canvas,
// shrunk to fit if the source is larger than the canvas (so big pastes don't land off the top-left).
export function computeNewItemPlacement(
  screen: { width: number; height: number },
  item: { width?: number; height?: number },
): { x: number; y: number; width: number; height: number } {
  let w = item.width  || 400;
  let h = item.height || 300;
  if (w > screen.width || h > screen.height) {
    const s = Math.min(screen.width / w, screen.height / h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  return { x: Math.round((screen.width - w) / 2), y: Math.round((screen.height - h) / 2), width: w, height: h };
}

// Geometry to activate an item with: its saved slot, or — when that slot has never been positioned —
// centred on the canvas and shrunk to fit, same as a freshly pasted item. The placement is persisted
// so it stays put once set (an unplaced slot would otherwise land at the 0,0 / 400×300 default).
export function getOrPlaceGeometry(
  item: { id: string; width?: number; height?: number },
  slot: SlotIndex,
  screen: { width: number; height: number },
  orientation: Orientation = 'landscape',
): ItemGeometry {
  const saved = loadStore(orientation)[item.id]?.[slot];
  if (saved) return saved;
  const geo: ItemGeometry = { ...DEFAULT_GEO, ...computeNewItemPlacement(screen, item) };
  saveGeometry(item.id, slot, geo, orientation);
  return geo;
}

// ── Orientation projection ────────────────────────────────────────────────
// The Portrait canvas edits `active.portrait`, but CanvasPanel only knows the flat
// x/y/width/height/rotation/crop/3D fields. Project the portrait block through those fields so the
// panel needs no orientation logic at all, and merge an edited projection back on commit. The look
// (border/shadow/reflection) and every item-level field stay shared — only geometry is per-orientation.

// The geometry fields the two orientations keep independently.
export function pickGeometry(s: PortraitGeometry): ItemGeometry {
  return {
    x: s.x, y: s.y, width: s.width, height: s.height, rotation: s.rotation,
    crop: s.crop, perspective: s.perspective, rotateX: s.rotateX, rotateY: s.rotateY,
  };
}

export function projectPortrait(active: ActiveState): ActiveState {
  return active.portrait ? { ...active, ...active.portrait } : active;
}

// Fold an edit made on the Portrait canvas back into the real state: its geometry becomes the
// portrait block, the landscape geometry is restored from `active`, and every SHARED field the
// Settings sidebar may have changed (border, shadow, reflection, visibility…) is kept from `edited`.
export function mergePortrait(active: ActiveState, edited: ActiveState): ActiveState {
  return { ...edited, ...pickGeometry(active), portrait: pickGeometry(edited) };
}

// Shrink a box onto the image's aspect so it hugs the rendered pixels — objectFit:contain would
// otherwise letterbox inside the box and the dotted selection border would enclose empty space.
// Trims the loose dimension (never grows) and keeps the box centred. Returns null when it already
// matches. Must run ONCE per commit for both orientations: two canvases conforming independently
// race, and the loser's merge restores the other's pre-conform geometry.
export function conformToAspect(
  g: { x: number; y: number; width: number; height: number },
  aspect: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!aspect || !g.width || !g.height) return null;
  const boxAspect = g.width / g.height;
  if (Math.abs(boxAspect - aspect) < 0.01) return null;
  let nw = g.width, nh = g.height;
  if (boxAspect > aspect) nw = Math.max(1, Math.round(g.height * aspect));
  else nh = Math.max(1, Math.round(g.width / aspect));
  return { width: nw, height: nh, x: Math.round(g.x + (g.width - nw) / 2), y: Math.round(g.y + (g.height - nh) / 2) };
}

// Frame a box onto the image's visible subject. Two steps, and both are needed:
//   1. conform the box to the image aspect, so objectFit:contain fills it exactly and box fractions
//      line up with image fractions (otherwise the crop below would be applied to letterbox space);
//   2. crop away the transparent margins, which is what actually pulls the dotted selection border
//      in to the opaque pixels — the rendered image does not move, only the box shrinks.
// `bounds` is the opaque-pixel rect as fractions of the image (see imageAlpha probeImageBounds).
export function frameToContent<T extends ItemGeometry>(
  g: T,
  aspect: number,
  bounds: { x: number; y: number; w: number; h: number },
): T {
  const conformed = conformToAspect(g, aspect);
  const out = { ...g, ...(conformed ?? {}) } as T;
  // Sub-1% margins aren't worth a crop — leave the box alone rather than record a no-op crop.
  if (bounds.w >= 0.99 && bounds.h >= 0.99) return out;
  out.crop = {
    top: bounds.y,
    left: bounds.x,
    right: Math.max(0, 1 - (bounds.x + bounds.w)),
    bottom: Math.max(0, 1 - (bounds.y + bounds.h)),
  };
  return out;
}

// ── Slot sets (saved layouts) ─────────────────────────────────────────────
// A complete layout snapshot for an item: both A/B slots in both orientations plus which slot is
// live. Shared by the named Styles library and the new-item default preset — both stamp a saved
// layout onto an item, so the capture/write logic lives here once.

export interface SlotSet {
  slotA?: ItemGeometry;
  slotB?: ItemGeometry;
  portraitSlotA?: ItemGeometry;
  portraitSlotB?: ItemGeometry;
  activeSlot?: SlotIndex;
}

// The live active state is the source of truth for what's on the canvas RIGHT NOW — the geometry
// store only catches up on commit, so capturing from the store alone can miss the current
// position/look. Take the ACTIVE slot from `active` and the other slot from the store.
export function captureSlots(active: ActiveState, item: { id: string } | null): SlotSet {
  const activeSlot: SlotIndex = item ? getActiveSlot(item.id) : 0;
  const other: SlotIndex = activeSlot === 0 ? 1 : 0;
  const liveGeo: ItemGeometry = {
    ...pickGeometry(active),
    shadowBlur: active.shadowBlur, shadowX: active.shadowX, shadowY: active.shadowY, shadowColor: active.shadowColor,
    borderWidth: active.borderWidth, borderRadius: active.borderRadius, borderColor: active.borderColor,
    reflection: active.reflection, reflectionOpacityMain: active.reflectionOpacityMain, reflectionOpacity: active.reflectionOpacity,
    reflectionDistance: active.reflectionDistance, reflectionFeather: active.reflectionFeather,
  };
  // peek, not get — an unplaced other slot must stay absent rather than be captured as the
  // 0,0/400×300 default, which applying the style would then stamp over a real layout.
  const otherGeo = item ? peekGeometry(item.id, other) : undefined;
  const livePortrait = active.portrait ? pickGeometry(active.portrait) : undefined;
  const otherPortrait = item ? peekGeometry(item.id, other, 'portrait') : undefined;
  return {
    slotA: activeSlot === 0 ? liveGeo : otherGeo,
    slotB: activeSlot === 0 ? otherGeo : liveGeo,
    portraitSlotA: activeSlot === 0 ? livePortrait : otherPortrait,
    portraitSlotB: activeSlot === 0 ? otherPortrait : livePortrait,
    activeSlot,
  };
}

// Stamp a captured layout onto an item — both A/B slots in both orientations — and return the
// geometry to go live with. A set saved before the Portrait canvas existed has no portrait slots,
// so those centre-fit on 1080×1920 instead.
export function writeSlots(
  itemId: string,
  set: SlotSet,
  item: { width?: number; height?: number },
): { geo: ItemGeometry; portrait: ItemGeometry; slot: SlotIndex } {
  // Only stamp slots the set actually captured. A set saved while State B was never laid out has no
  // slotB — leaving the item's own B alone is right; overwriting it with A would destroy work.
  const a = set.slotA!;
  const b = set.slotB;
  saveGeometry(itemId, 0, a);
  if (b) saveGeometry(itemId, 1, b);
  // A set saved before the Portrait canvas existed has no portrait slots — centre-fit those.
  const pFallback: ItemGeometry = { ...DEFAULT_GEO, ...computeNewItemPlacement(PORTRAIT_SCREEN, item) };
  const pa = set.portraitSlotA ?? peekGeometry(itemId, 0, 'portrait') ?? pFallback;
  const pb = set.portraitSlotB;
  saveGeometry(itemId, 0, pa, 'portrait');
  if (pb) saveGeometry(itemId, 1, pb, 'portrait');
  const slot = (set.activeSlot ?? 0) as SlotIndex;
  setActiveSlot(itemId, slot);
  return {
    geo:      slot === 1 ? (b ?? getGeometry(itemId, 1)) : a,
    portrait: slot === 1 ? (pb ?? getGeometry(itemId, 1, 'portrait')) : pa,
    slot,
  };
}

// Geometry for BOTH canvases in one call — the landscape slot flattened onto the active state
// (as before) plus the portrait slot in `portrait`. Every select / A↔B / deep-link path uses this
// so the two stores can never drift apart.
export function resolveActiveGeometry(
  item: { id: string; width?: number; height?: number },
  slot: SlotIndex,
  landscapeScreen: { width: number; height: number } = LANDSCAPE_SCREEN,
): ItemGeometry & { portrait: ItemGeometry } {
  return {
    ...getOrPlaceGeometry(item, slot, landscapeScreen),
    portrait: getOrPlaceGeometry(item, slot, PORTRAIT_SCREEN, 'portrait'),
  };
}

