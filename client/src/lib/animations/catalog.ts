import type { CSSProperties } from 'react';
import type { EffectModule } from './types';
import { inEffects, holdEffects, outEffects } from './cssEffects';
import { typeWriter } from './in/typeWriter';
import { letterBlurIn } from './in/letterBlurIn';
import { ensureEffectStyles } from './registry';

// Single index of every effect module by id (IN ∪ HOLD ∪ OUT + char effects). This is
// the one source the imperative path (registry.play*) and the declarative path
// (effectStyle, below) both draw from, so L3, the Clipboard board, and any future
// object animate from the same definitions.
const BY_ID = new Map<string, EffectModule>();
for (const e of [...inEffects, ...holdEffects, ...outEffects, typeWriter, letterBlurIn]) BY_ID.set(e.id, e);

export function effectById(id: string): EffectModule | undefined { return BY_ID.get(id); }

// Build the React style object that reproduces what play() does, for consumers that
// render the animation on a keyed element instead of calling play() imperatively.
// Static / non-CSS effects (no keyframeName) and non-positive durations render with
// no animation so the element rests in place.
export function effectStyle(id: string | undefined, durationMs?: number): CSSProperties {
  const e = id ? BY_ID.get(id) : undefined;
  if (!e || !e.keyframeName) return {};
  const dur = durationMs ?? 0;
  if (dur <= 0) return {};
  ensureEffectStyles();
  return { animation: `${e.keyframeName} ${dur}ms ${e.easing ?? 'ease'} ${e.iteration ?? 1} ${e.fill ?? 'forwards'}` };
}

// ── Clipboard board adapter ─────────────────────────────────────────────────────
// Replaces the former utils/clipAnimations.ts. The board surfaces a curated subset of
// the unified effects and applies them declaratively; durations default to a short
// board-appropriate value. Future object types can curate their own subset the same way.
export type ShowAnimationType = string;
export type HideAnimationType = string;

const CLIP_DEFAULT_MS = 200;
const clipPreset = (id: string, label?: string) => ({ id, label: label ?? BY_ID.get(id)?.label ?? id });

export const SHOW_ANIMATION_PRESETS: { id: string; label: string }[] = [
  clipPreset('static', 'Static (instant)'),
  clipPreset('fadeIn'),
  clipPreset('crashLandTop'),
  clipPreset('bounceFromBottom'),
  clipPreset('zipInRight'),
  clipPreset('zipInSpin'),
];

export const HIDE_ANIMATION_PRESETS: { id: string; label: string }[] = [
  clipPreset('static', 'Static (instant)'),
  clipPreset('fadeOut'),
  clipPreset('explode'),
  clipPreset('vibrateMoveLeft'),
  clipPreset('vibrateMoveRight'),
];

const durRecord = (presets: { id: string }[]): Record<string, number> =>
  Object.fromEntries(presets.map(p => [p.id, p.id === 'static' ? 0 : CLIP_DEFAULT_MS]));
export const SHOW_ANIM_DURATION_MS: Record<string, number> = durRecord(SHOW_ANIMATION_PRESETS);
export const HIDE_ANIM_DURATION_MS: Record<string, number> = durRecord(HIDE_ANIMATION_PRESETS);

export function getShowAnimationStyle(id: ShowAnimationType, durationMs?: number): CSSProperties {
  return effectStyle(id, durationMs ?? SHOW_ANIM_DURATION_MS[id] ?? 0);
}
export function getHideAnimationStyle(id: HideAnimationType, durationMs?: number): CSSProperties {
  return effectStyle(id, durationMs ?? HIDE_ANIM_DURATION_MS[id] ?? 0);
}

// The board injects keyframes on mount; the unified injector covers every effect's CSS.
export const ensureKeyframes = ensureEffectStyles;
