import { fetch as undiciFetch } from 'undici';
import { env } from '../env.js';

// HTTP client for the audio engine (engine/, the sole owner of the Agora RTC connection).
// The server calls these instead of loading the native SDK itself — agora-electron-sdk
// needs an Electron runtime and cannot load in plain Node.
const AUDIO_API = env.AUDIO_URL;

export class AudioEngineUnreachableError extends Error {
  readonly status = 503;
  readonly audioEngineDown = true;
  constructor(cause: unknown) {
    const code = (cause as any)?.cause?.code ?? (cause as any)?.code ?? '';
    super(
      code === 'ECONNREFUSED'
        ? `The StudioCall audio engine is not running at ${AUDIO_API}. Start it with start.ps1 in the StudioCall folder, then try again.`
        : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
          ? `The StudioCall audio engine at ${AUDIO_API} timed out. It is running but not responding — restart it.`
          : `Cannot reach the StudioCall audio engine at ${AUDIO_API}${code ? ` (${code})` : ''}.`,
    );
    this.name = 'AudioEngineUnreachableError';
  }
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  let res;
  try {
    res = await undiciFetch(`${AUDIO_API}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new AudioEngineUnreachableError(e);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(json?.error ?? `audio engine ${res.status}`);
  return json;
}

export const audioHealth = () => call('GET', '/health');
export const audioDevices = () => call('GET', '/devices');
export const audioSpeaking = () => call('GET', '/speaking');
export const audioLeave = () => call('POST', '/leave');

// Broadcaster or audience, inside the live channel. An audience client publishes nothing
// however its mute button reads, so this is what going on stage actually requires.
export const audioRole = (speaker: boolean) => call('POST', '/role', { speaker });
export const audioMute = (muted: boolean) => call('POST', '/mute', { muted });

// The room mix played out to the pinned playback device — what OBS hears. `volume` is
// Agora's 0..400 with 100 = unity; `muted` silences the room without leaving it.
export const audioOutput = (p: { volume?: number; muted?: boolean }) => call('POST', '/output', p);

// `stereo` is the send format, not a device: mono (Agora's MusicHighQuality) or stereo
// (MusicHighQualityStereo + stereo pre-processing). Agora reads it at join, so a change
// only lands on the next one — the caller arranges that, the same as a device change.
export const audioSetDevices = (p: {
  appId?: string; recordingName?: string | null; playbackName?: string | null; stereo?: boolean;
}) => call('POST', '/devices', p);

export const audioJoin = (p: { appId: string; token: string; channel: string; uid: number; asSpeaker: boolean }) =>
  call('POST', '/join', p);

// Whether the engine is reachable at all, for a status dot that must not throw.
export async function audioReachable(): Promise<boolean> {
  try { await audioHealth(); return true; } catch { return false; }
}
