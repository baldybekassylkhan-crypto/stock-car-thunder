import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildRoadCourse, type SceneryCtx } from './roadCourse';
import type { LoadedMap } from './maps';
import { billboard, fbm2, grandstand, SPONSOR_BOARDS, UP } from './props';

/**
 * The three Open-Wheel GP circuits (fictional): Harbor Point Street Circuit (night streets by the
 * water), Velmont Park (fast, hilly parkland) and Desert Ring Al-Sahra (long straights, dusk).
 */

// ---------------------------------------------------------------- shared scenery helpers
function mainGrandstand(c: SceneryCtx, from: number, to: number) {
  grandstand(c.track, c.group, { range: [from, to], edge: (i) => c.barrierAt(i, 1), gap: 4, depth: 20, base: 1.5, top: 12, roof: true });
}

function sponsorBoards(c: SceneryCtx, count: number) {
  SPONSOR_BOARDS.slice(0, count).forEach((name, k) => {
    const i = c.track.wrap(Math.round(c.n * (0.1 + k * (0.8 / count))));
    const side = c.outR[i] > c.outL[i] ? 1 : -1;
    const b = billboard(name, (k * 53) % 360, 16, 4);
    b.position.copy(c.barrierAt(i, side)).addScaledVector(c.track.R[i], side * 2.5).addScaledVector(UP, 3.5);
    b.lookAt(b.position.clone().addScaledVector(c.track.R[i], -side));
    c.group.add(b);
  });
}

function pitBuilding(c: SceneryCtx, at: number, colour = 0xe4e1da) {
  const i = c.track.wrap(at);
  const pb = new THREE.Mesh(new THREE.BoxGeometry(12, 8, 160), new THREE.MeshStandardMaterial({ color: colour, roughness: 0.7 }));
  pb.position.copy(c.barrierAt(i, -1)).addScaledVector(c.track.R[i], -9).addScaledVector(UP, 4);
  pb.rotation.y = Math.atan2(c.track.T[i].x, c.track.T[i].z);
  pb.castShadow = pb.receiveShadow = true;
  c.group.add(pb);
}

