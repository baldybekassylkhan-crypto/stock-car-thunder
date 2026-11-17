import * as THREE from 'three';
import { Track, resampleClosed, smoothClosed } from './track';
import { ribbon, toCollider, buildPitLane, type ColliderMesh, type SurfaceKind } from './build';
import type { Atmosphere, LoadedMap } from './maps';
import { makeGrid } from './maps';
import * as tex from '../render/textures';
import { rng, UP } from './props';

/**
 * Generic road-course builder (used by the GP circuits): a spline centreline with elevation,
 * kerbs, run-off (grass / tarmac / street), optional gravel traps, barriers (armco or concrete
 * street walls with catch fences), an optional tunnel, sector and safety-car lines, and a pit lane
 * with 32 stalls beside the main straight. Each circuit adds its own scenery through `scenery`.
 */
export interface RoadCourseDef {
  ctrl: [number, number, number][]; // x, z, elevation (m)
  length: number; // target length (m)
  width: number;
  /** Start/finish near this point (before scaling). */
  start: [number, number];
  camberDeg: number;
  /** Run-off on straights and extra on the outside of corners (m). */
  runoff: number;
  runoffTurn: number;
  runoffSurface: SurfaceKind;
  runoffColor: number;
  gravel: boolean;
  barrier: 'armco' | 'wall';
  /** Sample ranges with a tunnel roof (relative to start/finish). */
  tunnels?: [number, number][];
  pit: { from: number; to: number; taper: number; boxSpacing: number };
  ground: { color: number; texture: 'grass' | 'sand' | 'asphalt' };
  atmosphere: Atmosphere;
  /** Night circuit: emissive street lamps along the track. */
  lamps?: boolean;
  paceSpeed: number;
  scenery?: (ctx: SceneryCtx) => void;
}

export interface SceneryCtx {
  track: Track;
  group: THREE.Group;
  colliders: ColliderMesh[];
  n: number;
  r: () => number;
  /** Barrier position on a side (-1 left, +1 right). */
  barrierAt(i: number, side: number): THREE.Vector3;
  runL: number[];
  runR: number[];
  /** 0..1 how much of a corner's outside is on each side. */
  outL: number[];
  outR: number[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minE: number; avgE: number };
}

export function stripeTexture(a: string, b: string) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = a; ctx.fillRect(0, 0, 16, 32);
  ctx.fillStyle = b; ctx.fillRect(0, 32, 16, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Centreline from control points, scaled to the target length, starting at the start point. */
export function roadCentreline(def: Pick<RoadCourseDef, 'ctrl' | 'length' | 'start'>): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(def.ctrl.map(([x, z, e]) => new THREE.Vector3(x, e, z)), true, 'catmullrom', 0.5);
  let pts = curve.getPoints(8000);
  pts.pop();
  let len2d = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; len2d += Math.hypot(b.x - a.x, b.z - a.z); }
  const k = def.length / len2d;
  pts.forEach((p) => { p.x *= k; p.z *= k; });
  pts = resampleClosed(pts, Math.round(def.length / 2));
  pts = smoothClosed(pts, 2.5);
  let s0 = 0, best = Infinity;
  pts.forEach((p, i) => { const d = Math.hypot(p.x - def.start[0] * k, p.z - def.start[1] * k); if (d < best) { best = d; s0 = i; } });
  return pts.slice(s0).concat(pts.slice(0, s0));
}

