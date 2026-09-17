// Unified IN / HOLD / OUT animation library — the single source of animation
// definitions for L3 (Titles), the Clipboard board, the overlay components, and any
// future object. Imperative consumers use playIn/playOut/playHold(ById); declarative
// consumers (Clipboard) use effectStyle / getShow|HideAnimationStyle. Both resolve to
// the same effect modules in cssEffects.ts.
export * from './types';
export * from './registry';
export * from './catalog';
export { prepareTypewriter } from './in/typeWriter';
