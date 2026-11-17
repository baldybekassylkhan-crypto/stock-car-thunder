import * as THREE from 'three';
import { toCollider, type ColliderMesh } from '../tracks/build';
import type { Atmosphere } from '../tracks/maps';
import * as tex from '../render/textures';
import { rng, SPONSOR_BOARDS, zharkynCanvas } from '../tracks/props';
import { textDecal } from '../vehicle/carModel';

/**
 * The Demolition Arena: a floodlit circular dirt bowl. A concrete wall with tyre cushions and a
 * tall catch fence keeps the cars in (plus an invisible outer wall, so nobody can escape), tyre
 * stacks and old wrecks are obstacles, the stands are full of an animated crowd, and a four-sided
 * scoreboard hangs over the middle.
 */
export interface ArenaMap {
  group: THREE.Group;
  colliders: ColliderMesh[];
  atmosphere: Atmosphere;
  /** Inner radius of the wall (m). */
  radius: number;
  /** Solid obstacles inside the arena (for the AI). */
  obstacles: { x: number; z: number; r: number }[];
  /** Trampolines: drive onto one and the car is launched into the air. `mat` squashes when used. */
  trampolines: { x: number; z: number; r: number; mat: THREE.Object3D; t: number }[];
  spawn(k: number, n: number): { pos: THREE.Vector3; quat: THREE.Quaternion };
  /** Camera spots in the stands for intro / victory shots. */
  tvCams: THREE.Vector3[];
  /** Redraw the hanging scoreboard. */
  scoreboard(lines: string[], accent?: string): void;
  /** Animate the crowd; excitement 0..1. */
  update(dt: number, excitement: number): void;
}

const R = 75;

function cylinderCollider(kind: 'wall' | 'concrete', x: number, z: number, r: number, h: number, seg = 12): ColliderMesh {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, false);
  g.translate(x, h / 2, z);
  return toCollider(kind, g);
}

function boxCollider(kind: 'wall' | 'concrete', w: number, h: number, d: number, m: THREE.Matrix4): ColliderMesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(m);
  return toCollider(kind, g);
}

function scoreboardTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { c, t };
}

