import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The stage every layout designer draws on. It fits a canvas of `canvas.w × canvas.h` canvas
 * pixels into whatever room it is given and hands the children the scale — `cpx`, canvas pixels
 * to CSS pixels — so everything inside is positioned in canvas units and this is the only place
 * that knows how big the widget is on screen.
 *
 * Furniture, all inert and all optional: a checkerboard for a transparent canvas, the grid
 * (painted as a repeating gradient — a 5px grid on 1920×1080 is 768 lines, a real cost as
 * divs), the two centre lines, a dashed safe zone, and the magenta guides a drag has locked on
 * to. `stage` letterboxes the canvas inside a monitor of another shape, which is how the Move
 * Designer shows where a full-screen output lands on the Pop-out Screen.
 */
export function LayoutCanvas({
  canvas, stage, grid = 0, showGrid = true, safe, showCentre = true, guides, checker, background,
  onScale, children, outside, className,
}: {
  canvas: { w: number; h: number };
  /** A monitor to letterbox the canvas inside, in its own pixels. Absent = the stage IS the canvas. */
  stage?: { w: number; h: number } | null;
  grid?: number;
  showGrid?: boolean;
  /** Safe-zone inset off each edge, in canvas pixels. Null/undefined draws none. */
  safe?: { x: number; y: number } | null;
  showCentre?: boolean;
  /** Lines a drag is currently locked on to, in canvas pixels. */
  guides?: { x?: number; y?: number } | null;
  checker?: boolean;
  background?: string;
  /** The fitted scale, whenever it changes — for anyone converting outside the render prop. */
  onScale?: (cpx: number) => void;
  children: (cpx: number) => ReactNode;
  /** Drawn over the whole stage rather than inside the canvas plane. */
  outside?: (cpx: number) => ReactNode;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const outer = stage ?? canvas;
  const px = box.w && box.h ? Math.min(box.w / outer.w, box.h / outer.h) : 0;
  const stageW = outer.w * px, stageH = outer.h * px;
  const fit = stage ? Math.min(stage.w / canvas.w, stage.h / canvas.h) : 1;
  const cpx = fit * px;
  const canvasW = canvas.w * cpx, canvasH = canvas.h * cpx;
  const off = { x: (stageW - canvasW) / 2, y: (stageH - canvasH) / 2 };

  const onScaleRef = useRef(onScale); onScaleRef.current = onScale;
  useEffect(() => { onScaleRef.current?.(cpx); }, [cpx]);

  return (
    <div ref={wrapRef}
      className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#07090c] ${className ?? ''}`}>
      <div className="relative select-none overflow-hidden border border-slate-800 bg-[#040507]"
        style={{ width: stageW, height: stageH }}>
        <div className="absolute bg-[#101418]"
          style={{
            left: off.x, top: off.y, width: canvasW, height: canvasH,
            ...(checker ? { backgroundImage: CHECKER, backgroundSize: '24px 24px' } : {}),
          }}>
          {background && background !== 'transparent' && (
            <div className="pointer-events-none absolute inset-0" style={{ background }} />
          )}
          {showGrid && grid > 0 && cpx > 0 && (
            <div className="pointer-events-none absolute inset-0" style={{
              backgroundImage:
                'linear-gradient(to right,rgba(148,163,184,0.13) 1px,transparent 1px),' +
                'linear-gradient(to bottom,rgba(148,163,184,0.13) 1px,transparent 1px)',
              backgroundSize: `${grid * cpx}px ${grid * cpx}px`,
            }} />
          )}
          {showCentre && (
            <>
              <div className="pointer-events-none absolute inset-y-0 w-px bg-sky-500/25" style={{ left: canvasW / 2 }} />
              <div className="pointer-events-none absolute inset-x-0 h-px bg-sky-500/25" style={{ top: canvasH / 2 }} />
            </>
          )}
          {safe && (
            <div className="pointer-events-none absolute border border-dashed border-amber-500/40" style={{
              left: safe.x * cpx, top: safe.y * cpx,
              width: (canvas.w - safe.x * 2) * cpx, height: (canvas.h - safe.y * 2) * cpx,
            }} />
          )}

          {cpx > 0 && children(cpx)}

          {guides?.x !== undefined && (
            <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-fuchsia-400" style={{ left: guides.x * cpx }} />
          )}
          {guides?.y !== undefined && (
            <div className="pointer-events-none absolute inset-x-0 z-10 h-px bg-fuchsia-400" style={{ top: guides.y * cpx }} />
          )}
        </div>

        {/* Drawn over the plane rather than on it: a border would shift every absolutely
            positioned child inside it by its own width. */}
        {(off.x > 0.5 || off.y > 0.5) && (
          <div className="pointer-events-none absolute shadow-[inset_0_0_0_1px_rgba(148,163,184,0.45)]"
            style={{ left: off.x, top: off.y, width: canvasW, height: canvasH }} />
        )}
        {cpx > 0 && outside?.(cpx)}
      </div>
    </div>
  );
}

const CHECKER =
  'linear-gradient(45deg,#0d1117 25%,transparent 25%),linear-gradient(-45deg,#0d1117 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#0d1117 75%),linear-gradient(-45deg,transparent 75%,#0d1117 75%)';
