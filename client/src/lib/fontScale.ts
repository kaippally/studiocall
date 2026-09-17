import { getUiSetting, setUiSetting, onUiSettingsLoaded } from './uiSettings';

export const FONT_SCALE_KEY = 'ui:fontScale';
// 100% is the floor: the app is already dense at 1, and everything below it was
// unreadable on the studio monitor. The ceiling is 4x — the size the screen has to
// reach to be read from across the room.
export const FONT_SCALE_MIN = 1;
export const FONT_SCALE_MAX = 4;
export const FONT_SCALE_DEFAULT = 1;

// Tailwind emits literal font sizes, so a root font-size change would miss the ~1800
// text-[Npx] utilities this app uses. Instead every text utility is re-declared as
// calc(size * var(--ui-font-scale)) and only the variable changes at runtime.
const NAMED: [name: string, sizeRem: number, lineRem: number][] = [
  ['xs', 0.75, 1], ['sm', 0.875, 1.25], ['base', 1, 1.5], ['lg', 1.125, 1.75],
  ['xl', 1.25, 1.75], ['2xl', 1.5, 2], ['3xl', 1.875, 2.25], ['4xl', 2.25, 2.5],
];
const REM_SIZES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.25, 1.5];

function buildCss(): string {
  const scaled = (v: string) => `calc(${v} * var(--ui-font-scale, 1)) !important`;
  const rules: string[] = [];
  for (const [name, size, line] of NAMED) {
    rules.push(`.text-${name}{font-size:${scaled(size + 'rem')};line-height:${scaled(line + 'rem')}}`);
  }
  for (let px = 6; px <= 48; px++) {
    rules.push(`.text-\\[${px}px\\]{font-size:${scaled(px + 'px')}}`);
  }
  for (const rem of REM_SIZES) {
    rules.push(`.text-\\[${String(rem).replace('.', '\\.')}rem\\]{font-size:${scaled(rem + 'rem')}}`);
  }
  return rules.join('\n');
}

/**
 * Every document being kept at the app's size — this one, plus a window for each detached mosaic
 * panel. A panel popped out of the mosaic has its DOM in another document, and both halves of the
 * mechanism are per-document: the generated stylesheet lives in that document's head, and the
 * variable it multiplies lives on that document's root. Without both, the pop-out ignores the
 * setting entirely, because Tailwind's own literal `text-[12px]` is what stays in force.
 */
const scaled = new Set<Document>();
let current = FONT_SCALE_DEFAULT;

function ensureStyle(doc: Document) {
  if (doc.querySelector('style[data-ui-font-scale]')) return;
  const el = doc.createElement('style');
  el.dataset.uiFontScale = '';
  el.textContent = buildCss();
  doc.head.appendChild(el);
}

export function applyFontScale(scale: number) {
  current = scale;
  scaled.add(document);
  for (const doc of scaled) {
    try {
      ensureStyle(doc);
      doc.documentElement.style.setProperty('--ui-font-scale', String(scale));
    } catch {
      scaled.delete(doc);   // its window closed between the poll and here
    }
  }
}

/**
 * Put a second document under the app's font size and keep it there — a detached panel window
 * follows the Settings slider live, the same as the tile it came out of. Returns the release.
 */
export function adoptFontScale(doc: Document): () => void {
  scaled.add(doc);
  ensureStyle(doc);
  doc.documentElement.style.setProperty('--ui-font-scale', String(current));
  return () => { scaled.delete(doc); };
}

export function getFontScale(): number {
  const raw = Number(getUiSetting(FONT_SCALE_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, raw));
}

export function setFontScale(scale: number) {
  applyFontScale(scale);
  setUiSetting(FONT_SCALE_KEY, String(scale));
}

export function initFontScale() {
  applyFontScale(FONT_SCALE_DEFAULT);
  onUiSettingsLoaded(() => applyFontScale(getFontScale()));
}
