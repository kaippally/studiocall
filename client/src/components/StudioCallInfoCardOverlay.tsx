import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDisplayWsMessage, type DisplayMessage } from '../lib/displayWs';
import { useLayerRect, useLayerStyle } from '../lib/overlayLayerContext';
import { reflectionInPlaneStylePct, reflectionObjectStyle } from '../clipboard/reflection';
import { effectStyle } from '../lib/animations';

import { API } from '../lib/api';

export interface InfoCard {
  userId: string;
  name: string;
  username: string;
  photoUrl: string | null;
  bio: string | null;
  followers: number | null;
  following: number | null;
  twitter: string | null;
  instagram: string | null;
  role: string;
  /**
   * Nothing to read — no bio, no counts. Stamped by the server (`cardIsThin` in
   * routes/studiocall.ts) so the desk's warning and this drawing are one judgement, and drawn as
   * the picture alone: three bands with two of them empty reads on air as a graphic that failed
   * to load, not as a person who wrote no bio.
   */
  thin?: boolean;
  /** The dialog's framing of the picture: 1–5×, and pan as a share of the frame. */
  zoom?: number;
  panX?: number;
  panY?: number;
  /** What this show has counted about them (`ch_people`) — absent for somebody never met. */
  listenerSince?: string | null;
  roomsAttended?: number | null;
  talkMs?: number | null;
  drops?: number | null;
}

type InfoCardMsg = DisplayMessage & { card: InfoCard | null };

const count = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  : String(n);

/** Total speech as a duration: `48s`, `12m`, `1h 05m`. */
const speechLabel = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/**
 * The card, on the canvas — and, with `card` given, the very same card drawn as a live preview in
 * the Live Chat pop-out's profile dialog.
 *
 * One component for both, because the preview's whole job is to be *right*: the operator frames a
 * face and drags the two separators against what they can see, and a preview that approximated the
 * card would be a lie told at exactly the moment it matters. `card` also lets the dialog show
 * somebody who is NOT on air — you look at a profile before you decide to hold it up.
 */
/** The card's play: one card of bands, or two acts — the picture, then the text. */
export interface CardSeq {
  style: 'bands' | 'sequence';
  imageHold: number;
  imageEffect: string;
  textHold: number;
  textEffect: string;
}
export const DEFAULT_SEQ: CardSeq = { style: 'bands', imageHold: 5, imageEffect: 'fade', textHold: 5, textEffect: 'fade' };
export const CARD_EFFECTS: { id: string; label: string }[] = [
  { id: 'fade', label: 'Fade' }, { id: 'blur', label: 'Blur' }, { id: 'slideIn', label: 'Slide in' },
  { id: 'slideUp', label: 'Slide up' }, { id: 'slideRight', label: 'Slide right' },
];
// Each act's one name maps to an in/out pair from the shared effect library.
const EFFECT_PAIR: Record<string, [string, string]> = {
  fade: ['fadeIn', 'fadeOut'], blur: ['blurIn', 'blurOut'], slideIn: ['slideFromLeft', 'zipOutLeft'],
  slideUp: ['riseIn', 'sinkOut'], slideRight: ['zipInRight', 'zipOutRight'],
};
type Phase = 'image' | 'imageOut' | 'text' | 'textOut' | 'done';
export function seqFrom(d: any): CardSeq {
  return {
    style: d?.cardStyle === 'sequence' ? 'sequence' : 'bands',
    imageHold: Number(d?.cardImageHold) || DEFAULT_SEQ.imageHold,
    imageEffect: typeof d?.cardImageEffect === 'string' ? d.cardImageEffect : DEFAULT_SEQ.imageEffect,
    textHold: Number(d?.cardTextHold) || DEFAULT_SEQ.textHold,
    textEffect: typeof d?.cardTextEffect === 'string' ? d.cardTextEffect : DEFAULT_SEQ.textEffect,
  };
}

