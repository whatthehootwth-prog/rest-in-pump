/**
 * All game audio, synthesized live with the Web Audio API: no audio files, no licences, nothing to download.
 *
 * Music: a looping spooky-but-silly graveyard tune in A minor: oom-pah tuba bass, a plinky music-box melody,
 * a soft "ooh" choir pad and a woodblock.
 * Sound effects: hop, emotes (sobbing wail, temple bell, wub...), offerings, new graves, level-ups, chat, snapshot.
 *
 * Browsers only allow audio after a user gesture, so nothing plays until start() is called from a click
 * (the "Enter the Meme Graveyard" button). Music and effects can be switched off separately, and everything
 * can be muted at once (M). Settings are remembered in localStorage.
 */

const BPM = 100;
const STEP = 60 / BPM / 4;                 // a 16th note, in seconds
const BAR_STEPS = 16;
const LOOKAHEAD = 0.25;                    // schedule this far ahead (s)

const A4 = 440;
const NOTE: Record<string, number> = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
/** "A4", "C#5" -> Hz */
const hz = (n: string) => { const m = /^([A-G]#?)(\d)$/.exec(n)!; return A4 * 2 ** ((NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12); };

// 8 bars: Am F C E | Am F Dm E
const CHORDS: string[][] = [
  ['A2', 'E3', 'A3', 'C4', 'E4'], ['F2', 'C3', 'F3', 'A3', 'C4'], ['C3', 'G3', 'C4', 'E4', 'G4'], ['E2', 'B2', 'E3', 'G#3', 'B3'],
  ['A2', 'E3', 'A3', 'C4', 'E4'], ['F2', 'C3', 'F3', 'A3', 'C4'], ['D3', 'A3', 'D4', 'F4', 'A4'], ['E2', 'B2', 'E3', 'G#3', 'B3'],
];
// music-box melody, one string per bar, 16 steps: note names or '.' for rest (space separated)
const MELODY = [
  'E5 . A5 . C6 . B5 A5 . . E5 . . . . .',
  'F5 . A5 . C6 . A5 F5 . . C5 . . . . .',
  'G5 . E5 . G5 . C6 . B5 . G5 . E5 . . .',
  'G#5 . B5 . E6 . D6 B5 G#5 . . . E5 . . .',
  'A5 . . E5 A5 . C6 . E6 . D6 C6 B5 . A5 .',
  'C6 . A5 . F5 . A5 . C6 . . . A5 . . .',
  'D6 . A5 . F5 . D5 . F5 . A5 . D6 . C6 .',
  'B5 . G#5 . E5 . G#5 . B5 . . . E5 . . .',
].map((bar) => bar.split(' ').map((n) => (n === '.' ? null : n)));

type EmoteSound = 'dance' | 'club' | 'pray' | 'cry' | 'roll';
const EMOTE_IDS: Record<number, EmoteSound> = { 1: 'dance', 2: 'club', 3: 'pray', 4: 'cry', 5: 'roll' };

const PREF = { music: 'rip.music', sfx: 'rip.sfx', muted: 'rip.muted' };
const readPref = (k: string, def: boolean) => { try { const v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch { return def; } };
const writePref = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* not persisted */ } };

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
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

  private applyLevels(now = false) {
    for (const fn of this.listeners) fn();
    if (!this.ctx) return;
    const t = this.ctx.currentTime, ramp = now ? 0.01 : 0.25;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, ramp / 3);
    this.musicBus.gain.setTargetAtTime(this.musicOn ? 0.32 : 0, t, ramp / 3);
    this.sfxBus.gain.setTargetAtTime(this.sfxOn ? 0.75 : 0, t, ramp / 3);
  }

  private get live(): boolean { return !!this.ctx && !this.muted && this.ctx.state === 'running'; }
  private get sfxLive(): boolean { return this.live && this.sfxOn; }

  // ------------------------------------------------------------------ music

  private schedule() {
    const ctx = this.ctx!;
    if (ctx.state !== 'running') { this.nextTime = ctx.currentTime + 0.1; return; }
    if (this.nextTime < ctx.currentTime - 0.5) this.nextTime = ctx.currentTime + 0.05;   // woke up from a pause
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      if (this.musicOn && !this.muted) this.playStep(this.step, this.nextTime);
      this.step = (this.step + 1) % (BAR_STEPS * CHORDS.length);
      this.nextTime += STEP * (this.step % 2 === 1 ? 1.08 : 0.92);   // a little swing
    }
  }

  private playStep(step: number, t: number) {
    const bar = Math.floor(step / BAR_STEPS), s = step % BAR_STEPS, chord = CHORDS[bar];
    // oom-pah tuba: root on 1 and 3, fifth on 2 and 4
    if (s % 4 === 0) this.tuba(hz(s % 8 === 0 ? chord[0] : chord[1]), t, s % 8 === 0 ? 0.32 : 0.22);
    // woodblock on the off-beats, a skeleton-ish double tap at the end of every other bar
    if (s % 4 === 2) this.woodblock(t, 0.12);
    if (bar % 2 === 1 && (s === 14 || s === 15)) this.woodblock(t, 0.08, 1.4);
    // choir pad, once per bar
    if (s === 0) for (const n of chord.slice(2, 5)) this.ooh(hz(n), t, STEP * BAR_STEPS * 0.95);
    // music box
    const m = MELODY[bar][s];
    if (m) this.musicBox(hz(m), t);
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tuba(f: number, t: number, vol: number) {
    const ctx = this.ctx!, o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.985, t + 0.25);
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.25); lp.Q.value = 2;
    this.env(g, t, vol, 0.02, 0.28);
    o.connect(lp).connect(g).connect(this.musicBus);
    o.start(t); o.stop(t + 0.35);
  }

  private woodblock(t: number, vol: number, pitch = 1) {
    const ctx = this.ctx!, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(1150 * pitch, t); o.frequency.exponentialRampToValueAtTime(700 * pitch, t + 0.05);
    this.env(g, t, vol, 0.002, 0.07);
    o.connect(g).connect(this.musicBus);
    o.start(t); o.stop(t + 0.1);
  }

  private ooh(f: number, t: number, dur: number) {
    const ctx = this.ctx!, g = ctx.createGain(), bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 650; bp.Q.value = 1.2;   // an "oo/oh" vowel-ish colour
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(bp); o.start(t); o.stop(t + dur + 0.05);
    }
    bp.connect(g).connect(this.musicBus);
  }

  private musicBox(f: number, t: number, bus?: GainNode, vol = 0.16) {
    const ctx = this.ctx!, g = ctx.createGain();
    for (const [mult, amp] of [[1, 1], [2.01, 0.35], [4.02, 0.12]] as const) {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * mult; og.gain.value = amp;
      o.connect(og).connect(g); o.start(t); o.stop(t + 0.9);
    }
    this.env(g, t, vol, 0.004, 0.8);
    g.connect(bus ?? this.musicBus);
  }

  // ------------------------------------------------------------------ sound effects

  private noiseBurst(t: number, dur: number, freq: number, vol: number, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx!, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise; f.type = type; f.frequency.value = freq; f.Q.value = 1;
    this.env(g, t, vol, 0.003, dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  private sweep(type: OscillatorType, from: number, to: number, t: number, dur: number, vol: number, vibrato = 0) {
    const ctx = this.ctx!, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + dur);
    if (vibrato) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 7; lg.gain.value = vibrato; lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + dur + 0.05);
    }
    this.env(g, t, vol, 0.01, dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** Cartoon "boing" when hopping. */
  hop() {
    if (!this.sfxLive) return;
    this.sweep('sine', 180, 520, this.ctx!.currentTime, 0.22, 0.6, 18);
  }

  /** UI tick (opening dialogs, pressing buttons). */
  click() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    this.sweep('triangle', 900, 600, t, 0.05, 0.3);
  }

  /** Camera shutter for snapshots. */
  shutter() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 0.04, 3000, 0.4, 'highpass');
    this.noiseBurst(t + 0.09, 0.06, 2000, 0.3, 'highpass');
  }

  /** Someone else's chat message. */
  chatPop() {
    if (!this.sfxLive) return;
    this.sweep('sine', 700, 1100, this.ctx!.currentTime, 0.08, 0.3);
  }

  /** An offering was left (anyone's): a sparkly chime. */
  offering() {
    if (!this.sfxLive) return;
    const t = this.ctx!.currentTime;
    ['C6', 'E6', 'G6', 'C7'].forEach((n, i) => this.musicBox(hz(n), t + i * 0.07, this.sfxBus, 0.22));
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
    [['A4', 0], ['C#5', 0.12], ['E5', 0.24], ['A5', 0.36], ['A5', 0.62]].forEach(([n, d]) => {
      const ctx = this.ctx!, o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), at = t + (d as number);
      o.type = 'sawtooth'; o.frequency.value = hz(n as string);
      lp.type = 'lowpass'; lp.frequency.value = 2200;
      this.env(g, at, 0.18, 0.01, n === 'A5' && d === 0.62 ? 0.7 : 0.16);
      o.connect(lp).connect(g).connect(this.sfxBus); o.start(at); o.stop(at + 0.9);
    });
  }

  private bell(f: number, t: number, vol: number, dur: number) {
    const ctx = this.ctx!;
    for (const [mult, amp] of [[1, 1], [2.76, 0.45], [5.4, 0.25], [8.9, 0.1]] as const) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * mult;
      this.env(g, t, vol * amp, 0.005, dur / mult ** 0.3);
      o.connect(g).connect(this.sfxBus); o.start(t); o.stop(t + dur + 0.1);
    }
  }

  /** A sobbing "waaah": a sawtooth through two vowel formants, wobbling and falling. */
  private wail(t: number, dur: number, vol: number, from = 520) {
    const ctx = this.ctx!, o = ctx.createOscillator(), g = ctx.createGain(), mix = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(from, t);
    o.frequency.linearRampToValueAtTime(from * 1.12, t + dur * 0.2);
    o.frequency.exponentialRampToValueAtTime(from * 0.55, t + dur);
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 9; lg.gain.value = from * 0.05; lfo.connect(lg).connect(o.frequency);
    for (const [ff, q, a] of [[850, 6, 1], [1250, 8, 0.6]] as const) {   // "aah"
      const bp = ctx.createBiquadFilter(), fg = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = ff; bp.Q.value = q; fg.gain.value = a;
      o.connect(bp).connect(fg).connect(mix);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.08);
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mix.connect(g).connect(this.sfxBus);
    o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  }

  /** Short gasping sobs between wails. */
  private sobs(t: number, n: number) {
    for (let i = 0; i < n; i++) this.wail(t + i * 0.22, 0.16, 0.22, 640 + Math.random() * 80);
  }

  /** The local player's emote changed (0 = none). Some emotes repeat their sound while they last. */
  setEmote(i: number) {
    if (i === this.emote) return;
    this.emote = i;
    if (this.emoteTimer !== null) { clearInterval(this.emoteTimer); this.emoteTimer = null; }
    const id = EMOTE_IDS[i];
    if (!id) return;
    const play = () => {
      if (!this.sfxLive) return;
      const t = this.ctx!.currentTime;
      switch (id) {
        case 'dance': ['E5', 'G5', 'A5', 'C6'].forEach((n, k) => this.musicBox(hz(n), t + k * 0.08, this.sfxBus, 0.2)); break;
        case 'club': this.sweep('sawtooth', 90, 45, t, 0.4, 0.7); this.noiseBurst(t, 0.06, 6000, 0.3, 'highpass'); break;
        case 'pray': this.bell(hz('E5'), t, 0.22, 2.2); break;
        case 'cry': this.sobs(t, 4); this.wail(t + 1.0, 1.6, 0.42); this.wail(t + 2.8, 1.3, 0.36, 470); break;
        case 'roll': this.wail(t, 1.1, 0.4, 600); this.sobs(t + 1.2, 3); break;
      }
    };
    play();
    const every: Partial<Record<EmoteSound, number>> = { pray: 2400, cry: 5400, roll: 2600 };
    if (every[id]) this.emoteTimer = window.setInterval(play, every[id]);
  }
}
