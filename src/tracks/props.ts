import * as THREE from 'three';
import type { Track } from './track';
import { ribbon } from './build';
import * as tex from '../render/textures';

export const UP = new THREE.Vector3(0, 1, 0);

export function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function vnoise(x: number, y: number, seed = 0): number {
  const h = (a: number, b: number) => {
    let n = (a * 374761393 + b * 668265263 + seed * 2147483647) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm2(x: number, y: number, oct = 5, seed = 0) {
  let s = 0, a = 1, t = 0;
  for (let o = 0; o < oct; o++) { s += vnoise(x, y, seed + o) * a; t += a; a *= 0.5; x *= 2.03; y *= 2.03; }
  return s / t;
}

export function swapUV(g: THREE.BufferGeometry) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); uv.setXY(i, uv.getY(i), u); }
  return g;
}

/**
 * Grandstand following the track outside the wall. `range` null = all the way around.
 * `edge(i)` gives the point behind the wall/barrier where the stand starts (horizontal offsets
 * are applied along R).
 */
export function grandstand(
  track: Track,
  group: THREE.Group,
  o: { range: [number, number] | null; edge: (i: number) => THREE.Vector3; gap: number; depth: number; base: number; top: number; suites?: boolean; roof?: boolean },
) {
  const crowdTex = tex.crowd();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb6b0a6, roughness: 0.9 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x223448, roughness: 0.05, metalness: 0.3, emissive: 0x1a2430, envMapIntensity: 1.6 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xdcdcdc, roughness: 0.6, metalness: 0.3 });
  const at = (i: number, h: number, y: number) => {
    const p = o.edge(i).addScaledVector(track.R[i], o.gap + h);
    p.y += y;
    return p;
  };
  const seats = swapUV(ribbon(track, o.range, (i) => [at(i, 0, o.base), at(i, o.depth, o.top)], { uAcross: [0, o.depth / 18], vScale: 28 }));
  const m = new THREE.Mesh(seats, new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 0.95, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  group.add(m);
  group.add(new THREE.Mesh(ribbon(track, o.range, (i) => [at(i, 0, -2), at(i, 0, o.base), at(i, -0.3, o.base + 1.1)], {}), concrete));
  const back = new THREE.Mesh(ribbon(track, o.range, (i) => [at(i, o.depth, o.top), at(i, o.depth + 1, o.top), at(i, o.depth + 1, -2)], {}), concrete);
  back.castShadow = true;
  group.add(back);
  const sh = o.suites ? 8 : 0;
  if (o.suites) group.add(new THREE.Mesh(ribbon(track, o.range, (i) => [at(i, o.depth - 0.2, o.top), at(i, o.depth - 0.2, o.top + sh)], {}), glass));
  if (o.roof || o.suites) {
    const rm = new THREE.Mesh(ribbon(track, o.range, (i) => [at(i, o.depth + 1.2, o.top + sh + 3), at(i, o.depth - 16, o.top + sh + 3), at(i, o.depth - 16, o.top + sh + 3.8), at(i, o.depth + 1.2, o.top + sh + 3.8)], {}), roofMat);
    rm.castShadow = true;
    group.add(rm);
  }
  return { at, topY: o.top + sh + 3.8 };
}

/** Distant terrain ring (mountains) with vertex colours from a height → colour ramp. */
export function mountainRing(group: THREE.Group, o: { r0: number; r1: number; height: number; seed: number; base: number; ramp: (h: number, n: number) => THREE.Color; center?: THREE.Vector2 }) {
  const rings = 44, segs = 300;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const cx = o.center?.x ?? 0, cz = o.center?.y ?? 0;
  for (let ri = 0; ri <= rings; ri++) {
    const rad = o.r0 + (o.r1 - o.r0) * Math.pow(ri / rings, 1.3);
    for (let si = 0; si <= segs; si++) {
      const a = (si / segs) * Math.PI * 2;
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
      const n = fbm2(x / 1100, z / 1100, 5, o.seed);
      const edge = THREE.MathUtils.smoothstep((rad - o.r0) / 1200, 0, 1);
      const ridge = 1 - Math.abs(fbm2(x / 700, z / 700, 4, o.seed + 5) * 2 - 1);
      const h = o.base + edge * (n * 0.6 + ridge * 0.6) * o.height;
      pos.push(x, h, z);
      const c = o.ramp(h - o.base, n);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let ri = 0; ri < rings; ri++) for (let si = 0; si < segs; si++) {
    const a = ri * (segs + 1) + si, b = a + 1, c = a + segs + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
}

/** Billboard with a fictional sponsor. */
export function billboard(text: string, hue: number, w = 32, h = 8) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `hsl(${hue},70%,40%)`; ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = '#fff'; ctx.font = 'italic 900 96px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.15 }));
}

export const SPONSOR_BOARDS = ['DUNEBLAZE ENERGY', 'RIDGEBACK TIRES', 'KESTREL MOTOR OIL', 'QUORRA INSURANCE', 'HOLLOWPEAK TOOLS', 'SOLANO SNACKS', 'VANTIX PARTS', 'MAKO TOOLS'];