/** Distance from (x, z) to the nearest centreline sample (and that sample's elevation). */
function nearestTrack(c: SceneryCtx, x: number, z: number) {
  let bd = Infinity, bi = 0;
  for (let i = 0; i < c.n; i += 3) { const p = c.track.center[i]; const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  return { d: Math.sqrt(bd), e: c.track.center[bi].y };
}

// ---------------------------------------------------------------- Harbor Point
export async function loadHarborPoint(): Promise<LoadedMap> {
  return buildRoadCourse({
    // a tight street loop round the old port: waterfront straight, climb round the casino square,
    // tunnel under the hotel, harbour chicane, hairpin
    ctrl: [
      [-300, 0, 1], [0, 0, 1], [320, 0, 1], [470, 20, 1.5],
      [540, 110, 3], [520, 210, 5],
      [430, 260, 6], [330, 250, 6],
      [270, 310, 6], [300, 390, 5],
      [230, 440, 4], [120, 430, 3.5],
      [100, 380, 3.5], [40, 350, 3],
      [-100, 330, 2], [-230, 300, 1.5],
      [-290, 230, 1.2], [-240, 170, 1], [-300, 110, 1],
      [-420, 80, 1], [-460, 20, 1],
    ],
    length: 3340,
    width: 11,
    start: [100, 0],
    camberDeg: 2,
    runoff: 2.5,
    runoffTurn: 3,
    runoffSurface: 'concrete',
    runoffColor: 0x8d8a84,
    gravel: false,
    barrier: 'wall',
    tunnels: [[Math.round(3340 / 2 * 0.62), Math.round(3340 / 2 * 0.69)]],
    pit: { from: -200, to: 70, taper: 55, boxSpacing: 5 },
    ground: { color: 0x2a2b2e, texture: 'asphalt' },
    lamps: true,
    paceSpeed: 22,
    atmosphere: {
      mode: 'night', background: 0x03050b,
      envScene: () => { const s = new THREE.Scene(); s.background = new THREE.Color(0x0a0f1c); return s; },
      sunElevation: 70, sunAzimuth: 210, turbidity: 1, rayleigh: 0, mie: 0,
      sunColor: 0xffe6c8, sunIntensity: 1.7, hemiSky: 0x384868, hemiGround: 0x151517, hemiIntensity: 0.65,
      envIntensity: 0.8, fogColor: 0x0b1020, fogDensity: 0.0012, exposure: 1.0,
    },
    scenery: (c) => {
      // the harbour: dark water with moored yachts on the outside of the waterfront straight
      const water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 1600), new THREE.MeshPhysicalMaterial({ color: 0x0a1a2c, roughness: 0.08, metalness: 0.2, clearcoat: 1 }));
      water.rotation.x = -Math.PI / 2;
      water.position.set(0, c.bounds.minE - 0.8, -900);
      c.group.add(water);
      const hull = new THREE.BoxGeometry(5, 2.2, 18);
      const yachts = new THREE.InstancedMesh(hull, new THREE.MeshStandardMaterial({ color: 0xf1f1f1, roughness: 0.4 }), 40);
      const o = new THREE.Object3D();
      for (let k = 0; k < yachts.count; k++) {
        o.position.set(-500 + k * 26 + c.r() * 8, c.bounds.minE - 0.2, -60 - c.r() * 140);
        o.rotation.y = Math.PI / 2 + (c.r() - 0.5) * 0.3;
        o.updateMatrix();
        yachts.setMatrixAt(k, o.matrix);
      }
      c.group.add(yachts);
      // city blocks behind the walls, with lit windows
      const block = new THREE.BoxGeometry(1, 1, 1);
      block.translate(0, 0.5, 0);
      const city = new THREE.InstancedMesh(block, new THREE.MeshStandardMaterial({ color: 0x1b1d24, emissive: 0xffc977, emissiveIntensity: 0.12, roughness: 0.8 }), 420);
      let k = 0;
      for (let tries = 0; k < city.count && tries < 5000; tries++) {
        const x = c.bounds.minX - 250 + c.r() * (c.bounds.maxX - c.bounds.minX + 500);
        const z = -40 + c.r() * (c.bounds.maxZ + 300);
        if (nearestTrack(c, x, z).d < 26) continue;
        o.position.set(x, c.bounds.minE - 0.1, z);
        o.scale.set(14 + c.r() * 22, 10 + c.r() * c.r() * 60, 14 + c.r() * 22);
        o.rotation.y = c.r() * 0.3;
        o.updateMatrix();
        city.setMatrixAt(k++, o.matrix);
      }
      city.count = k;
      c.group.add(city);
      mainGrandstand(c, -60, 40);
      pitBuilding(c, -110, 0xcfc8bc);
      sponsorBoards(c, 6);
    },
  });
}

