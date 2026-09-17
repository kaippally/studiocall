import type { EffectModule } from './types';
import { cssEffect } from './css';

// A no-op effect (the "static" presets): no motion, just visible. Self-contained
// like the others — play() makes the element rest at opacity 1.
function noop(id: string, label: string, kind: 'in' | 'out'): EffectModule {
  return {
    id, label, kind,
    play(el) {
      el.style.animation = '';
      el.style.opacity = '1';
      el.style.transform = 'none';
      el.style.transformOrigin = '';
      return { cancel() {} };
    },
  };
}

const BOUNCE = 'cubic-bezier(.18,.89,.32,1.1)';
const BACK = 'cubic-bezier(.34,1.56,.64,1)';
const OUT_EASE = 'cubic-bezier(.4,0,1,1)';

// Reflection rest pose = the static floor-flip (translateY 100% + distance gap, scaleY −1).
// `extra` is the per-keyframe vertical travel: the floor mirror of a main translateY(y) is
// reached by adding −2·y to the reflection (it rides fx's +y, so +y−2y = −y = mirror).
const flipY = (extra = '') => `translateY(calc(100% + var(--l3rd,0px)${extra})) scaleY(-1)`;

// ── IN effects ────────────────────────────────────────────────────────────────
export const inEffects: EffectModule[] = [
  cssEffect({ id: 'crashLandTop', label: 'Crash Land (Top)', kind: 'in', easing: 'ease-out',
    keyframes: `0%{transform:translateY(-110vh);opacity:0}20%{opacity:1}55%{transform:translateY(0)}70%{transform:translateY(-14%)}82%{transform:translateY(0)}91%{transform:translateY(-5%)}100%{transform:translateY(0);opacity:1}`,
    reflectKeyframes: `0%{transform:${flipY(' + 220vh')}}55%{transform:${flipY()}}70%{transform:${flipY(' + 28%')}}82%{transform:${flipY()}}91%{transform:${flipY(' + 10%')}}100%{transform:${flipY()}}` }),
  cssEffect({ id: 'bounceFromBottom', label: 'Bounce From Bottom', kind: 'in', easing: 'ease-out',
    keyframes: `0%{transform:translateY(110vh);opacity:0}20%{opacity:1}55%{transform:translateY(0)}70%{transform:translateY(14%)}82%{transform:translateY(0)}91%{transform:translateY(5%)}100%{transform:translateY(0);opacity:1}`,
    reflectKeyframes: `0%{transform:${flipY(' - 220vh')}}55%{transform:${flipY()}}70%{transform:${flipY(' - 28%')}}82%{transform:${flipY()}}91%{transform:${flipY(' - 10%')}}100%{transform:${flipY()}}` }),
  cssEffect({ id: 'zipInRight', label: 'Zip In (Right)', kind: 'in', easing: BACK,
    keyframes: `0%{transform:translateX(110vw);opacity:0}60%{opacity:1}80%{transform:translateX(-6%)}100%{transform:translateX(0);opacity:1}` }),
  cssEffect({ id: 'zipInLeft', label: 'Zip In (Left)', kind: 'in', easing: BACK,
    keyframes: `0%{transform:translateX(-110vw);opacity:0}60%{opacity:1}80%{transform:translateX(6%)}100%{transform:translateX(0);opacity:1}` }),
  cssEffect({ id: 'zipInSpin', label: 'Zip In + Spin', kind: 'in', easing: BACK,
    keyframes: `0%{transform:translateX(110vw) rotate(-360deg);opacity:0}60%{opacity:1}100%{transform:translateX(0) rotate(0);opacity:1}` }),
  cssEffect({ id: 'spinAndStop', label: 'Spin & Stop', kind: 'in', easing: 'cubic-bezier(.2,.7,.2,1)',
    keyframes: `0%{transform:rotate(720deg) scale(.7);opacity:0}40%{opacity:1}100%{transform:rotate(0) scale(1);opacity:1}` }),
  cssEffect({ id: 'bounce', label: 'Bounce', kind: 'in', easing: 'ease-out',
    keyframes: `0%{transform:translateY(110vh);opacity:0}30%{opacity:1}60%{transform:translateY(0)}75%{transform:translateY(-10%)}88%{transform:translateY(0)}100%{transform:translateY(0);opacity:1}`,
    reflectKeyframes: `0%{transform:${flipY(' - 220vh')}}60%{transform:${flipY()}}75%{transform:${flipY(' + 20%')}}88%{transform:${flipY()}}100%{transform:${flipY()}}` }),
  cssEffect({ id: 'fadeIn', label: 'Fade In', kind: 'in', easing: 'ease-out',
    keyframes: `0%{opacity:0}100%{opacity:1}` }),
  // Travels its own height rather than the viewport's, for an element that emerges inside a
  // list instead of flying onto the canvas — the 110vh slide-ins overshoot a chat column.
  cssEffect({ id: 'riseIn', label: 'Rise In', kind: 'in', easing: 'ease-out',
    keyframes: `0%{transform:translateY(100%);opacity:0}100%{transform:translateY(0);opacity:1}` }),
  cssEffect({ id: 'blurIn', label: 'Blur In', kind: 'in', easing: 'ease-out',
    keyframes: `0%{filter:blur(20px);opacity:0}100%{filter:blur(0px);opacity:1}` }),
  cssEffect({ id: 'dropFromTop', label: 'Drop From Top', kind: 'in', easing: BACK,
    keyframes: `0%{transform:translateY(-110vh);opacity:0}60%{opacity:1}100%{transform:translateY(0);opacity:1}`,
    reflectKeyframes: `0%{transform:${flipY(' + 220vh')}}100%{transform:${flipY()}}` }),
  cssEffect({ id: 'slideFromLeft', label: 'Slide From Left', kind: 'in', easing: BACK,
    keyframes: `0%{transform:translateX(-110vw);opacity:0}60%{opacity:1}100%{transform:translateX(0);opacity:1}` }),
  cssEffect({ id: 'scaleIn', label: 'Scale In', kind: 'in', easing: BACK,
    keyframes: `0%{transform:scale(0);opacity:0}50%{opacity:1}100%{transform:scale(1);opacity:1}` }),
  // Seal Stamp: rushes in from far on the Z axis (fading up from 0), slams to rest at
  // 48%, then a damped tremor — for a "Fake / True / Approved" seal dropped over an image.
  cssEffect({ id: 'sealStamp', label: 'Seal Stamp', kind: 'in', easing: 'cubic-bezier(.2,.7,.2,1)',
    keyframes: `0%{transform:perspective(1000px) translateZ(650px);opacity:0}20%{opacity:1}48%{transform:perspective(1000px) translateZ(0);opacity:1}56%{transform:perspective(1000px) translateZ(18px)}64%{transform:perspective(1000px) translateZ(-12px)}72%{transform:perspective(1000px) translateZ(7px)}82%{transform:perspective(1000px) translateZ(-4px)}100%{transform:none;opacity:1}` }),
  cssEffect({ id: 'grow', label: 'Grow', kind: 'in', easing: 'ease-out', transformOrigin: 'center center',
    keyframes: `0%{transform:scaleX(0);opacity:1}100%{transform:scaleX(1);opacity:1}` }),
  noop('static', 'Static', 'in'),
];

