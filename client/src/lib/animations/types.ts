// A text effect is a self-contained program: it carries its own CSS and a
// play() that animates a DOM element. The same module is mounted and played by
// BOTH the editor preview and the OBS display, so they are identical by
// construction. play() targets the inner "fx" element of a TrackView; the outer
// wrapper owns position + base 3D rotation, so effect transforms never clobber
// the base rotation.

export interface PlayCtx {
  durationMs: number;        // length of this IN/OUT phase (or loop period for holds)
  text: string;              // full plain text — typewriter uses it for char count
  reduceMotion?: boolean;
  transformOrigin?: string;  // runtime origin override — honoured only by origin-aware effects (Grow/Shrink)
  typeWriterMode?: 'chars' | 'words'; // typeWriter only: reveal unit (default chars)
}

export interface EffectHandle {
  cancel(): void;            // stop + clean up (timers, animation, revealed chars)
}

export interface EffectModule {
  id: string;
  label: string;
  kind: 'in' | 'out' | 'hold';
  css?: string;              // @keyframes / styles — injected once by the registry
  // Declarative metadata for consumers that apply the effect as a React style object
  // instead of calling play() (e.g. the Clipboard board renders the animation on a
  // keyed element). cssEffect() fills these; non-CSS effects (typeWriter/noop) omit
  // keyframeName, so the declarative adapter treats them as static.
  keyframeName?: string;
  easing?: string;
  iteration?: number | 'infinite';
  fill?: string;
  play(el: HTMLElement, ctx: PlayCtx): EffectHandle;
  // Surface-reflection mirror. A reflection clone rides its parent fx (so it shares
  // opacity / X-motion), but its VERTICAL motion must be the floor-mirror of the
  // main effect. playReflect runs an override animation on the reflection element
  // that contributes the −2·translateY correction, turning fx's motion into the
  // mirror. Only effects with vertical motion provide it; others omit it and the
  // reflection just rides fx (correct for X / fade / scale).
  reflectCss?: string;
  playReflect?(el: HTMLElement, ctx: PlayCtx): EffectHandle;
}