// ---------------------------------------------------------------- Velmont Park
export async function loadVelmontPark(): Promise<LoadedMap> {
  return buildRoadCourse({
    // a flowing parkland lap: long main straight, fast right-handers, an uphill esses section,
    // a sweeping run across the top of the hill and a fast drop back down
    ctrl: [
      [-650, 0, 4], [0, 0, 4], [550, 0, 5], [760, 40, 8],
      [850, 170, 14], [810, 300, 22],
      [710, 365, 27], [630, 340, 31], [550, 380, 34], [460, 355, 37],
      [350, 405, 39], [150, 440, 40], [-100, 440, 36],
      [-260, 470, 30], [-390, 430, 22], [-440, 340, 15],
      [-400, 245, 11], [-520, 200, 8], [-680, 185, 6],
      [-820, 150, 5], [-870, 70, 4], [-820, 12, 4], [-730, 0, 4],
    ],
    length: 5100,
    width: 13,
    start: [150, 0],
    camberDeg: 4,
    runoff: 9,
    runoffTurn: 22,
    runoffSurface: 'grass',
    runoffColor: 0x9cbf84,
    gravel: true,
    barrier: 'armco',
    pit: { from: -260, to: 70, taper: 60, boxSpacing: 5 },
    ground: { color: 0x6f9a52, texture: 'grass' },
    paceSpeed: 28,
    atmosphere: {
      sunElevation: 38, sunAzimuth: 135, turbidity: 3.5, rayleigh: 1.6, mie: 0.004,
      sunColor: 0xfff4e2, sunIntensity: 2.6, hemiSky: 0xbcd6ff, hemiGround: 0x4a6235, hemiIntensity: 1.1,
      envIntensity: 1.0, fogColor: 0xc9d8e6, fogDensity: 0.00045, exposure: 0.85,
    },
    scenery: (c) => {
      // rolling parkland terrain that meets the track's elevation
      const { minX, maxX, minZ, maxZ, avgE } = c.bounds;
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const heightAt = (x: number, z: number) => {
        const t = nearestTrack(c, x, z);
        const far = avgE + (fbm2(x / 500, z / 500, 4, 5) - 0.45) * 60;
        const k = THREE.MathUtils.smoothstep(t.d, 38, 260);
        return { h: (t.e - 0.4) * (1 - k) + far * k, d: t.d };
      };
      const SIZE = 3600, SEG = 150;
      const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
      g.rotateX(-Math.PI / 2);
      g.translate(cx, 0, cz);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) { p.setY(i, heightAt(p.getX(i), p.getZ(i)).h); uv.setXY(i, p.getX(i) / 8, p.getZ(i) / 8); }
      g.computeVertexNormals();
      const terrain = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x6f9a52, roughness: 1 }));
      terrain.receiveShadow = true;
      c.group.add(terrain);
      // round broadleaf trees in clumps
      const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3.5, 6); trunk.translate(0, 1.75, 0);
      const crown = new THREE.IcosahedronGeometry(3.2, 1); crown.translate(0, 5.5, 0);
      const col = (geo: THREE.BufferGeometry, hex: number) => { const ng = geo.toNonIndexed(); const cc = new THREE.Color(hex); const a = new Float32Array(ng.getAttribute('position').count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = cc.r; a[i + 1] = cc.g; a[i + 2] = cc.b; } ng.setAttribute('color', new THREE.BufferAttribute(a, 3)); return ng; };
      const tree = mergeGeometries([col(trunk, 0x5a4030), col(crown, 0x3f6a2e)]);
      const trees = new THREE.InstancedMesh(tree, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), 2600);
      const o = new THREE.Object3D();
      let k = 0;
      for (let tries = 0; k < trees.count && tries < 14000; tries++) {
        const x = cx + (c.r() - 0.5) * SIZE * 0.9, z = cz + (c.r() - 0.5) * SIZE * 0.9;
        const hh = heightAt(x, z);
        if (hh.d < 45 || fbm2(x / 220, z / 220, 3, 17) < 0.45) continue;
        o.position.set(x, hh.h - 0.2, z);
        const s = 0.8 + c.r() * 0.8;
        o.scale.set(s, s * (0.9 + c.r() * 0.4), s);
        o.rotation.y = c.r() * 6;
        o.updateMatrix();
        trees.setMatrixAt(k, o.matrix);
        trees.setColorAt(k, new THREE.Color().setHSL(0.24 + c.r() * 0.08, 0.35, 0.7 + c.r() * 0.35));
        k++;
      }
      trees.count = k;
      trees.castShadow = true;
      c.group.add(trees);
      mainGrandstand(c, -80, 50);
      pitBuilding(c, -140);
      sponsorBoards(c, 8);
    },
  });
}

