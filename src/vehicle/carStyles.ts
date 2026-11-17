import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarVisual } from './carModel';
import { contrast, decalPlane, textDecal } from './carModel';
import type { CarSpec } from './catalog';
import { isSupercar, styleSupercar } from './superStyles';

/**
 * Per-model body details, so the six cars are easy to tell apart on track:
 *  - Vanguard SR (balanced stock car): the clean baseline body.
 *  - Ironhide 427 (torque): muscle-car look — power-bulge hood with a scoop in a contrast colour,
 *    chrome grille bars and side pipes, a tall rear spoiler.
 *  - Stiletto Aero: low and sleek — a lower roofline, nose canards, long splitter, NACA ducts,
 *    a small ducktail spoiler and diffuser fins.
 *  - Apex GP-1 (balanced open-wheeler): baseline.
 *  - Titan HD-7 (high downforce): big multi-element wings, a beam wing, a T-wing and bargeboards.
 *  - Falcon LD-3 (low drag): long slim nose, a thin low-angle rear wing, single-element front wing
 *    and a tall shark fin.
 * Every car also wears its maker's badge.
 */
export function applyCarStyle(v: CarVisual, spec: CarSpec, number = 0) {
  const accentColor = contrast(v.primary) === '#111111' ? '#1b1b1b' : '#f2f2f2';
  const accent = new THREE.MeshPhysicalMaterial({ color: accentColor, metalness: 0.3, roughness: 0.35, clearcoat: 1 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.15 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.35, metalness: 0.45 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.6, metalness: 0.2 });
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const badge = (text: string, w: number, h: number, x: number, y: number, z: number, ry: number, rx = 0) => {
    const d = decalPlane(w, h, textDecal(text.toUpperCase(), null, accentColor === '#f2f2f2' ? '#ffffff' : '#111111', 512, 96));
    d.position.set(x, y, z);
    d.rotation.set(rx, ry, 0, 'YXZ');
    v.body.add(d);
    v.decals.push(d);
  };
  const { body, parts } = v;
  /** Rim colour per model: the quickest way to tell cars apart from the chase camera. */
  const rims = (color: number, metal = 1, rough = 0.2) => {
    const mat = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
    for (const w of v.wheels) w.traverse((o) => {
      const m = o as THREE.Mesh;
      const mm = m.material as THREE.MeshStandardMaterial | undefined;
      if (m.isMesh && mm && mm.metalness >= 0.8 && mm.color?.getHex() === RIM_HEX) m.material = mat;
    });
  };

  if (spec.body === 'stock') {
    badge(spec.maker, 0.62, 0.12, 0, 0.93, -2.665, Math.PI, 0.25);
    badge(spec.maker, 0.5, 0.1, 0, 0.47, 2.69, 0, -0.35);

    if (spec.series === 'drift') {
      styleDrift(v, spec.id, { add, rims, accent, carbon, black, chrome });
      return;
    }
    if (isSupercar(spec.id)) {
      styleSupercar(v, spec.id, { accent, carbon, black, chrome, rims }, number);
      return;
    }

    if (spec.id === 'stock-torque') {
      // chunky: wider and taller body, chrome rims
      body.scale.set(1.05, 1.06, 1);
      rims(0xdadde2, 1, 0.12);
      // power-bulge hood with a scoop (rides on the hood panel, so it flies off with it)
      const hood = parts.hood as THREE.Mesh | undefined;
      if (hood) {
        hood.material = accent;
        add(hood, new RoundedBoxGeometry(0.76, 0.2, 0.95, 2, 0.06), accent, 0, 0.09, -0.02);
        add(hood, new THREE.BoxGeometry(0.5, 0.15, 0.05), black, 0, 0.13, 0.47);
      }
      // chrome grille bars and a black front fascia
      for (let k = 0; k < 3; k++) add(body, new THREE.BoxGeometry(1.25, 0.018, 0.02), chrome, 0, 0.29 + k * 0.045, 2.7 - k * 0.008, 0.2);
      if (parts.bumperF) (parts.bumperF as THREE.Mesh).material = black;
      // side pipes under the doors
      for (const sx of [1, -1]) {
        add(body, new THREE.CylinderGeometry(0.055, 0.055, 1.5, 12), chrome, sx * 1.1, 0.2, -0.1, Math.PI / 2);
        add(body, new THREE.CylinderGeometry(0.06, 0.06, 0.03, 12), black, sx * 1.1, 0.2, -0.86, Math.PI / 2);
      }
      // tall rear spoiler
      if (parts.spoiler) parts.spoiler.scale.set(1, 1.7, 1.2);
    }

    if (spec.id === 'stock-aero') {
      // low and long: lower roofline and body, gold rims
      lowerGreenhouse(v, 0.84, 0.8);
      body.scale.set(0.98, 0.93, 1.03);
      rims(0xd4a640, 1, 0.25);
      // long splitter, nose canards, NACA ducts, ducktail, diffuser fins
      if (parts.splitter) { parts.splitter.scale.set(1.05, 1, 1.7); parts.splitter.position.z += 0.14; }
      for (const sx of [1, -1]) {
        add(body, new THREE.BoxGeometry(0.28, 0.018, 0.16), carbon, sx * 0.86, 0.42, 2.5, 0.25, 0, sx * -0.35);
        add(body, new THREE.BoxGeometry(0.22, 0.018, 0.12), carbon, sx * 0.9, 0.53, 2.42, 0.3, 0, sx * -0.35);
        add(body, new THREE.BoxGeometry(0.12, 0.012, 0.32), black, sx * 0.32, 0.935, 1.2, 0.1);
      }
      if (parts.spoiler) parts.spoiler.scale.set(1, 0.55, 0.8);
      for (let k = -2; k <= 2; k++) add(body, new THREE.BoxGeometry(0.02, 0.14, 0.4), carbon, k * 0.3, 0.13, -2.45, -0.25);
    }
    return;
  }

  // ---------- open-wheelers ----------
  for (const sx of [1, -1]) badge(spec.maker, 0.42, 0.08, sx * 0.215, 0.3, 1.35, sx * Math.PI / 2);

  if (spec.id === 'gp-downforce') {
    rims(0xdadde2, 1, 0.12);
    const rw = parts.spoiler;
    if (rw) {
      rw.scale.set(1, 1.15, 1.35);
      rw.position.z += 0.8; // scaling about the car's origin pushed it back; pull it in again
      // (children of the scaled group: local = (world - offset) / scale)
      add(rw, new THREE.BoxGeometry(1.0, 0.025, 0.16), carbon, 0, 1.03 / 1.15, (-2.47 - 0.8) / 1.35, 0.7); // extra flap
      add(rw, new THREE.BoxGeometry(0.86, 0.025, 0.2), carbon, 0, 0.42 / 1.15, (-2.2 - 0.8) / 1.35, 0.2); // beam wing
    }
    const fw = parts.splitter;
    if (fw) add(fw, new THREE.BoxGeometry(1.6, 0.02, 0.12), carbon, 0, 0.22, 2.3, 0.6);
    add(body, new THREE.BoxGeometry(0.5, 0.02, 0.1), carbon, 0, 0.98, -1.85, 0.15); // T-wing
    for (const sx of [1, -1]) {
      add(body, new THREE.BoxGeometry(0.015, 0.26, 0.5), carbon, sx * 0.48, 0.24, 0.78, 0, sx * 0.12);
      add(body, new THREE.BoxGeometry(0.015, 0.18, 0.35), carbon, sx * 0.62, 0.2, 0.62, 0, sx * 0.2);
    }
  }

  if (spec.id === 'gp-lowdrag') {
    rims(0xd4a640, 1, 0.25);
    const nose = parts.bumperF;
    if (nose) { nose.scale.set(0.85, 0.9, 1.18); nose.position.z += 0.12; }
    const rw = parts.spoiler;
    if (rw) {
      rw.scale.set(1, 0.85, 0.65);
      rw.position.y += 0.1;
      rw.position.z -= 0.8;
      for (const c of rw.children) if (c.name !== 'drsFlap' && Math.abs(c.rotation.x) > 0.05) c.rotation.x *= 0.4;
    }
    const fw = parts.splitter;
    if (fw && fw.children[2]) fw.children[2].visible = false; // single-element front wing
    add(body, new THREE.BoxGeometry(0.012, 0.36, 1.3), accent, 0, 0.92, -1.45); // tall shark fin
  }
}

