/**
 * The app's short notification sounds, synthesized — no audio files to ship or license. Each
 * ring gets fresh oscillators, so a second hand going up in the same second is still audible;
 * an autoplay refusal (a tab nobody has clicked yet) is simply silent, and every caller pairs the
 * sound with something visible.
 */
export const CHIME = {
  /** A hand going up in the room. */
  bell: [880, 1320],
} as const;

let ctx: AudioContext | null = null;

export function chime(partials: readonly number[]): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    const now = ctx.currentTime;
    partials.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const peak = 0.25 / (i + 1);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(now);
      osc.stop(now + 1.7);
    });
  } catch { /* no audio in this browser — the notice still shows */ }
}
