// Generates the trailer narration with ElevenLabs, one MP3 per line, into trailer/voice/.
//
//   node voice.mjs            generate missing lines
//   node voice.mjs --force    regenerate every line
//   node voice.mjs --only 07  regenerate one line
//
// The key is read from the environment (ELEVENLABS_API_KEY) or from trailer/.env (git-ignored). It is only sent
// to api.elevenlabs.io. Optional: ELEVENLABS_VOICE_ID (default: Brian, a deep male narration voice),
// ELEVENLABS_MODEL (default eleven_multilingual_v2).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const here = dirname(fileURLToPath(import.meta.url));
const { LINES } = await import(new URL('../client/src/film/script.ts', import.meta.url));

function env(name) {
  if (process.env[name]) return process.env[name].trim();
  const file = join(here, '.env');
  if (!existsSync(file)) return null;
  const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}
const key = env('ELEVENLABS_API_KEY');
if (!key) { console.error('No ELEVENLABS_API_KEY: put it in trailer/.env (ELEVENLABS_API_KEY=...) or the environment.'); process.exit(1); }
const voice = env('ELEVENLABS_VOICE_ID') ?? 'nPczCjzI2devNBz1zQrb';   // Brian
const model = env('ELEVENLABS_MODEL') ?? 'eleven_multilingual_v2';

// one voice, four deliveries: restrained and slow -> warmer -> playful -> warm and confident
const MOOD = {
  opening: { stability: 0.62, similarity_boost: 0.8, style: 0.18, use_speaker_boost: true, speed: 0.88 },
  warm: { stability: 0.5, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true, speed: 0.93 },
  play: { stability: 0.38, similarity_boost: 0.78, style: 0.58, use_speaker_boost: true, speed: 1.0 },
  ending: { stability: 0.55, similarity_boost: 0.8, style: 0.4, use_speaker_boost: true, speed: 0.9 },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const outDir = join(here, 'voice');
mkdirSync(outDir, { recursive: true });

const duration = (file) => {
  try { execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) {
    const m = String(e.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return null;
};

for (const [i, line] of LINES.entries()) {
  const file = join(outDir, `${line.id}.mp3`);
  if (only && line.id !== only) continue;
  if (existsSync(file) && !force && !only) { console.log(`${line.id} exists`); continue; }
  const body = {
    text: line.say, model_id: model, voice_settings: MOOD[line.mood],
    previous_text: LINES[i - 1]?.say, next_text: LINES[i + 1]?.say,
  };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_192`, {
    method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    // speed is newer; retry without it if the account/model refuses it
    const msg = await r.text();
    if (/speed/i.test(msg)) { delete body.voice_settings.speed; }
    else { console.error(`${line.id} failed: ${r.status} ${msg.slice(0, 300)}`); process.exit(1); }
    const r2 = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_192`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body),
    });
    if (!r2.ok) { console.error(`${line.id} failed: ${r2.status} ${(await r2.text()).slice(0, 300)}`); process.exit(1); }
    writeFileSync(file, Buffer.from(await r2.arrayBuffer()));
  } else writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  console.log(`${line.id} ${duration(file)?.toFixed(2)} s  "${line.text}"`);
}

// timing check: a line should end before the next one starts
let ok = true;
for (const [i, line] of LINES.entries()) {
  const file = join(outDir, `${line.id}.mp3`);
  if (!existsSync(file)) { console.log(`${line.id} missing`); ok = false; continue; }
  const d = duration(file), next = LINES[i + 1];
  const gap = next ? next.at - (line.at + d) : null;
  if (gap !== null && gap < 0.15) { ok = false; console.log(`TIMING ${line.id}: ${d.toFixed(2)} s, overlaps the next line by ${(-gap).toFixed(2)} s`); }
}
console.log(ok ? 'All lines fit their slots.' : 'Some lines need re-timing (move the next line in client/src/film/script.ts).');