export function buildArena(): ArenaMap {
  const group = new THREE.Group();
  const colliders: ColliderMesh[] = [];
  const r = rng(77);
  const obstacles: { x: number; z: number; r: number }[] = [];

  // ---------- dirt floor ----------
  const dirt = tex.sand();
  for (const t of [dirt.map, dirt.normalMap, dirt.roughnessMap]) t.repeat.set(30, 30);
  const floorGeo = new THREE.CircleGeometry(R + 1, 96);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ ...dirt, color: 0x9b7650, roughness: 1 }));
  floor.receiveShadow = true;
  group.add(floor);
  colliders.push(toCollider('dirt', floorGeo));
  // tyre marks / darker centre ring for texture
  const ringGeo = new THREE.RingGeometry(18, 52, 96);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 1, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  ring.position.y = 0.01;
  group.add(ring);

  // ---------- wall, tyre cushions, catch fence ----------
  const wallTex = tex.wall();
  wallTex.repeat.set(40, 1);
  const wallGeo = new THREE.CylinderGeometry(R, R, 1.5, 128, 1, true);
  wallGeo.translate(0, 0.75, 0);
  const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8, side: THREE.DoubleSide }));
  wall.receiveShadow = true;
  group.add(wall);
  colliders.push(toCollider('wall', wallGeo));
  // invisible outer containment: nobody gets out of the arena
  const outer = new THREE.CylinderGeometry(R + 0.4, R + 0.4, 9, 64, 1, true);
  outer.translate(0, 4.5, 0);
  colliders.push(toCollider('wall', outer));
  const fenceTex = tex.fence();
  fenceTex.repeat.set(120, 3);
  const fenceGeo = new THREE.CylinderGeometry(R + 0.2, R + 0.2, 5.5, 128, 1, true);
  fenceGeo.translate(0, 1.5 + 2.75, 0);
  group.add(new THREE.Mesh(fenceGeo, new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 })));
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.7, roughness: 0.4 });
  const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 7, 6);
  const posts = new THREE.InstancedMesh(postGeo, postMat, 64);
  const o = new THREE.Object3D();
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    o.position.set(Math.cos(a) * (R + 0.3), 3.5, Math.sin(a) * (R + 0.3));
    o.updateMatrix();
    posts.setMatrixAt(k, o.matrix);
  }
  group.add(posts);
  // tyre cushions along the wall (visual; the wall itself is the collider)
  const tyreGeo = new THREE.TorusGeometry(0.42, 0.18, 6, 12);
  tyreGeo.rotateX(Math.PI / 2);
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const cushions = new THREE.InstancedMesh(tyreGeo, tyreMat, 360);
  let ti = 0;
  for (let seg = 0; seg < 12; seg++) {
    const a0 = (seg / 12) * Math.PI * 2 + 0.12;
    for (let k = 0; k < 10; k++) {
      const a = a0 + k * 0.022;
      for (let h = 0; h < 3; h++) {
        if (ti >= cushions.count) break;
        o.position.set(Math.cos(a) * (R - 0.6), 0.2 + h * 0.36, Math.sin(a) * (R - 0.6));
        o.rotation.set(0, 0, 0);
        o.updateMatrix();
        cushions.setMatrixAt(ti++, o.matrix);
      }
    }
  }
  cushions.count = ti;
  cushions.castShadow = true;
  group.add(cushions);

  // ---------- obstacles: tyre stacks, jersey barriers, old wrecks ----------
  const stackGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.3, 14);
  stackGeo.translate(0, 0.65, 0);
  const stackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 });
  const addStack = (x: number, z: number) => {
    const m = new THREE.Mesh(stackGeo, stackMat);
    m.position.set(x, 0, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.63, 0.14, 14), stripeMat);
    band.position.set(x, 1.0, z);
    group.add(band);
    colliders.push(cylinderCollider('wall', x, z, 0.62, 1.3));
  };
  for (let c = 0; c < 4; c++) {
    const a = (c / 4) * Math.PI * 2 + Math.PI / 4;
    const cx = Math.cos(a) * 34, cz = Math.sin(a) * 34;
    for (const [dx, dz] of [[0, 0], [1.3, 0], [0.65, 1.1]]) addStack(cx + dx, cz + dz);
    obstacles.push({ x: cx + 0.6, z: cz + 0.4, r: 2.2 });
  }
  const jersey = new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.85 });
  for (const a of [0, Math.PI]) {
    const m = new THREE.Matrix4().makeRotationY(a + Math.PI / 2).setPosition(Math.cos(a) * 14, 0.45, Math.sin(a) * 14);
    for (const off of [-2.2, 2.2]) {
      const mm = m.clone().multiply(new THREE.Matrix4().makeTranslation(off, 0, 0));
      const b = new THREE.Mesh(new THREE.BoxGeometry(4, 0.9, 0.7), jersey);
      b.applyMatrix4(mm);
      b.castShadow = b.receiveShadow = true;
      group.add(b);
      colliders.push(boxCollider('wall', 4, 0.9, 0.7, mm));
    }
    obstacles.push({ x: Math.cos(a) * 14, z: Math.sin(a) * 14, r: 4.6 });
  }
  const wreckMat = new THREE.MeshStandardMaterial({ color: 0x5a3a24, metalness: 0.5, roughness: 0.8 });
  const wreckDark = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.9 });
  for (const a of [Math.PI / 2, -Math.PI / 2 + 0.3, Math.PI * 0.95]) {
    const x = Math.cos(a) * 52, z = Math.sin(a) * 52;
    const m = new THREE.Matrix4().makeRotationY(r() * 3).setPosition(x, 0.55, z);
    const shell = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.1, 4.6), wreckMat);
    shell.applyMatrix4(m);
    shell.rotation.z += 0.15;
    shell.castShadow = shell.receiveShadow = true;
    group.add(shell);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.8), wreckDark);
    cab.position.copy(shell.position).add(new THREE.Vector3(0, 0.7, 0));
    cab.rotation.copy(shell.rotation);
    group.add(cab);
    colliders.push(boxCollider('wall', 1.9, 1.1, 4.6, m));
    obstacles.push({ x, z, r: 2.8 });
  }
  // ---------- trampolines: one in the middle, four around it ----------
  const trampolines: ArenaMap['trampolines'] = [];
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, metalness: 0.4, roughness: 0.45 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.55, emissive: 0x0b2a80, emissiveIntensity: 0.5 });
  const springMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 1, roughness: 0.3 });
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
  const padSpots: [number, number][] = [[0, 0], ...[0, 1, 2, 3].map((k): [number, number] => { const a = k * Math.PI / 2 + Math.PI / 4; return [Math.cos(a) * 24, Math.sin(a) * 24]; })];
  for (const [x, z] of padSpots) {
    const rr = 3;
    const frame = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.16, 8, 40), frameMat);
    frame.rotation.x = -Math.PI / 2;
    frame.position.set(x, 0.2, z);
    frame.castShadow = true;
    group.add(frame);
    const mat = new THREE.Group();
    mat.position.set(x, 0.17, z);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(rr - 0.12, 40), padMat);
    disc.rotation.x = -Math.PI / 2;
    disc.receiveShadow = true;
    mat.add(disc);
    // an up arrow painted on the mat
    const arrow = new THREE.Shape();
    arrow.moveTo(0, 1.3); arrow.lineTo(0.9, 0.2); arrow.lineTo(0.35, 0.2); arrow.lineTo(0.35, -1.1);
    arrow.lineTo(-0.35, -1.1); arrow.lineTo(-0.35, 0.2); arrow.lineTo(-0.9, 0.2); arrow.closePath();
    const am = new THREE.Mesh(new THREE.ShapeGeometry(arrow), arrowMat);
    am.rotation.x = -Math.PI / 2;
    am.position.y = 0.01;
    mat.add(am);
    group.add(mat);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6), springMat);
      sp.position.set(x + Math.cos(a) * (rr - 0.05), 0.08, z + Math.sin(a) * (rr - 0.05));
      group.add(sp);
    }
    trampolines.push({ x, z, r: rr - 0.2, mat, t: 9 });
  }

  addFloorDetail(group, r);
  addWallBanners(group);
  addBackstage(group, r);

  // scattered loose junk (visual)
  const junk = new THREE.InstancedMesh(tyreGeo, tyreMat, 40);
  for (let k = 0; k < junk.count; k++) {
    const a = r() * Math.PI * 2, d = 8 + r() * (R - 14);
    o.position.set(Math.cos(a) * d, 0.18, Math.sin(a) * d);
    o.rotation.set(r() * 0.4, r() * 3, 0);
    o.updateMatrix();
    junk.setMatrixAt(k, o.matrix);
  }
  group.add(junk);

  // ---------- stands with an animated crowd ----------
  /** Flat annular sector (x = r·sin a, z = r·cos a like CylinderGeometry), facing up. */
  const stepGeo = (r0: number, r1: number, a0: number, len: number, y: number) => {
    const seg = 48, pos: number[] = [], idx: number[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (k / seg) * len;
      pos.push(Math.sin(a) * r0, y, Math.cos(a) * r0, Math.sin(a) * r1, y, Math.cos(a) * r1);
      if (k < seg) { const i = k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  const standMat = new THREE.MeshStandardMaterial({ color: 0x8f8a82, roughness: 0.9 });
  const tiers = 12;
  const people: { k: number; y: number; ph: number }[] = [];
  const personGeo = new THREE.BoxGeometry(0.45, 0.8, 0.35);
  personGeo.translate(0, 0.4, 0);
  const crowd = new THREE.InstancedMesh(personGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), 1400);
  let ci = 0;
  for (let s = 0; s < 4; s++) {
    const a0 = (s / 4) * Math.PI * 2 + 0.1, len = Math.PI / 2 - 0.2;
    for (let t = 0; t < tiers; t++) {
      const rad = R + 3 + t * 1.6, y = 1.8 + t * 0.9;
      // riser (open-ended: closed caps on a partial cylinder are pie slices that covered the
      // whole arena like pale clouds) plus a flat step on top
      const riser = new THREE.CylinderGeometry(rad + 1.6, rad + 1.6, 0.9, 48, 1, true, a0, len);
      riser.translate(0, y - 0.45, 0);
      const m = new THREE.Mesh(riser, standMat);
      m.receiveShadow = true;
      group.add(m);
      const step = new THREE.Mesh(stepGeo(rad + 1.6, rad + 3.2, a0, len, y), standMat);
      step.receiveShadow = true;
      group.add(step);
      const n = Math.floor(len * rad / 0.75);
      for (let k = 0; k < n && ci < crowd.count; k++) {
        if (r() < 0.22) continue;
        const a = a0 + ((k + 0.5) / n) * len;
        o.position.set(Math.cos(a) * (rad + 0.8), y, Math.sin(a) * (rad + 0.8));
        o.rotation.set(0, -a - Math.PI / 2, 0);
        o.updateMatrix();
        crowd.setMatrixAt(ci, o.matrix);
        crowd.setColorAt(ci, new THREE.Color().setHSL(r(), 0.5 + r() * 0.4, 0.35 + r() * 0.3));
        people.push({ k: ci, y, ph: r() * 6 });
        ci++;
      }
    }
  }
  crowd.count = ci;
  group.add(crowd);
  const crowdMat4 = new THREE.Matrix4();
  const crowdPos = new THREE.Vector3(), crowdQ = new THREE.Quaternion(), crowdS = new THREE.Vector3();

  // ---------- light towers ----------
  const lightPos: THREE.Vector3[] = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x777b82, metalness: 0.7, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3dd, emissiveIntensity: 9 });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const base = new THREE.Vector3(Math.cos(a) * (R + 26), 0, Math.sin(a) * (R + 26));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 40, 8), poleMat);
    pole.position.copy(base).setY(20);
    group.add(pole);
    const head = new THREE.Group();
    head.position.copy(base).setY(40);
    head.lookAt(0, 0, 0);
    head.add(new THREE.Mesh(new THREE.BoxGeometry(7, 4, 0.5), poleMat));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 0.2), lampMat);
      lamp.position.set(-2.2 + i * 2.2, -0.9 + j * 1.8, 0.35);
      head.add(lamp);
    }
    group.add(head);
    lightPos.push(head.position.clone());
  }
  for (let k = 0; k < 4; k++) {
    const s = new THREE.SpotLight(0xfff1dc, 2200, 300, THREE.MathUtils.degToRad(45), 0.6, 1.4);
    s.position.copy(lightPos[k * 2]);
    s.target.position.set(0, 0, 0);
    group.add(s, s.target);
  }

  // ---------- hanging scoreboard ----------
  const faces = [0, 1, 2, 3].map(() => scoreboardTexture());
  const sb = new THREE.Group();
  sb.position.set(0, 24, 0);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.4, 5.2, 9.4), new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.6, roughness: 0.5 }));
  sb.add(frame);
  faces.forEach((f, k) => {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(8.8, 4.4), new THREE.MeshBasicMaterial({ map: f.t, toneMapped: false }));
    const a = (k / 4) * Math.PI * 2;
    screen.position.set(Math.sin(a) * 4.75, 0, Math.cos(a) * 4.75);
    screen.rotation.y = a;
    sb.add(screen);
  });
  for (const [x, z] of [[3, 3], [-3, 3], [3, -3], [-3, -3]]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 30, 4), poleMat);
    cable.position.set(x, 17.5, z);
    sb.add(cable);
  }
  group.add(sb);
  const scoreboard = (lines: string[], accent = '#ffcc00') => {
    for (const f of faces) {
      const g = f.c.getContext('2d')!;
      g.fillStyle = '#05070b';
      g.fillRect(0, 0, 512, 256);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      lines.slice(0, 3).forEach((l, i) => {
        g.fillStyle = i === 0 ? accent : '#f2f2f2';
        g.font = `italic 900 ${i === 0 ? 92 : 46}px "Barlow Condensed", Impact, sans-serif`;
        g.fillText(l, 256, i === 0 ? 80 : 150 + (i - 1) * 56);
      });
      f.t.needsUpdate = true;
    }
  };
  scoreboard(['DEMOLITION', 'ARENA']);

  // ---------- night sky ----------
  {
    const n = 1500;
    const pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const th = r() * Math.PI * 2, ph = Math.acos(0.15 + r() * 0.85);
      pos.set([Math.cos(th) * Math.sin(ph) * 3000, Math.cos(ph) * 3000, Math.sin(th) * Math.sin(ph) * 3000], k * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false })));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x14130f, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    group.add(ground);
  }

  const envScene = () => {
    const s = new THREE.Scene();
    s.background = new THREE.Color(0x070a12);
    const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 13, 11) });
    for (const p of lightPos) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 1), lm);
      m.position.copy(p).multiplyScalar(0.8);
      m.lookAt(0, 0, 0);
      s.add(m);
    }
    return s;
  };

  let crowdT = 0;
  return {
    group,
    colliders,
    radius: R,
    obstacles,
    trampolines,
    tvCams: [0, 1, 2, 3, 4, 5].map((k) => { const a = (k / 6) * Math.PI * 2 + 0.3; return new THREE.Vector3(Math.cos(a) * (R + 12), 14, Math.sin(a) * (R + 12)); }),
    spawn(k, n) {
      const a = (k / Math.max(1, n)) * Math.PI * 2;
      const pos = new THREE.Vector3(Math.cos(a) * R * 0.66, 0.62, Math.sin(a) * R * 0.66);
      const yaw = Math.atan2(-pos.x, -pos.z); // facing the centre
      return { pos, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw) };
    },
    scoreboard,
    update(dt, excitement) {
      crowdT += dt;
      // bob a third of the crowd each frame (cheap) — more when the action heats up
      const amp = 0.05 + excitement * 0.35;
      for (let k = crowdT * 60 % 3 | 0; k < people.length; k += 3) {
        const p = people[k];
        crowd.getMatrixAt(p.k, crowdMat4);
        crowdMat4.decompose(crowdPos, crowdQ, crowdS);
        crowdPos.y = p.y + Math.max(0, Math.sin(crowdT * (4 + excitement * 6) + p.ph)) * amp;
        crowdMat4.compose(crowdPos, crowdQ, crowdS);
        crowd.setMatrixAt(p.k, crowdMat4);
      }
      crowd.instanceMatrix.needsUpdate = true;
    },
    atmosphere: {
      mode: 'night',
      background: 0x04060c,
      envScene,
      sunElevation: 75,
      sunAzimuth: 200,
      turbidity: 1,
      rayleigh: 0,
      mie: 0,
      sunColor: 0xfff1e0,
      sunIntensity: 2.1,
      hemiSky: 0x3a4660,
      hemiGround: 0x1d1810,
      hemiIntensity: 0.6,
      envIntensity: 0.9,
      fogColor: 0x0a0d16,
      fogDensity: 0.0012,
      exposure: 1.0,
    },
  };
}

