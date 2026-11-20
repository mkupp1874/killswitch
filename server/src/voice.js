// ElevenLabs: text-to-speech for spoken alerts, speech-to-text (Scribe) for voice commands.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

const API = 'https://api.elevenlabs.io/v1';
const AUDIO_DIR = path.join(ROOT, 'public', 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

export const voiceEnabled = () => Boolean(config.elevenlabs.apiKey);

/** Speak `text`, save an mp3 under /audio, return its URL (or null when no key is set). */
export async function speak(text, id) {
  if (!voiceEnabled()) return null;
  const { voiceId, ttsModel, apiKey } = config.elevenlabs;
  const res = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: ttsModel,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
  const file = `${id}.mp3`;
  fs.writeFileSync(path.join(AUDIO_DIR, file), Buffer.from(await res.arrayBuffer()));
  return `/audio/${file}`;
}

/** Transcribe a short voice command recorded in the browser. */
export async function transcribe(buffer, mime = 'audio/webm', filename = 'command.webm') {
  if (!voiceEnabled()) throw new Error('ELEVENLABS_API_KEY not set');
  const form = new FormData();
  form.append('model_id', config.elevenlabs.sttModel);
  form.append('language_code', 'en');
  form.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${API}/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenlabs.apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.text ?? '').trim();
}

/**
 * Turn a transcript into an action. Deterministic on purpose: a voice command that moves money
 * should never depend on an LLM guessing. Returns { action, target } or { action: 'unknown' }.
 *   "approve it" / "yes, pay it"           -> approve the most recent held charge
 *   "kill it" / "block CloudTool" / "no"   -> reject + kill (named merchant, or most recent alert)
 *   "pause the agent" / "kill everything"  -> kill every active mandate
 */
export function parseCommand(text, mandates = []) {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9$ ]/g, ' ')} `;
  const named = [...mandates].reverse().filter((m) => {
    const first = m.label.toLowerCase().split(/[\s(]/)[0];
    return first.length > 2 && t.includes(` ${first}`);
  });
  const target = named.find((m) => m.active) ?? named[0]; // newest live match first
  if (/\b(kill|stop|freeze|pause) (everything|all|the agent|my agent)\b/.test(t)) return { action: 'kill-all' };
  if (/\b(kill|block|cancel|stop|reject|deny|no|nope|don t)\b/.test(t)) return { action: 'kill', target: target?.id ?? null };
  if (/\b(approve|yes|yeah|allow|pay it|go ahead|accept|ok|okay)\b/.test(t)) return { action: 'approve', target: target?.id ?? null };
  return { action: 'unknown' };
}
