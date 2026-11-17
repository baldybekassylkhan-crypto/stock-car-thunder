import * as THREE from 'three';
import { textDecal, type CarVisual } from './carModel';
import { BODY_PROFILES, rebody } from './supercarBody';

/**
 * Sports cars and supercars built on the stock-car body. The body itself is reshaped (a wedge
 * nose, the cabin moved forward or back and lowered, wider rear haunches, a dropped tail), then
 * each model gets its own parts: wings, ducktails, intakes, roof scoops, louvres, light bars,
 * exhausts and rims. Every add-on is placed on the reshaped surface by casting a ray down onto
 * the body, so nothing floats above it or sinks into it.
 */

export const isSupercar = (id: string) => id in BODY_PROFILES;

export interface SuperKit {
  accent: THREE.Material; carbon: THREE.Material; black: THREE.Material; chrome: THREE.Material;
  rims: (color: number, metal?: number, rough?: number) => void;
}

export function styleSupercar(v: CarVisual, id: string, k: SuperKit, number: number) {
  const { body } = v;
  // a body of its own, built from this model's profile
  rebody(v, BODY_PROFILES[id], number);
  const sh = { cab: 0, hips: BODY_PROFILES[id].hips, scale: [1, 1, 1] as [number, number, number] };
  const parts = v.parts;
  v.root.updateMatrixWorld(true);

  // ---------- surface probe: top of the body at a body-local (x, z) ----------
  const ray = new THREE.Raycaster();
  const targets = body.children.filter((c) => (c as THREE.Mesh).isMesh && c.visible && !((c as THREE.Mesh).material as THREE.Material).transparent);
  const top = (x: number, z: number) => {
    ray.set(new THREE.Vector3(x * sh.scale[0], 6, z * sh.scale[2]), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(targets, false)[0];
    return hit ? hit.point.y / sh.scale[1] : 0.6;
  };
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    body.add(m);
    return m;
  };
  const { accent, carbon, black, chrome, rims } = k;

  /** A wing on two struts standing on the rear deck. */
  const spoiler = (parts.spoiler ?? body) as THREE.Object3D;
  const addTo = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const wing = (w: number, chord: number, above: number, z: number, swan = false) => {
    const deck = Math.max(top(0.42, z), top(-0.42, z));
    const h = deck + above;
    addTo(spoiler, new THREE.BoxGeometry(w, 0.03, chord), carbon, 0, h, z, -0.12);
    for (const sx of [1, -1]) {
      addTo(spoiler, new THREE.BoxGeometry(0.02, 0.24, chord + 0.14), carbon, sx * w / 2, h - 0.03, z);
      const foot = top(sx * 0.42, z + 0.04);
      addTo(spoiler, new THREE.BoxGeometry(0.035, h - foot + (swan ? 0.04 : 0), 0.13), black, sx * 0.42, (h + foot) / 2, z + 0.04);
    }
  };
  /** A lip spoiler that follows the tail edge. */
  const ducktail = (height: number, z = -2.1) => {
    const y = top(0, z);
    addTo(spoiler, new THREE.BoxGeometry(1.6, height, 0.05), carbon, 0, y + height / 2 - 0.02, z, -0.5);
  };
  const intakes = (size: number) => {
    for (const sx of [1, -1]) add(new THREE.BoxGeometry(0.06, 0.22 * size, 0.55 * size), black, sx * (1.0 + sh.hips * 0.9), 0.52, -0.62, 0, 0, sx * 0.08);
  };
  const louvres = () => { for (let i = 0; i < 6; i++) { const z = -1.55 - i * 0.12; add(new THREE.BoxGeometry(1.1, 0.015, 0.05), black, 0, top(0, z) + 0.01, z, -0.25); } };
  const hoodVents = (big: boolean) => { for (const sx of [1, -1]) { const z = 1.45; add(new THREE.BoxGeometry(big ? 0.34 : 0.22, 0.02, big ? 0.42 : 0.26), black, sx * 0.34, top(sx * 0.34, z) + 0.005, z, 0.12); } };
  const roofScoop = () => { const z = -0.55 + sh.cab; const y = top(0, z); add(new THREE.BoxGeometry(0.42, 0.14, 0.7), carbon, 0, y + 0.06, z); add(new THREE.BoxGeometry(0.34, 0.09, 0.02), black, 0, y + 0.07, z + 0.36); };
  const quadPipes = () => { for (const x of [-0.55, -0.4, 0.4, 0.55]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 12), chrome, x, 0.22, -2.3, Math.PI / 2); };
  const sidePipes = () => { for (const sx of [1, -1]) add(new THREE.CylinderGeometry(0.055, 0.055, 1.4, 12), chrome, sx * 1.1, 0.2, -0.1, Math.PI / 2); };
  const fin = () => { const z0 = -0.6 + sh.cab, z1 = -2.0; const y0 = top(0, z0), y1 = top(0, z1); const len = Math.hypot(z1 - z0, y1 - y0); add(new THREE.BoxGeometry(0.02, 0.28, len), accent, 0, (y0 + y1) / 2 + 0.13, (z0 + z1) / 2, Math.atan2(y0 - y1, z0 - z1)); };
  const canards = () => { for (const sx of [1, -1]) add(new THREE.BoxGeometry(0.24, 0.016, 0.13), carbon, sx * 0.8, top(sx * 0.8, 2.1) - 0.08, 2.1, 0.25, 0, sx * -0.35); };
  const stripes = () => { for (const sx of [0.16, -0.16]) for (const z of [1.65, 1.25, 0.9]) add(new THREE.BoxGeometry(0.12, 0.012, 0.36), accent, sx, top(sx, z) + 0.006, z, 0.1); };
  const splitter = (scale: number) => { if (parts.splitter) parts.splitter.scale.set(1.02, 1, scale); };
  // maker badge on the tail
  const badgeZ = -2.12;
  const badge = decal(textDecal(BADGES[id] ?? '', null, '#ffffff', 512, 96), 0.5, 0.09);
  badge.position.set(0, top(0, badgeZ) - 0.1, badgeZ - 0.17);
  badge.rotation.y = Math.PI;
  body.add(badge);
  v.decals.push(badge);

  // ---------- per model ----------
  switch (id) {
    case 'stock-valkyr': rims(0x4a4f57, 0.9, 0.3); wing(1.75, 0.3, 0.32, -1.95); intakes(1); hoodVents(false); quadPipes(); splitter(1.4); break;
    case 'stock-corsa': rims(0xd8dade, 1, 0.15); ducktail(0.12); hoodVents(false); quadPipes(); break;
    case 'stock-strada': rims(0xf2b600, 1, 0.25); wing(1.8, 0.32, 0.42, -1.9, true); intakes(1.4); roofScoop(); louvres(); splitter(1.6); break;
    case 'stock-sabre': rims(0xe9eaec, 0.6, 0.3); wing(1.7, 0.36, 0.1, -1.95); intakes(0.7); quadPipes(); break;
    case 'stock-halcyon': rims(0x8a8f96, 0.9, 0.25); ducktail(0.07); intakes(0.6); quadPipes(); break;
    case 'stock-tempest': rims(0xc81e1e, 0.7, 0.3); wing(1.85, 0.34, 0.5, -1.95, true); fin(); canards(); intakes(1.3); roofScoop(); splitter(1.7); break;
    case 'stock-rattler': rims(0x111214, 0.8, 0.35); wing(1.8, 0.32, 0.36, -1.95); hoodVents(true); sidePipes(); stripes(); intakes(1); splitter(1.5); break;
    case 'stock-nordlys': rims(0xf4f4f5, 0.3, 0.4); ducktail(0.05); break;
  }
}

const BADGES: Record<string, string> = {
  'stock-valkyr': 'VALKYR', 'stock-corsa': 'CORSA', 'stock-strada': 'STRADA', 'stock-sabre': 'SABRE',
  'stock-halcyon': 'HALCYON', 'stock-tempest': 'TEMPEST', 'stock-rattler': 'RATTLER', 'stock-nordlys': 'NORDLYS',
};

function decal(tex: THREE.Texture, w: number, h: number) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
}
