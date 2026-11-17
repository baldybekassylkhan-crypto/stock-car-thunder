import * as THREE from 'three';
import { Track } from './track';
import * as tex from '../render/textures';
import type { PitInfo } from '../race/pits';

const UP = new THREE.Vector3(0, 1, 0);

export type SurfaceKind = 'asphalt' | 'concrete' | 'grass' | 'sand' | 'wall' | 'gravel' | 'curb' | 'dirt';

export interface ColliderMesh {
  kind: SurfaceKind;
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface BuiltTrack {
  group: THREE.Group;
  colliders: ColliderMesh[];
  /** Pit lane, when the track has one. */
  pit?: PitInfo;
}

/** Cross-section ribbon: for every sample i, `cross(i)` returns points across; closes the loop. */
export function ribbon(
  track: Track,
  range: [number, number] | null,
  cross: (i: number, k: number) => THREE.Vector3[],
  opts: { uAcross?: number[]; vScale?: number; colors?: (i: number, j: number) => number } = {},
): THREE.BufferGeometry {
  const closed = range === null;
  const i0 = closed ? 0 : range![0];
  const count = closed ? track.n + 1 : range![1] - range![0] + 1;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let m = 0;
  for (let k = 0; k < count; k++) {
    const i = track.wrap(i0 + k);
    const pts = cross(i, k);
    m = pts.length;
    const v = ((k * track.ds) / (opts.vScale ?? 10));
    pts.forEach((p, j) => {
      pos.push(p.x, p.y, p.z);
      uv.push(opts.uAcross ? opts.uAcross[j] : j / (m - 1), v);
      if (opts.colors) {
        const c = opts.colors(i, j);
        col.push(c, c, c);
      }
    });
  }
  for (let k = 0; k < count - 1; k++) {
    for (let j = 0; j < m - 1; j++) {
      const a = k * m + j;
      const b = a + 1;
      const c = a + m;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (opts.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function toCollider(kind: SurfaceKind, g: THREE.BufferGeometry): ColliderMesh {
  return {
    kind,
    vertices: new Float32Array(g.getAttribute('position').array as ArrayLike<number>),
    indices: new Uint32Array(g.getIndex()!.array as ArrayLike<number>),
  };
}

function pbrMat(set: tex.PBRSet, repeat: [number, number], extra: THREE.MeshStandardMaterialParameters = {}) {
  for (const t of [set.map, set.normalMap, set.roughnessMap]) t.repeat.set(repeat[0], repeat[1]);
  return new THREE.MeshStandardMaterial({ map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap, roughness: 1, ...extra });
}

export interface OvalOptions {
  apron: number;
  wallHeight: number;
  fenceHeight: number;
  pit?: { from: number; to: number; width: number; taper?: number; boxSpacing?: number }; // sample range along frontstretch
  surface?: 'asphalt' | 'concrete';
  /** Multiplies road roughness (lower = wet-looking sheen). */
  roughness?: number;
}

/** Racing surface, apron, lines, SAFER wall, catch fence, pit road for an oval. */
export function buildOval(track: Track, o: OvalOptions): BuiltTrack {
  const group = new THREE.Group();
  const colliders: ColliderMesh[] = [];
  const W = track.width;

  // ---------- racing surface ----------
  // dense across the transition curve, then evenly up the banking
  const dList = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  for (let j = 1; j <= 10; j++) dList.push(4 + (j / 10) * (W - 4));
  const roadGeo = ribbon(track, null, (i) => dList.map((d) => track.surface(i, d)), {
    uAcross: dList.map((d) => d / 3),
    vScale: 3,
    colors: (i, j) => {
      // rubbered-in groove: darker along the low/middle line, a bit darker in turns
      const d = dList[j] / W;
      const turn = Math.min(1, Math.abs(track.curvature[i]) * 300);
      const grooveCenter = 0.22 + 0.18 * turn;
      const g = Math.exp(-((d - grooveCenter) ** 2) / 0.012);
      const top = d > 0.85 ? 0.08 : 0;
      return 1 - g * 0.32 + top;
    },
  });
  const asphalt = pbrMat(o.surface === 'concrete' ? tex.concrete() : tex.asphalt(), [1, 1], { vertexColors: true, roughness: o.roughness ?? 1, color: o.surface === 'concrete' ? 0x9a9a9a : 0xffffff });
  const road = new THREE.Mesh(roadGeo, asphalt);
  road.receiveShadow = true;
  group.add(road);
  colliders.push(toCollider(o.surface === 'concrete' ? 'concrete' : 'asphalt', roadGeo));

  // ---------- apron (flat, inside) ----------
  const apronGeo = ribbon(track, null, (i) => [track.surface(i, -o.apron).setY(0.0), track.surface(i, 0)], {
    uAcross: [0, o.apron / 6],
    vScale: 6,
  });
  const apronMat = pbrMat(tex.asphalt(), [1, 1], { color: 0xb9b9b9 });
  const apron = new THREE.Mesh(apronGeo, apronMat);
  apron.receiveShadow = true;
  group.add(apron);
  colliders.push(toCollider('asphalt', apronGeo));

  // ---------- painted lines ----------
  const lineMat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const stripe = (d0: number, d1: number, c: number, lift = 0.01) => {
    const g = ribbon(track, null, (i) => {
      return [track.surface(i, d0).addScaledVector(track.normalAt(i, d0), lift), track.surface(i, d1).addScaledVector(track.normalAt(i, d1), lift)];
    });
    const m = new THREE.Mesh(g, lineMat(c));
    m.receiveShadow = true;
    group.add(m);
  };
  stripe(0.15, 0.4, 0xf1f1f1); // white line at bottom of the banking
  stripe(-o.apron * 0.55, -o.apron * 0.55 + 0.2, 0xf2c200); // double yellow
  stripe(-o.apron * 0.55 + 0.35, -o.apron * 0.55 + 0.55, 0xf2c200);
  stripe(W - 0.55, W - 0.35, 0xf1f1f1);

  // start / finish checkered band across the surface
  {
    const sfD = [0, 1, 2, 3, 4, W];
    const sf = ribbon(track, [0, 2], (i) => [track.surface(i, -o.apron).setY(0.012), ...sfD.map((d) => track.surface(i, d).addScaledVector(track.normalAt(i, d), 0.012))], {
      uAcross: [0, ...sfD.map((d) => 1.5 + (d / o.apron) * 1.5)],
      vScale: track.ds * 2,
    });
    const ck = tex.checkered(4);
    const m = new THREE.Mesh(sf, new THREE.MeshStandardMaterial({ map: ck, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.receiveShadow = true;
    group.add(m);
  }

  // ---------- SAFER wall ----------
  // The wall rises perpendicular to the banked surface (not world-vertical): a vertical wall on a
  // 31° bank acts as a ramp and launches cars on impact.
  const wallT = 0.7;
  const wallUp = (i: number) => track.normalAt(i, W);
  const wallOut = (i: number) => track.B[i];
  const fenceTop = (i: number, base: THREE.Vector3, h: number, lean: number) =>
    base.clone().addScaledVector(wallUp(i), h).addScaledVector(wallOut(i), -lean);
  const wallGeo = ribbon(track, null, (i) => {
    const top = track.surface(i, W);
    const n = wallUp(i), out = wallOut(i);
    return [
      top.clone().addScaledVector(n, -0.05),
      top.clone().addScaledVector(n, o.wallHeight),
      top.clone().addScaledVector(n, o.wallHeight).addScaledVector(out, wallT),
      top.clone().addScaledVector(out, wallT).setY(0),
    ];
  }, { uAcross: [0, 0.45, 0.5, 1], vScale: 16 });
  const wallTex = tex.wall();
  const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.75 }));
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);
  colliders.push(toCollider('wall', wallGeo));

  // invisible collision for the catch fence: keeps cars inside the stadium
  const fenceCol = ribbon(track, null, (i) => {
    const base = track.surface(i, W).addScaledVector(wallUp(i), o.wallHeight - 0.1);
    return [base, fenceTop(i, base, o.fenceHeight, 1.2)];
  });
  colliders.push(toCollider('wall', fenceCol));

  // ---------- catch fence + posts ----------
  const fenceBase = (i: number) => track.surface(i, W).addScaledVector(wallUp(i), o.wallHeight).addScaledVector(wallOut(i), 0.2);
  const fenceGeo = ribbon(track, null, (i) => {
    const base = fenceBase(i);
    return [base, fenceTop(i, base, o.fenceHeight, 1.2)];
  }, { uAcross: [0, o.fenceHeight / 2.5], vScale: 2.5 });
  const ft = tex.fence();
  const fenceMat = new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.35, transparent: false, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.45 });
  const fenceMesh = new THREE.Mesh(fenceGeo, fenceMat);
  group.add(fenceMesh);

  const postEvery = Math.max(1, Math.round(6 / track.ds));
  const postCount = Math.floor(track.n / postEvery);
  const postLen = Math.hypot(o.fenceHeight, 1.2) + 0.3;
  const postGeo = new THREE.CylinderGeometry(0.07, 0.07, postLen, 6);
  postGeo.translate(0, postLen / 2, 0);
  const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 }), postCount);
  const tmp = new THREE.Object3D();
  let pitInfo: PitInfo | undefined;
  for (let k = 0; k < postCount; k++) {
    const i = k * postEvery;
    const base = fenceBase(i).addScaledVector(wallUp(i), -0.2);
    tmp.position.copy(base);
    tmp.quaternion.setFromUnitVectors(UP, fenceTop(i, base, o.fenceHeight, 1.2).sub(base).normalize());
    tmp.updateMatrix();
    posts.setMatrixAt(k, tmp.matrix);
  }
  posts.castShadow = true;
  group.add(posts);
  // cables
  for (const hFrac of [0.35, 0.7, 1.0]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= track.n; i += 2) {
      const ii = track.wrap(i);
      pts.push(fenceTop(ii, fenceBase(ii), o.fenceHeight * hFrac, 1.2 * hFrac));
    }
    const lg = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x55595e })));
  }

  // ---------- pit road + pit wall ----------
  if (o.pit) {
    const { from, to, width } = o.pit;
    const taper = o.pit.taper ?? 60;
    const inner0 = -o.apron - 2.2;
    const pitGeo = ribbon(track, [from, to], (i, k) => {
      // taper in/out at the ends so the pit road blends into the apron
      const t = Math.min(1, k / taper, (to - from - k) / taper);
      const w = width * Math.max(0, t);
      return [track.surface(i, -o.apron - 0.01 - w).setY(0.015), track.surface(i, -o.apron + 0.5).setY(0.015)];
    }, { uAcross: [0, width / 6], vScale: 6 });
    const pit = new THREE.Mesh(pitGeo, pbrMat(tex.concrete(), [1, 1], { color: 0xd0d0d0 }));
    pit.receiveShadow = true;
    group.add(pit);
    colliders.push(toCollider('concrete', pitGeo));

    // pit wall between apron and pit lane (with gaps at both ends)
    const wFrom = from + taper + 10;
    const wTo = to - taper - 10;
    const pwGeo = ribbon(track, [wFrom, wTo], (i) => {
      const a = track.surface(i, inner0).setY(0);
      const b = track.surface(i, inner0 - 0.6).setY(0);
      return [a, a.clone().setY(1.05), b.clone().setY(1.05), b];
    }, { uAcross: [0, 0.4, 0.5, 1], vScale: 16 });
    const pw = new THREE.Mesh(pwGeo, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.75, side: THREE.DoubleSide }));
    pw.castShadow = pw.receiveShadow = true;
    group.add(pw);
    colliders.push(toCollider('wall', pwGeo));

    // pit boxes: painted stalls
    const spacing = o.pit.boxSpacing ?? 7;
    const boxGeo = new THREE.PlaneGeometry(0.15, width * 0.55);
    boxGeo.rotateX(-Math.PI / 2);
    const boxes = new THREE.InstancedMesh(boxGeo, lineMat(0xffffff), Math.floor((wTo - wFrom) / spacing) + 1);
    for (let k = 0; k < boxes.count; k++) {
      const i = track.wrap(wFrom + k * spacing);
      tmp.position.copy(track.surface(i, inner0 - width * 0.55)).setY(0.03);
      tmp.rotation.set(0, Math.atan2(track.T[i].x, track.T[i].z), 0);
      tmp.updateMatrix();
      boxes.setMatrixAt(k, tmp.matrix);
    }
    group.add(boxes);
    pitInfo = {
      entry: track.wrap(from), exit: track.wrap(to),
      limitFrom: track.wrap(from + taper), limitTo: track.wrap(to - taper),
      lane: inner0 - 0.6 - width * 0.17,
      box: inner0 - width * 0.55,
      inside: -o.apron - 0.8,
      boxFrom: track.wrap(wFrom + Math.round(spacing / 2)), boxSpacing: spacing,
    };
  }

  return { group, colliders, pit: pitInfo };
}

