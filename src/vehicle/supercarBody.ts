import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { WHEELBASE_F, WHEELBASE_R, contrast, decalPlane, numberDecal, type CarVisual } from './carModel';

/**
 * Own bodies for the sports cars and supercars: each model is built from its own side profile
 * (nose, bonnet, windscreen, roof line, tail), plan-view shape (width, nose/tail taper, rear
 * haunches), cabin, lights and livery pattern, so no two look alike. The stock car's wheels,
 * brakes and damage hooks are kept; the body is replaced.
 */
export interface BodyProfile {
  /** Lower body outline (z, y) from the front bottom corner, over the top, to the rear bottom corner. */
  top: [number, number][];
  /** Cabin outline (z, y): windscreen base, roof front, roof rear, rear end of the cabin. */
  cab: [number, number][];
  /** Half width (m), plan-view nose / tail taper, cabin tumblehome, rear-haunch bulge. */
  hw: number; noseTaper: number; tailTaper: number; tumble: number; hips: number;
  /** Painted roof panel over the glass (false = glass canopy roof). */
  roof: boolean;
  /** Painted engine cover behind the roof (mid-engined cars) instead of a glass fastback. */
  engineCover: boolean;
  front: 'strip' | 'slit' | 'pair' | 'round';
  rear: 'bar' | 'quad' | 'pair' | 'slim';
  livery: 'stripe' | 'sweep' | 'arrow' | 'twotone' | 'gradient' | 'band' | 'twin' | 'circuit';
}