// ---------------------------------------------------------------- Desert Ring Al-Sahra
export async function loadDesertRing(): Promise<LoadedMap> {
  return buildRoadCourse({
    // a modern purpose-built circuit: two very long straights joined by hairpins and a twisty
    // infield, with wide tarmac run-off everywhere
    ctrl: [
      [-700, 0, 2], [0, 0, 2], [700, 0, 2], [830, 40, 2],
      [850, 160, 2], [720, 230, 2], [320, 230, 2],
      [210, 300, 2], [260, 420, 2], [480, 460, 2],
      [690, 500, 2], [760, 620, 2], [650, 700, 2],
      [200, 700, 2], [-200, 700, 2],
      [-360, 630, 2], [-300, 500, 2], [-460, 410, 2],
      [-620, 430, 2], [-770, 330, 2], [-815, 160, 2], [-800, 70, 2], [-755, 14, 2],
    ],
    length: 5350,
    width: 14,
    start: [-100, 0],
    camberDeg: 2,
    runoff: 14,
    runoffTurn: 18,
    runoffSurface: 'asphalt',
    runoffColor: 0x5d5a58,
    gravel: false,
    barrier: 'armco',
    pit: { from: -260, to: 70, taper: 60, boxSpacing: 5 },
    ground: { color: 0xe0b98a, texture: 'sand' },
    paceSpeed: 30,
    atmosphere: {
      sunElevation: 4, sunAzimuth: 250, turbidity: 9, rayleigh: 3, mie: 0.012,
      sunColor: 0xffa860, sunIntensity: 2.0, hemiSky: 0xffc896, hemiGround: 0x8a6440, hemiIntensity: 0.9,
      envIntensity: 0.9, fogColor: 0xe0b48a, fogDensity: 0.0011, exposure: 0.9,
    },
    scenery: (c) => {
      // dunes beyond the circuit, palm-like posts and a towering hotel by the start
      const { minX, maxX, minZ, maxZ, minE } = c.bounds;
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const SIZE = 5000, SEG = 120;
      const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
      g.rotateX(-Math.PI / 2);
      g.translate(cx, 0, cz);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        const d = nearestTrack(c, x, z).d;
        const dune = Math.pow(fbm2(x / 260, z / 180, 4, 9), 2) * 45;
        p.setY(i, minE - 0.1 + dune * THREE.MathUtils.smoothstep(d, 60, 400));
      }
      g.computeVertexNormals();
      const sand = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe3bd8e, roughness: 1 }));
      sand.receiveShadow = true;
      c.group.add(sand);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(18, 26, 160, 6), new THREE.MeshPhysicalMaterial({ color: 0xbfd2e2, metalness: 0.6, roughness: 0.15 }));
      tower.position.copy(c.barrierAt(c.track.wrap(-40), -1)).addScaledVector(c.track.R[c.track.wrap(-40)], -160).setY(minE + 80);
      c.group.add(tower);
      const palm = new THREE.CylinderGeometry(0.25, 0.4, 9, 6); palm.translate(0, 4.5, 0);
      const fronds = new THREE.ConeGeometry(3, 2, 7); fronds.translate(0, 9.5, 0);
      const palms = new THREE.InstancedMesh(mergeGeometries([palm.toNonIndexed(), fronds.toNonIndexed()]), new THREE.MeshStandardMaterial({ color: 0x5d6b3a, roughness: 0.9 }), 160);
      const o = new THREE.Object3D();
      for (let k = 0; k < palms.count; k++) {
        const i = c.track.wrap(Math.round((k / palms.count) * c.n));
        const side = k % 2 ? 1 : -1;
        o.position.copy(c.barrierAt(i, side)).addScaledVector(c.track.R[i], side * (8 + c.r() * 10));
        o.rotation.y = c.r() * 6;
        o.updateMatrix();
        palms.setMatrixAt(k, o.matrix);
      }
      c.group.add(palms);
      mainGrandstand(c, -90, 60);
      pitBuilding(c, -150, 0xf2efe8);
      sponsorBoards(c, 8);
    },
  });
}
