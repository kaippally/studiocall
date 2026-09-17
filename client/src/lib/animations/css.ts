import type { EffectModule } from './types';

// Factory for a self-contained CSS-keyframe effect. Each effect owns its
// @keyframes (named `l3-<id>`); play() restarts the animation and returns a
// handle that clears it. The resting (final) keyframe of an IN effect must be
// `transform:none; opacity:1` so the element settles in place with fill:forwards.
export function cssEffect(opts: {
  id: string;
  label: string;
  kind: 'in' | 'out' | 'hold';
  keyframes: string;                 // body of @keyframes (without the name)
  easing?: string;
  iteration?: number | 'infinite';
  transformOrigin?: string;          // e.g. 'left center' for a line that grows from one end
  reflectKeyframes?: string;         // override-transform keyframes for the surface-reflection clone
}): EffectModule {
  const name = `l3-${opts.id}`;
  const easing = opts.easing ?? 'cubic-bezier(.22,1,.36,1)';
  const iter = opts.iteration ?? 1;
  const fill = opts.kind === 'hold' ? 'none' : 'forwards';
  const reflectName = opts.reflectKeyframes ? `${name}-refl` : null;
  return {
    id: opts.id,
    label: opts.label,
    kind: opts.kind,
    css: `@keyframes ${name}{${opts.keyframes}}`,
    keyframeName: name,
    easing,
    iteration: iter,
    fill,
    ...(reflectName ? { reflectCss: `@keyframes ${reflectName}{${opts.reflectKeyframes}}` } : {}),
    play(el, ctx) {
      // Origin-aware effects (those that declare opts.transformOrigin, i.e. Grow/Shrink)
      // accept a per-call override via ctx.transformOrigin; everything else resets to
      // center so a previous origin-based effect can't leak in.
      el.style.transformOrigin = opts.transformOrigin != null
        ? (ctx.transformOrigin ?? opts.transformOrigin)
        : '';
      // Force a reflow so the same animation replays from the start.
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = `${name} ${ctx.durationMs}ms ${easing} ${iter} ${fill}`;
      return {
        cancel() {
          el.style.animation = '';
        },
      };
    },
    // Same timing/easing as play(), but drives the reflection clone's transform so its
    // VERTICAL motion mirrors the main element while still riding fx for X/opacity.
    ...(reflectName ? {
      playReflect(el, ctx) {
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = `${reflectName} ${ctx.durationMs}ms ${easing} ${iter} ${fill}`;
        return { cancel() { el.style.animation = ''; } };
      },
    } : {}),
  };
}
