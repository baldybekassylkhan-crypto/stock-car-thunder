import * as THREE from 'three';

/** Procedural, tileable textures so the game ships with zero downloaded image assets. */

function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable fractal value noise in [0,1], `period` cells across at octave 0. */
export function fbm(size: number, period: number, octaves: number, seed: number, persistence = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period << o;
    const cell = size / p;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = hash(x0 % p, y0 % p, seed + o);
        const b = hash((x0 + 1) % p, y0 % p, seed + o);
        const c = hash(x0 % p, (y0 + 1) % p, seed + o);
        const d = hash((x0 + 1) % p, (y0 + 1) % p, seed + o);
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= persistence;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function heightToNormal(h: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const c = canvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function pbrFromNoise(
  size: number,
  seed: number,
  color: (n: number, grain: number, x: number, y: number) => [number, number, number],
  rough: (n: number, grain: number) => number,
  normalStrength: number,
  period = 4,
): PBRSet {
  const n = fbm(size, period, 6, seed, 0.55);
  const grain = fbm(size, 64, 2, seed + 99, 0.5);
  const cc = canvas(size);
  const rc = canvas(size);
  const cctx = cc.getContext('2d')!;
  const rctx = rc.getContext('2d')!;
  const ci = cctx.createImageData(size, size);
  const ri = rctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const [r, g, b] = color(n[k], grain[k], x, y);
      ci.data[k * 4] = r; ci.data[k * 4 + 1] = g; ci.data[k * 4 + 2] = b; ci.data[k * 4 + 3] = 255;
      const rv = rough(n[k], grain[k]) * 255;
      ri.data[k * 4] = rv; ri.data[k * 4 + 1] = rv; ri.data[k * 4 + 2] = rv; ri.data[k * 4 + 3] = 255;
      h[k] = n[k] * 0.4 + grain[k] * 0.6;
    }
  }
  cctx.putImageData(ci, 0, 0);
  rctx.putImageData(ri, 0, 0);
  return {
    map: toTexture(cc, true),
    roughnessMap: toTexture(rc, false),
    normalMap: toTexture(heightToNormal(h, size, normalStrength), false),
  };
}

export const asphalt = () =>
  pbrFromNoise(
    512, 11,
    (n, g) => {
      const v = 58 + n * 14 + (g > 0.74 ? 26 : g < 0.25 ? -10 : 0);
      return [v, v, v + 3];
    },
    (n, g) => 0.8 + n * 0.1 - (g > 0.74 ? 0.15 : 0),
    3,
  );

export const concrete = () =>
  pbrFromNoise(
    512, 23,
    (n, g) => {
      const v = 150 + n * 40 + g * 12;
      return [v, v - 2, v - 6];
    },
    (n) => 0.85 + n * 0.1,
    2.5,
  );

export const grass = () =>
  pbrFromNoise(
    512, 37,
    (n, g) => [52 + n * 26 + g * 22, 82 + n * 30 + g * 28, 30 + n * 12],
    (n) => 0.9 + n * 0.08,
    2.5,
    8,
  );

export const sand = () =>
  pbrFromNoise(
    512, 51,
    (n, g) => [176 + n * 46 + g * 14, 132 + n * 38 + g * 12, 88 + n * 26 + g * 8],
    (n) => 0.95 + n * 0.05,
    4,
    5,
  );

/** Crowd in grandstand rows: rows of colored "people" over dark seats. */
export function crowd(): THREE.Texture {
  const c = canvas(512);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2a2f3a';
  ctx.fillRect(0, 0, 512, 512);
  const palette = ['#e8e2d6', '#c23b2e', '#2c5aa0', '#f2c230', '#1d1d1d', '#4b8b3b', '#d9763a', '#8a8fa0', '#ffffff', '#6b3b8a'];
  for (let row = 0; row < 32; row++) {
    const y = row * 16;
    ctx.fillStyle = '#1b1f28';
    ctx.fillRect(0, y + 12, 512, 4);
    for (let x = 0; x < 512; x += 6 + ((row * 7 + x) % 3)) {
      if (hash(x, row, 3) < 0.15) continue;
      ctx.fillStyle = palette[Math.floor(hash(x, row, 5) * palette.length)];
      ctx.fillRect(x, y + 4, 5, 8);
      ctx.fillStyle = hash(x, row, 9) < 0.5 ? '#e3b48f' : '#8d5a3b';
      ctx.fillRect(x + 1, y + 1, 3, 3);
    }
  }
  return toTexture(c, true);
}

/** Chain-link catch fence (alpha). */
export function fence(): THREE.Texture {
  const c = canvas(128);
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(200,205,210,0.9)';
  ctx.lineWidth = 1.5;
  for (let i = -128; i < 256; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 128, 128); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i + 128, 0); ctx.lineTo(i, 128); ctx.stroke();
  }
  const t = toTexture(c, true);
  return t;
}

/** SAFER barrier / wall face: white concrete with dark scuffs. */
export function wall(): THREE.Texture {
  const c = canvas(512);
  const ctx = c.getContext('2d')!;
  const n = fbm(512, 8, 5, 77);
  const img = ctx.createImageData(512, 512);
  for (let i = 0; i < n.length; i++) {
    const y = Math.floor(i / 512);
    let v = 228 + n[i] * 20;
    if (y > 470) v = 40; // base stripe
    if (n[i] > 0.66 && y < 380 && y > 120) v -= (n[i] - 0.66) * 300; // rubber scuffs
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v + 2; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, true);
}

export function checkered(cells = 8): THREE.Texture {
  const c = canvas(256);
  const ctx = c.getContext('2d')!;
  const s = 256 / cells;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
    ctx.fillRect(x * s, y * s, s, s);
  }
  return toTexture(c, true);
}
