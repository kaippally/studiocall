import type { EffectModule } from '../types';
import { getMainSpans, getReflSpans } from './chars';

// Letter Blur In: every grapheme fades up out of a blur, staggered left-to-right so
// the line resolves letter by letter. Same char-span machinery as typeWriter, but the
// reveal is a per-span CSS animation (compositor-driven) instead of a rAF loop.
// The staggered starts are spread so the LAST letter lands exactly at durationMs.

const BLUR_PX = 16;
const CHAR_SHARE = 0.4; // each letter's own blur→sharp time, as a share of the phase

export const letterBlurIn: EffectModule = {
  id: 'letterBlurIn',
  label: 'Letter Blur In',
  kind: 'in',
  // The show keyframe pins fx at opacity 1: callers hide fx with an inline opacity:0
  // until the IN phase ends, and a CSS animation outranks inline style.
  css: `@keyframes l3-lbi-show { from, to { opacity: 1; } }
@keyframes l3-lbi-char { from { opacity: 0; filter: blur(${BLUR_PX}px); } to { opacity: 1; filter: blur(0); } }`,
  play(el, ctx) {
    const chars = getMainSpans(el);
    const refl = getReflSpans(el); // mirror clone's chars, 1:1 with `chars` by index
    const total = chars.length || 1;
    const charMs = Math.max(120, ctx.durationMs * CHAR_SHARE);
    const stagger = total > 1 ? Math.max(0, (ctx.durationMs - charMs) / (total - 1)) : 0;

    for (const c of [...chars, ...refl]) c.style.animation = 'none';
    el.style.animation = 'none';
    void el.offsetWidth; // one reflow restarts fx + every char on replay
    el.style.animation = 'l3-lbi-show 0.001ms ease forwards';

    const clearChars = () => {
      for (const c of [...chars, ...refl]) { c.style.animation = ''; c.style.filter = ''; c.style.opacity = ''; }
    };

    if (ctx.reduceMotion) {
      clearChars();
      return { cancel() { el.style.animation = ''; } };
    }

    const run = (spans: HTMLElement[]) => spans.forEach((c, i) => {
      c.style.animation = `l3-lbi-char ${charMs}ms ease-out ${i * stagger}ms both`;
    });
    run(chars);
    run(refl);

    // Drop the per-char animations once the reveal has landed: a lingering
    // filter:blur(0) on every letter keeps a compositor layer per glyph, which the
    // OBS browser source pays for the whole time the title is on screen.
    const settle = setTimeout(clearChars, ctx.durationMs + 60);

    return {
      cancel() {
        clearTimeout(settle);
        clearChars();
        el.style.animation = '';
      },
    };
  },
};