/** Floor detail: mud patches, puddles, tyre tracks, loose body panels and cones (all visual). */
function addFloorDetail(group: THREE.Group, r: () => number) {
  const flat = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, y: number, rot: number, sx = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, rot);
    m.scale.set(sx, sz, 1);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const decalMat = (color: number, opacity: number, rough = 1, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
  // irregular mud patches
  const blob = (k: number) => {
    const sh = new THREE.Shape();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = 1 + 0.35 * Math.sin(a * 3 + k) + 0.2 * Math.sin(a * 5 + k * 2);
      if (i === 0) sh.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else sh.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    return new THREE.ShapeGeometry(sh, 4);
  };
  const mud = decalMat(0x3d2a1c, 0.55);
  for (let k = 0; k < 18; k++) {
    const a = r() * Math.PI * 2, d = 8 + r() * 60;
    flat(blob(k), mud, Math.cos(a) * d, Math.sin(a) * d, 0.014, r() * 6, 2 + r() * 4, 1.5 + r() * 3);
  }
  // puddles: dark and glossy
  const water = decalMat(0x1c1a17, 0.85, 0.05, 0.4);
  for (let k = 0; k < 6; k++) {
    const a = r() * Math.PI * 2, d = 15 + r() * 50;
    flat(blob(k + 30), water, Math.cos(a) * d, Math.sin(a) * d, 0.018, r() * 6, 1.2 + r() * 1.6, 0.8 + r());
  }
  // tyre tracks: a canvas of curving double lines laid over the whole floor
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1024;
  const ctx = cv.getContext('2d')!;
  ctx.strokeStyle = 'rgba(30,20,12,0.55)';
  ctx.lineCap = 'round';
  for (let k = 0; k < 46; k++) {
    const x = r() * 1024, y = r() * 1024, rad = 80 + r() * 380, a0 = r() * 6.3, len = 0.6 + r() * 2;
    ctx.lineWidth = 5 + r() * 4;
    for (const off of [0, 22]) {
      ctx.beginPath();
      ctx.arc(x, y, rad + off, a0, a0 + len);
      ctx.stroke();
    }
  }
  const tracksTex = new THREE.CanvasTexture(cv);
  tracksTex.colorSpace = THREE.SRGBColorSpace;
  tracksTex.anisotropy = 4;
  const trackMat = new THREE.MeshStandardMaterial({ map: tracksTex, transparent: true, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  flat(new THREE.CircleGeometry(74, 64), trackMat, 0, 0, 0.016, 0);
  // loose body panels (doors, hoods) and a few cones
  const panelCols = [0x8a2a22, 0x2c4a8a, 0xcfa21a, 0x3c6e3a, 0x777777, 0xe0e0e0];
  for (let k = 0; k < 16; k++) {
    const a = r() * Math.PI * 2, d = 10 + r() * 58;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.9 + r() * 0.7, 0.04, 0.6 + r() * 0.8), new THREE.MeshStandardMaterial({ color: panelCols[k % panelCols.length], metalness: 0.5, roughness: 0.6 }));
    m.position.set(Math.cos(a) * d, 0.04, Math.sin(a) * d);
    m.rotation.set((r() - 0.5) * 0.15, r() * 6, (r() - 0.5) * 0.15);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.6 });
  const coneBand = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  for (let k = 0; k < 10; k++) {
    const a = r() * Math.PI * 2, d = 20 + r() * 45;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 12), coneMat);
    const knocked = r() < 0.5;
    c.position.set(x, knocked ? 0.2 : 0.35, z);
    if (knocked) c.rotation.set(Math.PI / 2, 0, r() * 6);
    c.castShadow = true;
    group.add(c);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.12, 12), coneBand);
    band.position.copy(c.position);
    band.rotation.copy(c.rotation);
    group.add(band);
  }
}

