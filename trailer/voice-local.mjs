// Generates the trailer narration on this machine with Kokoro (open source, Apache 2.0; no account, no key),
// one MP3 per line, into trailer/voice/. The first run downloads the model (about 90 MB) from Hugging Face.
//
//   node voice-local.mjs                     all lines (overwrites)
//   node voice-local.mjs --only 07           one line
//   node voice-local.mjs --voice bm_george   another voice (am_michael, am_onyx, am_fenrir, bm_george, bm_lewis...)
//
// Kokoro has no emotion control, so the four moods are shaped with speaking speed and the length of the pauses
// written as "..." in client/src/film/script.ts.
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { KokoroTTS } from 'kokoro-js';

const here = dirname(fileURLToPath(import.meta.url));
const { LINES } = await import(new URL('../client/src/film/script.ts', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const VOICE = opt('voice', 'am_michael');
const only = opt('only', null);

// restrained and slow -> warmer -> playful -> warm and confident
const MOOD = {
  opening: { speed: 0.84, pause: 0.6 },
  warm: { speed: 0.9, pause: 0.45 },
  play: { speed: 1.02, pause: 0.3 },
  ending: { speed: 0.88, pause: 0.55 },
};

const outDir = join(here, 'voice');
mkdirSync(outDir, { recursive: true });
console.log(`loading Kokoro (voice ${VOICE})...`);
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });

function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

/** Trims silence at both ends of a clip (Kokoro adds some), so pauses are exactly what we ask for. */
function trim(a, rate) {
  const th = 0.012, pad = Math.round(rate * 0.03);
  let s = 0, e = a.length - 1;
  while (s < e && Math.abs(a[s]) < th) s++;
  while (e > s && Math.abs(a[e]) < th) e--;
  return a.subarray(Math.max(0, s - pad), Math.min(a.length, e + pad));
}

const results = [];
for (const line of LINES) {
  if (only && line.id !== only) continue;
  const mood = MOOD[line.mood];
  const parts = line.say.split('...').map((p) => p.trim()).filter(Boolean);
  let rate = 24000;
  const pieces = [];
  for (const [i, p] of parts.entries()) {
    const text = i < parts.length - 1 && !/[.!?,]$/.test(p) ? `${p},` : p;
    const audio = await tts.generate(text, { voice: VOICE, speed: mood.speed });
    rate = audio.sampling_rate;
    pieces.push(trim(audio.audio, rate));
    if (i < parts.length - 1) pieces.push(new Float32Array(Math.round(rate * mood.pause)));
  }
  const total = pieces.reduce((n, p) => n + p.length, 0), all = new Float32Array(total);
  let o = 0; for (const p of pieces) { all.set(p, o); o += p.length; }
  const tmp = join(outDir, `${line.id}.tmp.wav`), file = join(outDir, `${line.id}.mp3`);
  writeFileSync(tmp, wav(all, rate));
  // a little warmth and presence, consistent level per line
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmp,
    '-af', 'highpass=f=70,equalizer=f=160:t=q:w=1:g=2.5,equalizer=f=3200:t=q:w=1.2:g=1.5,loudnorm=I=-18:TP=-2:LRA=7',
    '-ar', '44100', '-ac', '1', '-b:a', '192k', file]);
  unlinkSync(tmp);
  const secs = total / rate;
  results.push({ line, secs });
  console.log(`${line.id}  ${secs.toFixed(2)} s  "${line.text}"`);
}

// timing check: a line should end before the next one starts
if (!only) {
  let ok = true;
  for (const [i, { line, secs }] of results.entries()) {
    const next = LINES[i + 1];
    if (next && line.at + secs > next.at - 0.15) { ok = false; console.log(`TIMING ${line.id}: ends at ${(line.at + secs).toFixed(2)} s, next starts ${next.at} s`); }
  }
  console.log(ok ? 'All lines fit their slots.' : 'Some lines need re-timing in client/src/film/script.ts.');
}
