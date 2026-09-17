
export type ClipboardItem = { id: string; [k: string]: unknown };

export interface CropState {
  top: number;    // 0–1 fraction of height to remove from top
  right: number;  // 0–1 fraction of width to remove from right
  bottom: number; // 0–1 fraction of height to remove from bottom
  left: number;   // 0–1 fraction of width to remove from left
}

export const DEFAULT_CROP: CropState = { top: 0, right: 0, bottom: 0, left: 0 };

export interface ImageStyle {
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  shadowColor: string;
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
}

export const DEFAULT_IMAGE_STYLE: ImageStyle = {
  shadowBlur: 0, shadowX: 0, shadowY: 4,
  shadowColor: '#000000',
  borderRadius: 0, borderWidth: 0, borderColor: '#ffffff',
};

// Geometry the Portrait (1080×1920) canvas keeps independently of Landscape. Everything not listed
// here — look, animations, audio, BLE scenes, visibility, A/B slot — is shared between the two.
export interface PortraitGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  crop?: CropState;
  perspective?: number;
  rotateX?: number;
  rotateY?: number;
}

export interface ActiveState {
  itemId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  crop?: CropState;
  // Vertical-output layout for the same item, rendered by vertical-display.html.
  portrait?: PortraitGeometry;
  // Per-slot 3D transform (tweens with geometry on A↔B).
  perspective?: number;
  rotateX?: number;
  rotateY?: number;
  // A↔B transition control. `transitioning` is an ephemeral, per-toggle flag (not stored)
  // that tells the display to tween rather than snap; duration/easing are per-item.
  transitioning?: boolean;
  transitionDuration?: number;
  transitionEasing?: string;
  showAnimation?: string;
  hideAnimation?: string;
  showDuration?: number;
  hideDuration?: number;
  shadowBlur?: number;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  // Surface Reflection (floor mirror). reflectionMirrorY is the virtual horizon in canvas px,
  // anchored to State A's bottom; it stays fixed across A↔B so the object lifts off the surface.
  reflection?: boolean;
  reflectionMirrorY?: number;
  reflectionOpacityMain?: number;   // object opacity %, default 100
  reflectionOpacity?: number;       // reflected-image opacity %, default 55
  reflectionDistance?: number;      // px gap object → reflection, default 0
  reflectionSkew?: number;          // deg (persisted; not yet rendered — needs flipped-clone engine)
  reflectionFeather?: number;       // feather/falloff size %, default 67
}

export interface Screen {
  id: string;
  name: string;
  width: number;
  height: number;
}