/** Sponsor banners on the wall, in the gaps between the tyre cushions. */
function addWallBanners(group: THREE.Group) {
  const names = [...SPONSOR_BOARDS, 'DEMOLITION ARENA', 'LAST ONE STANDING', 'THUNDER SERIES', 'WRECK NIGHT'];
  const colors = ['#c81e1e', '#111111', '#1d4ed8', '#f2c200', '#166534', '#7c3aed'];
  for (let seg = 0; seg < 12; seg++) {
    // cushions sit at a0 .. a0 + 0.2 rad; the banner goes in the middle of the gap after them
    const a = (seg / 12) * Math.PI * 2 + 0.12 + 0.2 + 0.16;
    const bg = colors[seg % colors.length];
    const fg = bg === '#f2c200' ? '#111111' : '#ffffff';
    const name = names[seg % names.length];
    let tex: THREE.Texture;
    if (name === 'ZHARKYN') { tex = new THREE.CanvasTexture(zharkynCanvas()); tex.colorSpace = THREE.SRGBColorSpace; }
    else tex = textDecal(name, bg, fg, 1024, 128);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    const rr = R - 0.25;
    m.position.set(Math.cos(a) * rr, 0.78, Math.sin(a) * rr);
    m.lookAt(0, 0.78, 0);
    group.add(m);
  }
}

