/**
 * Game audio (Web Audio API).
 *
 * Music: MP3 loops in client/public/audio, one at a time, crossfaded:
 *   theme.mp3   the graveyard background ("The Organ's Lament"), played soft
 *   dance.mp3   while YOU dance ("Bouncy Bassline"), played soft
 *   club.mp3    while YOU club ("Push Your Hands Up")
 * Crying: cry.mp3 loops while you cry; roll-cry.mp3 loops while you roll, made harder (higher pitch, doubled
 * and slightly driven).
 * Small effects are synthesized: hop, offerings, new graves, level-ups, chat, snapshot, dialog clicks.
 *
 * Browsers only allow audio after a user gesture, so nothing plays until start() is called from a click
 * (the "Enter the Meme Graveyard" button). Music and effects can be switched off separately, and everything
 * can be muted at once (M). Settings are remembered in localStorage. Files load on first use.
 */

const NOTE: Record<string, number> = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
const hz = (n: string) => { const m = /^([A-G]#?)(\d)$/.exec(n)!; return 440 * 2 ** ((NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12); };

type TrackId = 'theme' | 'dance' | 'club';
/** Loudness of each track (theme and dance are kept soft on purpose). */
const TRACK_GAIN: Record<TrackId, number> = { theme: 0.35, dance: 0.4, club: 0.7 };
const EMOTE_TRACK: Record<number, TrackId> = { 1: 'dance', 2: 'club' };
const url = (name: string) => `/audio/${name}.mp3`;

const PREF = { music: 'rip.music', sfx: 'rip.sfx', muted: 'rip.muted' };
const readPref = (k: string, def: boolean) => { try { const v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch { return def; } };
const writePref = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* not persisted */ } };

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private out!: DynamicsCompressorNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private track: TrackId = 'theme';
  private music: { src: AudioBufferSourceNode; gain: GainNode; id: TrackId } | null = null;
  private crying: { stop(): void } | null = null;
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
      comp.threshold.value = -16; comp.ratio.value = 4;
      this.master = ctx.createGain(); this.master.connect(comp); comp.connect(ctx.destination); this.out = comp;
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
      for (const n of ['cry', 'roll-cry']) void this.load(n);   // small: fetch early so the first cry is instant
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.music) void this.playTrack(this.track);
  }

  /** A copy of everything the game plays, for recording videos (the ?film page). Call after start(). */
  recordStream(): MediaStream | null {
    if (!this.ctx) return null;
    const d = this.ctx.createMediaStreamDestination();
    this.out.connect(d);
    return d.stream;
  }

  setMusic(on: boolean) { this.musicOn = on; writePref(PREF.music, on); this.applyLevels(); }
  setSfx(on: boolean) { this.sfxOn = on; writePref(PREF.sfx, on); this.applyLevels(); }
  setMuted(on: boolean) { this.muted = on; writePref(PREF.muted, on); this.applyLevels(); }
  toggleMuted() { this.setMuted(!this.muted); }
  onChange(fn: () => void) { this.listeners.add(fn); }

  private applyLevels(now = false) {
    for (const fn of this.listeners) fn();
    if (!this.ctx) return;
    const t = this.ctx.currentTime, tc = now ? 0.005 : 0.08;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, tc);
    this.musicBus.gain.setTargetAtTime(this.musicOn ? 1 : 0, t, tc);
    this.sfxBus.gain.setTargetAtTime(this.sfxOn ? 0.8 : 0, t, tc);
  }

  private get sfxLive(): boolean { return !!this.ctx && !this.muted && this.sfxOn && this.ctx.state === 'running'; }

  /** Fetches and decodes an MP3 once; null if it can't be loaded (the game stays playable, just quieter). */
  private load(name: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(name);
    if (!p) {
      p = fetch(url(name))
        .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); })
        .then((b) => this.ctx!.decodeAudioData(b))
        .catch((e) => { console.warn('audio failed to load', name, e); return null; });
      this.buffers.set(name, p);
    }
    return p;
  }

  // ------------------------------------------------------------------ music

  private async playTrack(id: TrackId) {
    this.track = id;
    const buf = await this.load(id);
    if (!buf || !this.ctx || this.track !== id) return;   // failed, or switched again while loading
    const ctx = this.ctx, t = ctx.currentTime;
    if (this.music?.id === id) return;
    if (this.music) {   // fade the old one out
      const old = this.music;
      old.gain.gain.setTargetAtTime(0, t, 0.15);
      old.src.stop(t + 1);
    }
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf; src.loop = true;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.setTargetAtTime(TRACK_GAIN[id], t, id === 'theme' ? 0.6 : 0.12);
    src.connect(gain).connect(this.musicBus);
    src.start(t);
    this.music = { src, gain, id };
  }

  // ------------------------------------------------------------------ crying (sampled)

  /** Loops a crying sample until stopped. intense: higher pitch, a second detuned copy, slight drive. */
  private async startCrying(name: string, intense: boolean) {
    this.stopCrying();
    const token = {};
    const handle = { token, stop: () => {} };
    this.crying = handle;
    const buf = await this.load(name);
    if (!buf || !this.ctx || this.crying !== handle) return;
    const ctx = this.ctx, t = ctx.currentTime, out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.setTargetAtTime(intense ? 1.0 : 0.85, t, 0.03);
    let dest: AudioNode = out;
    if (intense) {
      // a little overdrive + presence boost makes it sound strained, like crying with everything you have
      const drive = ctx.createWaveShaper(), curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
      drive.curve = curve;
      const presence = ctx.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 2200; presence.gain.value = 6; presence.Q.value = 0.8;
      drive.connect(presence).connect(out);
      dest = drive;
    }
    out.connect(this.sfxBus);
    const voices = intense ? [{ rate: 1.12, gain: 1, delay: 0 }, { rate: 1.22, gain: 0.55, delay: 0.09 }] : [{ rate: 1, gain: 1, delay: 0 }];
    const srcs = voices.map((v) => {
      const s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = buf; s.loop = true; s.playbackRate.value = v.rate; g.gain.value = v.gain;
      s.connect(g).connect(dest); s.start(t + v.delay);
      return s;
    });
    handle.stop = () => {
      const now = ctx.currentTime;
      out.gain.setTargetAtTime(0, now, 0.08);
      for (const s of srcs) s.stop(now + 0.5);
    };
  }
  private stopCrying() { this.crying?.stop(); this.crying = null; }

  /** The local player's emote changed (0 = none): dance/club switch the music, cry/roll cry. Pray is silent. */
  setEmote(i: number) {
    if (i === this.emote) return;
    this.emote = i;
    if (this.ctx) void this.playTrack(EMOTE_TRACK[i] ?? 'theme');
    else this.track = EMOTE_TRACK[i] ?? 'theme';
    this.stopCrying();
    if (!this.ctx) return;
    if (i === 4) void this.startCrying('cry', false);
    else if (i === 5) void this.startCrying('roll-cry', true);
  }

  // ------------------------------------------------------------------ small synthesized effects

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
  private noiseHit(t: number, dur: number, freq: number, vol: number, type: BiquadFilterType) {
    const ctx = this.ctx!, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise; f.type = type; f.frequency.value = freq; f.Q.value = 1;
    this.env(g, t, vol, 0.003, dur);
    src.connect(f).connect(g).connect(this.sfxBus);
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
}
