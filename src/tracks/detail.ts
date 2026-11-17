import * as THREE from 'three';
import type { LoadedMap } from './maps';
import { rng } from './props';

/**
 * Extra detail for every race track, added after the map is built:
 *  - building facades: plain box buildings (pit buildings, garages, towers, city blocks) get a
 *    window grid, with a share of the windows lit (they glow at night and at dusk);
 *  - pit lane equipment at every stall: tyre stacks (with coloured tyre blankets for GP cars),
 *    tool trolleys, an overhead pit boom with a light and an air hose, a team sign, and fuel rigs
 *    for stock cars.
 */
export function addTrackDetail(map: LoadedMap, series: 'stock' | 'gp') {
  const a = map.atmosphere;
  const glow = a.mode === 'night' ? 1.4 : (a.sunElevation ?? 45) < 14 || a.mode === 'overcast' ? 0.8 : 0.35;
  applyFacades(map.group, glow);
  addPitEquipment(map, series, glow);
}

// ------------------------------------------------------------------ facades

/** Window grid: 6 columns × 12 floors on a 256×512 canvas (about 21 m × 42 m of wall). */
const TILE_W = 21, TILE_H = 42;
let facadeCache: { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } | null = null;

function facadeTextures() {
  if (facadeCache) return facadeCache;
  const r = rng(4242);
  const mk = () => { const c = document.createElement('canvas'); c.width = 256; c.height = 512; return c; };
  const base = mk(), glow = mk();
  const b = base.getContext('2d')!, g = glow.getContext('2d')!;
  b.fillStyle = '#f2f2f2';
  b.fillRect(0, 0, 256, 512);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 512);
  const cw = 256 / 6, rh = 512 / 12;
  for (let row = 0; row < 12; row++) {
    // a darker band between floors
    b.fillStyle = '#d4d4d4';
    b.fillRect(0, row * rh + rh - 5, 256, 5);
    for (let col = 0; col < 6; col++) {
      const x = col * cw + 6, y = row * rh + 7, w = cw - 12, h = rh - 16;
      const lit = r() < 0.38;
      const warm = r() < 0.7;
      b.fillStyle = lit ? (warm ? '#ffe2a8' : '#e4f0ff') : (r() < 0.5 ? '#2a3442' : '#1c2430');
      b.fillRect(x, y, w, h);
      // window frame mullion
      b.fillStyle = '#9aa0a8';
      b.fillRect(x + w / 2 - 1, y, 2, h);
      if (lit) {
        g.fillStyle = warm ? '#ffcf7a' : '#cfe4ff';
        g.fillRect(x, y, w, h);
        // a drawn blind on some lit windows
        if (r() < 0.3) { g.fillStyle = '#7a5a2a'; g.fillRect(x, y, w, h * 0.45); }
      }
    }
  }
  const map = new THREE.CanvasTexture(base);
  map.colorSpace = THREE.SRGBColorSpace;
  const emissive = new THREE.CanvasTexture(glow);
  emissive.colorSpace = THREE.SRGBColorSpace;
  for (const t of [map, emissive]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
  facadeCache = { map, emissive };
  return facadeCache;
}

function facadeMat(src: THREE.MeshStandardMaterial, faceW: number, faceH: number, glow: number, offset: number) {
  const { map, emissive } = facadeTextures();
  const m = src.clone();
  m.map = map.clone();
  m.emissiveMap = emissive.clone();
  for (const t of [m.map, m.emissiveMap]) {
    t.repeat.set(Math.max(0.2, faceW / TILE_W), Math.max(0.1, faceH / TILE_H));
    t.offset.set(offset, 0);
    t.needsUpdate = true;
  }
  m.emissive = new THREE.Color(0xffffff);
  m.emissiveIntensity = glow;
  // keep the building's own colour on the wall, but don't let a dark base colour hide the windows
  const hsl = { h: 0, s: 0, l: 0 };
  m.color.getHSL(hsl);
  if (hsl.l < 0.35) m.color.setHSL(hsl.h, hsl.s, 0.35);
  return m;
}