export const BODY_PROFILES: Record<string, BodyProfile> = {
  // Supercar proportions: short overhangs (nose / tail ~0.9 m past the wheels), low ground
  // clearance, roofs 1.05-1.25 m, wide bodies. Outlines are splines through these points.

  // front-engined GT coupe: muscular, upright glasshouse, four round tail lights
  'stock-valkyr': {
    top: [[2.3, 0.17], [2.36, 0.33], [2.2, 0.58], [1.7, 0.69], [0.95, 0.8], [-1.2, 0.92], [-1.95, 0.96], [-2.2, 0.88], [-2.26, 0.5], [-2.22, 0.18]],
    cab: [[0.95, 0.8], [0.0, 1.24], [-0.95, 1.25], [-1.55, 0.94]],
    hw: 0.97, noseTaper: 0.06, tailTaper: 0.04, tumble: 0.12, hips: 0.06, roof: true, engineCover: false,
    front: 'pair', rear: 'quad', livery: 'stripe',
  },
  // front-mid V12 GT: very long bonnet, cabin far back, long glass fastback
  'stock-corsa': {
    top: [[2.32, 0.18], [2.38, 0.33], [2.22, 0.51], [1.5, 0.66], [0.35, 0.78], [-1.5, 0.88], [-2.0, 0.9], [-2.22, 0.82], [-2.26, 0.46], [-2.22, 0.18]],
    cab: [[0.35, 0.78], [-0.45, 1.13], [-1.0, 1.14], [-2.0, 0.9]],
    hw: 0.95, noseTaper: 0.16, tailTaper: 0.08, tumble: 0.18, hips: 0.08, roof: true, engineCover: false,
    front: 'slit', rear: 'pair', livery: 'sweep',
  },
  // mid-engined wedge: knife nose, cab-forward, long flat engine cover
  'stock-strada': {
    top: [[2.34, 0.13], [2.4, 0.23], [1.9, 0.43], [1.25, 0.6], [-0.95, 0.84], [-2.05, 0.86], [-2.22, 0.78], [-2.26, 0.42], [-2.2, 0.16]],
    cab: [[1.25, 0.6], [0.2, 1.07], [-0.7, 1.08], [-2.0, 0.86]],
    hw: 1.0, noseTaper: 0.2, tailTaper: 0.02, tumble: 0.22, hips: 0.1, roof: true, engineCover: true,
    front: 'slit', rear: 'bar', livery: 'arrow',
  },
  // rear-engined coupe: short low bonnet, round lamps, roof flowing down to the tail
  'stock-sabre': {
    top: [[2.28, 0.18], [2.34, 0.33], [2.18, 0.5], [1.8, 0.58], [1.05, 0.72], [-1.2, 0.84], [-1.95, 0.78], [-2.18, 0.64], [-2.22, 0.4], [-2.18, 0.18]],
    cab: [[1.05, 0.72], [0.25, 1.18], [-0.45, 1.2], [-2.0, 0.8]],
    hw: 0.92, noseTaper: 0.1, tailTaper: 0.12, tumble: 0.24, hips: 0.14, roof: true, engineCover: false,
    front: 'round', rear: 'bar', livery: 'twotone',
  },
  // grand tourer: long, smooth, rising waistline
  'stock-halcyon': {
    top: [[2.32, 0.18], [2.38, 0.35], [2.18, 0.57], [1.4, 0.71], [0.65, 0.8], [-1.15, 0.88], [-2.0, 0.9], [-2.22, 0.82], [-2.26, 0.48], [-2.22, 0.18]],
    cab: [[0.65, 0.8], [-0.15, 1.16], [-0.95, 1.17], [-1.85, 0.91]],
    hw: 0.95, noseTaper: 0.13, tailTaper: 0.1, tumble: 0.16, hips: 0.06, roof: true, engineCover: false,
    front: 'pair', rear: 'slim', livery: 'gradient',
  },
  // hypercar: very low, narrow bubble canopy, long tail
  'stock-tempest': {
    top: [[2.36, 0.12], [2.42, 0.21], [2.0, 0.33], [1.5, 0.47], [0.95, 0.6], [-0.9, 0.74], [-2.1, 0.72], [-2.32, 0.62], [-2.36, 0.32], [-2.28, 0.15]],
    cab: [[0.95, 0.6], [0.3, 1.03], [-0.5, 1.05], [-1.7, 0.76]],
    hw: 1.0, noseTaper: 0.22, tailTaper: 0.06, tumble: 0.36, hips: 0.14, roof: false, engineCover: true,
    front: 'strip', rear: 'bar', livery: 'band',
  },
  // American front-mid supercar: long nose, short deck, double-bubble roof
  'stock-rattler': {
    top: [[2.32, 0.19], [2.4, 0.37], [2.22, 0.61], [1.3, 0.77], [0.25, 0.84], [-1.25, 0.9], [-2.05, 0.93], [-2.22, 0.84], [-2.26, 0.48], [-2.22, 0.18]],
    cab: [[0.25, 0.84], [-0.5, 1.18], [-1.1, 1.19], [-1.7, 0.93]],
    hw: 0.98, noseTaper: 0.12, tailTaper: 0.04, tumble: 0.14, hips: 0.1, roof: true, engineCover: false,
    front: 'pair', rear: 'bar', livery: 'twin',
  },
  // electric GT: smooth and flush, glass roof running nose to tail
  'stock-nordlys': {
    top: [[2.3, 0.18], [2.36, 0.33], [2.14, 0.5], [1.6, 0.64], [1.1, 0.74], [-1.4, 0.84], [-2.05, 0.83], [-2.2, 0.72], [-2.24, 0.44], [-2.2, 0.18]],
    cab: [[1.1, 0.74], [0.2, 1.13], [-1.0, 1.13], [-2.0, 0.84]],
    hw: 0.96, noseTaper: 0.14, tailTaper: 0.1, tumble: 0.14, hips: 0.06, roof: false, engineCover: false,
    front: 'strip', rear: 'bar', livery: 'circuit',
  },
};

