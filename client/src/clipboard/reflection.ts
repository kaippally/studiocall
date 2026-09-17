// Surface Reflection — a floor-mirror reflection for clipboard objects.
//
// Engine: a COPLANAR flipped copy of the image, rendered as a child of the object's 3D-tilt layer,
// directly below the image. Because it lives inside the same perspective/tilt context, the
// reflection shares the object's perspective foreshortening and skew, and — translated down by
// exactly the object's height — its top edge meets the object's BOTTOM edge precisely. It is a real
// mirror of the tilted plane, not a flat 2D flip (which loses the perspective and looks detached).
//
// The flip is `translateY(height) scaleY(-1)` applied in the tilt layer's LOCAL space (so it stays
// on the same plane, just mirrored across the bottom edge). `distance` adds a small in-plane gap.
//
// Falloff: a mask-image gradient feathers the reflection. CSS masks apply in the element's LOCAL
// space *before* its transform, so `to bottom, transparent → opaque` puts full opacity at the edge
// touching the object (post-flip top, = local bottom) fading to transparent at the far end. The fade
// spans the near `feather`% of the reflection. reflectionOpacity dims the reflection;
// reflectionOpacityMain dims the object itself (the reflection, nested under it, inherits it too — a
// dimmer object has a dimmer reflection).
import type { CSSProperties } from 'react';

export interface ReflectionParams {
  reflection?: boolean;
  reflectionMirrorY?: number;
  reflectionOpacityMain?: number;
  reflectionOpacity?: number;
  reflectionDistance?: number;
  reflectionSkew?: number;
  reflectionFeather?: number;
}

const clampPct = (v: number | undefined, dflt: number) => Math.max(0, Math.min(100, v ?? dflt));

// Opacity to apply to the OBJECT itself when reflection is on (so the reflection, nested under it,
// inherits it). Returns {} when reflection is off so nothing changes.
export function reflectionObjectStyle(p: ReflectionParams): { opacity?: number } {
  if (!p.reflection) return {};
  return { opacity: clampPct(p.reflectionOpacityMain, 100) / 100 };
}

// Shared mask/opacity/position for the coplanar reflection element (everything but the flip
// transform, which differs between the px-height and percentage-height variants).
function reflectionBaseStyle(p: ReflectionParams): CSSProperties {
  const feather = clampPct(p.reflectionFeather, 67);
  const grad = `linear-gradient(to bottom, transparent ${100 - feather}%, #000)`;
  return {
    position: 'absolute',
    inset: 0,
    transformOrigin: 'center center',
    opacity: clampPct(p.reflectionOpacity, 50) / 100,
    WebkitMaskImage: grad,
    maskImage: grad,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskSize: '100% 100%',
    maskSize: '100% 100%',
    pointerEvents: 'none',
  };
}

// Style for the coplanar reflection element — a sibling of the image inside the 3D-tilt layer.
// `heightPx` is the tilt layer's height in rendered px (canvas px × zoom in the editor preview, raw
// px in the OBS display); `distancePx` is the in-plane gap below the image. Returns null when
// reflection is off (caller skips rendering it).
export function reflectionInPlaneStyle(
  p: ReflectionParams,
  heightPx: number,
  distancePx = 0,
): CSSProperties | null {
  if (!p.reflection) return null;
  return { ...reflectionBaseStyle(p), transform: `translateY(${heightPx + distancePx}px) scaleY(-1)` };
}

// Live single-element mirror via CSS `-webkit-box-reflect` — used for the browser preview of the
// flat video overlay (a real <video> can't be cheaply cloned coplanar like the Slides image is).
// reflectionOpacity is the near-edge alpha; the fade spans the near `feather` fraction; distance is
// the gap. reflectionOpacityMain (object dim) is applied separately on the element's own opacity.
export function reflectionBoxStyle(p: ReflectionParams): CSSProperties {
  if (!p.reflection) return {};
  const reflectA = clampPct(p.reflectionOpacity, 50) / 100;
  const solid = 100 - clampPct(p.reflectionFeather, 67);
  const gap = Math.max(0, p.reflectionDistance ?? 0);
  const mask = `linear-gradient(to bottom, rgba(0,0,0,${reflectA}) ${solid}%, transparent)`;
  return { WebkitBoxReflect: `below ${gap}px ${mask}` };
}

// As above but the reflection element is `inset:0` over the object box, so `translateY(100%)`
// mirrors it across the bottom edge without needing the box height in px. Used by L3, whose
// auto-fit text/gradient tracks have no fixed pixel height. `distancePx` adds an in-plane gap.
export function reflectionInPlaneStylePct(
  p: ReflectionParams,
  distancePx = 0,
): CSSProperties | null {
  if (!p.reflection) return null;
  const down = distancePx ? `calc(100% + ${distancePx}px)` : '100%';
  return { ...reflectionBaseStyle(p), transform: `translateY(${down}) scaleY(-1)` };
}
