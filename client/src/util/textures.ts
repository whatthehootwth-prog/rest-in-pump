import * as THREE from 'three';

export function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas is not available');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

/** Engraved-looking serif text on a transparent background. */
export function textTex(lines: string[], w = 256, h = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas is not available');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const fs = lines.length > 1 ? h * 0.3 : h * 0.46;
  g.font = `600 ${fs}px Georgia, "Times New Roman", serif`;
  lines.forEach((ln, i) => {
    const y = h / 2 + (i - (lines.length - 1) / 2) * fs * 1.15;
    g.fillStyle = 'rgba(230,228,240,.35)'; g.fillText(ln, w / 2 + 1.5, y + 1.5);
    g.fillStyle = 'rgba(38,34,48,.9)'; g.fillText(ln, w / 2, y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Soft round shadow blob used under characters. */
export const blobShadowTexture = (() => {
  let tex: THREE.CanvasTexture | null = null;
  return () => tex ??= canvasTex(128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
})();
