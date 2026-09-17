import type { EffectModule, PlayCtx, EffectHandle } from './types';
import { inEffects, outEffects, holdEffects } from './cssEffects';
import { typeWriter } from './in/typeWriter';
import { letterBlurIn } from './in/letterBlurIn';

// Phase durations (ms) — shared by preview and display so they match.
export const ANIM_IN_MS = 1000;
export const ANIM_OUT_MS = 500;
export const HOLD_LOOP_MS = 6000;   // base period for hold loops (spin/bounce)

// CSS transform-origin for the Grow/Shrink anchor (default centre).
export function growOriginCss(origin?: 'left' | 'center' | 'right'): string {
  return origin === 'left' ? 'left center' : origin === 'right' ? 'right center' : 'center center';
}

// Loop period for a hold effect. The Bounce hold scales by a per-track speed
// multiplier (higher = faster bounce); other holds use the fixed base period.
export function holdDurationMs(animId: string, speed?: number): number {
  if (animId === 'bounce' && speed && speed > 0) return HOLD_LOOP_MS / speed;
  return HOLD_LOOP_MS;
}

// Each EffectModule is a self-contained program (own CSS + play()). The registry
// just indexes them by id and injects their CSS once. Preview and Display both
// call playIn/playOut/playHold — identical by construction.

const IN = new Map<string, EffectModule>();
[...inEffects, typeWriter, letterBlurIn].forEach(e => IN.set(e.id, e));

const OUT = new Map<string, EffectModule>();
outEffects.forEach(e => OUT.set(e.id, e));

const HOLD = new Map<string, EffectModule>();
holdEffects.forEach(e => HOLD.set(e.id, e));

// Which hold loop (if any) runs while a given IN animation is held on screen.
const HOLD_FOR: Record<string, string> = {
  spinContinuous: 'spinContinuous',
  zipInSpin: 'spinContinuous',
  bounce: 'holdBounce',
};

let injected = false;
export function ensureEffectStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const css = [...IN.values(), ...OUT.values(), ...HOLD.values()]
    .flatMap(e => [e.css, e.reflectCss])
    .filter(Boolean)
    .join('\n');
  const style = document.createElement('style');
  style.id = 'l3-effect-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// Play an effect on fx, and — if a surface-reflection clone lives under it and the
// effect supplies a mirror — also drive the clone so its vertical motion is the
// floor-mirror of the main element. The clone rides fx for opacity/X; only its
// transform is overridden. Both callers (preview + display) go through here, so
// reflection animation stays in parity by construction.
function playWithReflection(eff: EffectModule, el: HTMLElement, ctx: PlayCtx): EffectHandle {
  const handle = eff.play(el, ctx);
  if (!eff.playReflect) return handle;
  const reflEl = el.querySelector<HTMLElement>('[data-l3-reflection]');
  if (!reflEl) return handle;
  const reflHandle = eff.playReflect(reflEl, ctx);
  return { cancel() { handle.cancel(); reflHandle.cancel(); } };
}

export function playIn(id: string, el: HTMLElement, ctx: PlayCtx): EffectHandle {
  ensureEffectStyles();
  return playWithReflection(IN.get(id) ?? IN.get('static')!, el, ctx);
}

export function playOut(id: string, el: HTMLElement, ctx: PlayCtx): EffectHandle {
  ensureEffectStyles();
  return playWithReflection(OUT.get(id) ?? OUT.get('fadeOut')!, el, ctx);
}

export function playHold(animId: string, el: HTMLElement, ctx: PlayCtx): EffectHandle | null {
  const holdId = HOLD_FOR[animId];
  if (!holdId) return null;
  const e = HOLD.get(holdId);
  if (!e) return null;
  ensureEffectStyles();
  return playWithReflection(e, el, ctx);
}

// Play a hold effect directly by its own id, bypassing the HOLD_FOR mapping.
// Used by overlay components where the user independently selects any hold effect.
export function playHoldById(holdId: string, el: HTMLElement, ctx: PlayCtx): EffectHandle | null {
  if (!holdId || holdId === 'none') return null;
  const e = HOLD.get(holdId);
  if (!e) return null;
  ensureEffectStyles();
  return playWithReflection(e, el, ctx);
}