const RIM_HEX = 0x1a1c20;

/** Squash the cabin (everything above the beltline) for a lower roofline. */
function lowerGreenhouse(v: CarVisual, pivotY: number, k: number) {
  v.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const c of [...v.body.children]) {
    box.setFromObject(c);
    if (box.isEmpty() || box.min.y < pivotY - 0.02) continue;
    const cz = (box.min.z + box.max.z) / 2;
    if (cz > 1.1 || cz < -2.1) continue; // hood and spoiler stay where they are
    c.position.y = pivotY + (c.position.y - pivotY) * k;
    // unrotated pieces are squashed too; tilted ones (pillars, decals) only move down
    if (c.rotation.x === 0 && c.rotation.y === 0 && c.rotation.z === 0) c.scale.y *= k;
  }
}

type Kit = {
  add: (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number) => THREE.Mesh;
  rims: (color: number, metal?: number, rough?: number) => void;
  accent: THREE.Material; carbon: THREE.Material; black: THREE.Material; chrome: THREE.Material;
};

/**
 * Drift cars: a street-coupe look on the stock body — lower stance, no NASCAR blade spoiler but
 * a proper wing, front lip, tow hook, coloured rims; each model with its own signature parts.
 */
function styleDrift(v: CarVisual, id: string, k: Kit) {
  const { body, parts } = v;
  const { add, rims, accent, carbon, black } = k;
  // NASCAR-only bits off: blade spoiler, roof flaps, window net
  if (parts.spoiler) parts.spoiler.visible = false;
  for (const f of v.flaps) f.visible = false;
  body.children.forEach((c) => { const m = c as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshBasicMaterial).wireframe) m.visible = false; });
  // common: front lip and a red tow hook
  add(body, new THREE.BoxGeometry(1.8, 0.03, 0.22), carbon, 0, 0.11, 2.62);
  add(body, new THREE.TorusGeometry(0.07, 0.018, 6, 12), new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.4 }), 0.55, 0.26, 2.72, 0, Math.PI / 2);
  /** A wing on two struts at the rear deck. */
  const wing = (w: number, chord: number, h: number, z: number, swan: boolean) => {
    const g = new THREE.Group();
    add(g, new THREE.BoxGeometry(w, 0.03, chord), carbon, 0, h, z, -0.12);
    for (const sx of [1, -1]) {
      add(g, new THREE.BoxGeometry(0.02, 0.22, chord + 0.12), carbon, sx * w / 2, h - 0.02, z);
      // struts: swan-neck (from above) or classic (from below)
      add(g, new THREE.BoxGeometry(0.03, h - 0.98, 0.12), black, sx * 0.42, swan ? (h + 0.98) / 2 + 0.03 : (h + 0.98) / 2, z + 0.05);
    }
    body.add(g);
    return g;
  };
  if (id === 'drift-ronin') {
    body.scale.set(1, 0.96, 1);
    rims(0xb8862f, 1, 0.3); // bronze
    wing(1.6, 0.26, 1.24, -2.35, false);
    for (const sx of [1, -1]) add(body, new THREE.BoxGeometry(0.28, 0.015, 0.12), black, sx * 0.4, 0.935, 1.5, 0.1); // hood vents
  }
  if (id === 'drift-kaze') {
    body.scale.set(0.98, 0.93, 1);
    rims(0xf2f2f2, 0.6, 0.3); // white
    wing(1.75, 0.32, 1.42, -2.3, true);
    for (const sx of [1, -1]) add(body, new THREE.BoxGeometry(0.26, 0.016, 0.14), carbon, sx * 0.86, 0.45, 2.48, 0.25, 0, sx * -0.35); // canards
    add(body, new THREE.BoxGeometry(0.9, 0.012, 0.5), accent, 0, 0.94, 1.35, 0.1); // contrast hood panel
  }
  if (id === 'drift-brute') {
    body.scale.set(1.06, 0.98, 1);
    rims(0x18181b, 0.7, 0.35); // black
    wing(1.7, 0.28, 1.3, -2.35, false);
    // wide fender flares
    for (const sx of [1, -1]) for (const z of [1.45, -1.35]) add(body, new THREE.BoxGeometry(0.12, 0.16, 1.0), black, sx * 1.03, 0.55, z);
    // hood bulge and twin big exhausts
    const hood = parts.hood;
    if (hood) add(hood, new THREE.BoxGeometry(0.6, 0.14, 0.8), accent, 0, 0.07, 0);
    for (const sx of [0.35, 0.6]) add(body, new THREE.CylinderGeometry(0.075, 0.075, 0.3, 12), k.chrome, -sx, 0.24, -2.66, Math.PI / 2);
  }
}
