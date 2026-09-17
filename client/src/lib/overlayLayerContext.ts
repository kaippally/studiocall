import { createContext, useContext } from 'react';

export interface LayerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayerStyle {
  color?: string | null;
  fontFamily?: string | null;
  bodyFontFamily?: string | null;
  titleSize?: number | null;
  bodySize?: number | null;
  autoFitFont?: boolean | null;
  showAnimation?: string | null;
  hideAnimation?: string | null;
  stayAnimation?: string | null;
  duration?: number | null;
  startAfter?: number | null;
  audioStart?: string | null;
  audioEnd?: string | null;
  audioVolume?: number | null;
  audioFadeInMs?: number | null;
  audioFadeOutMs?: number | null;
  repeatCycle?: boolean | null;
  opacity?: number | null;
  videoVolume?: number | null;
  borderWidth?: number | null;
  borderColor?: string | null;
  borderOpacity?: number | null;
  borderRadius?: number | null;
  effectOnPause?: boolean | null;
  animInMs?: number | null;
  animOutMs?: number | null;
  videoBlur?: number | null;
  videoSaturation?: number | null;
  videoOutputDeviceId?: string | null;
  reflection?: boolean | null;
  reflectionOpacityMain?: number | null;
  reflectionOpacity?: number | null;
  reflectionDistance?: number | null;
  reflectionFeather?: number | null;
  reflectionBlur?: number | null;
  videoBounce?: number | null;
  threedRotX?: number | null;
  threedRotY?: number | null;
  threedFov?: number | null;
  /** CHinfocard's three bands: `photoScale` and `nameScale` are the image's and the name strip's
   *  share of the layer height in %, and the profile text takes what is left. `photoRadius` is the
   *  image's corner in PIXELS; `photoBorder` is its ring, % of the image's short side. */
  photoScale?: number | null;
  nameScale?: number | null;
  photoRadius?: number | null;
  photoBorder?: number | null;
  cardMargin?: number | null;
  /** The name strip's inner gap, % of the strip's own height. */
  nameMargin?: number | null;
  cardDpSize?: number | null;
  /** The whole card's scale about its centre, 0.2–2. Not the photo's crop — that is the
   *  profile dialog's own Zoom, which lives on the card, not on the layer. */
  cardScale?: number | null;
  /** StudioCall Speakers name plate: width is % of the avatar, opacity and shadow are %.
   *  Its border is the generic borderWidth/borderColor/borderOpacity/borderRadius. */
  plateBg?: string | null;
  plateOpacity?: number | null;
  plateShadow?: number | null;
  plateWidth?: number | null;
  plateWrap?: boolean | null;
  /** StudioCall Speakers reaction: 'bounce' hops the face, 'blink' brings it up out of the
   *  dark with the voice. Sensitivity scales the level for both; image size 0 = fit to box. */
  speakerAnim?: string | null;
  speakerSensitivity?: number | null;
  speakerImageSize?: number | null;
  bounceHeight?: number | null;
  bounceEase?: string | null;
  waftMs?: number | null;
}

export interface LayerContext extends LayerRect, LayerStyle {
  id?: string;
  customType?: string | null;
  customRef?: string | null;
  orientation?: 'landscape' | 'portrait';
  /**
   * WHICH SURFACE this overlay instance is. Every one of them draws the same layer
   * set from the same broadcast, so a clip appeared on all of them at once; a video
   * command now addresses one sink and the rest ignore it. `monitor` is exempt — the
   * Live Preview is a confidence monitor and always mirrors what is on air.
   */
  sink?: 'obs' | 'popout' | 'recording' | 'monitor';
}

export const OverlayLayerContext = createContext<LayerContext | null>(null);
export function useLayerRect(): LayerRect | null {
  return useContext(OverlayLayerContext);
}
export function useLayerStyle(): LayerStyle {
  const ctx = useContext(OverlayLayerContext);
  return ctx ?? {};
}
// Which canvas the layer is being rendered into. Defaults to landscape outside a layer context
// (e.g. the standalone clipboard-display.html page).
export function useLayerOrientation(): 'landscape' | 'portrait' {
  return useContext(OverlayLayerContext)?.orientation ?? 'landscape';
}
