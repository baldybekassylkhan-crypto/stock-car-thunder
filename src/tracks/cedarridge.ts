import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Track, resampleClosed, smoothClosed } from './track';
import { ribbon, toCollider, type ColliderMesh } from './build';
import type { LoadedMap, MapLoadOptions } from './maps';
import { makeGrid } from './maps';
import * as tex from '../render/textures';
import { rng, fbm2, mountainRing, grandstand, billboard, SPONSOR_BOARDS, UP } from './props';

const deg = THREE.MathUtils.degToRad;

// control points: x, z, elevation (m). Validated offline: no crossings, ≥110 m between sections.
const CTRL: [number, number, number][] = [
  [-350, 0, 10], [0, 0, 10], [300, 0, 9],
  [420, -20, 9], [470, -110, 12],
  [430, -230, 18], [330, -300, 24],
  [200, -300, 27], [120, -360, 30],
  [150, -470, 33], [260, -540, 34],
  [420, -560, 35], [560, -520, 33],
  [640, -420, 28], [650, -300, 22],
  [700, -200, 18], [660, -120, 17], [720, -60, 16],
  [760, 60, 14], [700, 180, 12],
  [560, 240, 10], [380, 230, 9],
  [200, 180, 8], [0, 160, 8], [-200, 170, 9],
  [-420, 200, 10], [-560, 140, 11],
  [-560, 50, 11], [-480, 0, 10],
];