/** Behind the fence (seen through it): barrels, hay bales, a tow truck and a crew trailer. */
function addBackstage(group: THREE.Group, r: () => number) {
  const barrelCols = [0xb91c1c, 0x1d4ed8, 0xf2c200, 0x3f6212];
  const barrelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 14);
  for (let k = 0; k < 40; k++) {
    const a = r() * Math.PI * 2, d = R + 1.1 + r() * 1.2;
    const m = new THREE.Mesh(barrelGeo, new THREE.MeshStandardMaterial({ color: barrelCols[k % barrelCols.length], metalness: 0.5, roughness: 0.5 }));
    m.position.set(Math.cos(a) * d, 0.45, Math.sin(a) * d);
    m.castShadow = true;
    group.add(m);
  }
  const hayMat = new THREE.MeshStandardMaterial({ color: 0xc9a54a, roughness: 1 });
  for (let k = 0; k < 24; k++) {
    const a = r() * Math.PI * 2, d = R + 1.6;
    for (let h = 0; h < 2; h++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.55, 0.6), hayMat);
      m.position.set(Math.cos(a) * d, 0.28 + h * 0.55, Math.sin(a) * d);
      m.rotation.y = -a + (r() - 0.5) * 0.2;
      m.castShadow = true;
      group.add(m);
    }
  }
  // tow truck (simple boxes) and a crew trailer in the gaps between the stands
  const truck = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xb91c1c, metalness: 0.4, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 2), red);
  cabin.position.set(0, 1.3, 1.6);
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 3.6), red);
  bed.position.set(0, 0.8, -1.2);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 3), dark);
  boom.position.set(0, 2.0, -1.6);
  boom.rotation.x = 0.5;
  truck.add(cabin, bed, boom);
  for (const [x, z] of [[1.1, 1.6], [-1.1, 1.6], [1.1, -2], [-1.1, -2]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 14), dark);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.45, z);
    truck.add(w);
  }
  const ta = 0.05;
  truck.position.set(Math.cos(ta) * (R + 4), 0, Math.sin(ta) * (R + 4));
  truck.rotation.y = -ta;
  truck.traverse((o) => { o.castShadow = true; });
  group.add(truck);
  const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.3, roughness: 0.5 }));
  const tb = Math.PI + 0.05;
  trailer.position.set(Math.cos(tb) * (R + 5), 1.6, Math.sin(tb) * (R + 5));
  trailer.rotation.y = -tb;
  trailer.castShadow = true;
  group.add(trailer);
}
