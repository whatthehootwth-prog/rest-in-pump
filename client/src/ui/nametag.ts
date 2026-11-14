import * as THREE from 'three';

const BUBBLE_MS = 6000;
const SCALE = 2;                       // canvas pixels per CSS pixel
const FONT = `600 ${13 * SCALE}px system-ui, -apple-system, "Segoe UI", sans-serif`;
const BUBBLE_FONT = `500 ${13 * SCALE}px system-ui, -apple-system, "Segoe UI", sans-serif`;
/** World-space height of one CSS pixel of the tag. */
const PX = 0.12 / 30;

/**
 * A player's name floating above their owl, plus a speech bubble when they chat.
 * With an empty name (NPCs) only the speech bubble is drawn, and nothing at all when there is none.
 * Drawn on a small canvas; the sprite is anchored at its bottom so the bubble grows upward.
 */
export class NameTag {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private texture: THREE.CanvasTexture;
  private name: string;
  private readonly self: boolean;
  private status: string | null = null;
  private bubble: string | null = null;
  private bubbleUntil = 0;

  constructor(name: string, self = false) {
    this.name = name;
    this.self = self;
    this.texture = this.makeTexture();
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthWrite: false, transparent: true, fog: false }));
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 10;
    this.draw();
  }

  setName(name: string) { this.name = name; this.draw(); }
  setStatus(status: string | null) { this.status = status; this.draw(); }

  /** Shows a chat bubble for a few seconds. */
  say(text: string) {
    this.bubble = text;
    this.bubbleUntil = performance.now() + BUBBLE_MS;
    this.draw();
  }

  /** Hides the chat bubble now (the ?film page uses it between shots). */
  clearBubble() { if (this.bubble) { this.bubble = null; this.draw(); } }

  /** Call every frame: hides the bubble when it expires. */
  tick(now: number) {
    if (this.bubble && now > this.bubbleUntil) { this.bubble = null; this.draw(); }
  }

  private makeTexture(): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }

  dispose() {
    this.sprite.removeFromParent();
    this.texture.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }

  private draw() {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const S = SCALE;
    // ---- measure
    g.font = FONT;
    const label = this.status ? `${this.name} · ${this.status}` : this.name;
    const chip = this.self ? 'you' : '';
    const chipW = chip ? g.measureText(chip).width + 12 * S : 0;
    const nameW = Math.ceil(g.measureText(label).width + chipW + (chip ? 6 * S : 0)) + 20 * S;
    const showName = !!this.name || this.self;
    const nameH = showName ? 26 * S : 0;
    let lines: string[] = [];
    let bubbleW = 0;
    const lineH = 17 * S, padX = 10 * S, padY = 7 * S, tail = 7 * S, gap = 4 * S;
    if (this.bubble) {
      g.font = BUBBLE_FONT;
      lines = wrap(g, this.bubble, 210 * S, 3);
      bubbleW = Math.ceil(Math.max(...lines.map((l) => g.measureText(l).width))) + padX * 2;
    }
    const bubbleH = lines.length ? lines.length * lineH + padY * 2 : 0;
    if (!showName && !bubbleH) { this.sprite.visible = false; return; }
    this.sprite.visible = true;
    const w = Math.max(showName ? nameW : 0, bubbleW);
    const h = nameH + (bubbleH ? bubbleH + tail + (showName ? gap : 0) : 0);
    const resized = this.canvas.width !== w || this.canvas.height !== h;
    this.canvas.width = w; this.canvas.height = h;
    if (resized && this.sprite) {
      // GPU texture storage has a fixed size: a resized canvas needs a fresh texture
      this.texture.dispose();
      this.texture = this.makeTexture();
      const mat = this.sprite.material as THREE.SpriteMaterial;
      mat.map = this.texture;
      mat.needsUpdate = true;
    }
    // ---- speech bubble
    if (bubbleH) {
      const bx = (w - bubbleW) / 2;
      g.fillStyle = '#f4f2ec';
      g.beginPath(); g.roundRect(bx, 0, bubbleW, bubbleH, 10 * S); g.fill();
      g.beginPath(); g.moveTo(w / 2 - tail, bubbleH - 1); g.lineTo(w / 2, bubbleH + tail); g.lineTo(w / 2 + tail, bubbleH - 1); g.fill();
      g.fillStyle = '#16151b'; g.font = BUBBLE_FONT; g.textAlign = 'center'; g.textBaseline = 'top';
      lines.forEach((l, i) => g.fillText(l, w / 2, padY + i * lineH + S));
    }
    // ---- name pill
    if (!showName) { this.texture.needsUpdate = true; this.sprite.scale.set((w / S) * PX, (h / S) * PX, 1); return; }
    const ny = h - nameH, nx = (w - nameW) / 2;
    g.font = FONT;
    g.fillStyle = 'rgba(14,13,18,0.8)';
    g.beginPath(); g.roundRect(nx, ny, nameW, nameH, 8 * S); g.fill();
    let x = nx + 10 * S;
    if (chip) {
      g.fillStyle = '#f1c76b';
      g.beginPath(); g.roundRect(x, ny + 5 * S, chipW, nameH - 10 * S, 6 * S); g.fill();
      g.fillStyle = '#16151b'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(chip, x + 6 * S, ny + nameH / 2 + S);
      x += chipW + 6 * S;
    }
    g.fillStyle = this.status ? '#c9b37a' : '#f1efe9';
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(label, x, ny + nameH / 2 + S);
    this.texture.needsUpdate = true;
    this.sprite.scale.set((w / S) * PX, (h / S) * PX, 1);
    (this.sprite.material as THREE.SpriteMaterial).opacity = this.status ? 0.75 : 1;
  }
}

/** Word-wraps text to maxW (falls back to character breaks for long words / CJK). */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of [...text]) {
    const next = cur + ch;
    if (g.measureText(next).width <= maxW) { cur = next; continue; }
    const cut = ch !== ' ' ? cur.lastIndexOf(' ') : -1;
    if (cut > 0) { lines.push(cur.slice(0, cut)); cur = cur.slice(cut + 1) + ch; }
    else { lines.push(cur); cur = ch === ' ' ? '' : ch; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && lines.join(' ').length < text.length) {
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}
