// Runs inside the film page (injected by render.mjs). Builds the whole soundtrack offline with Web Audio:
// the game's own music tracks placed on the timeline, synthesized transitions and sound effects (original), the
// narration with music ducking underneath, then returns a 48 kHz stereo 16-bit WAV in base64 chunks.
window.mixTrailer = async function mixTrailer({ cues, voices, from = 0, to }) {
  const SR = 48000, END = to ?? cues.end, LEN = Math.ceil((END - from) * SR);
  const ctx = new OfflineAudioContext(2, LEN, SR);
  const T = (t) => t - from;                      // timeline -> render time
  const live = (t0, t1) => t1 > from && t0 < END;

  // ---- buses: music (ducked), sfx, voice -> master (gentle glue + safety limiter)
  const master = ctx.createGain(); master.gain.value = 0.9;
  const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -14; glue.ratio.value = 2.5; glue.attack.value = 0.01; glue.release.value = 0.25;
  const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -2; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.08;
  master.connect(glue).connect(limiter).connect(ctx.destination);
  const music = ctx.createGain(); music.connect(master);
  const sfx = ctx.createGain(); sfx.gain.value = 0.8; sfx.connect(master);
  const voice = ctx.createGain(); voice.gain.value = 1.0;
  const vComp = ctx.createDynamicsCompressor(); vComp.threshold.value = -20; vComp.ratio.value = 3; vComp.attack.value = 0.005; vComp.release.value = 0.15;
  voice.connect(vComp).connect(master);

  // a small generated room for the opening (sfx and a touch on the voice)
  const ir = ctx.createBuffer(2, SR * 2.6, SR);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2); }
  const verb = ctx.createConvolver(); verb.buffer = ir;
  const verbOut = ctx.createGain(); verbOut.gain.value = 0.32; verb.connect(verbOut).connect(master);
  const sfxSend = ctx.createGain(); sfxSend.gain.value = 0.35; sfx.connect(sfxSend).connect(verb);
  const vSend = ctx.createGain(); vSend.gain.value = 0.06; vComp.connect(vSend).connect(verb);

  // ---- helpers
  const noise = ctx.createBuffer(1, SR * 2, SR);
  { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const hz = (n) => { const m = /^([A-G])(#?)(\d)$/.exec(n); const i = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0); return 440 * Math.pow(2, (i - 9) / 12 + (+m[3] - 4)); };
  const env = (g, t, a, d, peak, sustain = 0) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), t + a + d); };
  const osc = (type, f, t, dur, out) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.connect(out); o.start(t); o.stop(t + dur + 0.05); return o; };
  const nz = (t, dur, out, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.playbackRate.value = rate; s.connect(out); s.start(t, Math.random()); s.stop(t + dur + 0.05); return s; };
  const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const load = async (url) => { const r = await fetch(url); return ctx.decodeAudioData(await r.arrayBuffer()); };
  const b64buf = async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return ctx.decodeAudioData(u.buffer); };

  // ---- sound effects (original, synthesized; the cry is the game's own sample)
  const cry = await load('/audio/cry.mp3');
  const S = {
    crow(t, g) { for (let k = 0; k < 3; k++) { const at = t + k * 0.34, out = ctx.createGain(); env(out, at, 0.01, 0.24, 0.32 * g); const bp = filt('bandpass', 1300, 3); bp.connect(out).connect(sfx); const o = osc('sawtooth', 560 - k * 25, at, 0.26, bp); o.frequency.exponentialRampToValueAtTime(330, at + 0.24); nz(at, 0.2, bp, 0.6); } },
    step(t, g) { const out = ctx.createGain(); env(out, t, 0.004, 0.08, 0.35 * g); const lp = filt('lowpass', 700); lp.connect(out).connect(sfx); nz(t, 0.1, lp, 0.5); },
    notice(t, g) { [880, 1318].forEach((f, i) => { const out = ctx.createGain(); env(out, t + i * 0.06, 0.005, 0.9, 0.12 * g); osc('sine', f, t + i * 0.06, 1, out).connect(out); out.connect(sfx); }); },
    cry(t, g) { const s = ctx.createBufferSource(); s.buffer = cry; const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(0.5 * g, t + 0.15); out.gain.setValueAtTime(0.5 * g, t + 2.6); out.gain.linearRampToValueAtTime(0.0001, t + 3.4); s.connect(out).connect(sfx); s.start(t, 0.2); s.stop(t + 3.5); },
    candle(t, g) { const hp = filt('highpass', 2500); const o1 = ctx.createGain(); env(o1, t, 0.005, 0.25, 0.25 * g); hp.connect(o1).connect(sfx); nz(t, 0.3, hp); ['C6', 'E6', 'G6'].forEach((n, i) => S._chime(hz(n), t + 0.25 + i * 0.09, 0.2 * g)); },
    _chime(f, t, peak) { const g = ctx.createGain(); env(g, t, 0.005, 1.4, peak); osc('sine', f, t, 1.5, g); osc('sine', f * 2.01, t, 0.6, g); g.connect(sfx); },
    pop(t, g) { const out = ctx.createGain(); env(out, t, 0.004, 0.12, 0.18 * g); const o = osc('sine', 320, t, 0.14, out); o.frequency.exponentialRampToValueAtTime(760, t + 0.1); out.connect(sfx); },
    gift(t, g) { ['C6', 'E6', 'G6', 'C7'].forEach((n, i) => S._chime(hz(n), t + i * 0.07, 0.17 * g)); },
    boing(t, g) { const out = ctx.createGain(); env(out, t, 0.01, 0.7, 0.3 * g); const o = osc('sine', 180, t, 0.75, out); o.frequency.linearRampToValueAtTime(520, t + 0.12); o.frequency.exponentialRampToValueAtTime(200, t + 0.7); const lfo = osc('sine', 18, t, 0.75, ctx.createGain()); const lg = ctx.createGain(); lg.gain.value = 30; lfo.disconnect(); lfo.connect(lg).connect(o.frequency); out.connect(sfx); },
    scratch(t, g) { const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(0.45 * g, t + 0.02); out.gain.exponentialRampToValueAtTime(0.0001, t + 0.42); const bp = filt('bandpass', 1800, 4); bp.frequency.setValueAtTime(2200, t); bp.frequency.exponentialRampToValueAtTime(350, t + 0.18); bp.frequency.exponentialRampToValueAtTime(1900, t + 0.38); bp.connect(out).connect(master); nz(t, 0.45, bp, 1.5); const o = osc('sawtooth', 300, t, 0.4, bp); o.frequency.exponentialRampToValueAtTime(90, t + 0.18); o.frequency.exponentialRampToValueAtTime(260, t + 0.38); },
    whoosh(t, g) { const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.4 * g, t + 0.5); out.gain.exponentialRampToValueAtTime(0.0001, t + 0.75); const bp = filt('bandpass', 300, 1.2); bp.frequency.exponentialRampToValueAtTime(3500, t + 0.6); bp.connect(out).connect(sfx); nz(t, 0.8, bp); },
    impact(t, g) { const out = ctx.createGain(); env(out, t, 0.003, 1.6, 0.9 * g); const o = osc('sine', 95, t, 1.7, out); o.frequency.exponentialRampToValueAtTime(38, t + 1.2); out.connect(master); const n = ctx.createGain(); env(n, t, 0.002, 0.4, 0.4 * g); const lp = filt('lowpass', 900); lp.connect(n).connect(sfx); nz(t, 0.5, lp); },
    shimmer(t, g) { ['C7', 'G6', 'E7', 'C7', 'G7', 'E7'].forEach((n, i) => S._chime(hz(n), t + i * 0.06, 0.07 * g)); },
    title(t, g) { const out = ctx.createGain(); env(out, t, 0.003, 0.25, 0.35 * g); const o = osc('sine', 150, t, 0.3, out); o.frequency.exponentialRampToValueAtTime(60, t + 0.25); out.connect(sfx); S.key(t, g * 0.8); },
    key(t, g) { const out = ctx.createGain(); env(out, t, 0.001, 0.025, 0.25 * g); const hp = filt('highpass', 2800); hp.connect(out).connect(sfx); nz(t, 0.04, hp); },
    click(t, g) { const out = ctx.createGain(); env(out, t, 0.002, 0.06, 0.22 * g); const o = osc('triangle', 900, t, 0.07, out); o.frequency.exponentialRampToValueAtTime(600, t + 0.05); out.connect(sfx); },
    bell(t, g) { [[hz('A2'), 0.45, 3.5], [hz('A3'), 0.15, 2.5], [hz('A2') * 2.76, 0.08, 1.6]].forEach(([f, p, d]) => { const out = ctx.createGain(); env(out, t, 0.004, d, p * g); osc('sine', f, t, d + 0.1, out); out.connect(sfx); }); },
    thud(t, g) { const out = ctx.createGain(); env(out, t, 0.003, 0.35, 0.6 * g); const lp = filt('lowpass', 220); lp.connect(out).connect(sfx); nz(t, 0.4, lp, 0.4); },
    levelup(t, g) { S.gift(t, g * 0.6); [['A4', 0], ['C#5', 0.12], ['E5', 0.24], ['A5', 0.36], ['A5', 0.62]].forEach(([n, d], i) => { const lp = filt('lowpass', 2400), out = ctx.createGain(), at = t + d; env(out, at, 0.01, i === 4 ? 0.9 : 0.2, 0.17 * g); osc('sawtooth', hz(n), at, 1, lp); lp.connect(out).connect(sfx); }); S.shimmer(t + 0.6, g); },
    flip(t, g) { const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.25 * g, t + 0.12); out.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); const bp = filt('bandpass', 800, 1.5); bp.frequency.exponentialRampToValueAtTime(4000, t + 0.25); bp.connect(out).connect(sfx); nz(t, 0.32, bp); S._chime(hz('E6'), t + 0.2, 0.08 * g); },
    evolve(t, g) { const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.22 * g, t + 0.95); out.gain.setValueAtTime(0.0001, t + 1.0); const trem = ctx.createGain(); const lfo = osc('sine', 6, t, 1.05, ctx.createGain()); lfo.disconnect(); const lg = ctx.createGain(); lg.gain.setValueAtTime(0.2, t); lg.gain.linearRampToValueAtTime(0.5, t + 1); lfo.frequency.exponentialRampToValueAtTime(28, t + 1); lfo.connect(lg).connect(trem.gain); trem.connect(out).connect(sfx); for (const m of [1, 1.5, 2]) { const o = osc('sine', 260 * m, t, 1.05, trem); o.frequency.exponentialRampToValueAtTime(1300 * m, t + 1.0); } const hp = filt('highpass', 5000); const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.12 * g, t + 0.95); ng.gain.setValueAtTime(0.0001, t + 1.0); hp.connect(ng).connect(sfx); nz(t, 1.05, hp); },
    node(t, g) { const out = ctx.createGain(); env(out, t, 0.004, 0.5, 0.16 * g); osc('triangle', 660, t, 0.55, out); osc('sine', 990, t, 0.4, out); out.connect(sfx); },
    coins(t, g) { for (let k = 0; k < 7; k++) { const at = t + k * 0.055 + Math.random() * 0.02; const out = ctx.createGain(); env(out, at, 0.001, 0.25, 0.09 * g); osc('sine', 2600 + Math.random() * 1600, at, 0.3, out); osc('sine', 5200 + Math.random() * 1500, at, 0.15, out); out.connect(sfx); } },
    'wind-in'() { /* the wind bed is a music part */ },
  };
  for (const c of cues.sfx) if (live(c.at, c.at + 3) && S[c.kind]) S[c.kind](Math.max(0, T(c.at)), c.gain ?? 1);

  // ---- music: the game's tracks plus synthesized parts
  const tracks = {};
  for (const m of cues.music) if (!m.src.startsWith('synth:') && !tracks[m.src]) tracks[m.src] = await load(`/audio/${m.src}.mp3`);
  for (const m of cues.music) {
    if (!live(m.at, m.until)) continue;
    const out = ctx.createGain(); out.connect(music);
    const a = Math.max(0, T(m.at)), b = T(m.until), skip = Math.max(0, from - m.at);
    const fi = m.fadeIn ?? 0.05, fo = m.fadeOut ?? 0.5;
    out.gain.setValueAtTime(0.0001, a);
    out.gain.linearRampToValueAtTime(m.gain, Math.min(b, a + Math.max(0.01, fi - skip)));
    out.gain.setValueAtTime(m.gain, Math.max(a, b - fo));
    out.gain.linearRampToValueAtTime(0.0001, b);
    if (m.src === 'synth:wind') {
      const lp = filt('lowpass', 420, 0.9); const lfo = osc('sine', 0.13, a, b - a, ctx.createGain()); lfo.disconnect(); const lg = ctx.createGain(); lg.gain.value = 180; lfo.connect(lg).connect(lp.frequency);
      lp.connect(out); nz(a, b - a, lp, 0.35);
      continue;
    }
    if (m.src === 'synth:hope') {
      // warm pads (C - G - Am - F, rising), a plucked arpeggio that speeds up, then a riser into the drop
      const chords = [['C3', 'E4', 'G4', 'C5'], ['G2', 'D4', 'G4', 'B4'], ['A2', 'C4', 'E4', 'A4'], ['F2', 'C4', 'F4', 'A4'], ['F2', 'C4', 'F4', 'A4'], ['G2', 'D4', 'G4', 'B4']];
      const span = (m.until - m.at) - 1.2, step = span / chords.length;
      const lp = filt('lowpass', 600, 0.8); lp.frequency.setValueAtTime(600, a); lp.frequency.exponentialRampToValueAtTime(3200, b); lp.connect(out);
      chords.forEach((ch, i) => {
        const at = m.at + i * step; if (!live(at, at + step + 1)) return;
        const ta = Math.max(0, T(at));
        for (const n of ch) for (const det of [-6, 6]) { const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, ta); g.gain.linearRampToValueAtTime(0.05, ta + 0.6); g.gain.linearRampToValueAtTime(0.0001, ta + step + 0.6); const o = osc('sawtooth', hz(n), ta, step + 0.7, g); o.detune.value = det; g.connect(lp); }
      });
      let at = m.at + 1.5, gap = 0.5, k = 0;
      const arp = ['C5', 'E5', 'G5', 'C6', 'G5', 'E5'];
      while (at < m.until - 0.4) { if (live(at, at + 0.4)) { const ta = T(at), g = ctx.createGain(); env(g, ta, 0.004, 0.35, 0.06 + 0.05 * ((at - m.at) / span)); osc('triangle', hz(arp[k % arp.length]), ta, 0.4, g); g.connect(out); } k++; at += gap; gap = Math.max(0.16, gap * 0.95); }
      const rs = T(m.until - 2.2), rg = ctx.createGain(); rg.gain.setValueAtTime(0.0001, Math.max(0, rs)); rg.gain.exponentialRampToValueAtTime(0.25, T(m.until) - 0.02); rg.gain.setValueAtTime(0.0001, T(m.until));
      const hp = filt('bandpass', 400, 1); hp.frequency.setValueAtTime(400, Math.max(0, rs)); hp.frequency.exponentialRampToValueAtTime(6000, T(m.until)); hp.connect(rg).connect(out); nz(Math.max(0, rs), 2.3, hp);
      continue;
    }
    const s = ctx.createBufferSource(); s.buffer = tracks[m.src];
    let node = s;
    if (m.lowpass) { const lp = filt('lowpass', m.lowpass[0]); lp.frequency.setValueAtTime(m.lowpass[0], a); lp.frequency.linearRampToValueAtTime(m.lowpass[1], Math.max(a + 0.1, T(Math.min(m.until, 20)))); s.connect(lp); node = lp; }
    node.connect(out);
    s.start(a, (m.offset ?? 0) + skip);
    s.stop(b + 0.05);
  }
  // the ending: a held warm chord under the title card
  if (live(cues.end - 4.8, END)) {
    const ta = Math.max(0, T(cues.end - 4.8)), tb = T(END);
    const lp = filt('lowpass', 1800); const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, ta); g.gain.linearRampToValueAtTime(0.06, ta + 1.2); g.gain.linearRampToValueAtTime(0.0001, tb); lp.connect(g).connect(music);
    for (const n of ['A2', 'E3', 'A3', 'C#4', 'E4']) for (const det of [-5, 5]) { const o = osc('sawtooth', hz(n), ta, tb - ta, lp); o.detune.value = det; }
  }

  // ---- narration, with the music ducked underneath
  music.gain.setValueAtTime(1, 0);
  for (const line of cues.lines) {
    const b64 = voices[line.id]; if (!b64) continue;
    const buf = await b64buf(b64);
    const at = line.at, end = at + buf.duration;
    if (!live(at, end)) continue;
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(voice);
    s.start(Math.max(0, T(at)), Math.max(0, from - at));
    const duck = at < cues.drop ? 0.5 : 0.36;
    music.gain.setTargetAtTime(duck, Math.max(0, T(at - 0.25)), 0.08);
    music.gain.setTargetAtTime(1, Math.max(0, T(end + 0.15)), 0.35);
  }

  const rendered = await ctx.startRendering();
  // 16-bit WAV
  const ch = [rendered.getChannelData(0), rendered.getChannelData(1)], n = rendered.length;
  const buf = new ArrayBuffer(44 + n * 4), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < 2; c++, o += 2) { const x = Math.max(-1, Math.min(1, ch[c][i])); peak = Math.max(peak, Math.abs(x)); dv.setInt16(o, x * 32767, true); }
  const bytes = new Uint8Array(buf), chunks = [], CH = 3 * 1024 * 1024;
  for (let i = 0; i < bytes.length; i += CH) { let s = ''; const sub = bytes.subarray(i, i + CH); for (let j = 0; j < sub.length; j += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(j, j + 0x8000)); chunks.push(btoa(s)); }
  window.__mix = chunks;
  return { chunks: chunks.length, peak, seconds: rendered.length / SR };
};
