import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutCanvas } from '../layout/LayoutCanvas';
import { BoxHandles, SIZE_HANDLE } from '../layout/BoxHandles';
import { useBoxDrag } from '../layout/useBoxDrag';
import { useHistory } from '../layout/useHistory';
import { CanvasToolbar, GridPicker, ToolCheck, UndoRedo } from '../layout/CanvasToolbar';
import { canvasGuides, resizeBox, snapBox, type Box, type DragHandle, type Handle } from '../layout/snap';
import { tumbleRotation } from '../../lib/tumble';
import { LANDSCAPE_SCREEN, PORTRAIT_SCREEN } from '../../clipboard/geometry';
import { getUiSetting, setUiSetting } from '../../lib/uiSettings';
import { RangeRow } from '../RangeRow';

/**
 * Where the CHinfocard sits on the overlay canvas, how big it is, and how it is tilted — the
 * Display profile's frame, driven with the mouse.
 *
 * **All three gestures are the app-wide canvas contract's, not this panel's**:
 *
 * | Gesture | Does |
 * |---|---|
 * | drag the **body** | move the card. The only one that snaps. |
 * | drag a **corner** | scale from the opposite corner |
 * | **Ctrl** + a corner | uniform scale — the aspect is locked |
 * | **Ctrl** + the **body** | **3D tumble** — horizontal is yaw, vertical is pitch |
 *
 * **There are no edge handles**, and that is the contract rather than an omission: edges CROP
 * everywhere in this app, an `overlay_layers` row carries no crop columns, and the contract is explicit that
 * a model with no crop draws corners only instead of quietly resizing with the edges. An operator
 * who has learnt the Move Designer reaches for an edge expecting a crop.
 *
 * **The tumble is the shared gesture** (`lib/tumble.ts`) — the same one the Overlay tab, Slides,
 * Clipboard and the lower thirds use, so the feel cannot drift between them. It measures in RAW
 * screen pixels from the mousedown snapshot and is deliberately never scaled by the canvas zoom;
 * `useBoxDrag` hands deltas in CANVAS pixels, so they are multiplied back by `cpx` here. Clamped to
 * ±45° to match the Rotate X/Y sliders below it, which write the same two columns.
 *
 * **FOV keeps its slider.** The contract assigns the wheel to zoom and spends Shift on repositioning inside a
 * crop; a surface with no crop simply has no third drag to give away, and inventing one is what the
 * document exists to stop.
 *
 * **It edits the same columns the Overlay tab's canvas does** — one value, two views. The
 * Landscape / Portrait switch picks which set: `x/y/width/height` + `threedRot*`, or the
 * `portrait*` pair, never a projection between them.
 *
 * The write is the dialog's own `patchLayer`, whose 100 ms debounce is TRAILING — a continuous
 * drag therefore writes once it settles rather than once per mousemove, and the `layers-changed`
 * broadcast puts the new frame on the overlay without a reload.
 */

const SNAP_SCREEN_PX = 7;
const MIN = 40;
const TILT_MAX = 45;
const TILT_STEP = 0.1;
const GRID_STEPS = [0, 5, 10, 20, 40] as const;
const SAFE = { x: 60, y: 40 };

const GRID_KEY = 'studiocall:cardFrame:grid';
const SNAP_KEY = 'studiocall:cardFrame:snap';
const SAFE_KEY = 'studiocall:cardFrame:safe';

/** The columns this canvas drives, per orientation. One layer, two independent frames. */
const COLS = {
  landscape: { x: 'x', y: 'y', w: 'width', h: 'height', rx: 'threedRotX', ry: 'threedRotY', fov: 'threedFov' },
  portrait: {
    x: 'portraitX', y: 'portraitY', w: 'portraitWidth', h: 'portraitHeight',
    rx: 'portraitThreedRotX', ry: 'portraitThreedRotY', fov: 'portraitThreedFov',
  },
} as const;

/** Everything a gesture on this canvas can change, and therefore everything one undo restores. */
interface Frame { box: Box; rotX: number; rotY: number }