export function buildRoadCourse(def: RoadCourseDef): LoadedMap {
  const W = def.width;
  const track = new Track(roadCentreline(def), W, (_u, kk) => THREE.MathUtils.clamp(kk * 260, -1, 1) * THREE.MathUtils.degToRad(def.camberDeg), 30, 'center');
  const n = track.n;
  const group = new THREE.Group();
  const colliders: ColliderMesh[] = [];
  const r = rng(Math.round(def.length));

  // ---------- run-off widths ----------
  const smoothArr = (a: number[], w: number) => a.map((_, i) => { let s = 0; for (let j = -w; j <= w; j++) s += a[track.wrap(i + j)]; return s / (2 * w + 1); });
  const kap = track.curvature;
  const turn = smoothArr(kap.map((x) => THREE.MathUtils.clamp((Math.abs(x) - 1 / 400) * 120, 0, 1)), 12);
  const outR = smoothArr(kap.map((x, i) => (x > 0 ? turn[i] : 0)), 25);
  const outL = smoothArr(kap.map((x, i) => (x < 0 ? turn[i] : 0)), 25);
  const PIT = { ...def.pit, wallD: Math.max(4, def.runoff + 1), laneWidth: 7 };
  const pitRun = (i: number) => {
    const k = ((i - track.wrap(PIT.from)) % n + n) % n, len = PIT.to - PIT.from;
    if (k <= len) return 1;
    return THREE.MathUtils.smoothstep(1 - Math.min(n - k, k - len) / 60, 0, 1);
  };
  const pitNeed = PIT.wallD + 0.6 + PIT.laneWidth + 2;
  const runL = outL.map((t, i) => Math.max(def.runoff + def.runoffTurn * t, def.runoff + (pitNeed - def.runoff) * pitRun(i)));
  const runR = outR.map((t) => def.runoff + def.runoffTurn * t);
  const CURB = 1.4;

  // ---------- road ----------
  const roadSet = tex.asphalt();
  const dList = [0, W * 0.15, W * 0.35, W * 0.5, W * 0.65, W * 0.85, W];
  const roadGeo = ribbon(track, null, (i) => dList.map((d) => track.surface(i, d)), {
    uAcross: dList.map((d) => d / 3), vScale: 3,
    colors: (i, j) => { const d = dList[j] / W; return 1 - 0.18 * Math.exp(-((d - 0.5 - turn[i] * Math.sign(kap[i]) * -0.3) ** 2) / 0.02); },
  });
  const road = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ ...roadSet, vertexColors: true, roughness: 1 }));
  road.receiveShadow = true;
  group.add(road);
  colliders.push(toCollider('asphalt', roadGeo));
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [a, b] of [[0.25, 0.45], [W - 0.45, W - 0.25]]) {
    group.add(new THREE.Mesh(ribbon(track, null, (i) => [track.surface(i, a).addScaledVector(track.N[i], 0.01), track.surface(i, b).addScaledVector(track.N[i], 0.01)]), lineMat));
  }
  // start/finish (checkered), sector lines (white) and the safety-car line (yellow) before the pit entry
  const crossLine = (at: number, len: number, mat: THREE.Material) => group.add(new THREE.Mesh(ribbon(track, [at, at + len], (i) => [0, W / 2, W].map((d) => track.surface(i, d).addScaledVector(track.N[i], 0.015)), { uAcross: [0, 2, 4], vScale: track.ds * 2 }), mat));
  crossLine(0, 2, new THREE.MeshStandardMaterial({ map: tex.checkered(4), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  const sectorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 });
  crossLine(Math.round(n / 3), 0.5, sectorMat);
  crossLine(Math.round((2 * n) / 3), 0.5, sectorMat);
  crossLine(track.wrap(PIT.from - 40), 0.5, new THREE.MeshStandardMaterial({ color: 0xffcc00, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 }));

  // ---------- kerbs ----------
  const ranges = (vals: number[], thr: number): [number, number][] => {
    const out: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && vals[i] > thr;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push([start, i - 1]); start = -1; }
    }
    return out.filter(([a, b]) => b - a > 4);
  };
  const curbMat = new THREE.MeshStandardMaterial({ map: stripeTexture('#d32020', '#f4f4f4'), roughness: 0.55 });
  for (const side of [-1, 1]) {
    for (const [a, b] of ranges(turn, 0.25)) {
      const g = ribbon(track, [a - 6, b + 6], (i) => side < 0
        ? [track.surface(i, -CURB), track.surface(i, -CURB * 0.5).addScaledVector(UP, 0.05), track.surface(i, 0).addScaledVector(UP, 0.005)]
        : [track.surface(i, W).addScaledVector(UP, 0.005), track.surface(i, W + CURB * 0.5).addScaledVector(UP, 0.05), track.surface(i, W + CURB)], { uAcross: [0, 0.5, 1], vScale: 2 });
      const m = new THREE.Mesh(g, curbMat);
      m.receiveShadow = true;
      group.add(m);
      colliders.push(toCollider('curb', g));
    }
  }

  // ---------- run-off (continues under the road edge: no gaps a wheel can drop into) ----------
  const runSet = def.runoffSurface === 'grass' ? tex.grass() : def.runoffSurface === 'sand' ? tex.sand() : tex.concrete();
  const runMat = new THREE.MeshStandardMaterial({ ...runSet, roughness: 1, color: def.runoffColor });
  const gL = ribbon(track, null, (i) => [track.surface(i, -runL[i]).addScaledVector(UP, -0.02), track.surface(i, 0.4).addScaledVector(UP, -0.02)], { uAcross: [0, 4], vScale: 6 });
  const gR = ribbon(track, null, (i) => [track.surface(i, W - 0.4).addScaledVector(UP, -0.02), track.surface(i, W + runR[i]).addScaledVector(UP, -0.02)], { uAcross: [0, 4], vScale: 6 });
  for (const g of [gL, gR]) {
    const m = new THREE.Mesh(g, runMat);
    m.receiveShadow = true;
    group.add(m);
    colliders.push(toCollider(def.runoffSurface, g));
  }
  if (def.gravel) {
    const gravelMat = new THREE.MeshStandardMaterial({ ...tex.sand(), roughness: 1, color: 0xd8cdb8 });
    for (const [side, vals] of [[-1, outL], [1, outR]] as const) {
      for (const range of ranges(vals, 0.35)) {
        const g = ribbon(track, range, (i) => {
          const w = vals[i];
          const run = side < 0 ? runL[i] : runR[i];
          const inner = CURB + 2.5 + (1 - w) * 6;
          if (side < 0) return [track.surface(i, -(run - 0.8)).addScaledVector(UP, 0.01), track.surface(i, -inner).addScaledVector(UP, 0.01)];
          return [track.surface(i, W + inner).addScaledVector(UP, 0.01), track.surface(i, W + run - 0.8).addScaledVector(UP, 0.01)];
        }, { uAcross: [0, 3], vScale: 5 });
        group.add(new THREE.Mesh(g, gravelMat));
        colliders.push(toCollider('gravel', g));
      }
    }
  }

  // ---------- barriers ----------
  const barrierAt = (i: number, side: number) => (side < 0 ? track.surface(i, -runL[i]) : track.surface(i, W + runR[i]));
  const wallTex = tex.wall();
  for (const side of [-1, 1]) {
    // invisible tall collision wall keeps every car in
    colliders.push(toCollider('wall', ribbon(track, null, (i) => {
      const b = barrierAt(i, side);
      return side < 0 ? [b.clone().addScaledVector(UP, 4), b.clone().addScaledVector(UP, -1.5)] : [b.clone().addScaledVector(UP, -1.5), b.clone().addScaledVector(UP, 4)];
    })));
    if (def.barrier === 'wall') {
      // street circuit: concrete blocks and a catch fence
      const wall = ribbon(track, null, (i) => { const b = barrierAt(i, side); return [b.clone().addScaledVector(UP, -0.5), b.clone().addScaledVector(UP, 1.1)]; }, { vScale: 6 });
      group.add(new THREE.Mesh(wall, new THREE.MeshStandardMaterial({ map: wallTex, color: 0xd8d4cc, roughness: 0.85, side: THREE.DoubleSide })));
      const fenceTex = tex.fence();
      fenceTex.repeat.set(1, 1);
      const fence = ribbon(track, null, (i) => { const b = barrierAt(i, side).addScaledVector(track.R[i], side * 0.2); return [b.clone().addScaledVector(UP, 1.1), b.clone().addScaledVector(UP, 3.6)]; }, { vScale: 3 });
      group.add(new THREE.Mesh(fence, new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.5 })));
    } else {
      const foot = ribbon(track, null, (i) => { const b = barrierAt(i, side); return [b.clone().addScaledVector(UP, -2.5), b.clone().addScaledVector(UP, 0.25)]; });
      group.add(new THREE.Mesh(foot, new THREE.MeshStandardMaterial({ color: 0x8c8a85, roughness: 0.9, side: THREE.DoubleSide })));
      const rail = ribbon(track, null, (i) => { const b = barrierAt(i, side).addScaledVector(track.R[i], side * 0.15); return [b.clone().addScaledVector(UP, 0.35), b.clone().addScaledVector(UP, 0.75)]; }, { vScale: 4 });
      group.add(new THREE.Mesh(rail, new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide })));
    }
  }

  // ---------- tunnel ----------
  for (const [a, b] of def.tunnels ?? []) {
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.8, side: THREE.DoubleSide });
    const roof = ribbon(track, [a, b], (i) => [barrierAt(i, -1).addScaledVector(UP, 6.5), barrierAt(i, 1).addScaledVector(UP, 6.5)], { vScale: 6 });
    group.add(new THREE.Mesh(roof, roofMat));
    for (const side of [-1, 1]) {
      const wall = ribbon(track, [a, b], (i) => [barrierAt(i, side).addScaledVector(UP, 1.1), barrierAt(i, side).addScaledVector(UP, 6.5)], { vScale: 6 });
      group.add(new THREE.Mesh(wall, roofMat));
    }
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2b0, emissiveIntensity: 4 });
    for (let i = a; i < b; i += 8) {
      const ii = track.wrap(i);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 2.4), lampMat);
      lamp.position.copy(track.surface(ii, W / 2)).addScaledVector(UP, 6.4);
      lamp.rotation.y = Math.atan2(track.T[ii].x, track.T[ii].z);
      group.add(lamp);
    }
  }

  // ---------- street lamps (night) ----------
  if (def.lamps) {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a5e66, metalness: 0.6, roughness: 0.5 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd9a0, emissiveIntensity: 6 });
    const pole = new THREE.CylinderGeometry(0.1, 0.14, 9, 6);
    pole.translate(0, 4.5, 0);
    const count = Math.floor(n / 14) * 2;
    const poles = new THREE.InstancedMesh(pole, poleMat, count);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.25, 1.6), headMat, count);
    const o = new THREE.Object3D();
    let k = 0;
    for (let i = 0; i < n && k < count; i += 14) {
      for (const side of [-1, 1]) {
        const p = barrierAt(i, side).addScaledVector(track.R[i], side * 1.2);
        o.position.copy(p); o.rotation.set(0, 0, 0); o.updateMatrix();
        poles.setMatrixAt(k, o.matrix);
        o.position.copy(p).addScaledVector(UP, 9).addScaledVector(track.R[i], -side * 0.8); o.updateMatrix();
        heads.setMatrixAt(k, o.matrix);
        k++;
      }
    }
    poles.count = heads.count = k;
    group.add(poles, heads);
  }

  // ---------- ground ----------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, avgE = 0, minE = Infinity;
  for (const p of track.center) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); avgE += p.y; minE = Math.min(minE, p.y); }
  avgE /= n;
  const groundSet = def.ground.texture === 'grass' ? tex.grass() : def.ground.texture === 'sand' ? tex.sand() : tex.asphalt();
  for (const t of [groundSet.map, groundSet.normalMap, groundSet.roughnessMap]) t.repeat.set(400, 400);
  const groundGeo = new THREE.PlaneGeometry(9000, 9000);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ ...groundSet, color: def.ground.color, roughness: 1 }));
  ground.position.set((minX + maxX) / 2, minE - 0.06, (minZ + maxZ) / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // ---------- pit lane ----------
  const pitLane = buildPitLane(track, PIT);
  group.add(pitLane.group);
  colliders.push(...pitLane.colliders);

  def.scenery?.({ track, group, colliders, n, r, barrierAt, runL, runR, outL, outR, bounds: { minX, maxX, minZ, maxZ, minE, avgE } });

  const tvCams = [0.03, 0.14, 0.27, 0.4, 0.52, 0.64, 0.77, 0.9].map((u) => {
    const i = track.wrap(Math.round(u * n));
    const side = outR[i] > outL[i] ? 1 : -1;
    return barrierAt(i, side).addScaledVector(track.R[i], side * 4).addScaledVector(UP, 9);
  });

  return {
    track,
    group,
    colliders,
    pit: pitLane.pit,
    tvCams,
    gridSlot: makeGrid(track, { backM: 12, rowM: 8, lanes: [W * 0.3, W * 0.7], stagger: true }),
    paceSpeed: def.paceSpeed,
    oval: false,
    rain: false,
    gripScale: 1,
    groundY: minE - 40,
    outOfBounds: 60,
    atmosphere: def.atmosphere,
  };
}
