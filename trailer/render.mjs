// Renders the REST IN PUMP trailer.
//
//   node render.mjs                       full trailer -> out/REST-IN-PUMP-Trailer.mp4
//   node render.mjs --from 20 --to 34     a section -> out/section-20-34.mp4 (quick checks)
//   node render.mjs --audio-only          only rebuild out/audio.wav and re-mux with the last video
//   node render.mjs --stills 5,13,22      single frames -> out/still-<t>.jpg
//   options: --no-build (skip the client build), --fps 30, --quality 92
//
// How it works: starts the game server on a private port with an in-memory database (nothing real is touched),
// opens /?film&capture in headless Chromium, and steps the trailer one frame at a time (window.__film.frame),
// screenshotting each frame into FFmpeg. So the result is smooth whatever the machine's speed. Then it builds the
// soundtrack offline in the page (mix.js: the game's music, synthesized sound effects, narration from voice/ with
// ducking) and muxes H.264 + AAC.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const FPS = Number(opt('fps', 30)), QUALITY = Number(opt('quality', 92));
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- 1. client build
if (!has('no-build') && !has('audio-only')) {
  log('building the client');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
}

// ---- 2. a private game server (in-memory database, local only)
const server = spawn(process.execPath, ['server/src/index.ts'], {
  cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: ':memory:', NODE_ENV: 'development', LOG_LEVEL: 'warn' },
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

// ---- 3. the browser
// some Windows setups block chrome.exe from starting; the headless shell build works there (CHROMIUM_PATH overrides)
function findBrowser() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const exe = join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}
const browser = await chromium.launch({
  headless: true, executablePath: findBrowser(),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, bypassCSP: true });   // the game's CSP blocks injected scripts; only this private render bypasses it
page.on('pageerror', (e) => console.error('[page]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[page console]', m.text()); });
await page.goto(`${BASE}/?film&capture`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__filmReady === true, null, { timeout: 120_000 });
const gl = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const e = c?.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
log('renderer:', gl);
const END = await page.evaluate(() => window.__film.end);

// real narration lengths: captions follow the voice, and an .srt is written next to the video
function mediaSeconds(file) {
  try { execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) {
    const m = String(e.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return null;
}
const LINES = (await page.evaluate(() => window.__film.cues())).lines;
const durations = {};
for (const l of LINES) { const d = mediaSeconds(join(here, 'voice', `${l.id}.mp3`)); if (d) durations[l.id] = d; }
await page.evaluate((d) => window.__film.setCaptions(d), durations);
function writeSrt(file) {
  const ts = (x) => { const ms = Math.round(x * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const body = LINES.map((l, i) => `${i + 1}\n${ts(l.at)} --> ${ts(l.at + (durations[l.id] ?? l.text.split(' ').length * 0.36) + 0.25)}\n${l.text}\n`).join('\n');
  writeFileSync(file, body);
  log('captions written:', file);
}

async function captureRange(from, to, file) {
  await page.evaluate((f) => window.__film.begin(f), from);
  const enc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round((to - from) * FPS);
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    for (let tries = 0; ; tries++) {
      const r = await page.evaluate((dt) => window.__film.frame(dt), 1 / FPS);
      if (r.advanced) break;
      if (tries > 300) throw new Error(`stuck waiting at ${r.t.toFixed(2)} s (a network answer never came)`);
      await new Promise((res) => setTimeout(res, 100));
    }
    const jpg = await page.screenshot({ type: 'jpeg', quality: QUALITY });
    if (!enc.stdin.write(jpg)) await new Promise((res) => enc.stdin.once('drain', res));
    if (i % (FPS * 5) === 0) log(`frame ${i}/${frames}  t=${(from + i / FPS).toFixed(1)} s  ${((Date.now() - t0) / 1000 / Math.max(1, i)).toFixed(2)} s/frame`);
  }
  enc.stdin.end();
  await new Promise((res) => enc.on('close', res));
  log('video written:', file);
}

async function buildAudio(from, to, file) {
  const cues = await page.evaluate(() => window.__film.cues());
  const voices = {};
  const vdir = join(here, 'voice');
  for (const line of cues.lines) { const f = join(vdir, `${line.id}.mp3`); if (existsSync(f)) voices[line.id] = readFileSync(f).toString('base64'); }
  const missing = cues.lines.filter((l) => !voices[l.id]).map((l) => l.id);
  if (missing.length) log(`NARRATION MISSING for lines ${missing.join(', ')} (run: node voice.mjs). Rendering without them.`);
  await page.addScriptTag({ content: readFileSync(join(here, 'mix.js'), 'utf8') });
  const info = await page.evaluate((a) => window.mixTrailer(a), { cues, voices, from, to });
  const parts = [];
  for (let i = 0; i < info.chunks; i++) parts.push(Buffer.from(await page.evaluate((k) => window.__mix[k], i), 'base64'));
  writeFileSync(file, Buffer.concat(parts));
  log(`audio written: ${file} (${info.seconds.toFixed(1)} s, peak ${info.peak.toFixed(2)})`);
  return missing;
}

function mux(video, audio, file) {
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
    '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', file], { stdio: 'inherit' });
  log('done:', file);
}

try {
  if (has('stills')) {
    for (const s of opt('stills', '').split(',').map(Number)) {
      await page.evaluate((x) => window.__film.seek(x), s);
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__film.frame(0.0001));
      await page.screenshot({ path: join(out, `still-${s}.jpg`), type: 'jpeg', quality: 90 });
      log('still', s);
    }
  } else {
    const from = Number(opt('from', 0)), to = Math.min(END, Number(opt('to', END)));
    const full = from === 0 && to === END;
    const name = full ? 'REST-IN-PUMP-Trailer' : `section-${from}-${to}`;
    const video = join(out, `${name}.video.mp4`), audio = join(out, `${name}.wav`);
    if (!has('audio-only')) await captureRange(from, to, video);
    const missing = await buildAudio(from, to, audio);
    mux(video, audio, join(out, `${name}.mp4`));
    if (full) writeSrt(join(out, `${name}.srt`));
    if (missing.length) log(`NOTE: ${missing.length} narration lines were missing from this render.`);
  }
} finally {
  await browser.close();
  stop();
}