/** y of a polyline (z, y), sorted along z either way, at z. */
function yAt(line: [number, number][], z: number) {
  const pts = [...line].sort((a, b) => b[0] - a[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [z0, y0] = pts[i], [z1, y1] = pts[i + 1];
    if (z <= z0 && z >= z1) return y0 + ((y1 - y0) * (z - z0)) / (z1 - z0 || 1);
  }
  return z > pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
}

function livery(style: BodyProfile['livery'], primary: string): THREE.CanvasTexture {
  // u: rear → front over 5.6 m, v: ground → 1.25 m
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d')!;
  const second = contrast(primary) === '#111111' ? '#1a1a1a' : '#f2f2f2';
  g.fillStyle = primary; g.fillRect(0, 0, 1024, 256);
  g.fillStyle = second;
  switch (style) {
    case 'stripe': g.fillRect(0, 118, 1024, 12); break; // one thin side stripe
    case 'sweep': g.beginPath(); g.moveTo(1024, 150); g.bezierCurveTo(700, 100, 420, 220, 120, 160); g.lineTo(120, 185); g.bezierCurveTo(420, 245, 700, 130, 1024, 175); g.fill(); break; // sweeping cove
    case 'arrow': g.beginPath(); g.moveTo(1024, 120); g.lineTo(560, 70); g.lineTo(560, 100); g.lineTo(160, 100); g.lineTo(160, 150); g.lineTo(560, 150); g.lineTo(560, 180); g.fill(); break; // big arrow
    case 'twotone': g.fillStyle = '#16171a'; g.fillRect(0, 150, 1024, 106); g.fillStyle = second; g.fillRect(0, 146, 1024, 5); break;
    case 'gradient': { const gr = g.createLinearGradient(0, 60, 0, 256); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.7)'); g.fillStyle = gr; g.fillRect(0, 0, 1024, 256); break; }
    case 'band': g.fillRect(0, 96, 1024, 46); g.fillStyle = primary; g.fillRect(0, 108, 1024, 22); break; // hollow band
    case 'twin': g.fillRect(0, 100, 1024, 26); g.fillRect(0, 140, 1024, 26); break; // two thick stripes
    case 'circuit': g.strokeStyle = second; g.lineWidth = 6; g.beginPath(); for (let x = 60; x < 1000; x += 120) { g.moveTo(x, 200); g.lineTo(x + 40, 160); g.lineTo(x + 110, 160); } g.stroke(); break;
  }
  // dark rocker shading
  const r = g.createLinearGradient(0, 256, 0, 205);
  r.addColorStop(0, 'rgba(0,0,0,0.6)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 205, 1024, 51);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Replace the stock body with the profile's own body. Returns the deck-height probe material set. */
export function rebody(v: CarVisual, prof: BodyProfile, number: number) {
  const body = v.body;
  // keep nothing of the stock shell (wheels live on the root and stay)
  for (const c of [...body.children]) body.remove(c);
  const parts = v.parts;
  for (const k of ['spoiler', 'splitter', 'skirtL', 'skirtR', 'bumperF', 'bumperR', 'hood'] as const) delete parts[k];

  const paint = v.paintMats[0];
  const liveryMat = paint.clone();
  liveryMat.color.set(0xffffff);
  liveryMat.map = livery(prof.livery, v.primary);
  liveryMat.map.repeat.set(1 / 5.6, 1 / 1.25);
  liveryMat.map.offset.set(2.8 / 5.6, 0);
  const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.55, metalness: 0.2 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.35, metalness: 0.4 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1118, roughness: 0.02, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.5, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const smooth = THREE.MathUtils.smoothstep;
  const extrude = (shape: THREE.Shape, depth: number, bevel: number) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 4, curveSegments: 8 });
    geo.translate(0, 0, -depth / 2);
    geo.rotateY(-Math.PI / 2);
    return geo;
  };
  const planView = (g: THREE.BufferGeometry, cabin: boolean) => {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      let k = (1 - prof.noseTaper * smooth(z, 1.6, 2.8) - prof.tailTaper * smooth(-z, 1.9, 2.8));
      k *= 1 + prof.hips * Math.exp(-(((z + 1.35) / 0.75) ** 2)) * smooth(y, 0.3, 0.6) * (cabin ? 0 : 1);
      if (cabin) k *= 1 - prof.tumble * THREE.MathUtils.clamp((y - prof.cab[0][1]) / 0.45, 0, 1);
      p.setX(i, x * k);
    }
    g.computeVertexNormals();
  };

  // ---------- lower body: side profile with wheel arches ----------
  const s = new THREE.Shape();
  const arch = (cz: number) => {
    const r = 0.41, cy = 0.34;
    s.lineTo(cz - r, 0.13);
    for (let k = 0; k <= 14; k++) { const a = Math.PI - (k / 14) * Math.PI; s.lineTo(cz + Math.cos(a) * r, cy + Math.sin(a) * r); }
    s.lineTo(cz + r, 0.13);
  };
  const last = prof.top[prof.top.length - 1];
  s.moveTo(last[0], last[1]);
  arch(WHEELBASE_R);
  arch(WHEELBASE_F);
  const T = prof.top;
  s.lineTo(T[0][0], T[0][1]);
  s.lineTo(T[1][0], T[1][1]);
  s.splineThru(T.slice(2, T.length - 2).map(([z, y]) => new THREE.Vector2(z, y)));
  s.lineTo(T[T.length - 2][0], T[T.length - 2][1]);
  s.lineTo(T[T.length - 1][0], T[T.length - 1][1]);
  s.closePath();
  const shellGeo = extrude(s, prof.hw * 2 - 0.12, 0.07);
  planView(shellGeo, false);
  const shell = new THREE.Mesh(shellGeo, [liveryMat, paint]);
  shell.castShadow = shell.receiveShadow = true;
  body.add(shell);

  // ---------- cabin: glass, painted roof, engine cover ----------
  const cs = new THREE.Shape();
  const cab = prof.cab;
  const belt = cab[0][1];
  cs.moveTo(cab[0][0], belt - 0.05);
  cs.lineTo(cab[0][0], cab[0][1]);
  cs.splineThru(cab.slice(1).map(([z, y]) => new THREE.Vector2(z, y)));
  cs.lineTo(cab[cab.length - 1][0], yAt(prof.top, cab[cab.length - 1][0]) - 0.05);
  cs.closePath();
  const cabW = prof.hw * 2 * 0.78;
  const cabGeo = extrude(cs, cabW, 0.05);
  planView(cabGeo, true);
  const cabMesh = new THREE.Mesh(cabGeo, glass);
  body.add(cabMesh);
  const meshes: THREE.Mesh[] = [shell, cabMesh];
  const [rf, rr] = [cab[1], cab[2]];
  if (prof.roof) {
    const rs = new THREE.Shape();
    rs.moveTo(rf[0] + 0.05, rf[1] - 0.06); rs.lineTo(rf[0] + 0.03, rf[1] + 0.012); rs.lineTo(rr[0] - 0.03, rr[1] + 0.012); rs.lineTo(rr[0] - 0.05, rr[1] - 0.06); rs.closePath();
    const roofGeo = extrude(rs, cabW * (1 - prof.tumble) + 0.04, 0.025);
    const roof = new THREE.Mesh(roofGeo, paint);
    roof.castShadow = true;
    body.add(roof);
    meshes.push(roof);
  }
  if (prof.engineCover) {
    const es = new THREE.Shape();
    const endZ = cab[cab.length - 1][0];
    es.moveTo(rr[0] - 0.02, rr[1] - 0.05); es.lineTo(rr[0] - 0.02, rr[1] + 0.012); es.lineTo(endZ, cab[cab.length - 1][1] + 0.015); es.lineTo(endZ, yAt(prof.top, endZ) - 0.04); es.closePath();
    const cover = new THREE.Mesh(extrude(es, cabW * 0.92, 0.03), paint);
    planView(cover.geometry, true);
    cover.castShadow = true;
    body.add(cover);
  }

  // ---------- bonnet (detachable, crumples) ----------
  const hz0 = Math.min(2.2, prof.top[2][0] - 0.25), hz1 = cab[0][0] + 0.12;
  const hy0 = yAt(prof.top, hz0), hy1 = yAt(prof.top, hz1);
  const hoodLen = Math.hypot(hz0 - hz1, hy0 - hy1);
  const hood = new THREE.Mesh(new RoundedBoxGeometry(prof.hw * 1.45, 0.03, hoodLen, 2, 0.012), paint);
  hood.position.set(0, (hy0 + hy1) / 2 + 0.035, (hz0 + hz1) / 2);
  hood.rotation.x = Math.atan2(hy1 - hy0, hz0 - hz1);
  hood.castShadow = true;
  body.add(hood);
  parts.hood = hood;

  // ---------- bolt-on parts ----------
  const fz = prof.top[0][0], rz = last[0];
  const nose = new THREE.Mesh(new RoundedBoxGeometry(prof.hw * 1.7, 0.16, 0.16, 2, 0.05), paint);
  nose.position.set(0, 0.25, fz + 0.04);
  body.add(nose);
  parts.bumperF = nose;
  const valance = new THREE.Mesh(new RoundedBoxGeometry(prof.hw * 1.75, 0.2, 0.14, 2, 0.05), black);
  valance.position.set(0, 0.28, rz - 0.06);
  body.add(valance);
  parts.bumperR = valance;
  const split = new THREE.Mesh(new THREE.BoxGeometry(prof.hw * 1.85, 0.035, 0.4), carbon);
  split.position.set(0, 0.11, fz - 0.12);
  body.add(split);
  parts.splitter = split;
  for (const sx of [1, -1]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 1.75), carbon);
    sk.position.set(sx * (prof.hw + 0.06), 0.17, 0.05);
    body.add(sk);
    parts[sx > 0 ? 'skirtL' : 'skirtR'] = sk;
  }
  const spoiler = new THREE.Group();
  body.add(spoiler);
  parts.spoiler = spoiler;

  // ---------- lights ----------
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 1.2 });
  const [p1, p2] = [prof.top[1], prof.top[2]];
  const slope = Math.atan2(p1[1] - p2[1], p1[0] - p2[0]);
  const hzL = p1[0] - 0.12, hyL = yAt(prof.top, hzL) + 0.012;
  const addHead = (geo: THREE.BufferGeometry, x: number) => {
    const m = new THREE.Mesh(geo, head);
    m.position.set(x, hyL, hzL);
    m.rotation.x = -slope;
    body.add(m);
  };
  const lampX = prof.hw * (1 - prof.noseTaper) * 0.72;
  if (prof.front === 'strip') addHead(new THREE.BoxGeometry(prof.hw * 1.6, 0.02, 0.04), 0);
  else if (prof.front === 'slit') for (const sx of [1, -1]) addHead(new THREE.BoxGeometry(0.42, 0.02, 0.05), sx * lampX);
  else if (prof.front === 'pair') for (const sx of [1, -1]) addHead(new THREE.BoxGeometry(0.36, 0.03, 0.14), sx * lampX);
  else for (const sx of [1, -1]) addHead(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 18), sx * lampX);
  const tailY = yAt(prof.top, rz + 0.1) - 0.16;
  const addTail = (geo: THREE.BufferGeometry, x: number, y = tailY) => {
    const m = new THREE.Mesh(geo, v.taillights);
    m.position.set(x, y, rz - 0.075);
    if (geo.type === 'CylinderGeometry') m.rotation.x = Math.PI / 2;
    body.add(m);
  };
  const tx = prof.hw * (1 - prof.tailTaper) * 0.7;
  if (prof.rear === 'bar') addTail(new THREE.BoxGeometry(prof.hw * 1.7, 0.05, 0.02), 0);
  else if (prof.rear === 'quad') for (const sx of [1, -1]) for (const dx of [0, 0.24]) addTail(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 16), sx * (tx - dx));
  else if (prof.rear === 'pair') for (const sx of [1, -1]) addTail(new THREE.BoxGeometry(0.42, 0.09, 0.02), sx * tx);
  else for (const sx of [1, -1]) addTail(new THREE.BoxGeometry(0.6, 0.035, 0.02), sx * (tx - 0.1));

  // ---------- numbers ----------
  const beltDoor = Math.min(yAt(prof.top, -0.2), belt + 0.05);
  const numH = Math.max(0.36, (beltDoor - 0.24) * 0.85);
  const numFill = contrast(v.primary) === '#111111' ? '#111' : '#fff';
  const doorTex = numberDecal(number, numFill, numFill === '#111' ? '#ffffff' : '#111111', '');
  for (const sx of [1, -1]) {
    const d = decalPlane(numH * 1.2, numH, doorTex);
    d.rotation.y = sx * Math.PI / 2;
    d.position.set(sx * (prof.hw + 0.012), 0.2 + (beltDoor - 0.2) * 0.52, -0.25);
    body.add(d);
    v.decals.push(d);
  }

  // ---------- simple interior ----------
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), new THREE.MeshPhysicalMaterial({ color: v.primary, clearcoat: 1, roughness: 0.2 }));
  helmet.position.set(0.3, Math.min(rf[1], rr[1]) - 0.2, (rf[0] + rr[0]) / 2);
  body.add(helmet);

  // contract bits: no roof flaps, a hidden wiper, the glass list, what crumples
  v.flaps.length = 0;
  const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.015, 0.025), black);
  wiper.visible = false;
  body.add(wiper);
  v.wiper = wiper;
  v.glass = [cabMesh];
  v.decals = v.decals.filter((d) => d.parent === body);
  v.deformables = [...meshes, hood, nose];
  v.paintMats = [paint, liveryMat];
  v.engineBay = new THREE.Vector3(0, yAt(prof.top, 1.6), 1.6);
}
