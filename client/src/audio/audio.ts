/**
 * All game audio, synthesized live with the Web Audio API: no audio files, no licences, nothing to download.
 *
 * Music (one track at a time, crossfaded):
 *   sad    the graveyard theme: slow D-minor piano over soft strings and a low bass
 *   dance  while YOU dance: a wonky polka-disco with a kazoo lead
 *   club   while YOU club: a squeaky rubber-duck techno with a wobbly bass
 * Sound effects: hop, emotes (cartoon crying, harder crying while rolling...), offerings, new graves, level-ups,
 * chat, snapshot.
 *
 * Browsers only allow audio after a user gesture, so nothing plays until start() is called from a click
 * (the "Enter the Meme Graveyard" button). Music and effects can be switched off separately, and everything
 * can be muted at once (M). Settings are remembered in localStorage.
 */

const LOOKAHEAD = 0.25;                    // schedule this far ahead (s)
const NOTE: Record<string, number> = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
/** "A4", "C#5" -> Hz */
const hz = (n: string) => { const m = /^([A-G]#?)(\d)$/.exec(n)!; return 440 * 2 ** ((NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12); };
/** "A5 . . F5" -> per-step notes (null = rest) */
const seq = (bars: string[]) => bars.map((b) => b.trim().split(/\s+/).map((n) => (n === '.' ? null : n)));

type TrackId = 'sad' | 'dance' | 'club';
interface Track { bpm: number; bars: number; swing: number; play(a: GameAudio, bar: number, s: number, t: number, step: number): void }

// ---- sad: D minor, 64 bpm
const SAD_CHORDS = [
  ['D3', 'A3', 'D4', 'F4', 'A4'], ['A#2', 'F3', 'A#3', 'D4', 'F4'], ['F2', 'C3', 'F3', 'A3', 'C4'], ['A2', 'E3', 'A3', 'C#4', 'E4'],
  ['D3', 'A3', 'D4', 'F4', 'A4'], ['G2', 'D3', 'G3', 'A#3', 'D4'], ['A#2', 'F3', 'A#3', 'D4', 'F4'], ['A2', 'E3', 'A3', 'C#4', 'E4'],
];
const SAD_MELODY = seq([
  'A5 . . . . . F5 . E5 . . . D5 . . .',
  'D5 . . . F5 . . . A5 . . . G5 . F5 .',
  'C5 . . . F5 . . . A5 . . . C6 . . .',
  'C#6 . . . . . A5 . E5 . . . . . . .',
  'F5 . . . E5 . D5 . A5 . . . . . . .',
  'G5 . . . A#5 . . . D6 . . . C6 . A#5 .',
  'A5 . . . . . F5 . D5 . . . F5 . . .',
  'E5 . . . C#5 . . . A4 . . . . . . .',
]);
const ARP = [0, 2, 3, 4, 3, 2, 1, 2];   // chord-tone index for each 8th note

// ---- dance: wonky polka-disco in C, 124 bpm
const DANCE_CHORDS = [['C3', 'E4', 'G4'], ['F2', 'A3', 'C4'], ['G2', 'B3', 'D4'], ['C3', 'E4', 'G4']];
const DANCE_LEAD = seq([
  'C5 . E5 G5 . A5 G5 . E5 . C5 . D5 D#5 E5 .',
  'F5 . A5 . C6 . A5 F5 . . A5 . G#5 . A5 .',
  'G5 . B5 . D6 . B5 G5 F5 . D5 . B4 . D5 .',
  'C5 C6 . G5 . E5 . C5 . G4 A4 B4 C5 . . .',
]);

// ---- club: rubber-duck techno in A minor, 128 bpm
const CLUB_BASS = seq([
  'A1 . A2 . A1 . . A2 . A1 A2 . A1 . C2 .',
  'F1 . F2 . F1 . . F2 . F1 F2 . G1 . G2 .',
]);
const CLUB_DUCK = seq([
  '. . . . E6 . . . . . . . A6 . G6 .',
  '. . . . C6 . . . . . D6 . E6 . . .',
  '. . . . E6 . . . . . . . A6 . C7 .',
  '. . A6 . G6 . E6 . . . D6 . C6 . A5 .',
]);

export const TRACKS: Record<TrackId, Track> = {
  sad: {
    bpm: 64, bars: 8, swing: 0,
    play(a, bar, s, t) {
      const c = SAD_CHORDS[bar];
      if (s === 0) { a.bassNote(hz(c[0]), t, 3.6); for (const n of c.slice(2)) a.strings(hz(n), t, 3.8); }
      if (s % 2 === 0) a.piano(hz(c[ARP[s / 2]]), t, 0.07);
      const m = SAD_MELODY[bar][s];
      if (m) a.piano(hz(m), t, 0.16, 2.6);
    },
  },
  dance: {
    bpm: 124, bars: 4, swing: 0.06,
    play(a, bar, s, t, step) {
      const c = DANCE_CHORDS[bar];
      if (s % 4 === 0) a.kick(t, 0.55);
      if (s % 4 === 0) a.tubaNote(hz(s % 8 === 0 ? c[0] : c[0].replace(/\d/, (d) => String(Number(d) + 1))), t, 0.3);
      if (s % 4 === 2) for (const n of c.slice(1)) a.stab(hz(n), t, 0.06);   // the "pah"
      if (s % 2 === 1) a.hat(t, 0.05);
      if (step % 64 === 60) a.slideWhistle(t);                               // every 4 bars, a silly slide whistle
      const m = DANCE_LEAD[bar][s];
      if (m) a.kazoo(hz(m), t, 0.17);
    },
  },
  club: {
    bpm: 128, bars: 4, swing: 0,
    play(a, bar, s, t) {
      if (s % 4 === 0) a.kick(t, 0.7);
      if (s % 8 === 4) a.clap(t, 0.25);
      if (s % 4 === 2) a.hat(t, 0.09, true);
      const b = CLUB_BASS[bar % 2][s];
      if (b) a.wobble(hz(b), t);
      const d = CLUB_DUCK[bar][s];
      if (d) a.duck(hz(d), t);
    },
  },
};

const EMOTE_TRACK: Record<number, TrackId> = { 1: 'dance', 2: 'club' };
const PREF = { music: 'rip.music', sfx: 'rip.sfx', muted: 'rip.muted' };
const readPref = (k: string, def: boolean) => { try { const v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch { return def; } };
const writePref = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* not persisted */ } };

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
  private track: TrackId = 'sad';
  private step = 0;
  private nextTime = 0;
  private timer: number | null = null;
  private emoteTimer: number | null = null;
  private emote = 0;
  musicOn = readPref(PREF.music, true);
  sfxOn = readPref(PREF.sfx, true);
  muted = readPref(PREF.muted, false);
  private readonly listeners = new Set<() => void>();

  /** Call from a user gesture (click / key). Safe to call again. */
  start(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;   // no Web Audio: the game simply stays silent
      const ctx = new Ctx();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 4;
      this.master = ctx.createGain(); this.master.connect(comp); comp.connect(ctx.destination);
      this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
      this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.applyLevels(true);
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) void this.ctx.suspend(); else void this.ctx.resume();
      });
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.timer === null) {
      this.nextTime = this.ctx.currentTime + 0.1;
      this.timer = window.setInterval(() => this.schedule(), 60);
    }
  }

  setMusic(on: boolean) { this.musicOn = on; writePref(PREF.music, on); this.applyLevels(); }
  setSfx(on: boolean) { this.sfxOn = on; writePref(PREF.sfx, on); this.applyLevels(); }
  setMuted(on: boolean) { this.muted = on; writePref(PREF.muted, on); this.applyLevels(); }
  toggleMuted() { this.setMuted(!this.muted); }
  onChange(fn: () => void) { this.listeners.add(fn); }

  private musicLevel() { return this.track === 'sad' ? 0.42 : 0.36; }
  private applyLevels(now = false) {
    for (const fn of this.listeners) fn();
    if (!this.ctx) return;
    const t = this.ctx.currentTime, ramp = now ? 0.01 : 0.25;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, ramp / 3);
    this.musicBus.gain.setTargetAtTime(this.musicOn ? this.musicLevel() : 0, t, ramp / 3);
    this.sfxBus.gain.setTargetAtTime(this.sfxOn ? 0.75 : 0, t, ramp / 3);
  }

  private get live(): boolean { return !!this.ctx && !this.muted && this.ctx.state === 'running'; }
  private get sfxLive(): boolean { return this.live && this.sfxOn; }

  // ------------------------------------------------------------------ music

  /** Switches the music (quick fade out, new track from its first beat, fade in). */
  private setTrack(id: TrackId) {
    if (id === this.track) return;
    this.track = id;
    this.step = 0;
    if (!this.ctx) return;
    const t = this.ctx.currentTime, g = this.musicBus.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.04);
    this.nextTime = t + 0.18;
    if (this.musicOn) g.setTargetAtTime(this.musicLevel(), t + 0.18, 0.08);
  }

  private schedule() {
    const ctx = this.ctx!;
    if (ctx.state !== 'running') { this.nextTime = ctx.currentTime + 0.1; return; }
    if (this.nextTime < ctx.currentTime - 0.5) this.nextTime = ctx.currentTime + 0.05;   // woke up from a pause
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      const tr = TRACKS[this.track], stepLen = 60 / tr.bpm / 4;
      if (this.musicOn && !this.muted) tr.play(this, Math.floor(this.step / 16) % tr.bars, this.step % 16, this.nextTime, this.step);
      this.step = (this.step + 1) % (16 * tr.bars);
      this.nextTime += stepLen * (1 + (this.step % 2 === 1 ? -tr.swing : tr.swing));
    }
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  private osc(type: OscillatorType, f: number, t: number, dur: number) {
    const o = this.ctx!.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  // instruments (public so the track tables can use them)
  piano(f: number, t: number, vol: number, len = 1.6) {
    const ctx = this.ctx!, g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(900, t + len);
    for (const [mult, amp] of [[1, 1], [2, 0.4], [3, 0.15], [4.01, 0.08]] as const) {
      const og = ctx.createGain(); og.gain.value = amp;
      this.osc(mult === 1 ? 'triangle' : 'sine', f * mult, t, len).connect(og).connect(lp);
    }
    this.env(g, t, vol, 0.006, len);
    lp.connect(g).connect(this.musicBus);
  }
  strings(f: number, t: number, dur: number) {
    const ctx = this.ctx!, g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1100;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const det of [-9, 0, 9]) { const o = this.osc('sawtooth', f, t, dur); o.detune.value = det; o.connect(lp); }
    lp.connect(g).connect(this.musicBus);
  }
  bassNote(f: number, t: number, dur: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    this.osc('sine', f, t, dur).connect(g).connect(this.musicBus);
  }
  tubaNote(f: number, t: number, vol: number) {
    const ctx = this.ctx!, lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.2); lp.Q.value = 3;
    this.env(g, t, vol, 0.015, 0.2);
    this.osc('square', f, t, 0.25).connect(lp).connect(g).connect(this.musicBus);
  }
  stab(f: number, t: number, vol: number) {
    const ctx = this.ctx!, lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    this.env(g, t, vol, 0.005, 0.1);
    this.osc('square', f, t, 0.12).connect(lp).connect(g).connect(this.musicBus);
  }
  kazoo(f: number, t: number, vol: number) {
    const ctx = this.ctx!, o = this.osc('sawtooth', f, t, 0.22), g = ctx.createGain(), bp = ctx.createBiquadFilter();
    const lfo = this.osc('sine', 11, t, 0.22), lg = ctx.createGain(); lg.gain.value = f * 0.03; lfo.connect(lg).connect(o.frequency);
    bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 2.5;   // buzzy, nasal
    this.env(g, t, vol, 0.02, 0.2);
    o.connect(bp).connect(g).connect(this.musicBus);
  }
  slideWhistle(t: number) {
    const ctx = this.ctx!, o = this.osc('sine', 600, t, 0.5), g = ctx.createGain();
    o.frequency.exponentialRampToValueAtTime(1800, t + 0.22); o.frequency.exponentialRampToValueAtTime(500, t + 0.45);
    this.env(g, t, 0.12, 0.02, 0.45);
    o.connect(g).connect(this.musicBus);
  }
  kick(t: number, vol: number) {
    const ctx = this.ctx!, o = this.osc('sine', 140, t, 0.3), g = ctx.createGain();
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.env(g, t, vol, 0.002, 0.25);
    o.connect(g).connect(this.musicBus);
  }
  hat(t: number, vol: number, open = false) { this.noiseHit(t, open ? 0.12 : 0.03, 8000, vol, 'highpass', this.musicBus); }
  clap(t: number, vol: number) { for (const d of [0, 0.012, 0.024]) this.noiseHit(t + d, 0.09, 1500, vol, 'bandpass', this.musicBus); }
  wobble(f: number, t: number) {
    const ctx = this.ctx!, o = this.osc('sawtooth', f, t, 0.25), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.Q.value = 8;
    lp.frequency.setValueAtTime(200, t); lp.frequency.linearRampToValueAtTime(1400, t + 0.06); lp.frequency.exponentialRampToValueAtTime(180, t + 0.22);
    this.env(g, t, 0.28, 0.005, 0.22);
    o.connect(lp).connect(g).connect(this.musicBus);
  }
  /** A squeaky rubber-duck blip. */
  duck(f: number, t: number) {
    const ctx = this.ctx!, o = this.osc('square', f * 0.8, t, 0.14), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.frequency.exponentialRampToValueAtTime(f * 1.15, t + 0.05); o.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.12);
    lp.type = 'bandpass'; lp.frequency.value = 2200; lp.Q.value = 3;
    this.env(g, t, 0.16, 0.005, 0.12);
    o.connect(lp).connect(g).connect(this.musicBus);
  }

  // ------------------------------------------------------------------ sound effects

  private noiseHit(t: number, dur: number, freq: number, vol: number, type: BiquadFilterType, bus?: GainNode) {
    const ctx = this.ctx!, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise; f.type = type; f.frequency.value = freq; f.Q.value = 1;
    this.env(g, t, vol, 0.003, dur);
    src.connect(f).connect(g).connect(bus ?? this.sfxBus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  private sweep(type: OscillatorType, from: number, to: number, t: number, dur: number, vol: number, vibrato = 0) {
    const ctx = this.ctx!, o = this.osc(type, from, t, dur), g = ctx.createGain();
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    if (vibrato) { const lfo = this.osc('sine', 7, t, dur), lg = ctx.createGain(); lg.gain.value = vibrato; lfo.connect(lg).connect(o.frequency); }
    this.env(g, t, vol, 0.01, dur);
    o.connect(g).connect(this.sfxBus);
  }

  private chime(f: number, t: number, vol: number) {
    const ctx = this.ctx!, g = ctx.createGain();
    for (const [mult, amp] of [[1, 1], [2.01, 0.35], [4.02, 0.12]] as const) {
      const og = ctx.createGain(); og.gain.value = amp;
      this.osc('sine', f * mult, t, 0.9).connect(og).connect(g);
    }
    this.env(g, t, vol, 0.004, 0.8);
    g.connect(this.sfxBus);
  }

  private bell(f: number, t: number, vol: number, dur: number) {
    const ctx = this.ctx!;
    for (const [mult, amp] of [[1, 1], [2.76, 0.45], [5.4, 0.25], [8.9, 0.1]] as const) {
      const g = ctx.createGain();
      this.env(g, t, vol * amp, 0.005, dur / mult ** 0.3);
      this.osc('sine', f * mult, t, dur).connect(g).connect(this.sfxBus);
    }
  }

  /** Cartoon "boing" when hopping. */
  hop() { if (this.sfxLive) this.sweep('sine', 180, 520, this.ctx!.currentTime, 0.22, 0.6, 18); }
  /** UI tick (opening dialogs). */
  click() { if (this.sfxLive) this.sweep('triangle', 900, 600, this.ctx!.currentTime, 0.05, 0.3); }
  /** Someone else's chat message. */
  chatPop() { if (this.sfxLive) this.sweep('sine', 700, 1100, this.ctx!.currentTime, 0.08, 0.3); }
  /** Camera shutter for snapshots. */
  shutter() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    this.noiseHit(t, 0.04, 3000, 0.4, 'highpass');
    this.noiseHit(t + 0.09, 0.06, 2000, 0.3, 'highpass');
  }
  /** An offering was left (anyone's): a sparkly chime. */
  offering() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    ['C6', 'E6', 'G6', 'C7'].forEach((n, i) => this.chime(hz(n), t + i * 0.07, 0.22));
  }
  /** A new grave: a low bell toll. */
  graveCreated() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    this.bell(hz('A2'), t, 0.45, 3.5);
    this.bell(hz('A3'), t + 0.02, 0.15, 2.5);
  }
  /** A grave reached a new level: a silly little fanfare. */
  levelUp() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    ([['A4', 0], ['C#5', 0.12], ['E5', 0.24], ['A5', 0.36], ['A5', 0.62]] as const).forEach(([n, d], i) => {
      const ctx = this.ctx!, lp = ctx.createBiquadFilter(), g = ctx.createGain(), at = t + d;
      lp.type = 'lowpass'; lp.frequency.value = 2200;
      this.env(g, at, 0.18, 0.01, i === 4 ? 0.7 : 0.16);
      this.osc('sawtooth', hz(n), at, 0.9).connect(lp).connect(g).connect(this.sfxBus);
    });
  }

  // ---- cartoon crying

  /**
   * One crying "voice" note: a sawtooth through vowel formants with a wobbly, cartoonish vibrato.
   * vowel 'aa' (WAAAH) or 'oo' (boo-hoo).
   */
  private voice(t: number, dur: number, vol: number, from: number, to: number, vowel: 'aa' | 'oo', wobble = 12) {
    const ctx = this.ctx!, o = this.osc('sawtooth', from, t, dur), g = ctx.createGain(), mix = ctx.createGain();
    o.frequency.linearRampToValueAtTime(from * 1.15, t + dur * 0.15);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const lfo = this.osc('sine', wobble, t, dur), lg = ctx.createGain();
    lg.gain.value = from * 0.07; lfo.connect(lg).connect(o.frequency);
    const formants = vowel === 'aa' ? [[850, 5, 1], [1300, 7, 0.7]] : [[340, 5, 1], [800, 7, 0.4]];
    for (const [ff, q, a] of formants) {
      const bp = ctx.createBiquadFilter(), fg = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = ff; bp.Q.value = q; fg.gain.value = a;
      o.connect(bp).connect(fg).connect(mix);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.05);
    g.gain.setValueAtTime(vol, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mix.connect(g).connect(this.sfxBus);
  }
  /** "boo-hoo-hoo": short falling "hoo"s. */
  private booHoo(t: number, n: number, vol: number, base: number) {
    for (let i = 0; i < n; i++) this.voice(t + i * 0.2, 0.17, vol, base * (1 - i * 0.06), base * 0.8 * (1 - i * 0.06), 'oo', 16);
  }
  /** A sharp little hiccup. */
  private hiccup(t: number, vol: number) { this.voice(t, 0.09, vol, 700, 1300, 'aa', 0); }
  /** Snot sniff: two short noise inhales. */
  private sniff(t: number, vol: number) { this.noiseHit(t, 0.12, 2500, vol, 'bandpass'); this.noiseHit(t + 0.18, 0.18, 2200, vol * 1.2, 'bandpass'); }
  /** Comedy nose-blow honk. */
  private honk(t: number, vol: number) {
    const ctx = this.ctx!, o = this.osc('square', 220, t, 0.45), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.frequency.linearRampToValueAtTime(260, t + 0.1); o.frequency.linearRampToValueAtTime(200, t + 0.4);
    lp.type = 'bandpass'; lp.frequency.value = 600; lp.Q.value = 2;
    this.env(g, t, vol, 0.02, 0.4);
    o.connect(lp).connect(g).connect(this.sfxBus);
  }

  /** The local player's emote changed (0 = none): switches the music for dance/club, plays the emote's sound. */
  setEmote(i: number) {
    if (i === this.emote) return;
    this.emote = i;
    this.setTrack(EMOTE_TRACK[i] ?? 'sad');
    if (this.emoteTimer !== null) { clearInterval(this.emoteTimer); this.emoteTimer = null; }
    let n = 0;
    const cry = () => {
      if (!this.sfxLive) return;
      const t = this.ctx!.currentTime, k = n++ % 3;
      this.booHoo(t, 4, 0.3, 430);
      this.voice(t + 0.9, 1.5, 0.45, 560, 300, 'aa');                // WAAAAAH
      this.hiccup(t + 2.5, 0.3);
      if (k === 2) this.honk(t + 3.0, 0.3); else this.sniff(t + 3.0, 0.25);
    };
    const tantrum = () => {
      if (!this.sfxLive) return;
      const t = this.ctx!.currentTime;
      // two voices wailing over each other, higher and louder, hiccups in between
      this.voice(t, 1.3, 0.5, 720, 420, 'aa', 15);
      this.voice(t + 0.05, 1.25, 0.32, 760, 470, 'aa', 10);
      this.hiccup(t + 1.3, 0.35);
      this.hiccup(t + 1.45, 0.35);
      this.voice(t + 1.6, 0.9, 0.5, 820, 520, 'aa', 18);
      this.booHoo(t + 2.4, 3, 0.35, 560);
    };
    if (i === 4) { cry(); this.emoteTimer = window.setInterval(cry, 4200); }
    else if (i === 5) { tantrum(); this.emoteTimer = window.setInterval(tantrum, 3000); }
    // dance and club change the music instead; pray is silent
  }
}