export function StudioCallInfoCardOverlay({ card: override, seq: seqProp, playKey }: {
  card?: InfoCard | null;
  /** Preview only: the play to render, straight from the profile window's controls. */
  seq?: CardSeq;
  /** Preview only: bump to run the sequence once; 0/undefined sits on the picture. */
  playKey?: number;
} = {}) {
  const rect = useLayerRect();
  const { color, fontFamily, bodyFontFamily, titleSize, bodySize, opacity,
          photoScale, nameScale, photoRadius, photoBorder, cardMargin, nameMargin, cardDpSize, cardScale, borderColor,
          reflection, reflectionOpacityMain, reflectionOpacity,
          reflectionDistance, reflectionFeather, reflectionBlur,
          threedRotX, threedRotY, threedFov,
          showAnimation, hideAnimation, animInMs } = useLayerStyle();
  const [onAirCard, setOnAirCard] = useState<InfoCard | null>(null);
  const previewing = override !== undefined;

  // The card leaving stays mounted for exactly as long as its exit lasts — the same trick the
  // chat's held line uses. The Overlay tab's one Effect toggle writes the in/out pair and its
  // one Speed slider writes both durations, so `animInMs` is the whole clock.
  const [leaving, setLeaving] = useState<InfoCard | null>(null);
  const prevCard = useRef<InfoCard | null>(null);
  const outMs = Math.max(0, animInMs ?? 500);
  useEffect(() => {
    if (previewing) return;
    const prev = prevCard.current;
    prevCard.current = onAirCard;
    if (onAirCard) { setLeaving(null); return; }
    if (!prev || !hideAnimation || hideAnimation === 'none' || outMs <= 0) return;
    setLeaving(prev);
    const t = setTimeout(() => setLeaving(l => (l === prev ? null : l)), outMs);
    return () => clearTimeout(t);
  }, [onAirCard, previewing, hideAnimation, outMs]);

  // A card put on air before this page loaded is replayed on connect, but a page that
  // was already open when the server restarted has to ask. A preview asks nothing: it is
  // handed its card, and the pop-out has no display socket to replay one down.
  useEffect(() => {
    if (previewing) return;
    fetch(`${API}/api/studiocall/infocard`)
      .then(r => r.json())
      .then(d => setOnAirCard(d?.card ?? null))
      .catch(() => {});
  }, [previewing]);

  useDisplayWsMessage<InfoCardMsg>('studiocall-infocard', msg => {
    if (!previewing) setOnAirCard(msg.card ?? null);
  });

  // How the card plays — the style and the two acts' holds and effects — is a server control
  // (the same record the chat layer's effects live in), read once and followed on the
  // broadcast. A preview is handed its own, so the profile window's sliders drive it live.
  const [ctlSeq, setCtlSeq] = useState<CardSeq>(DEFAULT_SEQ);
  useEffect(() => {
    if (previewing) return;
    fetch(`${API}/api/studiocall/controls`)
      .then(r => r.json())
      .then(d => setCtlSeq(seqFrom(d)))
      .catch(() => {});
  }, [previewing]);
  useDisplayWsMessage<DisplayMessage & Partial<Record<keyof CardSeq, unknown>>>('studiocall-controls', msg => {
    if (!previewing) setCtlSeq(seqFrom(msg));
  });
  const seq = previewing ? (seqProp ?? DEFAULT_SEQ) : ctlSeq;

  const card = previewing ? override : (onAirCard ?? leaving);

  /**
   * The sequence: picture, out, text, out. Restarted whenever a new face lands (or, in the
   * preview, when the ▶ button bumps `playKey`); a preview with nothing playing sits on the
   * picture so there is something to frame. `done` draws nothing — the server still holds the
   * card until its own auto-hide, but the show has been told its story.
   */
  const [phase, setPhase] = useState<Phase>('image');
  const runKey = `${card?.userId ?? ''}:${playKey ?? 0}`;
  useEffect(() => {
    if (seq.style !== 'sequence' || !card) { setPhase('image'); return; }
    if (previewing && !playKey) { setPhase('image'); return; }
    const ts: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, p: Phase) => ts.push(setTimeout(() => setPhase(p), ms));
    /*
     * A THIN CARD GOES STRAIGHT TO ACT 2. There is nothing to read on it — no bio, no counts —
     * so Act 1 is a full-frame face with no story coming, held for imageHold seconds and then
     * cut to. Act 2 is where the DP settles into its corner beside the name, which is the frame
     * that says who this is; on a card with nothing else to say, it is the whole card. Starting
     * there spends the time on the shot worth holding instead of on the wind-up to it.
     */
    if (card.thin) {
      setPhase('text');
      at(seq.textHold * 1000, 'textOut');
      at(seq.textHold * 1000 + outMs, 'done');
      return () => ts.forEach(clearTimeout);
    }
    setPhase('image');
    const t1 = seq.imageHold * 1000;
    const t2 = t1 + outMs;
    const t3 = t2 + seq.textHold * 1000;
    at(t1, 'imageOut'); at(t2, 'text'); at(t3, 'textOut'); at(t3 + outMs, 'done');
    return () => ts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, seq.style, seq.imageHold, seq.textHold, outMs, previewing, card?.thin]);

  const textAct = seq.style === 'sequence' && (phase === 'text' || phase === 'textOut');

  // The DP's settle into the corner: false on arrival at the text act, true a beat later, which
  // is what gives the transition two states to run between. Reset when the act is left, so a
  // repeat of the sequence settles again rather than starting in the corner. Above the early
  // returns, because a hook that runs only for some renders is not a hook.
  const [dpSettled, setDpSettled] = useState(false);
  useEffect(() => {
    if (!textAct) { setDpSettled(false); return; }
    const t = setTimeout(() => setDpSettled(true), 30);
    return () => clearTimeout(t);
  }, [textAct]);

  if (!card) return null;
  // A thin card now has a `done` of its own — it played one act rather than none.
  if (seq.style === 'sequence' && phase === 'done' && !(previewing && !playKey)) return null;
  const exiting = !previewing && !onAirCard;
  const [imgIn, imgOut] = EFFECT_PAIR[seq.imageEffect] ?? EFFECT_PAIR.fade!;
  const [txtIn, txtOut] = EFFECT_PAIR[seq.textEffect] ?? EFFECT_PAIR.fade!;
  const fx = seq.style === 'sequence'
    ? (previewing && !playKey) ? {}
      : phase === 'image' ? effectStyle(imgIn, outMs)
      : phase === 'imageOut' ? effectStyle(imgOut, outMs)
      : phase === 'text' ? effectStyle(txtIn, outMs)
      : effectStyle(txtOut, outMs)
    : previewing ? {} : exiting
      ? effectStyle(hideAnimation ?? 'fadeOut', outMs)
      : effectStyle(showAnimation ?? 'fadeIn', outMs);

  const accent = color ?? '#38bdf8';
  const titleFont = fontFamily ?? "'Segoe UI', system-ui, sans-serif";
  const bodyFont = bodyFontFamily ?? titleFont;
  /**
   * With the mirror on, the card takes the TOP HALF of the layer box and its reflection hangs in
   * the bottom half — the same division Apologia's page uses, so a layer dragged to the same
   * height reads the same whatever is in it. Every proportion inside the card is a share of `h`,
   * so halving it re-proportions the whole card rather than cropping it.
   */
  const reflOn = !!reflection;
  const h = Math.round((rect?.height ?? 340) * (reflOn ? 0.5 : 1));
  const w = Math.round(rect?.width ?? 720);

  /**
   * Three bands down the card: the **picture**, a thin **name strip**, and the **profile text**.
   *
   * A face beside a paragraph was a chat line, not a card — the picture was the size of a line of
   * type and the bio ran out of room beside it. Stacked, the picture gets the whole width and the
   * text gets the whole width, which is the only arrangement in which both are legible at the
   * distance an overlay is read from. The name strip between them is the caption, and it is thin
   * on purpose: it is one line, and giving it more height would be taking it off the picture.
   *
   * Geometry is a share of the layer box, not pixels, so the card holds its proportions whatever
   * size the layer is dragged to in the Overlay tab.
   */
  const imgShare = Math.min(90, Math.max(5, photoScale ?? 55)) / 100;
  const nameShare = Math.min(1 - imgShare - 0.05, Math.max(0.04, (nameScale ?? 12) / 100));
  const imgH = Math.round(h * imgShare);
  const pad = Math.max(0, Math.round(cardMargin ?? 10));
  const gap = Math.round(h * 0.02);
  // No ring by default. A hairline of accent around the picture reads as a second frame inside
  // the card's own, and at the size an overlay is watched from it is the thing the eye lands on.
  const photoRing = Math.max(0, Math.round(Math.min(w, imgH) * ((photoBorder ?? 0) / 100)));
  // Roundness is a PERCENTAGE, read the way CSS reads `border-radius: n%` — per axis, so the
  // corner keeps its shape whatever the picture's aspect is and **50% is a full ellipse**: on a
  // square picture, a circle. That is the one number an operator actually reaches for, and it was
  // unreachable while this was in pixels (the Overlay tab had already moved to percent and the
  // renderer had not, so the two disagreed about what the same column meant).
  const photoCorner = `${Math.max(0, Math.min(50, photoRadius ?? 50))}%`;
  // The ring's own colour, falling back to the card's accent — the generic border_* column rather
  // than a second one, the same way the speaker plate borrows it.
  const ringColor = borderColor || accent;
  // The name strip is a band with a height of its own now, so the type fits the band it is in
  // rather than the band being whatever the type made it. An explicit `title_size` still wins.
  const nameSize = titleSize ?? Math.max(8, Math.round(h * nameShare * 0.46));
  // The gap between the strip's edges and the text in it — a share of the STRIP's height, not of
  // the name's size: with an explicit `title_size` the type no longer tracks the band, and a gap
  // measured off the type would then shrink as the strip grew. 16% is what the hard-coded
  // `nameSize * 0.35` drew at the default share, so an untouched card looks exactly as it did.
  const namePad = Math.round(h * nameShare * (Math.max(0, Math.min(40, nameMargin ?? 16)) / 100));
  const textSize = bodySize ?? Math.round(h * 0.05);

  /** The operator's framing from the profile dialog — pan is a share of the frame. */
  const zoom = Math.min(5, Math.max(1, card.zoom ?? 1));
  const panX = Math.min(1, Math.max(-1, card.panX ?? 0));
  const panY = Math.min(1, Math.max(-1, card.panY ?? 0));

  const reflStyle = reflOn
    ? reflectionInPlaneStylePct(
        {
          reflection: true,
          reflectionOpacity: reflectionOpacity ?? undefined,
          reflectionFeather: reflectionFeather ?? undefined,
        },
        reflectionDistance ?? 0,
      )
    : null;
  const reflBlur = Math.max(0, Math.min(40, reflectionBlur ?? 0));

  /**
   * 3D tilt — the Overlay Video Player's arrangement, and its arithmetic: perspective on the
   * wrapper, the rotation on the element that holds the card AND its mirror, so the two stay one
   * plane rather than the reflection detaching under a tilted card. The perspective depth is read
   * off the FOV against the card's own height (`h`, already halved when the mirror is on), which is
   * what makes a given FOV look the same on a card of any size.
   */
  const rotX = threedRotX ?? 0;
  const rotY = threedRotY ?? 0;
  const tilt = rotX !== 0 || rotY !== 0;
  /**
   * The card's own size, about its centre. It rides on the same element as the tilt, so the card
   * and its mirror scale as one plane — and it is deliberately NOT the photo's zoom: that one
   * crops the picture inside its band, this one makes the whole card bigger or smaller without
   * anyone dragging the layer's box in the Overlay tab. Above 1× it grows past that box, which
   * is why the CHinfocard layer does not clip.
   */
  const cardZoom = Math.min(2, Math.max(0.2, cardScale ?? 1));
  const persp = tilt && h ? (h / 2) / Math.tan(((threedFov ?? 90) * Math.PI / 180) / 2) : undefined;

  const photo = card.photoUrl
    ? (card.photoUrl.startsWith('http') ? card.photoUrl : `${API}${card.photoUrl}`)
    : null;

  /**
   * The card, drawn twice when the mirror is on: once upright and once flipped underneath it.
   *
   * A second render rather than a live clone, for the same reason Apologia does it — this is
   * static DOM, so drawing it again costs one layout, where `-webkit-box-reflect` on a compositor
   * layer costs a rasterisation per frame (the trap the video card is written up for).
   */
  const body = (
    <div style={{
      display: 'flex', flexDirection: 'column', gap,
      width: '100%', height: '100%',
      background: 'rgba(10, 12, 18, 0.86)',
      border: `1.5px solid ${accent}66`,
      borderLeft: `${Math.round(h * 0.012)}px solid ${accent}`,
      borderRadius: Math.round(h * 0.04),
      padding: pad,
      boxSizing: 'border-box',
      backdropFilter: 'blur(6px)',
      overflow: 'hidden',
    }}>
      {/* Image. The transform is the operator's own zoom and drag from the profile dialog,
          replayed here: percent pan against a picture that fills the band, so it lands where
          they put it whatever size the band is.

          **The separation eases.** The split is dragged and clicked live from the pop-out while
          the card is on air, and a band that jumps from a quarter of the card to most of it reads
          as a glitch — a cut nobody called. Moved over 420ms on an ease-in-out it reads as the
          card opening up, which is what it is. Nothing else about the card moves, so this is one
          animated property on one element. */}
      <div data-infocard-band="image" style={{
        position: 'relative', flex: `0 0 ${(imgShare * 100).toFixed(3)}%`, minHeight: 0,
        overflow: 'hidden', borderRadius: photoCorner, background: '#05070c',
        border: photoRing ? `${photoRing}px solid ${ringColor}` : 'none',
        transition: previewing ? undefined : 'flex-basis 420ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        {photo && (
          <img src={photo} alt="" style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
            transform: `translate(${panX * 100}%, ${panY * 100}%) scale(${zoom})`,
            transformOrigin: 'center center',
          }} />
        )}
      </div>

      {/* Name — the caption between the picture and the text, with a band of its own so the
          second separator has something to move. */}
      <div data-infocard-band="name" style={{
        display: 'flex', alignItems: 'center', gap: Math.round(nameSize * 0.4),
        flex: `0 0 ${(nameShare * 100).toFixed(3)}%`, minWidth: 0, minHeight: 0, overflow: 'hidden',
        transition: previewing ? undefined : 'flex-basis 420ms cubic-bezier(0.4, 0, 0.2, 1)',
        background: `${accent}1f`,
        borderTop: `1px solid ${accent}55`, borderBottom: `1px solid ${accent}55`,
        padding: `0 ${namePad}px`,
      }}>
        <span style={{
          fontFamily: titleFont, fontSize: nameSize, fontWeight: 800, color: '#fff',
          lineHeight: 1.15, letterSpacing: '-0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {card.name}
        </span>
        {card.username && (
          <span style={{
            fontFamily: bodyFont, fontSize: Math.round(textSize * 0.9), color: 'rgba(255,255,255,0.5)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            @{card.username}
          </span>
        )}
        <span style={{
          marginLeft: 'auto', flexShrink: 0,
          fontFamily: bodyFont, fontSize: Math.round(textSize * 0.8), fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.08em',
          color: accent, border: `1px solid ${accent}77`, borderRadius: 999,
          padding: `${Math.round(textSize * 0.12)}px ${Math.round(textSize * 0.45)}px`,
        }}>
          {card.role}
        </span>
      </div>

      {/* Profile text — whatever the other two bands have left. */}
      <div data-infocard-band="text" style={{
        flex: '1 1 auto', minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: Math.round(gap * 0.8),
      }}>
        {card.bio && (
          <div style={{
            fontFamily: bodyFont, fontSize: textSize, color: 'rgba(255,255,255,0.82)', lineHeight: 1.35,
            flex: '1 1 auto', minHeight: 0, overflow: 'hidden', whiteSpace: 'pre-wrap',
          }}>
            {card.bio}
          </div>
        )}

        {(card.followers != null || card.following != null) && (
          <div style={{
            display: 'flex', gap: Math.round(textSize * 1.2), flexShrink: 0,
            fontFamily: bodyFont, fontSize: Math.round(textSize * 0.95),
          }}>
            {card.followers != null && (
              <span style={{ color: 'rgba(255,255,255,0.75)' }}>
                <b style={{ color: '#fff' }}>{count(card.followers)}</b> followers
              </span>
            )}
            {card.following != null && (
              <span style={{ color: 'rgba(255,255,255,0.75)' }}>
                <b style={{ color: '#fff' }}>{count(card.following)}</b> following
              </span>
            )}
          </div>
        )}

        {/* What this show has counted about them — only for somebody the desk has met. */}
        {card.roomsAttended != null && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: `0 ${Math.round(textSize * 1.2)}px`, flexShrink: 0,
            fontFamily: bodyFont, fontSize: Math.round(textSize * 0.85), color: 'rgba(255,255,255,0.65)',
          }}>
            {card.listenerSince && <span>Listener since <b style={{ color: '#fff' }}>{card.listenerSince.slice(0, 10)}</b></span>}
            <span>Rooms attended <b style={{ color: '#fff' }}>{card.roomsAttended}</b></span>
            <span>Speech <b style={{ color: '#fff' }}>{speechLabel(card.talkMs ?? 0)}</b></span>
            <span>Drops <b style={{ color: '#fff' }}>{card.drops ?? 0}</b></span>
          </div>
        )}
      </div>
    </div>
  );

  /** The sequence's two acts wear the same frame as the card; only what is inside changes. */
  const frame: CSSProperties = {
    width: '100%', height: '100%',
    background: 'rgba(10, 12, 18, 0.86)',
    border: `1.5px solid ${accent}66`,
    borderLeft: `${Math.round(h * 0.012)}px solid ${accent}`,
    borderRadius: Math.round(h * 0.04),
    padding: pad,
    boxSizing: 'border-box',
    backdropFilter: 'blur(6px)',
    overflow: 'hidden',
  };
  const imageAct = (
    <div style={frame}>
      <div style={{
        position: 'relative', width: '100%', height: '100%', overflow: 'hidden',
        borderRadius: photoCorner, background: '#05070c',
        border: photoRing ? `${photoRing}px solid ${ringColor}` : 'none',
      }}>
        {photo && (
          <img src={photo} alt="" style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
            transform: `translate(${panX * 100}%, ${panY * 100}%) scale(${zoom})`,
            transformOrigin: 'center center',
          }} />
        )}
      </div>
    </div>
  );
  /**
   * The picture does not leave when the text arrives — it settles.
   *
   * On the text act the DP shrinks out of the full frame into a circle in the top-left corner and
   * the words read beside it. It is mounted at the picture's own geometry and moved a frame later,
   * so the browser has two states to tween between; without that first paint there is nothing to
   * transition FROM and the circle simply appears. The timeout is the card's own effect clock, so
   * the settle keeps pace with whatever speed the acts are set to.
   */
  const dp = Math.round(h * Math.min(60, Math.max(8, cardDpSize ?? 22)) / 100);
  const settleMs = Math.max(240, outMs);
  const dpBox: CSSProperties = dpSettled
    ? { left: 0, top: 0, width: dp, height: dp, borderRadius: '50%' }
    : { left: 0, top: 0, width: `calc(100% - ${pad * 2}px)`, height: `calc(100% - ${pad * 2}px)`, borderRadius: photoCorner };
  const textAct_ = (
    <div style={{ ...frame, position: 'relative', display: 'flex', flexDirection: 'column', gap: Math.round(gap * 1.2) }}>
      {photo && (
        <div style={{
          position: 'absolute', overflow: 'hidden', background: '#05070c', zIndex: 1,
          border: photoRing ? `${photoRing}px solid ${ringColor}` : 'none',
          transition: `all ${settleMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
          ...dpBox,
          marginLeft: pad, marginTop: pad,
        }}>
          <img src={photo} alt="" style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
            transform: `translate(${panX * 100}%, ${panY * 100}%) scale(${zoom})`,
            transformOrigin: 'center center',
          }} />
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: Math.round(nameSize * 0.5), minWidth: 0, flexShrink: 0,
        // Clear the circle. It rides in on a transition, so the words hold their place from the
        // first frame rather than being shoved sideways as it lands.
        paddingLeft: photo ? dp + Math.round(gap * 1.2) : 0,
        minHeight: photo ? dp : undefined,
        transition: `padding-left ${settleMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}>
        <span style={{
          fontFamily: titleFont, fontSize: Math.round(nameSize * 1.1), fontWeight: 800, color: '#fff',
          lineHeight: 1.1, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{card.name}</span>
        {card.username && (
          <span style={{ fontFamily: bodyFont, fontSize: textSize, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>
            @{card.username}
          </span>
        )}
      </div>
      <span style={{
        alignSelf: 'flex-start', fontFamily: bodyFont, fontSize: Math.round(textSize * 0.8), fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.08em', color: accent,
        border: `1px solid ${accent}77`, borderRadius: 999,
        padding: `${Math.round(textSize * 0.12)}px ${Math.round(textSize * 0.45)}px`,
      }}>{card.role}</span>
      {card.bio && (
        <div style={{
          fontFamily: bodyFont, fontSize: Math.round(textSize * 1.1), color: 'rgba(255,255,255,0.88)',
          lineHeight: 1.45, whiteSpace: 'pre-wrap', overflow: 'hidden', minHeight: 0,
        }}>{card.bio}</div>
      )}
      {(card.followers != null || card.following != null) && (
        <div style={{ display: 'flex', gap: Math.round(textSize * 1.2), fontFamily: bodyFont, fontSize: textSize, marginTop: 'auto' }}>
          {card.followers != null && <span style={{ color: 'rgba(255,255,255,0.75)' }}><b style={{ color: '#fff' }}>{count(card.followers)}</b> followers</span>}
          {card.following != null && <span style={{ color: 'rgba(255,255,255,0.75)' }}><b style={{ color: '#fff' }}>{count(card.following)}</b> following</span>}
        </div>
      )}
    </div>
  );
  /**
   * A card with nothing to read is drawn as the PICTURE, full frame — never as the three-band
   * card with two of its bands empty. `imageAct` is already exactly that rectangle, so the
   * thin case is not a fourth layout, it is the sequence's first act held indefinitely.
   */
  const shown = card.thin ? imageAct : seq.style !== 'sequence' ? body : textAct ? textAct_ : imageAct;

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', pointerEvents: 'none', opacity: opacity ?? 1,
      perspective: persp,
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, width: '100%',
        height: reflOn ? '50%' : '100%',
        transform: [
          cardZoom !== 1 ? `scale(${cardZoom})` : '',
          tilt ? `rotateX(${rotX}deg) rotateY(${rotY}deg)` : '',
        ].filter(Boolean).join(' ') || undefined,
        transformOrigin: 'center center',
        ...reflectionObjectStyle({ reflection: reflOn, reflectionOpacityMain: reflectionOpacityMain ?? undefined }),
        ...fx,
      }}>
        {shown}
        {reflStyle && (
          <div aria-hidden style={{ ...reflStyle, filter: reflBlur > 0 ? `blur(${reflBlur}px)` : undefined }}>
            {shown}
          </div>
        )}
      </div>
    </div>
  );
}