export function CardFrameCanvas({ layer, onChange, tint, orientation, onOrientationChange }: {
  /** The `CHinfocard` layer row. Only the geometry and tilt columns are read. */
  layer: Record<string, any>;
  /** The dialog's debounced layer PATCH — same one every other control in the panel writes. */
  onChange: (patch: Record<string, number>) => void;
  /** The card's accent, so the rectangle on the canvas is recognisably this layer. */
  tint?: string | null;
  /**
   * Which of the layer's two frames is being edited. **Owned by the dialog, not by this canvas**:
   * the Perspective sliders under it write the same two tilt columns a Ctrl+drag here does, so a
   * switch that moved only the canvas would leave the sliders editing the other orientation —
   * two controls for one value, disagreeing. One value, one control.
   */
  orientation: 'landscape' | 'portrait';
  onOrientationChange: (o: 'landscape' | 'portrait') => void;
}) {
  const [cpx, setCpx] = useState(0);
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null);

  const [grid, setGrid] = useState(() => Number(getUiSetting(GRID_KEY) ?? 10) || 0);
  const [snap, setSnap] = useState(() => getUiSetting(SNAP_KEY) !== 'false');
  const [showSafe, setShowSafe] = useState(() => getUiSetting(SAFE_KEY) === 'true');
  const editGrid = (v: number) => { setGrid(v); setUiSetting(GRID_KEY, String(v)); };
  const editSnap = (v: boolean) => { setSnap(v); setUiSetting(SNAP_KEY, String(v)); };
  const editSafe = (v: boolean) => { setShowSafe(v); setUiSetting(SAFE_KEY, String(v)); };

  const screen = orientation === 'portrait' ? PORTRAIT_SCREEN : LANDSCAPE_SCREEN;
  const canvas = { w: screen.width, h: screen.height };
  const col = COLS[orientation];

  /** The layer's frame in canvas pixels and degrees — the only units this file works in. */
  const frame: Frame = useMemo(() => ({
    box: {
      x: Math.round(layer[col.x] ?? 0),
      y: Math.round(layer[col.y] ?? 0),
      w: Math.max(MIN, Math.round(layer[col.w] ?? 400)),
      h: Math.max(MIN, Math.round(layer[col.h] ?? 600)),
    },
    rotX: layer[col.rx] ?? 0,
    rotY: layer[col.ry] ?? 0,
  }), [layer, col]);

  const frameRef = useRef(frame); frameRef.current = frame;
  const cpxRef = useRef(cpx); cpxRef.current = cpx;
  const history = useHistory<Frame>(10);

  const putBox = useCallback((b: Box) => {
    onChange({ [col.x]: Math.round(b.x), [col.y]: Math.round(b.y), [col.w]: Math.round(b.w), [col.h]: Math.round(b.h) });
  }, [onChange, col]);
  const putTilt = useCallback((rotX: number, rotY: number) => {
    onChange({ [col.rx]: rotX, [col.ry]: rotY });
  }, [onChange, col]);
  const putAll = useCallback((f: Frame) => { putBox(f.box); putTilt(f.rotX, f.rotY); }, [putBox, putTilt]);

  const rules = useMemo(() => {
    const g = canvasGuides(canvas, showSafe ? SAFE : null);
    // Snapping off empties the guides and zeroes the grid, so the box goes exactly where the
    // pointer puts it — the only way to place a card deliberately off a line.
    return snap
      ? { ...g, grid, tol: SNAP_SCREEN_PX / Math.max(cpx, 1e-6) }
      : { xs: [], ys: [], grid: 0, tol: 0 };
  }, [snap, grid, showSafe, cpx, canvas.w, canvas.h]);

  const drag = useBoxDrag<Frame>({
    cpx,
    onMove: (handle, dx, dy, mods, start) => {
      // Ctrl on the BODY is the tumble, Ctrl on a HANDLE is uniform — the contract decides by what is
      // under the cursor, and the two never collide because a gesture starts on exactly one.
      if (handle === 'body' && mods.uniform) {
        // tumble.ts is in RAW screen px on purpose (the feel must not change with the zoom of the
        // canvas it happens to be on), and useBoxDrag divides by cpx — so multiply it back.
        const k = Math.max(cpxRef.current, 1e-6);
        const { rotX, rotY } = tumbleRotation(start.rotX, start.rotY, dx * k, dy * k, TILT_MAX, TILT_STEP);
        putTilt(rotX, rotY);
        return;
      }

      const bent = snapBox(start.box, handle, dx, dy, rules);
      setGuides({ x: bent.guideX, y: bent.guideY });
      const lock = mods.uniform ? start.box.w / start.box.h : null;
      putBox(handle === 'body'
        ? { ...start.box, x: start.box.x + bent.dx, y: start.box.y + bent.dy }
        : { ...start.box, ...resizeBox(start.box, handle as Handle, bent.dx, bent.dy, MIN, lock) });
    },
    onEnd: (start, moved) => {
      setGuides(null);
      // A bare click banks nothing — an undo slot spent on a mis-hit is one the operator does
      // not get back.
      if (moved) history.commit(start);
    },
  });

  const begin = (e: React.MouseEvent, handle: DragHandle) => drag.begin(e, handle, frameRef.current);

  const step = useCallback((undo: boolean) => {
    const got = undo ? history.undo(frameRef.current) : history.redo(frameRef.current);
    if (got) putAll(got);
  }, [history, putAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z') { e.preventDefault(); step(true); }
      if (e.key === 'y') { e.preventDefault(); step(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const colour = tint || '#38bdf8';
  const { box, rotX, rotY } = frame;
  const tilted = rotX !== 0 || rotY !== 0;

  return (
    <div className="flex flex-col gap-1.5">
      <CanvasToolbar hint="Drag to move · corners scale · Ctrl+corner uniform · Ctrl+drag tilts">
        <div className="flex shrink-0 overflow-hidden rounded border border-slate-700">
          {(['landscape', 'portrait'] as const).map(o => (
            <button key={o} onClick={() => onOrientationChange(o)}
              title={o === 'portrait'
                ? 'The portrait frame — portraitX/Y/Width/Height and its own tilt, on the 1080×1920 canvas'
                : 'The landscape frame — x/y/width/height and its own tilt, on the 1920×1080 canvas'}
              className={`px-1.5 py-1 text-[11px] transition-colors ${orientation === o ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-slate-800'}`}>
              {o === 'portrait' ? 'Portrait' : 'Landscape'}
            </button>
          ))}
        </div>
        <GridPicker value={grid} steps={GRID_STEPS} onChange={editGrid} />
        <ToolCheck checked={snap} onChange={editSnap} title="Snap the box to the grid, the canvas edges and its centre lines">Snap</ToolCheck>
        <ToolCheck checked={showSafe} onChange={editSafe} title="Draw the title-safe inset, and snap to it">Safe</ToolCheck>
        <UndoRedo canUndo={history.canUndo} canRedo={history.canRedo} depth={history.depth}
          limit={10} onUndo={() => step(true)} onRedo={() => step(false)} />
      </CanvasToolbar>

      <div className="h-[170px] w-full">
        <LayoutCanvas
          canvas={canvas} grid={grid} showGrid={grid > 0} safe={showSafe ? SAFE : null}
          guides={guides} checker onScale={setCpx}
        >
          {k => (
            <div
              onMouseDown={e => { if (e.button === 0) begin(e, 'body'); }}
              className="absolute cursor-move"
              style={{
                left: box.x * k, top: box.y * k, width: box.w * k, height: box.h * k,
                // The FOV → perspective-depth mapping is the CARD'S OWN
                // (StudioCallInfoCardOverlay): half the height over tan(fov/2), so a given FOV
                // looks the same on a card of any size — and so this preview tilts by the same
                // maths the overlay draws with rather than an approximation of it.
                perspective: tilted
                  ? `${((box.h * k) / 2) / Math.tan((((layer[col.fov] ?? 90) as number) * Math.PI / 180) / 2)}px`
                  : undefined,
              }}>
              <div
                className="absolute inset-0 border-2"
                style={{
                  borderColor: colour, background: `${colour}22`,
                  transform: tilted ? `rotateX(${rotX}deg) rotateY(${rotY}deg)` : undefined,
                }}>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="truncate px-1 text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: colour }}>Info card</span>
                </div>
              </div>
              {/* Corners only — an overlay layer has no crop for an edge to take. They sit on
                  the UNTILTED box: a handle that swam with the perspective would be a handle the
                  operator has to chase, and the rectangle being resized is the flat one. */}
              <BoxHandles onBegin={begin} cornerClass={SIZE_HANDLE} edges={false} />
            </div>
          )}
        </LayoutCanvas>
      </div>

      {/*
        Zoom the OBJECT — picture, name strip and text together, about the card's centre. It is
        `cardScale`, the card's own transform, and above 1× it is allowed to grow past the layer
        box rather than being clipped by it.

        **It deliberately does not touch the box.** A first cut scaled the layer's width and height
        instead, and that is not a zoom of anything: the card's bands are shares of the box height
        and its type is in pixels, so changing the box RE-LAYS the card rather than magnifying it.
        It also jittered, and the two causes are worth remembering — the aspect was re-derived from
        a box that had just been rounded to integers, so it walked a little further every event,
        and the write fed straight back into the slider's own `value`, so the thumb was fighting
        the drag. A scalar the card multiplies by has neither failure: nothing is re-derived and
        nothing rounds.

        The drag it corresponds to is not a handle here — the corners size the frame, this sizes
        what is in it.
      */}
      <RangeRow label="Frame zoom" suffix="×" min={0.2} max={2} step={0.01}
        hint="Scale the whole card about its centre — picture, name and text together. Above 1× it grows past the frame rather than being cropped by it."
        value={layer.cardScale ?? 1}
        onChange={v => onChange({ cardScale: v })} />

      {/* Two lines, not one. In a column the operator can drag down to 160px these numbers and the
          two buttons wrapped into each other and the readout landed on top of Flat and Centre.
          `truncate` on the numbers and the buttons on their own row is what keeps it legible at
          every width the split allows. */}
      <div className="truncate text-[10px] tabular-nums text-slate-500">
        {box.x} · {box.y}
        <span className="px-1 text-slate-700">|</span>
        {box.w} × {box.h}
        {tilted && <>
          <span className="px-1 text-slate-700">|</span>
          <span title="Tilt — Ctrl+drag the card to change it">{rotX}° / {rotY}°</span>
        </>}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-slate-500">
        <button
          onClick={() => { history.commit(frameRef.current); putTilt(0, 0); }}
          disabled={!tilted}
          className="ml-auto rounded border border-slate-700 px-1.5 py-0.5 text-slate-400 transition-colors hover:bg-slate-800 disabled:opacity-30"
          title="Put the card flat on the canvas again">Flat</button>
        <button
          onClick={() => {
            history.commit(frameRef.current);
            putBox({ w: box.w, h: box.h, x: Math.round((canvas.w - box.w) / 2), y: Math.round((canvas.h - box.h) / 2) });
          }}
          className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-400 transition-colors hover:bg-slate-800"
          title="Put the card in the middle of the canvas">Centre</button>
      </div>
    </div>
  );
}
