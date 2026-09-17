import { useEffect, useRef, useState } from 'react';
import { useDisplayWsMessage, type DisplayMessage } from '../lib/displayWs';
import { useLayerRect, useLayerStyle } from '../lib/overlayLayerContext';

import { API } from '../lib/api';

interface Speaker {
  uid: string;
  name: string;
  photoUrl: string | null;
  isModerator: boolean;
  volume: number;
  level: number;   // 0..1, already floored/ceiled server-side
}

type SpeakersMsg = DisplayMessage & { channel: string | null; speakers: Speaker[]; bounce?: boolean };
/** Somebody in the room reacted to a speaker — "Alex reacted ❤️ to Sam". Drawn over the target's
 *  face for as long as Clubhouse says (`display_time_s`, usually 4 s), rising and fading. */
type ReactionMsg = DisplayMessage & { id: string; emoji: string; targetUid: string; fromName: string; ttlMs: number };
interface Floater { id: string; emoji: string; targetUid: string; until: number; ttlMs: number }

interface Card extends Speaker { leavingAt: number }

const FADE_MS = 280;
// The ceiling on the drift, as a fraction of the avatar. The operator's own height setting is
// capped at this and then again at the headroom actually measured above the card, so no
// setting can walk a face out through the top of the layer.
const LIFT = 0.55;
// The pump only sends on change, so silence is a single message. A face left on air
// because the server or the audio engine died is the one failure worth guarding.
const STALE_MS = 6_000;
// How long a face keeps animating after its level drops. Speech is full of gaps a syllable
// wide, and an animation that stopped in each of them would strobe rather than read.
const TALK_HOLD_MS = 700;
const BLINK_MS = 1500;

/**
 * The loops.
 *
 * **The animation does not follow the voice level.** It is there to say who is speaking, and a
 * face driven frame by frame off a meter jitters — the level moves several times a second and
 * every one of those moves is a direction change. So the level decides one thing only, whether
 * this person is talking, and a smooth loop runs for as long as that stays true.
 *
 * The height rides in on a custom property, so one static keyframe block serves every setting.
 */
const KEYFRAMES = `
@keyframes sc-react { 0% { opacity: 0; transform: translate(-50%, 20%) scale(0.4); } 12% { opacity: 1; transform: translate(-50%, -10%) scale(1.15); } 70% { opacity: 1; transform: translate(-50%, -90%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -160%) scale(0.9); } }

@keyframes sc-in{from{opacity:0;transform:translateY(14%) scale(.92)}to{opacity:1;transform:none}}
@keyframes sc-waft{
  0%{transform:translateY(0) rotate(0deg)}
  25%{transform:translateY(calc(var(--sc-hop, 0px) * -0.62)) rotate(-0.7deg)}
  50%{transform:translateY(calc(var(--sc-hop, 0px) * -1)) rotate(0deg)}
  75%{transform:translateY(calc(var(--sc-hop, 0px) * -0.48)) rotate(0.7deg)}
  100%{transform:translateY(0) rotate(0deg)}
}
@keyframes sc-blink{0%,100%{opacity:.55}50%{opacity:1}}
`;

/** `#rrggbb` + 0..1 → `rgba(...)`. The layer stores colour and opacity apart, because the
 *  operator sets them apart; CSS wants them together. Anything not a hex is passed through,
 *  so a colour already carrying its own alpha still works. */
