import type { EffectModule } from '../types';
import { getMainSpans, getReflSpans } from './chars';

// Real typewriter: reveals one grapheme at a time across durationMs, using the
// shared per-grapheme span splitter.

function groupIntoUnits(chars: HTMLElement[], mode: 'chars' | 'words'): HTMLElement[][] {
  if (mode !== 'words') return chars.map(c => [c]);
  const units: HTMLElement[][] = [];
  let current: HTMLElement[] = [];
  for (const c of chars) {
    current.push(c);
    if (/\s/.test(c.textContent ?? '')) {
      units.push(current);
      current = [];
    }
  }
  if (current.length) units.push(current);
  return units;
}

// Call this before the box animation to pre-hide all chars so they are invisible
// while the box animates in. typeWriter.play() finds the existing [data-l3char]
// spans on its first call and reuses them, so no double-wrapping occurs.
export function prepareTypewriter(root: HTMLElement): void {
  for (const c of getMainSpans(root)) c.style.visibility = 'hidden';
  for (const c of getReflSpans(root)) c.style.visibility = 'hidden';
}

export const typeWriter: EffectModule = {
  id: 'typeWriter',
  label: 'Type Writer',
  kind: 'in',
  // CSS animation overrides React's JSX-managed style={{ opacity: 0 }} on re-renders.
  // Direct el.style.opacity = '1' would be reset whenever React reconciles the component.
  css: '@keyframes l3-tw-show { from, to { opacity: 1; } }',
  play(el, ctx) {
    const chars = getMainSpans(el);
    const refl = getReflSpans(el); // mirror clone's chars, 1:1 with `chars` by index
    const units = groupIntoUnits(chars, ctx.typeWriterMode ?? 'chars');
    for (const c of chars) c.style.visibility = 'hidden';
    for (const c of refl) c.style.visibility = 'hidden';
    el.style.animation = 'none';
    void el.offsetWidth; // force reflow so animation restarts on replay
    el.style.animation = 'l3-tw-show 0.001ms ease forwards';
    const total = units.length || 1;
    const perUnit = Math.max(12, ctx.durationMs / total);
    let i = 0;       // unit index
    let revealed = 0; // count of main chars revealed → matching reflection chars
    let raf = 0;
    let start = 0;
    let cancelled = false;

    const step = (ts: number) => {
      if (cancelled) return;
      if (!start) start = ts;
      const target = Math.min(total, Math.floor((ts - start) / perUnit) + 1);
      for (; i < target; i++) {
        const unit = units[i];
        if (unit) for (const c of unit) { c.style.visibility = 'visible'; const r = refl[revealed]; if (r) r.style.visibility = 'visible'; revealed++; }
      }
      if (i < total) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return {
      cancel() {
        cancelled = true;
        cancelAnimationFrame(raf);
        for (const c of chars) c.style.visibility = 'visible';
        for (const c of refl) c.style.visibility = 'visible';
        el.style.animation = '';
      },
    };
  },
};
