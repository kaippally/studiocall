// Shared Ctrl+drag 3D-tumble gesture, normalized across L3 (titles), Slides, Clipboard,
// and the Overlay video layer. One source of truth so the feel can't drift:
//   • horizontal drag → rotateY (yaw),  vertical drag → rotateX (pitch)
//   • TUMBLE_DEG_PER_PX degrees per RAW screen pixel from the drag start (never scaled
//     by the canvas zoom), measured from the rotation snapshot taken at mousedown
// Only the clamp range and rounding step differ per medium (the renderers support
// different tilt limits) — everything else is identical.
export const TUMBLE_DEG_PER_PX = 0.5;

export function tumbleRotation(
  startRotX: number, startRotY: number,
  rawDx: number, rawDy: number,
  clampDeg: number, step = 1,
): { rotX: number; rotY: number } {
  const inv = 1 / step;
  const cl = (v: number) => Math.round(Math.max(-clampDeg, Math.min(clampDeg, v)) * inv) / inv;
  return {
    rotX: cl(startRotX + rawDy * TUMBLE_DEG_PER_PX),
    rotY: cl(startRotY + rawDx * TUMBLE_DEG_PER_PX),
  };
}