// ── HOLD effects (loop while the title is held on screen) ──────────────────────
export const holdEffects: EffectModule[] = [
  cssEffect({ id: 'spinContinuous', label: 'Spin Continuously', kind: 'hold', easing: 'linear', iteration: 'infinite',
    keyframes: `0%{transform:perspective(600px) rotateY(0deg);opacity:1}100%{transform:perspective(600px) rotateY(360deg);opacity:1}` }),
  cssEffect({ id: 'holdBounce', label: 'Bounce (hold)', kind: 'hold', easing: 'ease-in-out', iteration: 'infinite',
    keyframes: `0%{transform:translateY(0);opacity:1}50%{transform:translateY(-10%);opacity:1}100%{transform:translateY(0);opacity:1}`,
    reflectKeyframes: `0%{transform:${flipY()}}50%{transform:${flipY(' + 20%')}}100%{transform:${flipY()}}` }),
];

// ── OUT effects ────────────────────────────────────────────────────────────────
export const outEffects: EffectModule[] = [
  cssEffect({ id: 'explode', label: 'Explode', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:scale(1);opacity:1}100%{transform:scale(3.5);opacity:0}` }),
  cssEffect({ id: 'fadeOut', label: 'Fade Out', kind: 'out', easing: 'ease-in',
    keyframes: `0%{opacity:1}100%{opacity:0}` }),
  cssEffect({ id: 'vibrateMoveLeft', label: 'Vibrate & Move Left', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:translateX(0)}20%{transform:translateX(-2%) translateY(3%)}40%{transform:translateX(-12%) translateY(-3%)}100%{transform:translateX(-110vw);opacity:0}` }),
  cssEffect({ id: 'vibrateMoveRight', label: 'Vibrate & Move Right', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:translateX(0)}20%{transform:translateX(2%) translateY(3%)}40%{transform:translateX(12%) translateY(-3%)}100%{transform:translateX(110vw);opacity:0}` }),
  cssEffect({ id: 'vibrateAndMoveDown', label: 'Vibrate & Move Down', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:translateY(0)}20%{transform:translateY(3%) translateX(-2%)}40%{transform:translateY(-3%) translateX(2%)}100%{transform:translateY(110vh);opacity:0}`,
    reflectKeyframes: `0%{transform:${flipY()}}20%{transform:${flipY(' - 6%')}}40%{transform:${flipY(' + 6%')}}100%{transform:${flipY(' - 220vh')}}` }),
  // Clean counterparts to zipInRight/zipInLeft/riseIn: no vibration, for an element that
  // leaves a list rather than being thrown off the canvas. `sinkOut` travels its own height,
  // the way riseIn does, so it works inside a column instead of overshooting it.
  cssEffect({ id: 'zipOutRight', label: 'Zip Out (Right)', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:translateX(0);opacity:1}100%{transform:translateX(110vw);opacity:0}` }),
  cssEffect({ id: 'zipOutLeft', label: 'Zip Out (Left)', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:translateX(0);opacity:1}100%{transform:translateX(-110vw);opacity:0}` }),
  cssEffect({ id: 'sinkOut', label: 'Sink Out', kind: 'out', easing: OUT_EASE,
    keyframes: `0%{transform:translateY(0);opacity:1}100%{transform:translateY(100%);opacity:0}` }),
  cssEffect({ id: 'blurOut', label: 'Blur Out', kind: 'out', easing: 'ease-in',
    keyframes: `0%{filter:blur(0px);opacity:1}100%{filter:blur(20px);opacity:0}` }),
  cssEffect({ id: 'shrink', label: 'Shrink', kind: 'out', easing: 'ease-in', transformOrigin: 'center center',
    keyframes: `0%{transform:scaleX(1);opacity:1}100%{transform:scaleX(0);opacity:1}` }),
  noop('static', 'Static', 'out'),
];

void BOUNCE; // reserved easing
