import type { ReactNode } from 'react';

const P = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

/**
 * The in-frame control bar sits over live video at whatever size the operator made the frame,
 * so these are drawn heavy and simple — a 14px icon with hairlines disappears against a face.
 * Inline SVG, matching the tab icons; the project carries no icon package.
 */
function Svg({ children, className = 'w-3 h-3' }: { children: ReactNode; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>{children}</svg>;
}

export const IconZoomIn = () => <Svg><circle cx="10.5" cy="10.5" r="6.5" {...P} /><path d="M20 20l-4.6-4.6M10.5 7.5v6M7.5 10.5h6" {...P} /></Svg>;
export const IconZoomOut = () => <Svg><circle cx="10.5" cy="10.5" r="6.5" {...P} /><path d="M20 20l-4.6-4.6M7.5 10.5h6" {...P} /></Svg>;

/** Crop marks — the same shape the Reframe overlay draws around the on-air rectangle. */
export const IconReframe = () => <Svg><path d="M7 2v13a2 2 0 0 0 2 2h13M2 7h13a2 2 0 0 1 2 2v13" {...P} /></Svg>;

export const IconSet = () => <Svg><path d="M4 12.5 9.5 18 20 6.5" {...P} /></Svg>;
export const IconRevert = () => <Svg><path d="M4 9h11a5 5 0 0 1 0 10h-6" {...P} /><path d="M8 4.5 3.5 9 8 13.5" {...P} /></Svg>;
export const IconOnAir = () => <Svg><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" /></Svg>;

/**
 * The guest's microphone, as the DESK sees it: what the studio receives from them. Drawn with
 * a slash variant rather than a second glyph, because muted and live have to be one shape the
 * eye compares at a glance down a roster, not two shapes it has to read.
 */
export const IconMic = ({ off = false }: { off?: boolean }) => (
  <Svg>
    <rect x="9" y="2.5" width="6" height="11" rx="3" {...P} />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...P} />
    {off && <path d="M3.5 3.5l17 17" {...P} />}
  </Svg>
);

/**
 * The tone test — a mic with a wave leaving it, because that is exactly what happens: a tone
 * is put on their outgoing leg for a moment, in place of the microphone.
 */
export const IconTone = () => (
  <Svg>
    <rect x="4" y="7" width="5" height="10" rx="2.5" {...P} />
    <path d="M12.5 9a4.5 4.5 0 0 1 0 6" {...P} />
    <path d="M16 6a9 9 0 0 1 0 12" {...P} />
    <path d="M19.5 3.5a13.5 13.5 0 0 1 0 17" {...P} />
  </Svg>
);

/** What the guest HEARS — the return leg. Same slash convention as the mic. */
export const IconSpeaker = ({ off = false }: { off?: boolean }) => (
  <Svg>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" {...P} />
    {off ? <path d="M16 9.5l5 5M21 9.5l-5 5" {...P} />
      : <><path d="M15.5 9a4.5 4.5 0 0 1 0 6" {...P} /><path d="M18.5 6a8.5 8.5 0 0 1 0 12" {...P} /></>}
  </Svg>
);


/**
 * Alignment priority — a frame with the picture pushed to one edge of it. The whole point of
 * the control is *where in the box*, so the box has to be drawn: an arrow alone would read as
 * "move", which is a different verb.
 */
const AlignBox = () => <rect x="2.5" y="2.5" width="19" height="19" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />;
const AlignFill = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) =>
  <rect x={x} y={y} width={w} height={h} rx="1.5" fill="currentColor" stroke="none" />;
const AlignIcon = (p: { x: number; y: number; w: number; h: number }) => () =>
  <Svg className="w-3.5 h-3.5"><AlignBox /><AlignFill {...p} /></Svg>;

export const IconAlignTop = AlignIcon({ x: 6, y: 5, w: 12, h: 7 });
export const IconAlignMiddle = AlignIcon({ x: 6, y: 8.5, w: 12, h: 7 });
export const IconAlignBottom = AlignIcon({ x: 6, y: 12, w: 12, h: 7 });
export const IconAlignLeft = AlignIcon({ x: 5, y: 6, w: 7, h: 12 });
export const IconAlignCentre = AlignIcon({ x: 8.5, y: 6, w: 7, h: 12 });
export const IconAlignRight = AlignIcon({ x: 12, y: 6, w: 7, h: 12 });
