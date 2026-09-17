// Canonical z-index values for the app.
export const Z = {
  MOSAIC:  100,
  OVERLAY: 500,
  MODAL:   1000,
  DIALOG:  2000,
  TOP:     9999,
} as const;

// Returns the highest z-index currently in the DOM, then adds the given offset.
// Use for any floating element (dropdown, popover, modal, toast) that must
// appear above whatever is already rendered.
export function topZIndex(offset = 1): number {
  let max = 0;
  for (const el of document.querySelectorAll('*')) {
    const z = parseInt(getComputedStyle(el).zIndex, 10);
    if (!isNaN(z) && z > max) max = z;
  }
  return max + offset;
}