function stripeTexture(a: string, b: string) {
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

function cloudTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const n = tex.fbm(size, 4, 6, 99, 0.55);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < n.length; i++) {
    const v = THREE.MathUtils.smoothstep(n[i], 0.35, 0.75);
    img.data[i * 4] = 190 + v * 30; img.data[i * 4 + 1] = 196 + v * 30; img.data[i * 4 + 2] = 204 + v * 28;
    img.data[i * 4 + 3] = 120 + v * 135;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function loadCedarRidge(o: MapLoadOptions): Promise<LoadedMap> {
  const WIDTH = 13;
  const rain = o.rain;

  // ---------- centreline ----------
  const curve = new THREE.CatmullRomCurve3(CTRL.map(([x, z, e]) => new THREE.Vector3(x, e, z)), true, 'catmullrom', 0.5);
  let pts = curve.getPoints(6000);
  pts.pop();
  let len2d = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; len2d += Math.hypot(b.x - a.x, b.z - a.z); }
  const k = 3862 / len2d;
  pts.forEach((p) => { p.x *= k; p.z *= k; });
  pts = resampleClosed(pts, Math.round(3862 / 2));
  pts = smoothClosed(pts, 2.5);
  // start/finish near the end of the front straight
  let s0 = 0, best = Infinity;
  pts.forEach((p, i) => { const d = Math.hypot(p.x - 200 * k, p.z); if (d < best) { best = d; s0 = i; } });
  pts = pts.slice(s0).concat(pts.slice(0, s0));
  if (pts[1].x < pts[0].x) { pts.reverse(); }

  const track = new Track(pts, WIDTH, (_u, kk) => THREE.MathUtils.clamp(kk * 260, -1, 1) * deg(5), 30, 'center');
  const n = track.n;
  const group = new THREE.Group();
  const colliders: ColliderMesh[] = [];
  const r = rng(1234);

  // turn factors per side (smoothed)
  const smoothArr = (a: number[], w: number) => a.map((_, i) => { let s = 0; for (let j = -w; j <= w; j++) s += a[track.wrap(i + j)]; return s / (2 * w + 1); });
  const kap = track.curvature;
  const turn = smoothArr(kap.map((x) => THREE.MathUtils.clamp((Math.abs(x) - 1 / 400) * 120, 0, 1)), 12);
  // outside of a left turn (κ>0) is the right side
  const outR = smoothArr(kap.map((x, i) => (x > 0 ? turn[i] : 0)), 25);
  const outL = smoothArr(kap.map((x, i) => (x < 0 ? turn[i] : 0)), 25);
  const runL = outL.map((t) => 9 + 22 * t);
  const runR = outR.map((t) => 9 + 22 * t);
  const CURB = 1.4;

  // ---------- road ----------
  const roadSet = tex.asphalt();
  const dList = [0, 2, 4.5, 6.5, 8.5, 11, 13];
  const roadGeo = ribbon(track, null, (i) => dList.map((d) => track.surface(i, d)), {
    uAcross: dList.map((d) => d / 3), vScale: 3,
    colors: (i, j) => { const d = dList[j] / WIDTH; return 1 - 0.18 * Math.exp(-((d - 0.5 - (turn[i] * Math.sign(kap[i]) * -0.3)) ** 2) / 0.02); },
  });
  const roadMat = new THREE.MeshStandardMaterial({ ...roadSet, vertexColors: true, roughness: rain ? 0.28 : 1, color: rain ? 0x8a8a8a : 0xffffff, envMapIntensity: rain ? 1.6 : 1 });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  group.add(road);
  colliders.push(toCollider('asphalt', roadGeo));

  // edge lines
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [a, b] of [[0.25, 0.45], [WIDTH - 0.45, WIDTH - 0.25]]) {
    const g = ribbon(track, null, (i) => [track.surface(i, a).addScaledVector(track.N[i], 0.01), track.surface(i, b).addScaledVector(track.N[i], 0.01)]);
    group.add(new THREE.Mesh(g, lineMat));
  }
  // start / finish
  {
    const sf = ribbon(track, [0, 2], (i) => [0, WIDTH / 2, WIDTH].map((d) => track.surface(i, d).addScaledVector(track.N[i], 0.015)), { uAcross: [0, 2, 4], vScale: track.ds * 2 });
    group.add(new THREE.Mesh(sf, new THREE.MeshStandardMaterial({ map: tex.checkered(4), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
  }

  // ---------- ranges helper ----------
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

  // ---------- curbs (inside & outside of corners) ----------
  const curbTex = stripeTexture('#d32020', '#f4f4f4');
  const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.55 });
  for (const side of [-1, 1]) {
    for (const [a, b] of ranges(turn, 0.25)) {
      const g = ribbon(track, [a - 6, b + 6], (i) => {
        if (side < 0) return [track.surface(i, -CURB), track.surface(i, -CURB * 0.5).addScaledVector(UP, 0.05), track.surface(i, 0).addScaledVector(UP, 0.005)];
        return [track.surface(i, WIDTH).addScaledVector(UP, 0.005), track.surface(i, WIDTH + CURB * 0.5).addScaledVector(UP, 0.05), track.surface(i, WIDTH + CURB)];
      }, { uAcross: [0, 0.5, 1], vScale: 2 });
      const m = new THREE.Mesh(g, curbMat);
      m.receiveShadow = true;
      group.add(m);
      colliders.push(toCollider('curb', g));
    }
  }

  // ---------- runoff: grass everywhere, gravel traps on corner exits ----------
  const grassSet = tex.grass();
  const grassMat = new THREE.MeshStandardMaterial({ ...grassSet, roughness: 1, color: rain ? 0x8fa486 : 0xa8bc98 });
  const gL = ribbon(track, null, (i) => [track.surface(i, -runL[i]).addScaledVector(UP, -0.02), track.surface(i, -CURB).addScaledVector(UP, -0.02)], { uAcross: [0, 4], vScale: 6 });
  const gR = ribbon(track, null, (i) => [track.surface(i, WIDTH + CURB).addScaledVector(UP, -0.02), track.surface(i, WIDTH + runR[i]).addScaledVector(UP, -0.02)], { uAcross: [0, 4], vScale: 6 });
  for (const g of [gL, gR]) {
    const m = new THREE.Mesh(g, grassMat);
    m.receiveShadow = true;
    group.add(m);
    colliders.push(toCollider('grass', g));
  }
  const gravelSet = tex.sand();
  const gravelMat = new THREE.MeshStandardMaterial({ ...gravelSet, roughness: 1, color: 0xd8cdb8 });
  const gravelRanges: { side: number; range: [number, number] }[] = [];
  for (const [side, vals] of [[-1, outL], [1, outR]] as const) {
    for (const range of ranges(vals, 0.35)) {
      gravelRanges.push({ side, range });
      const g = ribbon(track, range, (i) => {
        const w = vals[i];
        const run = side < 0 ? runL[i] : runR[i];
        const inner = CURB + 2.5 + (1 - w) * 6;
        if (side < 0) return [track.surface(i, -(run - 0.8)).addScaledVector(UP, 0.01), track.surface(i, -inner).addScaledVector(UP, 0.01)];
        return [track.surface(i, WIDTH + inner).addScaledVector(UP, 0.01), track.surface(i, WIDTH + run - 0.8).addScaledVector(UP, 0.01)];
      }, { uAcross: [0, 3], vScale: 5 });
      const m = new THREE.Mesh(g, gravelMat);
      m.receiveShadow = true;
      group.add(m);
      colliders.push(toCollider('gravel', g));
    }
  }

  // ---------- barriers: armco everywhere, tyre walls behind gravel ----------
  const barrierAt = (i: number, side: number) => (side < 0 ? track.surface(i, -runL[i]) : track.surface(i, WIDTH + runR[i]));
  const armcoMat = new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.85, roughness: 0.35 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6f747a, metalness: 0.6, roughness: 0.5 });
  for (const side of [-1, 1]) {
    // invisible tall collision wall (contains cars; outward face inward)
    const col = ribbon(track, null, (i) => {
      const b = barrierAt(i, side);
      return side < 0 ? [b.clone().addScaledVector(UP, 4), b.clone().addScaledVector(UP, -1.5)] : [b.clone().addScaledVector(UP, -1.5), b.clone().addScaledVector(UP, 4)];
    });
    colliders.push(toCollider('wall', col));
    // visible: low concrete footing + double armco rail
    const foot = ribbon(track, null, (i) => { const b = barrierAt(i, side); return [b.clone().addScaledVector(UP, -2.5), b.clone().addScaledVector(UP, 0.25)]; });
    group.add(new THREE.Mesh(foot, new THREE.MeshStandardMaterial({ color: 0x8c8a85, roughness: 0.9, side: THREE.DoubleSide })));
    const rail = ribbon(track, null, (i) => {
      const b = barrierAt(i, side).addScaledVector(track.R[i], side * 0.15);
      return [b.clone().addScaledVector(UP, 0.35), b.clone().addScaledVector(UP, 0.75)];
    }, { vScale: 4 });
    const rm = new THREE.Mesh(rail, new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide }));
    rm.castShadow = true;
    group.add(rm);
    const postGeo = new THREE.BoxGeometry(0.12, 0.9, 0.12);
    postGeo.translate(0, 0.45, 0);
    const every = 2;
    const posts = new THREE.InstancedMesh(postGeo, postMat, Math.ceil(n / every));
    const ob = new THREE.Object3D();
    for (let k2 = 0; k2 < posts.count; k2++) {
      const i = track.wrap(k2 * every);
      ob.position.copy(barrierAt(i, side)).addScaledVector(track.R[i], side * 0.35);
      ob.updateMatrix();
      posts.setMatrixAt(k2, ob.matrix);
    }
    group.add(posts);
  }
  void armcoMat;
  {
    // tyre stacks (3 high, alternating colours) in front of the armco behind gravel traps
    const tyreGeo = new THREE.TorusGeometry(0.33, 0.14, 6, 12);
    tyreGeo.rotateX(Math.PI / 2);
    let total = 0;
    for (const g of gravelRanges) total += Math.ceil((g.range[1] - g.range[0]) / 0.6);
    const tyres = new THREE.InstancedMesh(tyreGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), total * 3);
    const ob = new THREE.Object3D();
    const cBlack = new THREE.Color(0x151515), cRed = new THREE.Color(0xc0281e), cWhite = new THREE.Color(0xe8e8e8);
    let k2 = 0;
    for (const g of gravelRanges) {
      for (let s = g.range[0]; s <= g.range[1]; s += 0.6) {
        const i = track.wrap(Math.round(s));
        const base = barrierAt(i, g.side).addScaledVector(track.R[i], -g.side * 0.5);
        for (let h = 0; h < 3 && k2 < tyres.count; h++) {
          ob.position.copy(base).addScaledVector(UP, 0.14 + h * 0.28);
          ob.rotation.set(0, r() * 3, 0);
          ob.updateMatrix();
          tyres.setMatrixAt(k2, ob.matrix);
          tyres.setColorAt(k2, h === 1 ? (Math.round(s) % 4 < 2 ? cRed : cWhite) : cBlack);
          k2++;
        }
      }
    }
    tyres.count = k2;
    tyres.castShadow = true;
    group.add(tyres);
  }

  // ---------- terrain (visual) ----------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, avgE = 0, minE = Infinity;
  for (const p of track.center) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); avgE += p.y; minE = Math.min(minE, p.y); }
  avgE /= n;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const nearest = (x: number, z: number) => {
    let bd = Infinity, bi = 0;
    for (let i = 0; i < n; i += 2) { const p = track.center[i]; const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return { d: Math.sqrt(bd), e: track.center[bi].y };
  };
  const heightAt = (x: number, z: number) => {
    const { d, e } = nearest(x, z);
    const near = e - 1.6;
    const far = avgE + (fbm2(x / 420, z / 420, 4, 3) - 0.42) * 110 + fbm2(x / 90, z / 90, 3, 8) * 8;
    const t = THREE.MathUtils.smoothstep(d, 46, 300);
    return { h: near * (1 - t) + Math.max(far, near - 2) * t, d };
  };
  const SIZE = 2800, SEG = 140;
  const tGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  tGeo.rotateX(-Math.PI / 2);
  tGeo.translate(cx, 0, cz);
  const tCols: number[] = [];
  {
    const p = tGeo.getAttribute('position') as THREE.BufferAttribute;
    const uv = tGeo.getAttribute('uv') as THREE.BufferAttribute;
    const cG = new THREE.Color(0x4e6b3a), cF = new THREE.Color(0x2c3b22), cR = new THREE.Color(0x77736b);
    for (let i = 0; i < p.count; i++) {
      const { h, d } = heightAt(p.getX(i), p.getZ(i));
      p.setY(i, h);
      uv.setXY(i, p.getX(i) / 6, p.getZ(i) / 6);
      const f = THREE.MathUtils.smoothstep(d, 50, 160);
      const c = cG.clone().lerp(cF, f * 0.8).lerp(cR, THREE.MathUtils.smoothstep(h - avgE, 45, 90) * 0.6);
      tCols.push(c.r, c.g, c.b);
    }
    tGeo.setAttribute('color', new THREE.Float32BufferAttribute(tCols, 3));
    tGeo.computeVertexNormals();
  }
  const terrain = new THREE.Mesh(tGeo, new THREE.MeshStandardMaterial({ ...tex.grass(), vertexColors: true, roughness: 1 }));
  for (const t of [(terrain.material as THREE.MeshStandardMaterial).map!, (terrain.material as THREE.MeshStandardMaterial).normalMap!]) t.repeat.set(1, 1);
  terrain.receiveShadow = true;
  group.add(terrain);

  // ---------- forest ----------
  {
    const trunk = new THREE.CylinderGeometry(0.18, 0.28, 3, 6); trunk.translate(0, 1.5, 0);
    const c1 = new THREE.ConeGeometry(2.6, 5, 8); c1.translate(0, 4.5, 0);
    const c2 = new THREE.ConeGeometry(2.0, 4.2, 8); c2.translate(0, 7, 0);
    const c3 = new THREE.ConeGeometry(1.3, 3.4, 8); c3.translate(0, 9.3, 0);
    const toCol = (g: THREE.BufferGeometry, col: number) => {
      const ng = g.toNonIndexed();
      const c = new THREE.Color(col);
      const arr = new Float32Array(ng.getAttribute('position').count * 3);
      for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
      ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return ng;
    };
    const pine = mergeGeometries([toCol(trunk, 0x4a3426), toCol(c1, 0x24391f), toCol(c2, 0x2a4423), toCol(c3, 0x305027)]);
    const COUNT = 4200;
    const trees = new THREE.InstancedMesh(pine, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), COUNT);
    const ob = new THREE.Object3D();
    let placed = 0;
    for (let tries = 0; placed < COUNT && tries < COUNT * 4; tries++) {
      const x = cx + (r() - 0.5) * SIZE * 0.95, z = cz + (r() - 0.5) * SIZE * 0.95;
      const { h, d } = heightAt(x, z);
      if (d < 50 || fbm2(x / 160, z / 160, 3, 21) < 0.38) continue; // clearings
      ob.position.set(x, h - 0.3, z);
      ob.rotation.set(0, r() * 6.28, 0);
      const s = 0.8 + r() * 0.9;
      ob.scale.set(s, s * (0.9 + r() * 0.5), s);
      ob.updateMatrix();
      trees.setMatrixAt(placed, ob.matrix);
      trees.setColorAt(placed, new THREE.Color().setHSL(0.27 + r() * 0.06, 0.25, 0.75 + r() * 0.3));
      placed++;
    }
    trees.count = placed;
    trees.castShadow = true;
    trees.receiveShadow = true;
    group.add(trees);
  }

  mountainRing(group, {
    r0: 1500, r1: 7000, height: 900, seed: 41, base: avgE - 10, center: new THREE.Vector2(cx, cz),
    ramp: (h, nn) => {
      const forest = new THREE.Color(0x2e4227), rock = new THREE.Color(0x6d6a66), snow = new THREE.Color(0xeef1f4);
      if (h < 260) return forest.clone().lerp(rock, Math.max(0, (h - 120) / 140) * (0.5 + nn * 0.5));
      if (h < 520) return rock.clone().lerp(snow, Math.max(0, (h - 420) / 100));
      return snow;
    },
  });

  // ---------- start/finish gantry, pit building, main grandstand ----------
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x3b4048, metalness: 0.6, roughness: 0.4 });
    const i = 0;
    const l = track.surface(i, -3), rr = track.surface(i, WIDTH + 3);
    for (const p of [l, rr]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), steel);
      leg.position.copy(p).addScaledVector(UP, 4);
      leg.castShadow = true;
      group.add(leg);
    }
    const beam = billboard('CEDAR RIDGE', 140, WIDTH + 6, 2.2);
    beam.position.copy(l).lerp(rr, 0.5).addScaledVector(UP, 7.5);
    beam.lookAt(beam.position.clone().sub(track.T[i]));
    group.add(beam);
    const back = beam.clone();
    back.rotateY(Math.PI);
    back.position.addScaledVector(track.T[i], 0.05);
    group.add(back);
    // pit building on the left behind the barrier
    const pb = new THREE.Mesh(new THREE.BoxGeometry(12, 8, 200), new THREE.MeshStandardMaterial({ color: 0xe4e1da, roughness: 0.7 }));
    const pi = track.wrap(-60);
    pb.position.copy(barrierAt(pi, -1)).addScaledVector(track.R[pi], -12).addScaledVector(UP, 4);
    pb.rotation.y = Math.atan2(track.T[pi].x, track.T[pi].z);
    pb.castShadow = pb.receiveShadow = true;
    group.add(pb);
    const glassStrip = new THREE.Mesh(new THREE.BoxGeometry(12.2, 2, 196), new THREE.MeshPhysicalMaterial({ color: 0x24384c, roughness: 0.05, metalness: 0.3 }));
    glassStrip.position.copy(pb.position).addScaledVector(UP, 2);
    glassStrip.rotation.copy(pb.rotation);
    group.add(glassStrip);
    grandstand(track, group, { range: [-110, 40], edge: (ii) => barrierAt(ii, 1), gap: 4, depth: 22, base: 1.5, top: 13, roof: true });
    SPONSOR_BOARDS.slice(0, 6).forEach((name, kk) => {
      const ii = track.wrap(Math.round(n * (0.15 + kk * 0.13)));
      const b = billboard(name, (kk * 53) % 360, 18, 4.5);
      const side = outR[ii] > outL[ii] ? 1 : -1;
      b.position.copy(barrierAt(ii, side)).addScaledVector(track.R[ii], side * 3).addScaledVector(UP, 4);
      b.lookAt(b.position.clone().addScaledVector(track.R[ii], -side));
      group.add(b);
    });
  }

  // ---------- low cloud deck ----------
  {
    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshBasicMaterial({ map: cloudTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: rain ? 0.95 : 0.8 }));
    cloud.rotation.x = Math.PI / 2;
    cloud.position.set(cx, avgE + 520, cz);
    group.add(cloud);
  }

  const tvCams = [0.03, 0.14, 0.27, 0.4, 0.52, 0.64, 0.77, 0.9].map((u) => {
    const i = track.wrap(Math.round(u * n));
    const side = outR[i] > outL[i] ? 1 : -1;
    return barrierAt(i, side).addScaledVector(track.R[i], side * 4).addScaledVector(UP, 9);
  });

  const skyCol = rain ? 0x7d858d : 0xa7b0b8;
  const envScene = () => {
    const s = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(skyCol).multiplyScalar(1.4) }, bot: { value: new THREE.Color(0x3a4430) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 vP; void main(){ float t = smoothstep(-80.0, 120.0, vP.y); gl_FragColor = vec4(mix(bot, top, t), 1.0); }',
    }));
    s.add(dome);
    return s;
  };

  return {
    track,
    group,
    colliders,
    tvCams,
    gridSlot: makeGrid(track, { backM: 12, rowM: 9, lanes: [3.8, 9.2] }),
    paceSpeed: 26,
    oval: false,
    rain,
    gripScale: rain ? 0.78 : 1,
    groundY: minE - 40,
    outOfBounds: 70,
    atmosphere: {
      mode: 'overcast',
      background: skyCol,
      envScene,
      sunElevation: 40,
      sunAzimuth: 150,
      turbidity: 10,
      rayleigh: 1,
      mie: 0.01,
      sunColor: 0xeef2f6,
      sunIntensity: rain ? 0.7 : 1.3,
      hemiSky: rain ? 0x9aa4ae : 0xc4ced8,
      hemiGround: 0x3b4a2e,
      hemiIntensity: rain ? 1.2 : 1.5,
      envIntensity: rain ? 0.7 : 0.85,
      fogColor: skyCol,
      fogDensity: rain ? 0.0024 : 0.0011,
      exposure: rain ? 0.8 : 0.85,
    },
  };
}
