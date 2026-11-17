import * as THREE from 'three';
import { buildRoadCourse, type SceneryCtx } from './roadCourse';
import type { LoadedMap } from './maps';
import { billboard } from './props';

/**
 * Neon Docks Drift Park (fictional): a wide, walled drift course laid out on a container port at
 * night — a long entry straight into a fast sweeper, a hairpin, a tight S-section, a big
 * constant-radius bowl and a final double-apex corner back onto the straight. Wide tarmac all
 * round, so a slide that runs wide doesn't end in the wall.
 */

/** Distance from (x, z) to the nearest centreline sample. */
function trackDist(c: SceneryCtx, x: number, z: number) {
  let bd = Infinity;
  for (let i = 0; i < c.n; i += 4) { const p = c.track.center[i]; const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) bd = d; }
  return Math.sqrt(bd);
}

export async function loadDriftPark(): Promise<LoadedMap> {
  return buildRoadCourse({
    ctrl: [
      [-260, 0, 0.5], [60, 0, 0.5], [230, 25, 0.5], [320, 110, 0.5],
      [310, 220, 0.5], [230, 270, 0.5], [150, 230, 0.5],
      [90, 170, 0.5], [20, 200, 0.5], [-30, 280, 0.5],
      [-140, 320, 0.5], [-250, 290, 0.5], [-290, 200, 0.5],
      [-230, 130, 0.5], [-300, 80, 0.5], [-390, 60, 0.5], [-400, 10, 0.5],
    ],
    length: 2400,
    width: 16,
    start: [-60, 0],
    camberDeg: 1,
    runoff: 7,
    runoffTurn: 9,
    runoffSurface: 'asphalt',
    runoffColor: 0x3a3b3f,
    gravel: false,
    barrier: 'wall',
    pit: { from: -150, to: 40, taper: 45, boxSpacing: 6 },
    ground: { color: 0x2b2c30, texture: 'asphalt' },
    lamps: true,
    paceSpeed: 18,
    atmosphere: {
      mode: 'night', background: 0x05040c,
      envScene: () => { const s = new THREE.Scene(); s.background = new THREE.Color(0x120a1e); return s; },
      sunElevation: 70, sunAzimuth: 140, turbidity: 1, rayleigh: 0, mie: 0,
      sunColor: 0xd8d0ff, sunIntensity: 1.5, hemiSky: 0x3a2f5a, hemiGround: 0x141218, hemiIntensity: 0.7,
      envIntensity: 0.8, fogColor: 0x120c22, fogDensity: 0.0016, exposure: 1.05,
    },
    scenery: (c) => {
      const { minX, maxX, minZ, maxZ, minE } = c.bounds;
      const o = new THREE.Object3D();
      // shipping container stacks on the open ground around the course
      const box = new THREE.BoxGeometry(2.5, 2.6, 6.1);
      box.translate(0, 1.3, 0);
      const cols = [0xb91c1c, 0x1d4ed8, 0x15803d, 0xd97706, 0x6b7280, 0x0e7490, 0x7c2d12];
      const stacks = cols.map((col) => new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, metalness: 0.3 }), 80));
      const counts = cols.map(() => 0);
      for (let tries = 0; tries < 2500; tries++) {
        const x = minX - 80 + c.r() * (maxX - minX + 160), z = minZ - 80 + c.r() * (maxZ - minZ + 160);
        if (trackDist(c, x, z) < 34) continue;
        const yaw = Math.round(c.r() * 2) * (Math.PI / 2);
        const h = 1 + Math.floor(c.r() * 3);
        for (let k = 0; k < h; k++) {
          const ci = Math.floor(c.r() * cols.length);
          if (counts[ci] >= 80) continue;
          o.position.set(x, minE + k * 2.6, z);
          o.rotation.set(0, yaw, 0);
          o.updateMatrix();
          stacks[ci].setMatrixAt(counts[ci]++, o.matrix);
        }
      }
      stacks.forEach((s, i) => { s.count = counts[i]; s.castShadow = s.receiveShadow = true; c.group.add(s); });
      // gantry cranes along the quay (north side)
      const craneMat = new THREE.MeshStandardMaterial({ color: 0xd9a400, roughness: 0.5, metalness: 0.4 });
      for (let k = 0; k < 5; k++) {
        const x = minX + (k + 0.5) * ((maxX - minX) / 5), z = maxZ + 70;
        const g = new THREE.Group();
        for (const dx of [-8, 8]) for (const dz of [-6, 6]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 40, 1.2), craneMat); leg.position.set(dx, 20, dz); g.add(leg); }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(18, 2.5, 60), craneMat);
        beam.position.set(0, 40, -14);
        g.add(beam);
        const warn = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
        warn.position.set(0, 42, -43);
        g.add(warn);
        g.position.set(x, minE, z);
        c.group.add(g);
      }
      // warehouses (they get lit windows from the track-detail pass)
      const shedMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.8 });
      for (let k = 0; k < 8; k++) {
        const x = minX - 60 + (k / 7) * (maxX - minX + 120), z = minZ - 70 - (k % 2) * 30;
        const w = 30 + c.r() * 25, h = 10 + c.r() * 8;
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 24), shedMat);
        m.position.set(x, minE + h / 2, z);
        m.castShadow = m.receiveShadow = true;
        c.group.add(m);
      }
      // neon signs on poles around the course
      const neon = ['DRIFT PARK', 'NEON DOCKS', 'SIDEWAYS', 'NO GRIP CLUB', 'SMOKE SHOW', 'ANGLE KINGS'];
      const hues = [300, 190, 50, 130, 0, 260];
      neon.forEach((txt, k) => {
        const i = c.track.wrap(Math.round((k / neon.length) * c.n) + 40);
        const side = k % 2 ? 1 : -1;
        const p = c.barrierAt(i, side).addScaledVector(c.track.R[i], side * 8);
        const b = billboard(txt, hues[k], 14, 3.2);
        b.position.copy(p).setY(p.y + 7);
        b.lookAt(c.track.center[i].x, p.y + 7, c.track.center[i].z);
        b.traverse((m) => {
          const mm = (m as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (mm && 'emissive' in mm && mm.map) { mm.emissive = new THREE.Color(0xffffff); mm.emissiveMap = mm.map; mm.emissiveIntensity = 1.4; }
        });
        c.group.add(b);
      });
    },
  });
}
