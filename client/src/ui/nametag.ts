import * as THREE from 'three';

/** A player's name floating above their owl. Drawn on a small canvas; always faces the camera. */
export class NameTag {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private name: string;
  private status: string | null = null;

  constructor(name: string) {
    this.name = name;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthWrite: false, transparent: true, fog: false }));
    this.sprite.renderOrder = 10;
    this.draw();
  }

  setName(name: string) { this.name = name; this.draw(); }
  setStatus(status: string | null) { this.status = status; this.draw(); }

  dispose() {
    this.sprite.removeFromParent();
    this.texture.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }

  private draw() {
    const scale = 2, h = 30 * scale, font = `600 ${14 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.font = font;
    const label = this.status ? `${this.name} · ${this.status}` : this.name;
    const w = Math.ceil(g.measureText(label).width) + 20 * scale;
    this.canvas.width = w; this.canvas.height = h;
    g.font = font;
    g.fillStyle = 'rgba(14,13,18,0.78)';
    g.beginPath(); g.roundRect(0, 0, w, h, 8 * scale); g.fill();
    g.fillStyle = this.status ? '#c9b37a' : '#f1efe9';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, w / 2, h / 2 + scale);
    this.texture.needsUpdate = true;
    const worldH = 0.12;
    this.sprite.scale.set((worldH * w) / h, worldH, 1);
    (this.sprite.material as THREE.SpriteMaterial).opacity = this.status ? 0.75 : 1;
  }
}