/**
 * Pit lane for a road course: a paved lane beside the track on the left (negative lateral), a pit
 * wall between it and the track, painted stalls, and paved entry/exit tapers. The track's
 * run-off there must reach beyond `wallD + 0.6 + laneWidth`.
 */
export function buildPitLane(track: Track, o: { from: number; to: number; taper: number; wallD: number; laneWidth: number; boxSpacing: number }): { group: THREE.Group; colliders: ColliderMesh[]; pit: PitInfo } {
  const group = new THREE.Group();
  const colliders: ColliderMesh[] = [];
  const tmp = new THREE.Object3D();
  const lineMat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const { from, to, taper, wallD, laneWidth } = o;
  const len = to - from;
  const outer = -(wallD + 0.6 + laneWidth);
  const lift = (i: number, d: number, h = 0.012) => track.surface(i, d).addScaledVector(track.N[i], h);
  const laneGeo = ribbon(track, [from, to], (i, k) => {
    const t = THREE.MathUtils.smoothstep(Math.min(k / taper, (len - k) / taper), 0, 1);
    const inner = THREE.MathUtils.lerp(-0.3, -(wallD + 0.6), t);
    return [lift(i, outer), lift(i, (outer + inner) / 2), lift(i, inner)];
  }, { uAcross: [0, laneWidth / 6, (wallD + laneWidth) / 6], vScale: 6 });
  const lane = new THREE.Mesh(laneGeo, pbrMat(tex.concrete(), [1, 1], { color: 0xc8c8c8 }));
  lane.receiveShadow = true;
  group.add(lane);
  colliders.push(toCollider('concrete', laneGeo));
  // pit wall (generous gaps at both ends for the entry and exit)
  const wFrom = from + taper + 20, wTo = to - taper - 12;
  const wallTex = tex.concrete();
  const pwGeo = ribbon(track, [wFrom, wTo], (i) => {
    const a = track.surface(i, -wallD), b = track.surface(i, -wallD - 0.6);
    return [a, a.clone().addScaledVector(UP, 1.05), b.clone().addScaledVector(UP, 1.05), b];
  }, { uAcross: [0, 0.4, 0.5, 1], vScale: 16 });
  const pw = new THREE.Mesh(pwGeo, new THREE.MeshStandardMaterial({ map: wallTex.map, color: 0xe8e8e8, roughness: 0.75, side: THREE.DoubleSide }));
  pw.castShadow = pw.receiveShadow = true;
  group.add(pw);
  colliders.push(toCollider('wall', pwGeo));
  // stall lines and the pit-lane speed limit line
  const box = outer + laneWidth * 0.28;
  const boxGeo = new THREE.PlaneGeometry(0.15, laneWidth * 0.5);
  boxGeo.rotateX(-Math.PI / 2);
  const count = Math.floor((wTo - wFrom) / o.boxSpacing) + 1;
  const boxes = new THREE.InstancedMesh(boxGeo, lineMat(0xffffff), count);
  for (let k = 0; k < count; k++) {
    const i = track.wrap(wFrom + k * o.boxSpacing);
    tmp.position.copy(lift(i, box, 0.025));
    tmp.rotation.set(0, Math.atan2(track.T[i].x, track.T[i].z), 0);
    tmp.updateMatrix();
    boxes.setMatrixAt(k, tmp.matrix);
  }
  group.add(boxes);
  for (const at of [from + taper, to - taper]) {
    const g = ribbon(track, [at, at + 1], (i) => [lift(i, outer, 0.03), lift(i, -wallD - 0.6, 0.03)], { uAcross: [0, 1], vScale: 1 });
    group.add(new THREE.Mesh(g, lineMat(0xffffff)));
  }
  const pit: PitInfo = {
    entry: track.wrap(from), exit: track.wrap(to),
    limitFrom: track.wrap(from + taper), limitTo: track.wrap(to - taper),
    lane: -(wallD + 0.6 + laneWidth * 0.3),
    box,
    inside: -(wallD - 2),
    boxFrom: track.wrap(wFrom + Math.round(o.boxSpacing / 2)), boxSpacing: o.boxSpacing,
  };
  return { group, colliders, pit };
}

/** Infield shape polygon (x, z) from a lateral offset inside the inner edge. */
export function infieldShape(track: Track, offset: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < track.n; i += 2) {
    const p = track.surface(i, offset);
    if (i === 0) s.moveTo(p.x, -p.z);
    else s.lineTo(p.x, -p.z);
  }
  s.closePath();
  return s;
}