function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function StudioCallSpeakerOverlay() {
  const rect = useLayerRect();
  const {
    color, fontFamily, titleSize, opacity,
    plateBg, plateOpacity, plateShadow, plateWidth, plateWrap,
    borderWidth, borderColor, borderOpacity, borderRadius,
    speakerAnim, speakerSensitivity, speakerImageSize, bounceHeight, bounceEase, waftMs,
  } = useLayerStyle();
  const [cards, setCards] = useState<Card[]>([]);
  // Off, the faces still come and go with who is talking — they just hold still. The
  // switch is in the StudioCall tab and rides along on the speaker payload.
  const [bounce, setBounce] = useState(true);
  const lastMsgAt = useRef(0);

  function apply(speakers: Speaker[]) {
    const now = Date.now();
    setCards(prev => {
      const next: Card[] = speakers.map(s => ({ ...s, leavingAt: 0 }));
      for (const p of prev) {
        if (speakers.some(s => s.uid === p.uid)) continue;
        const leavingAt = p.leavingAt || now;
        if (now - leavingAt < FADE_MS) next.push({ ...p, level: 0, leavingAt });
      }
      // Agora orders by loudness, which would make faces trade places mid-sentence.
      return next.sort((a, b) => a.uid.localeCompare(b.uid));
    });
  }

  const [floaters, setFloaters] = useState<Floater[]>([]);
  useDisplayWsMessage<ReactionMsg>('studiocall-reaction', msg => {
    if (!msg?.emoji || !msg.targetUid) return;
    const ttlMs = Math.max(1500, Math.min(10_000, Number(msg.ttlMs) || 4000));
    setFloaters(f => [...f.filter(x => x.until > Date.now()).slice(-11), { id: String(msg.id), emoji: msg.emoji, targetUid: String(msg.targetUid), until: Date.now() + ttlMs, ttlMs }]);
  });
  useEffect(() => {
    if (!floaters.length) return;
    const t = setTimeout(() => setFloaters(f => f.filter(x => x.until > Date.now())), Math.max(50, Math.min(...floaters.map(x => x.until)) - Date.now() + 20));
    return () => clearTimeout(t);
  }, [floaters]);

  useDisplayWsMessage<SpeakersMsg>('studiocall-speakers', msg => {
    lastMsgAt.current = Date.now();
    if (typeof msg.bounce === 'boolean') setBounce(msg.bounce);
    apply(Array.isArray(msg.speakers) ? msg.speakers : []);
  });

  /**
   * Who is talking *right now*, as a latch rather than a reading. `level` is what the meter
   * says this instant; this is the boolean the animation runs on, held open for TALK_HOLD_MS
   * past the last moment the level was above the bar so a pause for breath does not stop it.
   * Sensitivity sets where the bar is — at 100 anything the server bothered to report counts.
   */
  const talkUntil = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const floor = 0.02 + (1 - Math.max(1, Math.min(100, speakerSensitivity ?? 50)) / 100) * 0.4;
  for (const c of cards) {
    if (!c.leavingAt && c.level >= floor) talkUntil.current.set(c.uid, Date.now() + TALK_HOLD_MS);
  }

  // One sweep clears both the finished fade-outs and anything stranded by a dead pump.
  useEffect(() => {
    if (!cards.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      if (now - lastMsgAt.current > STALE_MS) { apply([]); return; }
      setCards(prev => prev.filter(c => !c.leavingAt || now - c.leavingAt < FADE_MS));
      // The latch above expires on a clock, not on a message, so the sweep has to be what
      // notices — the pump goes quiet the moment nothing changes.
      setTick(n => n + 1);
    }, 120);
    return () => clearInterval(t);
  }, [cards.length]);

  if (!cards.length) return null;

  const accent = color ?? '#38bdf8';
  const font = fontFamily ?? "'Segoe UI', system-ui, sans-serif";
  // The faces stand on the floor of the layer box and hop off it, so a second speaker
  // joining never shifts the first one's baseline. Two limits on the size. Height: the
  // card is face + gap + name plate (~1.46× the avatar) and a loud one jumps LIFT× its
  // own height on top of that, so the whole travel has to fit or the hop clips against
  // the layer's edge. Width: a full row has to fit, so a crowd shrinks rather than
  // spilling out of a box the operator sized for two.
  const boxH = rect?.height ?? 300;
  const boxW = rect?.width ?? 760;
  // The vertical budget, written out as multiples of the avatar rather than folded into one
  // magic 0.44: the card is the face plus a gap plus the name plate, the hop adds LIFT on top,
  // the ring's bloom paints outside all of it, and the container's own padding comes off the
  // box before any of that. A name plate the operator sized by hand is a fixed pixel height
  // instead of a share of the face, so it is taken out of the box first — that is the case
  // that was pushing the hop out of the layer, because the old cap assumed the default plate.
  const GAP_F = 0.09, PAD_F = 0.16, PLATE_F = 0.29, GLOW_F = 0.12;
  // A wrapping plate is two lines tall in the worst case we budget for; the lift is clamped
  // to real headroom below, so a third line costs travel rather than leaving the box.
  const lines = plateWrap ? 2 : 1;
  const plateFixed = titleSize ? Math.round(titleSize * 1.71 * lines) + 2 : 0;
  const vFactor = 1 + GAP_F + PAD_F + LIFT + GLOW_F + (titleSize ? 0 : PLATE_F * lines);
  const fitted = Math.max(24, Math.min(220, Math.round(Math.min(
    Math.max(1, boxH - plateFixed) / vFactor,
    boxW / Math.max(1, cards.length * 1.35),
  ))));
  // 0 means fit the faces to the box, which is the only setting that copes with a crowd —
  // six people arriving shrinks everybody rather than pushing the row out of the layer. A
  // number pins them there instead, which is what an operator who has sized the box around
  // one or two faces wants.
  const avatar = speakerImageSize ? Math.max(20, Math.min(300, speakerImageSize)) : fitted;
  const nameSize = titleSize ?? Math.round(avatar * 0.17);
  // Belt and braces: whatever the sizing above worked out, the hop is capped at the space
  // actually left above the card inside the box. The floor on the avatar and a name plate
  // set very large can both eat the headroom, and a face that leaves the layer is worse
  // than one that hops a little less.
  const plateH = plateFixed || Math.round(avatar * PLATE_F * lines);
  const cardH = avatar * (1 + GAP_F) + plateH;
  const headroom = Math.max(0, boxH - avatar * PAD_F - cardH - avatar * GLOW_F);
  const lift = Math.min(avatar * LIFT, headroom);

  // The plate's own skin. Held here rather than inline per card because it is identical on
  // every one of them and none of it depends on who is talking. A border width of 0 draws no
  // border at all — the accent hairline it used to have unconditionally is now a setting.
  const plateFill = hexA(plateBg ?? '#0a0c12', (plateOpacity ?? 82) / 100);
  const plateBorder = (borderWidth ?? 0) > 0
    ? `${borderWidth}px solid ${hexA(borderColor ?? '#ffffff', borderOpacity ?? 1)}`
    : 'none';
  const shadow = plateShadow ?? 0;
  const plateShadowCss = shadow > 0
    ? `0 ${Math.round(nameSize * 0.18 * (shadow / 100) * 4)}px ${Math.round(nameSize * 0.5 * (shadow / 100) * 4)}px rgba(0,0,0,${Math.min(0.9, shadow / 100)})`
    : 'none';

  const blink = speakerAnim === 'blink';
  // How far the face drifts, in pixels, capped at the room actually left above the card. The
  // default is gentle on purpose: this runs for as long as somebody is talking, and a travel
  // that reads well as an occasional peak reads as fidgeting when it never stops. Four
  // asymmetric stops and a fraction of a degree of roll are what make it waft rather than
  // pump — a two-stop up-down at any speed is a bounce, and a bounce that never lands is
  // the jitter this replaced.
  const hop = Math.min(avatar * ((bounceHeight ?? 18) / 100), lift);
  const ease = bounceEase || 'ease-in-out';
  const cycle = Math.max(300, Math.min(6000, waftMs ?? 2000));
  const now = Date.now();

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: Math.round(avatar * 0.24),
      // Enough floor that the name plate never meets the clip edge; the headroom the hop
      // needs is reserved by the avatar's height cap and then re-checked against `lift`.
      paddingTop: Math.round(avatar * 0.06), paddingBottom: Math.round(avatar * 0.1),
      pointerEvents: 'none', fontFamily: font,
      opacity: opacity ?? 1,
    }}>
      <style>{KEYFRAMES}</style>
      {cards.map(c => {
        // One boolean, not a number — see KEYFRAMES. `bounce` off holds every face still,
        // which is the switch in the StudioCall tab and outranks the layer's own choice.
        const talking = bounce && !c.leavingAt && (talkUntil.current.get(c.uid) ?? 0) > now;
        const t = talking ? 1 : 0;
        return (
          <div
            key={c.uid}
            style={{
              // The enter and the leave live on the outside, the loop on the inside: both
              // animate transform, and one element cannot run the two of them at once.
              opacity: c.leavingAt ? 0 : 1,
              transition: `opacity ${FADE_MS}ms linear`,
              animation: `sc-in ${FADE_MS}ms ease-out both`,
            }}
          >
          <div
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(avatar * 0.09),
              transformOrigin: 'bottom center',
              // Out the way it came in: it rose into place, so it settles back down rather
              // than snapping to nothing where it stood.
              ...(c.leavingAt ? { transform: 'translateY(14%) scale(0.92)' } : {}),
              transition: `transform ${FADE_MS}ms ease-in`,
              ['--sc-hop' as string]: `${Math.round(hop)}px`,
              animation: !talking ? 'none'
                : blink ? `sc-blink ${BLINK_MS}ms ease-in-out infinite`
                : `sc-waft ${cycle}ms ${ease} infinite`,
            } as React.CSSProperties}
          >
            <div style={{ position: 'relative' }}>
            {floaters.filter(f => f.targetUid === c.uid).map((f, i) => (
              <div key={f.id} style={{
                position: 'absolute', left: '50%', bottom: '55%',
                marginLeft: Math.round(avatar * (0.12 + (i % 3) * 0.14)),
                fontSize: Math.round(avatar * 0.42), lineHeight: 1,
                pointerEvents: 'none', zIndex: 2,
                textShadow: '0 2px 8px rgba(0,0,0,0.6)',
                animation: `sc-react ${f.ttlMs}ms ease-out forwards`,
              }}>{f.emoji}</div>
            ))}
            <div style={{
              width: avatar, height: avatar, borderRadius: '50%',
              // Ring and bloom cross between two states rather than tracking the meter, and the
              // transition is what makes the crossing smooth. The bloom scales with the face:
              // fixed pixels gave a small layer the same halo as a full-width one, and the halo
              // paints outside the card, so on a short box it was what crossed the layer edge.
              border: `${Math.max(2, Math.round(avatar * (0.022 + t * 0.022)))}px solid ${accent}`,
              boxShadow: `0 0 ${Math.round(avatar * (0.06 + t * 0.2))}px ${accent}${t ? 'cc' : '88'}, 0 ${Math.round(avatar * 0.06)}px ${Math.round(avatar * 0.18)}px rgba(0,0,0,0.55)`,
              overflow: 'hidden', background: '#0b0f16',
              transition: `box-shadow 260ms ease-out, border-width 260ms ease-out`,
            }}>
              {c.photoUrl
                ? <img src={`${API}${c.photoUrl}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                : <div style={{
                    width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#64748b', fontSize: Math.round(avatar * 0.4), fontWeight: 700,
                  }}>{(c.name || '?').slice(0, 1).toUpperCase()}</div>}
            </div>
            </div>
            {c.name && (
              <div style={{
                // Width is a share of the FACE, not of the layer: the faces resize themselves
                // to fit however many people are talking, and a plate measured against the box
                // would drift out of proportion with the head it belongs to as they do.
                maxWidth: avatar * ((plateWidth ?? 160) / 100),
                padding: `${Math.round(nameSize * 0.28)}px ${Math.round(nameSize * 0.7)}px`,
                borderRadius: borderRadius ?? 999,
                background: plateFill,
                border: plateBorder,
                boxShadow: plateShadowCss,
                color: '#fff', fontSize: nameSize, fontWeight: 600, lineHeight: 1.15,
                // Wrapping is what a long name needs; clipping to one line with an ellipsis is
                // what a tidy row of faces needs. The operator picks, because which one is
                // right depends on the name and on how much box there is.
                overflow: 'hidden',
                ...(plateWrap
                  ? { whiteSpace: 'normal' as const, overflowWrap: 'anywhere' as const, textAlign: 'center' as const }
                  : { whiteSpace: 'nowrap' as const, textOverflow: 'ellipsis' as const }),
                fontFamily: font,
              }}>
                {c.isModerator ? '★ ' : ''}{c.name}
              </div>
            )}
          </div>
          </div>
        );
      })}
    </div>
  );
}