/** Plain box meshes that look like buildings get window facades on their four sides. */
function applyFacades(group: THREE.Group, glow: number) {
  const todo: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.geometry?.type !== 'BoxGeometry' || Array.isArray(m.material)) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (!mat.isMeshStandardMaterial || mat.map || mat.transparent) return;
    todo.push(m);
  });
  let k = 0;
  for (const m of todo) {
    const p = (m.geometry as THREE.BoxGeometry).parameters;
    // world-ish size (instanced meshes: the average instance scale)
    let sx = m.scale.x, sy = m.scale.y, sz = m.scale.z;
    if ((m as THREE.InstancedMesh).isInstancedMesh) {
      const im = m as THREE.InstancedMesh;
      const n = Math.min(im.count, 60);
      const s = new THREE.Vector3(), acc = new THREE.Vector3(), mt = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3();
      for (let i = 0; i < n; i++) { im.getMatrixAt(i, mt); mt.decompose(pos, q, s); acc.add(s); }
      acc.divideScalar(Math.max(1, n));
      sx *= acc.x; sy *= acc.y; sz *= acc.z;
    }
    const w = p.width * sx, h = p.height * sy, d = p.depth * sz;
    if (h < 4.5 || Math.min(w, d) < 3.5 || Math.max(w, d) > 400) continue;
    const src = m.material as THREE.MeshStandardMaterial;
    const off = (k++ * 0.37) % 1;
    const sideX = facadeMat(src, d, h, glow, off), sideZ = facadeMat(src, w, h, glow, off + 0.5);
    m.material = [sideX, sideX, src, src, sideZ, sideZ];
  }
}

// ------------------------------------------------------------------ pit lane equipment

class Batch {
  readonly mats: THREE.Matrix4[] = [];
  constructor(readonly geo: THREE.BufferGeometry, readonly mat: THREE.Material) {}
  add(m: THREE.Matrix4) { this.mats.push(m.clone()); }
  build(group: THREE.Group, shadow = true) {
    if (!this.mats.length) return;
    const im = new THREE.InstancedMesh(this.geo, this.mat, this.mats.length);
    this.mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = shadow;
    im.receiveShadow = true;
    group.add(im);
  }
}

