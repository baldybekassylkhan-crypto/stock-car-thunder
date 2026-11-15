import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Track, ovalCenterline } from './track';
import { buildOval, infieldShape, ribbon } from './build';
import type { LoadedMap } from './maps';
import * as tex from '../render/textures';

const UP = new THREE.Vector3(0, 1, 0);
const deg = THREE.MathUtils.degToRad;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function vnoise(x: number, y: number, seed = 0): number {
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
function fbm2(x: number, y: number, oct = 5, seed = 0) {
  let s = 0, a = 1, t = 0;
  for (let o = 0; o < oct; o++) { s += vnoise(x, y, seed + o) * a; t += a; a *= 0.5; x *= 2.03; y *= 2.03; }
  return s / t;
}

function swapUV(g: THREE.BufferGeometry) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); uv.setXY(i, uv.getY(i), u); }
  return g;
}

export async function loadSunvale(): Promise<LoadedMap> {
  const WIDTH = 17;
  const APRON = 9;
  const center = ovalCenterline({ straight: 1069, radius: 300, triBulge: 55, smoothSigmaM: 45, targetLength: 4023 });
  const track = new Track(center, WIDTH, (_u, k) => {
    const t = THREE.MathUtils.clamp(Math.abs(k) * 300, 0, 1);
    return deg(3) + deg(28) * t * t * (3 - 2 * t);
  });
  const built = buildOval(track, { apron: APRON, wallHeight: 1.25, fenceHeight: 6.5, pit: { from: -300, to: 300, width: 15 } });
  const group = built.group;
  const r = rng(42);

  // ---------- ground: infield grass + desert sand ----------
  const sandSet = tex.sand();
  for (const t of [sandSet.map, sandSet.normalMap, sandSet.roughnessMap]) t.repeat.set(600, 600);
  const groundGeo = new THREE.PlaneGeometry(14000, 14000, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ ...sandSet, roughness: 1, color: 0xf0d8b8 }));
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  group.add(ground);

  const grassSet = tex.grass();
  const infieldGeo = new THREE.ShapeGeometry(infieldShape(track, -APRON + 0.05), 1);
  infieldGeo.rotateX(-Math.PI / 2);
  {
    const p = infieldGeo.getAttribute('position');
    const uv = infieldGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 5, p.getZ(i) / 5);
  }
  const infield = new THREE.Mesh(infieldGeo, new THREE.MeshStandardMaterial({ ...grassSet, roughness: 1 }));
  infield.position.y = -0.005;
  infield.receiveShadow = true;
  group.add(infield);

  // ---------- infield lake ----------
  {
    const lake = new THREE.Shape();
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const rr = 1 + 0.08 * Math.sin(a * 3) + 0.05 * Math.cos(a * 5);
      lake.lineTo(Math.cos(a) * 330 * rr, Math.sin(a) * 85 * rr + 120);
    }
    const g = new THREE.ShapeGeometry(lake, 2);
    g.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: 0x1b3d4c, roughness: 0.06, metalness: 0.1, envMapIntensity: 1.4, clearcoat: 1 }));
    water.position.y = 0.01;
    group.add(water);
    // sandy shore
    const shore = new THREE.Mesh(g.clone().scale(1.07, 1, 1.25), new THREE.MeshStandardMaterial({ color: 0xbfa27a, roughness: 1 }));
    shore.position.y = 0.0;
    group.add(shore);
  }

  // ---------- grandstands (frontstretch + backstretch) ----------
  const crowdTex = tex.crowd();
  crowdTex.repeat.set(1, 1);
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xbdb7ad, roughness: 0.9 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x5f6670, roughness: 0.5, metalness: 0.7 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x223448, roughness: 0.05, metalness: 0.3, emissive: 0x1a2430, envMapIntensity: 1.6 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.6, metalness: 0.2 });

  const grandstand = (from: number, to: number, gap: number, depth: number, base: number, top: number, suites: boolean) => {
    const at = (i: number, h: number, y: number) => {
      const p = track.surface(i, WIDTH).addScaledVector(track.R[i], gap + h);
      p.y = y;
      return p;
    };
    // seating slope with crowd
    const seats = swapUV(ribbon(track, [from, to], (i) => [at(i, 0, base), at(i, depth, top)], { uAcross: [0, depth / 18], vScale: 28 }));
    const m = new THREE.Mesh(seats, new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 0.95 }));
    m.receiveShadow = true;
    group.add(m);
    // front face / back face / underside
    const face = ribbon(track, [from, to], (i) => [at(i, 0, 0), at(i, 0, base), at(i, -0.3, base + 1.1)], {});
    group.add(new THREE.Mesh(face, concreteMat));
    const back = ribbon(track, [from, to], (i) => [at(i, depth, top), at(i, depth + 1, top), at(i, depth + 1, 0)], {});
    const bm = new THREE.Mesh(back, concreteMat);
    bm.castShadow = true;
    group.add(bm);
    if (suites) {
      const sh = 9;
      const s1 = ribbon(track, [from, to], (i) => [at(i, depth - 0.2, top), at(i, depth - 0.2, top + sh)], {});
      group.add(new THREE.Mesh(s1, glassMat));
      const roof = ribbon(track, [from, to], (i) => [at(i, depth + 1.2, top + sh + 0.6), at(i, depth - 14, top + sh + 0.6), at(i, depth - 14, top + sh + 1.6), at(i, depth + 1.2, top + sh + 1.6)], {});
      const rm = new THREE.Mesh(roof, roofMat);
      rm.castShadow = true;
      group.add(rm);
    }
    // stairs / aisles: thin concrete strips across the slope
    const aisleGeo = new THREE.BoxGeometry(1.4, 0.15, 1);
    const n = Math.floor((to - from) / 18);
    const aisles = new THREE.InstancedMesh(aisleGeo, concreteMat, n);
    const o = new THREE.Object3D();
    for (let k = 0; k < n; k++) {
      const i = track.wrap(from + k * 18 + 9);
      const a = at(i, 0, base), b = at(i, depth, top);
      o.position.copy(a).lerp(b, 0.5).addScaledVector(UP, 0.08);
      o.lookAt(b.clone().addScaledVector(UP, 0.08));
      o.scale.set(1, 1, a.distanceTo(b));
      o.updateMatrix();
      aisles.setMatrixAt(k, o.matrix);
    }
    group.add(aisles);
  };
  grandstand(-230, 230, 14, 62, 5, 38, true);
  const backI = Math.round(track.n / 2);
  grandstand(backI - 120, backI + 120, 12, 30, 3, 17, false);

  // ---------- scoring pylon ----------
  {
    const pylon = new THREE.Group();
    const base = track.surface(10, -APRON - 75);
    pylon.position.copy(base);
    pylon.rotation.y = Math.atan2(track.R[10].x, track.R[10].z) + Math.PI;
    const post = new THREE.Mesh(new THREE.BoxGeometry(3, 10, 3), steelMat);
    post.position.y = 5;
    pylon.add(post);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 1024;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, 256, 1024);
    ctx.fillStyle = '#ffcc00'; ctx.font = 'bold 54px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('SUNVALE', 128, 70);
    const nums = [7, 24, 3, 88, 11, 42, 19, 5, 31, 66];
    nums.forEach((nn, k) => {
      ctx.fillStyle = k === 0 ? '#ffcc00' : '#e8e8e8';
      ctx.font = 'bold 74px sans-serif';
      ctx.fillText(String(nn), 128, 170 + k * 84);
    });
    const screenTex = new THREE.CanvasTexture(c);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 28, 2), [steelMat, steelMat, steelMat, steelMat, new THREE.MeshStandardMaterial({ map: screenTex, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: 0.9 }), new THREE.MeshStandardMaterial({ map: screenTex, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: 0.9 })]);
    tower.position.y = 24;
    tower.castShadow = true;
    pylon.add(tower);
    group.add(pylon);
  }

  // ---------- infield garages & motorhome lot ----------
  {
    const garageMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.8 });
    for (let g = 0; g < 4; g++) {
      const i = track.wrap(-150 + g * 85);
      const p = track.surface(i, -APRON - 55);
      const b = new THREE.Mesh(new THREE.BoxGeometry(150, 7, 22), garageMat);
      b.position.copy(p).setY(3.5);
      b.rotation.y = Math.atan2(track.T[i].x, track.T[i].z) + Math.PI / 2;
      b.castShadow = b.receiveShadow = true;
      group.add(b);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(152, 0.6, 24), steelMat);
      roof.position.copy(b.position).setY(7.3);
      roof.rotation.copy(b.rotation);
      group.add(roof);
    }
    // motorhomes in the turn infields
    const rvGeo = new THREE.BoxGeometry(2.6, 3.4, 11);
    rvGeo.translate(0, 1.7, 0);
    const rvCount = 260;
    const rvs = new THREE.InstancedMesh(rvGeo, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 }), rvCount);
    const o = new THREE.Object3D();
    const colors = [0xf4f4f4, 0xe8e0d0, 0xd6d9dc, 0x2b3a55, 0x7a1f1f, 0xf0f0f0];
    let k = 0;
    for (const turnI of [Math.round(track.n * 0.25), Math.round(track.n * 0.75)]) {
      for (let row = 0; row < 10 && k < rvCount; row++) {
        for (let col = 0; col < 13 && k < rvCount; col++) {
          const i = track.wrap(turnI - 90 + col * 14);
          const p = track.surface(i, -APRON - 30 - row * 15);
          o.position.copy(p).setY(0);
          o.rotation.y = Math.atan2(track.T[i].x, track.T[i].z) + Math.PI / 2 + (r() - 0.5) * 0.2;
          o.updateMatrix();
          rvs.setMatrixAt(k, o.matrix);
          rvs.setColorAt(k, new THREE.Color(colors[Math.floor(r() * colors.length)]));
          k++;
        }
      }
    }
    rvs.count = k;
    rvs.castShadow = true;
    group.add(rvs);
  }

  // ---------- distant mesas (ring terrain) ----------
  {
    const rings = 48, segs = 320, r0 = 1600, r1 = 6800;
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const cA = new THREE.Color(0xc98d5a), cB = new THREE.Color(0x8a4a2e), cC = new THREE.Color(0xe2bf8e);
    for (let ri = 0; ri <= rings; ri++) {
      const rad = r0 + (r1 - r0) * Math.pow(ri / rings, 1.4);
      for (let si = 0; si <= segs; si++) {
        const a = (si / segs) * Math.PI * 2;
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        const n = fbm2(x / 900, z / 900, 4, 7);
        const plateau = THREE.MathUtils.smoothstep(n, 0.52, 0.58);
        const edge = THREE.MathUtils.smoothstep((rad - r0) / 900, 0, 1);
        const h = edge * (plateau * (140 + fbm2(x / 300, z / 300, 3, 9) * 120) + fbm2(x / 180, z / 180, 3, 2) * 35);
        pos.push(x, h - 2, z);
        const strata = 0.5 + 0.5 * Math.sin(h * 0.25);
        const c = cA.clone().lerp(cB, plateau * strata * 0.8).lerp(cC, (1 - plateau) * 0.6);
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
    group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: false })));
  }

  // ---------- desert scatter: cacti, shrubs, rocks ----------
  {
    const trunk = new THREE.CylinderGeometry(0.32, 0.38, 5, 8); trunk.translate(0, 2.5, 0);
    const armL = new THREE.CylinderGeometry(0.22, 0.24, 1.2, 7); armL.rotateZ(Math.PI / 2); armL.translate(-0.75, 2.6, 0);
    const armLu = new THREE.CylinderGeometry(0.22, 0.22, 1.6, 7); armLu.translate(-1.3, 3.35, 0);
    const armR = new THREE.CylinderGeometry(0.2, 0.22, 1.0, 7); armR.rotateZ(Math.PI / 2); armR.translate(0.65, 2.0, 0);
    const armRu = new THREE.CylinderGeometry(0.2, 0.2, 1.4, 7); armRu.translate(1.1, 2.65, 0);
    const cactusGeo = mergeGeometries([trunk, armL, armLu, armR, armRu].map((g) => g.toNonIndexed()));
    const shrubGeo = new THREE.IcosahedronGeometry(1, 1);
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    {
      const p = rockGeo.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(p, i);
        v.multiplyScalar(0.75 + fbm2(v.x * 2 + 5, v.z * 2 + v.y, 2, 3) * 0.6);
        p.setXYZ(i, v.x, v.y * 0.7, v.z);
      }
      rockGeo.computeVertexNormals();
    }
    const cacti = new THREE.InstancedMesh(cactusGeo, new THREE.MeshStandardMaterial({ color: 0x4f6b3a, roughness: 0.8 }), 500);
    const shrubs = new THREE.InstancedMesh(shrubGeo, new THREE.MeshStandardMaterial({ color: 0x7c7a48, roughness: 1 }), 1500);
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x9a6a48, roughness: 0.95 }), 700);
    const o = new THREE.Object3D();
    const outside = (minR: number) => {
      for (;;) {
        const a = r() * Math.PI * 2, rad = minR + r() * (1700 - minR) * r();
        const p = new THREE.Vector3(Math.cos(a) * rad * 1.5, 0, Math.sin(a) * rad);
        const i = track.nearest(p);
        if (track.lateral(p, i) > WIDTH + 110) return p;
      }
    };
    for (let k = 0; k < cacti.count; k++) {
      o.position.copy(outside(500)); o.rotation.set(0, r() * 6.28, 0); o.scale.setScalar(0.7 + r() * 0.8); o.updateMatrix(); cacti.setMatrixAt(k, o.matrix);
    }
    for (let k = 0; k < shrubs.count; k++) {
      o.position.copy(outside(450)); o.rotation.set(0, r() * 6.28, 0); const s = 0.4 + r() * 0.9; o.scale.set(s * 1.3, s * 0.6, s * 1.3); o.updateMatrix(); shrubs.setMatrixAt(k, o.matrix);
    }
    for (let k = 0; k < rocks.count; k++) {
      o.position.copy(outside(450)); o.rotation.set(r(), r() * 6.28, r()); o.scale.setScalar(0.5 + r() * r() * 5); o.updateMatrix(); rocks.setMatrixAt(k, o.matrix);
    }
    for (const m of [cacti, shrubs, rocks]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
  }

  // ---------- billboards on the backstretch outside ----------
  {
    const names = ['DUNEBLAZE ENERGY', 'RIDGEBACK TIRES', 'KESTREL MOTOR OIL', 'QUORRA INSURANCE', 'HOLLOWPEAK TOOLS', 'SOLANO SNACKS'];
    names.forEach((name, k) => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 256;
      const ctx = c.getContext('2d')!;
      const hue = (k * 57) % 360;
      ctx.fillStyle = `hsl(${hue},70%,40%)`; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = '#fff'; ctx.font = 'italic 900 96px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, 512, 128);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const i = track.wrap(Math.round(track.n * 0.5) + 160 + k * 40);
      const b = new THREE.Mesh(new THREE.PlaneGeometry(32, 8), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
      b.position.copy(track.surface(i, WIDTH)).addScaledVector(track.R[i], 22).setY(18);
      b.lookAt(b.position.clone().sub(track.R[i]));
      group.add(b);
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 14, 0.5), steelMat);
      legs.position.copy(b.position).setY(7);
      group.add(legs);
    });
  }

  const tvCams = [0.02, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((u) => {
    const i = track.wrap(Math.round(u * track.n));
    return track.surface(i, WIDTH).addScaledVector(track.R[i], 6).addScaledVector(UP, 14);
  });

  return {
    track,
    group,
    colliders: built.colliders,
    tvCams,
    gridSlot: (slot) => {
      const row = Math.floor(slot / 2);
      return { i: track.wrap(-300 - row * 7), d: slot % 2 === 0 ? 5.5 : 10.5 };
    },
    paceSpeed: 36,
    oval: true,
    rain: false,
    gripScale: 1,
    outOfBounds: 120,
    atmosphere: {
      sunElevation: 9,
      sunAzimuth: 235,
      turbidity: 9,
      rayleigh: 2.2,
      mie: 0.006,
      sunColor: 0xffc890,
      sunIntensity: 3.2,
      hemiSky: 0xb5c8ef,
      hemiGround: 0x9a7a55,
      hemiIntensity: 0.55,
      envIntensity: 0.45,
      fogColor: 0xd8b48e,
      fogDensity: 0.00016,
      exposure: 0.58,
    },
  };
}
