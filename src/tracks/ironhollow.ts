import * as THREE from 'three';
import { Track, ovalCenterline } from './track';
import { buildOval, infieldShape } from './build';
import type { LoadedMap, MapLoadOptions } from './maps';
import * as tex from '../render/textures';
import { grandstand, rng, UP, billboard, SPONSOR_BOARDS } from './props';

const deg = THREE.MathUtils.degToRad;

/** Iron Hollow Speedway: 0.5 mile concrete short track, 26° banking, a bowl of grandstands, at night. */
export async function loadIronHollow(_o: MapLoadOptions): Promise<LoadedMap> {
  const WIDTH = 15;
  const APRON = 6;
  const center = ovalCenterline({ straight: 183, radius: 70, triBulge: 0, smoothSigmaM: 18, targetLength: 805 });
  const track = new Track(center, WIDTH, (_u, k) => {
    const t = THREE.MathUtils.clamp(Math.abs(k) * 70, 0, 1);
    return deg(4) + deg(22) * t * t * (3 - 2 * t);
  }, 20);
  const built = buildOval(track, {
    apron: APRON, wallHeight: 1.2, fenceHeight: 5.5,
    pit: { from: -60, to: 60, width: 11, taper: 16 },
    surface: 'concrete',
    roughness: 0.5,
  });
  const group = built.group;
  const r = rng(7);

  // ---------- ground ----------
  const groundGeo = new THREE.PlaneGeometry(6000, 6000);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: 0x1d2117, roughness: 1 }));
  ground.position.y = -0.04;
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
  const infield = new THREE.Mesh(infieldGeo, new THREE.MeshStandardMaterial({ ...grassSet, roughness: 1, color: 0x9ab08a }));
  infield.position.y = -0.006;
  infield.receiveShadow = true;
  group.add(infield);

  // ---------- grandstand bowl ----------
  const edge = (i: number) => track.surface(i, WIDTH).addScaledVector(track.R[i], 0.8).setY(0);
  const stand = grandstand(track, group, { range: null, edge, gap: 6, depth: 34, base: 4, top: 24, roof: false });
  // a taller main stand with suites over the frontstretch
  grandstand(track, group, { range: [-70, 70], edge, gap: 6 + 34 + 2, depth: 16, base: 24, top: 34, suites: true });

  // ---------- light towers + flood lights ----------
  const lightPos: THREE.Vector3[] = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x777b82, metalness: 0.7, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3dd, emissiveIntensity: 9 });
  const towers = 12;
  for (let k = 0; k < towers; k++) {
    const i = track.wrap(Math.round((k / towers) * track.n));
    const base = stand.at(i, 36, 0);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 46, 8), poleMat);
    pole.position.copy(base).setY(23);
    group.add(pole);
    const head = new THREE.Group();
    head.position.copy(base).setY(46);
    head.lookAt(track.center[i].clone().setY(0));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 0.5), poleMat);
    head.add(frame);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 0.2), lampMat);
      lamp.position.set(-2.2 + a * 2.2, -0.9 + b * 1.8, 0.35);
      head.add(lamp);
    }
    group.add(head);
    lightPos.push(head.position.clone());
  }
  // a few real spotlights (no shadows: cheap) plus the overhead "sun" light from the renderer
  for (let k = 0; k < 4; k++) {
    const p = lightPos[k * 3];
    const s = new THREE.SpotLight(0xfff1dc, 2600, 420, deg(48), 0.6, 1.4);
    s.position.copy(p);
    s.target.position.set(0, 0, 0);
    group.add(s, s.target);
  }

  // ---------- infield buildings ----------
  {
    const m = new THREE.MeshStandardMaterial({ color: 0xcfcac0, roughness: 0.8 });
    const tower = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 8), m);
    tower.position.copy(track.surface(0, -APRON - 30)).setY(5);
    tower.rotation.y = Math.atan2(track.T[0].x, track.T[0].z);
    tower.castShadow = true;
    group.add(tower);
    const winMat = new THREE.MeshStandardMaterial({ color: 0x223040, emissive: 0xffd58a, emissiveIntensity: 1.4 });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(12, 2.5), winMat);
    win.position.copy(tower.position).setY(7).addScaledVector(track.R[0], 4.05);
    win.lookAt(win.position.clone().add(track.R[0]));
    group.add(win);
    const hauler = new THREE.BoxGeometry(2.6, 4, 16);
    hauler.translate(0, 2, 0);
    const haulers = new THREE.InstancedMesh(hauler, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }), 14);
    const o = new THREE.Object3D();
    for (let k = 0; k < haulers.count; k++) {
      const i = track.wrap(Math.round(track.n * 0.5) - 60 + k * 9);
      o.position.copy(track.surface(i, -APRON - 28)).setY(0);
      o.rotation.y = Math.atan2(track.T[i].x, track.T[i].z) + Math.PI / 2;
      o.updateMatrix();
      haulers.setMatrixAt(k, o.matrix);
      haulers.setColorAt(k, new THREE.Color().setHSL(r(), 0.6, 0.45));
    }
    haulers.castShadow = true;
    group.add(haulers);
  }

  // ---------- sponsor boards on the wall tops ----------
  SPONSOR_BOARDS.forEach((name, k) => {
    const i = track.wrap(Math.round(track.n * 0.5) - 40 + k * 12);
    const b = billboard(name, (k * 47) % 360, 14, 3.2);
    b.position.copy(stand.at(i, 0, 2.2)).addScaledVector(track.R[i], -0.6);
    b.lookAt(b.position.clone().sub(track.R[i]));
    group.add(b);
  });

  // ---------- night sky: stars + distant city glow ----------
  {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const th = r() * Math.PI * 2, ph = Math.acos(0.15 + r() * 0.85);
      pos.set([Math.cos(th) * Math.sin(ph) * 3500, Math.cos(ph) * 3500, Math.sin(th) * Math.sin(ph) * 3500], k * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false })));
    // horizon glow ring
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(3000, 3000, 500, 48, 1, true),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
        vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying float vY; void main(){ float a = smoothstep(250.0, -250.0, vY); gl_FragColor = vec4(1.0, 0.55, 0.25, a * 0.22); }',
      }),
    );
    glow.position.y = 200;
    group.add(glow);
    // city skyline silhouettes
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    bGeo.translate(0, 0.5, 0);
    const city = new THREE.InstancedMesh(bGeo, new THREE.MeshStandardMaterial({ color: 0x0b0d12, emissive: 0xffc070, emissiveIntensity: 0.06 }), 220);
    const o = new THREE.Object3D();
    for (let k = 0; k < city.count; k++) {
      const a = r() * Math.PI * 2, d = 1400 + r() * 900;
      o.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
      o.scale.set(30 + r() * 60, 30 + r() * r() * 180, 30 + r() * 60);
      o.rotation.y = r() * 3;
      o.updateMatrix();
      city.setMatrixAt(k, o.matrix);
    }
    group.add(city);
  }

  const tvCams = [0.05, 0.25, 0.45, 0.6, 0.8].map((u) => {
    const i = track.wrap(Math.round(u * track.n));
    return stand.at(i, 8, 16);
  });

  // reflections: dark sky with bright light banks
  const envScene = () => {
    const s = new THREE.Scene();
    s.background = new THREE.Color(0x070a12);
    const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 13, 11) });
    for (const p of lightPos) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 1), lm);
      m.position.copy(p).multiplyScalar(0.8);
      m.lookAt(0, 0, 0);
      s.add(m);
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshBasicMaterial({ color: 0x1a1c20 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -5;
    s.add(floor);
    return s;
  };

  return {
    track,
    group,
    colliders: built.colliders,
    tvCams,
    gridSlot: (slot) => {
      const row = Math.floor(slot / 2);
      return { i: track.wrap(-95 - row * 6), d: slot % 2 === 0 ? 4 : 9 };
    },
    paceSpeed: 24,
    oval: true,
    rain: false,
    gripScale: 1,
    fireworks: true,
    outOfBounds: 80,
    atmosphere: {
      mode: 'night',
      background: 0x04060c,
      envScene,
      sunElevation: 72,
      sunAzimuth: 200,
      turbidity: 1,
      rayleigh: 0,
      mie: 0,
      sunColor: 0xfff1e0,
      sunIntensity: 2.0,
      hemiSky: 0x33405a,
      hemiGround: 0x15140f,
      hemiIntensity: 0.55,
      envIntensity: 0.9,
      fogColor: 0x0a0d16,
      fogDensity: 0.0009,
      exposure: 1.0,
    },
  };
}
// keep UP referenced for consistency with other maps
void UP;
