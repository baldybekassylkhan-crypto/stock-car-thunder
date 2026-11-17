import * as THREE from 'three';
import type { CarVisual } from '../vehicle/carModel';

/**
 * Demolition-derby modifications on the stock-car body: steel front bumper (bar, plough or cow
 * catcher), heavy rear bumper, a visible roll cage and window bars, door armour plates and a roof
 * plate on the tougher classes. Model frame: +Z forward, +X left, origin on the ground.
 */
const steel = new THREE.MeshStandardMaterial({ color: 0x6b6f75, metalness: 0.85, roughness: 0.38 });
const darkSteel = new THREE.MeshStandardMaterial({ color: 0x3b3e43, metalness: 0.8, roughness: 0.5 });
const rust = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, metalness: 0.4, roughness: 0.85 });
const hazard = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2c200'; g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#111';
  for (let x = -32; x < 160; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, metalness: 0.3, roughness: 0.6 });
})();

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  m.castShadow = true;
  return m;
}

function tube(a: THREE.Vector3, b: THREE.Vector3, r = 0.035, mat: THREE.Material = darkSteel) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), mat);
  m.position.copy(a).lerp(b, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

export function addDerbyKit(v: CarVisual, kit: { cls: string; bumper: string }) {
  const g = new THREE.Group();
  g.name = 'derbyKit';
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ---------- front bumper ----------
  if (kit.bumper === 'plow' || kit.cls === 'rammer') {
    const plate = box(2.25, 0.62, 0.08, hazard, 0, 0.42, 2.88, -0.42);
    g.add(plate);
    g.add(box(2.3, 0.12, 0.3, steel, 0, 0.16, 2.92));
    for (const x of [-0.7, 0, 0.7]) g.add(tube(V(x, 0.3, 2.55), V(x, 0.55, 2.86), 0.05, steel));
  } else if (kit.bumper === 'cage') {
    g.add(box(2.15, 0.12, 0.14, steel, 0, 0.22, 2.84));
    g.add(box(2.15, 0.12, 0.14, steel, 0, 0.72, 2.8));
    for (let k = 0; k < 7; k++) { const x = -0.96 + k * 0.32; g.add(tube(V(x, 0.2, 2.84), V(x, 0.74, 2.8), 0.035, steel)); }
  } else {
    g.add(box(2.15, 0.24, 0.22, steel, 0, 0.42, 2.8));
    g.add(box(2.15, 0.06, 0.24, hazard, 0, 0.56, 2.8));
    for (const x of [-0.6, 0.6]) g.add(box(0.12, 0.12, 0.4, darkSteel, x, 0.42, 2.58));
  }
  if (kit.cls === 'tank') g.add(box(2.2, 0.36, 0.28, darkSteel, 0, 0.3, 2.95));

  // ---------- heavy rear bumper ----------
  g.add(box(2.15, 0.3, 0.3, kit.cls === 'rammer' ? rust : steel, 0, 0.42, -2.78));
  for (const x of [-0.6, 0.6]) g.add(box(0.12, 0.12, 0.4, darkSteel, x, 0.42, -2.56));

  // ---------- roll cage visible through the windows, X bars on the side windows ----------
  for (const s of [1, -1]) {
    const x = s * 0.93;
    g.add(tube(V(x, 0.78, 0.85), V(x, 1.12, -0.75)));
    g.add(tube(V(x, 1.12, 0.85), V(x, 0.78, -0.75)));
    g.add(tube(V(x, 0.78, 0.9), V(x, 0.78, -0.85)));
  }
  g.add(tube(V(0.62, 1.2, 0.4), V(-0.62, 1.2, 0.4), 0.04));
  g.add(tube(V(0.62, 1.2, -0.6), V(-0.62, 1.2, -0.6), 0.04));

  // ---------- armour plates ----------
  if (kit.cls === 'tank' || kit.cls === 'survivor') {
    for (const s of [1, -1]) {
      const p = box(0.05, 0.42, 2.3, kit.cls === 'tank' ? darkSteel : steel, s * 1.0, 0.46, 0);
      g.add(p);
      for (let k = 0; k < 5; k++) g.add(box(0.03, 0.05, 0.05, steel, s * 1.03, 0.62, -0.95 + k * 0.48)); // rivets
    }
  }
  if (kit.cls === 'tank') g.add(box(1.2, 0.05, 1.5, darkSteel, 0, 1.27, -0.35)); // roof protection
  if (kit.cls === 'speed') {
    // a stripped car: big rear wing for show
    g.add(box(1.7, 0.04, 0.32, darkSteel, 0, 1.02, -2.45));
    for (const x of [-0.7, 0.7]) g.add(box(0.04, 0.32, 0.2, darkSteel, x, 0.86, -2.45));
  }
  if (kit.cls === 'rammer') g.add(box(1.5, 0.05, 1.1, steel, 0, 0.92, 1.55, -0.12)); // hood plate

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  v.body.add(g);
  return g;
}
