import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { contrast, decalPlane, mergeByMaterial, numberDecal, textDecal, type CarVisual, type PartName } from './carModel';
import type { CarSpec } from './catalog';

/**
 * Procedural open-wheel GP car. Same CarVisual contract as the stock car, so damage, debris,
 * networking and LOD work unchanged. Damage part slots map to:
 *   splitter = front wing, bumperF = nose cone, spoiler = rear wing, bumperR = diffuser,
 *   skirtL / skirtR = sidepods, hood = engine cover, wheel0..3 = wheels.
 * Model frame: +Z forward, +X left, +Y up, origin on the ground at the car's centre.
 */
const SPONSORS = ['VANTIX', 'KESTREL', 'ORBITAL', 'SOLANO', 'MAKO', 'TRIDENT', 'QUORRA', 'DUNEBLAZE'];

/** A box with enough vertices to crumple (dentCar moves vertices). */
function panel(w: number, h: number, d: number, mat: THREE.Material, r = 0.04, seg = 3) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, seg, r), mat);
  m.castShadow = true;
  return m;
}

/** Tapered box (wider at the back), for the tub, nose and engine cover. */
function tapered(wBack: number, wFront: number, hBack: number, hFront: number, len: number, mat: THREE.Material) {
  const g = new THREE.BoxGeometry(1, 1, len, 2, 2, 8);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = p.getZ(i) / len + 0.5; // 0 back → 1 front
    const w = THREE.MathUtils.lerp(wBack, wFront, t);
    const h = THREE.MathUtils.lerp(hBack, hFront, t);
    p.setX(i, p.getX(i) * w);
    p.setY(i, (p.getY(i) + 0.5) * h);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

export function buildOpenWheelModel(opts: { number: number; color: string; seed: number }, spec: CarSpec): CarVisual {
  const g = spec.geo;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const primary = opts.color;
  const secondary = contrast(primary) === '#111111' ? '#1b1b1b' : '#f5f5f5';
  const sponsor = SPONSORS[opts.seed % SPONSORS.length];

  const paint = new THREE.MeshPhysicalMaterial({ color: primary, metalness: 0.3, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  const accent = new THREE.MeshPhysicalMaterial({ color: secondary, metalness: 0.2, roughness: 0.35, clearcoat: 1 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.35, metalness: 0.45 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.55, metalness: 0.2 });
  const titanium = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.9, roughness: 0.3 });
  const parts: Partial<Record<PartName, THREE.Object3D>> = {};

  // ---------- floor & tub ----------
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.03, 3.1), carbon);
  floor.position.set(0, 0.06, -0.25);
  floor.castShadow = true;
  body.add(floor);
  const plank = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 2.6), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 }));
  plank.position.set(0, 0.04, -0.25);
  body.add(plank);
  const tub = tapered(0.78, 0.5, 0.52, 0.4, 2.1, paint);
  tub.position.set(0, 0.1, 0.15);
  body.add(tub);
  // cockpit opening and driver
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.8), black);
  cockpit.position.set(0, 0.6, -0.1);
  body.add(cockpit);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 18, 14), new THREE.MeshPhysicalMaterial({ color: secondary, clearcoat: 1, roughness: 0.2 }));
  helmet.position.set(0, 0.74, -0.32);
  body.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.142, 18, 8, -0.9, 1.8, 1.2, 0.5), new THREE.MeshStandardMaterial({ color: 0x111820, metalness: 0.6, roughness: 0.1 }));
  visor.position.copy(helmet.position);
  body.add(visor);
  // halo: hoop over the cockpit plus a centre pillar
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 8, 28, Math.PI * 1.15), titanium);
  halo.rotation.x = -Math.PI / 2 - 0.12;
  halo.rotation.z = Math.PI * 0.92;
  halo.position.set(0, 0.84, -0.2);
  halo.scale.set(1, 1.25, 1);
  body.add(halo);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.34, 8), titanium);
  pillar.position.set(0, 0.72, 0.22);
  pillar.rotation.x = -0.55;
  body.add(pillar);

  // ---------- nose cone (bumperF) ----------
  const nose = tapered(0.42, 0.16, 0.34, 0.16, 1.3, paint);
  nose.position.set(0, 0.16, 1.85);
  nose.name = 'nose';
  body.add(nose);
  parts.bumperF = nose;

  // ---------- front wing (splitter) ----------
  const fw = new THREE.Group();
  const fwMain = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.025, 0.36), carbon);
  fwMain.position.set(0, 0.09, 2.55);
  fw.add(fwMain);
  for (let k = 0; k < 2; k++) {
    const flap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.02, 0.16), k === 0 ? paint : accent);
    flap.position.set(0, 0.13 + k * 0.045, 2.42 - k * 0.1);
    flap.rotation.x = 0.25 + k * 0.15;
    fw.add(flap);
  }
  for (const sx of [1, -1]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.42), paint);
    end.position.set(sx * 0.93, 0.15, 2.52);
    fw.add(end);
  }
  body.add(fw);
  parts.splitter = fw;

  // ---------- sidepods (skirtL / skirtR) ----------
  const sponsorTex = textDecal(sponsor, null, '#ffffff', 512, 128);
  for (const sx of [1, -1]) {
    const pod = new THREE.Group();
    const shell = panel(0.36, 0.34, 1.5, paint, 0.1, 3);
    shell.position.set(sx * 0.52, 0.27, -0.25);
    pod.add(shell);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.04), black);
    intake.position.set(sx * 0.52, 0.32, 0.51);
    pod.add(intake);
    const dec = decalPlane(0.9, 0.22, sponsorTex);
    dec.position.set(sx * 0.705, 0.3, -0.3);
    dec.rotation.y = sx * Math.PI / 2;
    pod.add(dec);
    body.add(pod);
    parts[sx > 0 ? 'skirtL' : 'skirtR'] = pod;
  }

  // ---------- engine cover & airbox (hood) ----------
  const cover = new THREE.Group();
  const coverShell = tapered(0.32, 0.7, 0.62, 0.58, 1.4, paint);
  coverShell.position.set(0, 0.12, -1.3);
  cover.add(coverShell);
  const airbox = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.12), black);
  airbox.position.set(0, 0.85, -0.6);
  cover.add(airbox);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.22, 1.1), accent);
  fin.position.set(0, 0.82, -1.25);
  cover.add(fin);
  const numTex = numberDecal(opts.number, '#ffffff', '#111111', '', 512, 420);
  for (const sx of [1, -1]) {
    const num = decalPlane(0.42, 0.34, numTex);
    num.position.set(sx * 0.27, 0.5, -1.05);
    num.rotation.y = sx * Math.PI / 2;
    cover.add(num);
  }
  body.add(cover);
  parts.hood = cover;
  const noseNum = decalPlane(0.26, 0.21, numTex);
  noseNum.rotation.x = -Math.PI / 2 + 0.12;
  noseNum.position.set(0, 0.36, 1.55);
  body.add(noseNum);

  // ---------- rear wing (spoiler) ----------
  const rw = new THREE.Group();
  const main = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 0.3), carbon);
  main.position.set(0, 0.86, -2.3);
  main.rotation.x = 0.12;
  rw.add(main);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.025, 0.2), paint);
  flap.position.set(0, 0.95, -2.42);
  flap.rotation.x = 0.45;
  flap.name = 'drsFlap';
  rw.add(flap);
  for (const sx of [1, -1]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.42, 0.55), paint);
    end.position.set(sx * 0.51, 0.78, -2.32);
    rw.add(end);
  }
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.12), carbon);
  pylon.position.set(0, 0.62, -2.28);
  rw.add(pylon);
  body.add(rw);
  parts.spoiler = rw;

  // ---------- diffuser (bumperR) and rain light ----------
  const diff = new THREE.Group();
  for (let k = -2; k <= 2; k++) {
    const strake = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.16, 0.5), carbon);
    strake.position.set(k * 0.18, 0.12, -1.98);
    strake.rotation.x = -0.3;
    diff.add(strake);
  }
  const diffTop = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.02, 0.5), carbon);
  diffTop.position.set(0, 0.2, -1.98);
  diffTop.rotation.x = -0.3;
  diff.add(diffTop);
  body.add(diff);
  parts.bumperR = diff;
  const taillights = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1100, emissiveIntensity: 0.15, roughness: 0.3 });
  const rain = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.03), taillights);
  rain.position.set(0, 0.36, -2.08);
  body.add(rain);

  // ---------- suspension arms (static, visual) ----------
  const arm = (a: THREE.Vector3, b: THREE.Vector3) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, a.distanceTo(b), 6), carbon);
    m.position.copy(a).lerp(b, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    body.add(m);
  };
  for (const sx of [1, -1]) {
    for (const [z, inner] of [[g.wheelbaseF, 0.22], [g.wheelbaseR, 0.32]] as const) {
      const hub = new THREE.Vector3(sx * (g.trackHalf - 0.12), g.wheelRadius, z);
      arm(new THREE.Vector3(sx * inner, 0.18, z + 0.25), hub);
      arm(new THREE.Vector3(sx * inner, 0.18, z - 0.25), hub);
      arm(new THREE.Vector3(sx * inner, 0.36, z), hub.clone().setY(g.wheelRadius + 0.12));
    }
  }
  const mirror = (sx: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.04), paint);
    m.position.set(sx * 0.42, 0.66, 0.3);
    body.add(m);
  };
  mirror(1); mirror(-1);

  // ---------- wheels ----------
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.9 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf2d22e, roughness: 0.6 }); // compound stripe (medium)
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.85, roughness: 0.3 });
  const wheels: THREE.Group[] = [];
  const brakeDiscs: THREE.MeshStandardMaterial[] = [];
  const positions: [number, number, boolean][] = [
    [g.trackHalf, g.wheelbaseF, true], [-g.trackHalf, g.wheelbaseF, true], [g.trackHalf, g.wheelbaseR, false], [-g.trackHalf, g.wheelbaseR, false],
  ];
  const R = g.wheelRadius;
  for (const [x, z, front] of positions) {
    const width = front ? 0.3 : 0.38;
    const pivot = new THREE.Group();
    pivot.position.set(x, R, z);
    const spin = new THREE.Group();
    pivot.add(spin);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(R, R, width, 32, 1, true), tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    spin.add(tire);
    const outward = x > 0 ? 1 : -1;
    for (const side of [1, -1]) {
      const wall = new THREE.Mesh(new THREE.RingGeometry(R * 0.62, R, 32), tireMat);
      wall.rotation.y = side * outward * Math.PI / 2;
      wall.position.x = side * outward * width / 2;
      spin.add(wall);
    }
    const stripe = new THREE.Mesh(new THREE.RingGeometry(R * 0.8, R * 0.86, 32), stripeMat);
    stripe.rotation.y = outward * Math.PI / 2;
    stripe.position.x = outward * (width / 2 + 0.002);
    spin.add(stripe);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.6, R * 0.6, width * 0.9, 24), rimMat);
    rim.rotation.z = Math.PI / 2;
    spin.add(rim);
    for (let k = 0; k < 6; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, R * 0.5, 0.04), rimMat);
      spoke.position.x = outward * (width / 2 - 0.01);
      spoke.rotation.x = (k / 6) * Math.PI * 2;
      spoke.translateY(R * 0.25);
      spin.add(spoke);
    }
    mergeByMaterial(spin);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.6, roughness: 0.5, emissive: 0xff3300, emissiveIntensity: 0 });
    brakeDiscs.push(discMat);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.5, R * 0.5, 0.03, 20), discMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = -outward * 0.06;
    pivot.add(disc);
    root.add(pivot);
    wheels.push(pivot);
  }
  for (let i = 0; i < 4; i++) parts[`wheel${i}` as PartName] = wheels[i];

  // no wiper on an open-wheeler: an empty placeholder keeps the CarVisual contract
  const wiper = new THREE.Group();
  wiper.visible = false;
  body.add(wiper);

  const decals: THREE.Object3D[] = [];
  body.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.Material).transparent) decals.push(m); });
  return {
    root, body, wheels, brakeDiscs, taillights, parts,
    deformables: [tub, nose, coverShell, ...[parts.skirtL, parts.skirtR].map((p) => p!.children[0] as THREE.Mesh)],
    paintMats: [paint],
    decals,
    glass: [],
    flaps: [],
    wiper,
    primary,
    comHeight: g.comHeight,
    engineBay: new THREE.Vector3(0, 0.55, -1.2),
    drsFlap: flap,
  };
}