function addPitEquipment(map: LoadedMap, series: 'stock' | 'gp', glow: number) {
  const pit = map.pit;
  if (!pit || pit.edge === undefined) return;
  const tr = map.track;
  const group = new THREE.Group();
  const UP = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Object3D();
  const M = new THREE.Matrix4();

  const tyreGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.28, 18);
  const blanketGeo = new THREE.CylinderGeometry(0.345, 0.345, 0.2, 18);
  const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.29, 12);
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8);
  const tyres = new Batch(tyreGeo, new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }));
  const rims = new Batch(rimGeo, new THREE.MeshStandardMaterial({ color: 0x8c9096, metalness: 0.9, roughness: 0.3 }));
  const blankets = ['#d62828', '#f2c200', '#f2f2f2'].map((c) => new Batch(blanketGeo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 })));
  const trolleyBody = new Batch(unitBox, new THREE.MeshStandardMaterial({ color: 0xb91c1c, metalness: 0.4, roughness: 0.45 }));
  const trolleyTop = new Batch(unitBox, new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
  const drawer = new Batch(unitBox, new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.8, roughness: 0.3 }));
  const steel = new Batch(unitCyl, new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.8, roughness: 0.35 }));
  const hose = new Batch(unitCyl, new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.6 }));
  const lamp = new Batch(unitBox, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.6 + glow }));
  const fuel = new Batch(unitCyl, new THREE.MeshStandardMaterial({ color: 0xd0d3d8, metalness: 0.7, roughness: 0.35 }));
  const fuelBand = new Batch(unitCyl, new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5 }));
  const signCols = [0xd62828, 0x1d4ed8, 0x16a34a, 0xf59e0b, 0x7c3aed, 0x0ea5e9, 0xe11d48, 0x334155];
  const signs = signCols.map((c) => new Batch(unitBox, new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, emissive: c, emissiveIntensity: 0.15 + glow * 0.25 })));

  const span = ((pit.limitTo - pit.boxFrom) % tr.n + tr.n) % tr.n;
  const stalls = Math.min(40, Math.max(0, Math.floor(span / pit.boxSpacing)));
  const r = rng(99);
  const back = pit.edge - 1.0; // just beyond the lane's garage-side edge
  const reach = pit.box - back + 0.6; // how far the boom arm reaches out over the stall

  for (let k = 0; k < stalls; k++) {
    const i0 = tr.wrap(pit.boxFrom + k * pit.boxSpacing);
    const T = tr.T[i0];
    const yaw = Math.atan2(T.x, T.z);
    /** World point: `lat` metres towards the track from the equipment line, `along` metres down the lane, `h` up. */
    const P = (lat: number, along: number, h: number) => tr.surface(i0, back + lat).addScaledVector(T, along).addScaledVector(UP, h);
    const place = (b: Batch, p: THREE.Vector3, sx: number, sy: number, sz: number, rotY = yaw) => {
      tmp.position.copy(p);
      tmp.rotation.set(0, rotY, 0);
      tmp.scale.set(sx, sy, sz);
      tmp.updateMatrix();
      b.add(tmp.matrix);
    };
    const between = (b: Batch, p0: THREE.Vector3, p1: THREE.Vector3, radius: number) => {
      const dir = p1.clone().sub(p0);
      const len = dir.length();
      M.compose(p0.clone().lerp(p1, 0.5), new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()), new THREE.Vector3(radius, len, radius));
      b.add(M);
    };

    // tyre stacks: two stacks of four (a fresh set), with tyre blankets on GP cars
    const compound = (k + Math.floor(r() * 3)) % 3;
    for (const along of [-1.25, -0.5]) {
      for (let h = 0; h < 4; h++) {
        const p = P(0, along, 0.15 + h * 0.3);
        place(tyres, p, 1, 1, 1);
        place(rims, p, 1, 1, 1);
        if (series === 'gp') place(blankets[compound], p, 1, 1, 1);
      }
    }
    // tool trolley with drawers
    place(trolleyBody, P(0.1, 0.75, 0.5), 0.55, 0.9, 0.85);
    place(trolleyTop, P(0.1, 0.75, 0.97), 0.58, 0.04, 0.88);
    for (let d = 0; d < 3; d++) place(drawer, P(0.39, 0.75, 0.25 + d * 0.25), 0.02, 0.05, 0.6);
    // pit boom: post, arm out over the stall, a light and an air hose hanging down
    const post0 = P(-0.4, 1.6, 0), post1 = P(-0.4, 1.6, 4.4);
    between(steel, post0, post1, 0.07);
    const armEnd = P(reach, 1.6, 4.3);
    between(steel, P(-0.4, 1.6, 4.3), armEnd, 0.05);
    place(lamp, P(reach - 0.4, 1.6, 4.2), 0.35, 0.06, 0.2);
    between(hose, armEnd, P(reach, 1.6, 3.1), 0.03);
    between(hose, P(reach, 1.6, 3.1), P(reach - 0.25, 1.45, 2.7), 0.03);
    // team sign on the post
    place(signs[k % signs.length], P(-0.4, 1.6, 3.4), 0.06, 0.7, 1.3);
    // stock cars: a fuel rig (tall tank on a stand) at every other stall
    if (series === 'stock') {
      place(fuel, P(-0.1, -2.0, 1.1), 0.32, 1.6, 0.32);
      place(fuelBand, P(-0.1, -2.0, 1.5), 0.33, 0.12, 0.33);
      between(steel, P(-0.1, -2.0, 0), P(-0.1, -2.0, 0.3), 0.36);
    }
  }
  for (const b of [tyres, rims, ...blankets, trolleyBody, trolleyTop, drawer, steel, hose, fuel, fuelBand, ...signs]) b.build(group);
  lamp.build(group, false);
  map.group.add(group);
}
