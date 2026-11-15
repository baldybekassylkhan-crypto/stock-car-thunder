import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Procedural stock car. Local frame: +Z forward, +X left, +Y up, origin on the ground
 * at the car's center. (The physics body origin is the center of mass; see CAR_COM_HEIGHT.)
 */
export const CAR_COM_HEIGHT = 0.45;
export const WHEELBASE_F = 1.45;
export const WHEELBASE_R = -1.35;
export const TRACK_HALF = 0.79;
export const WHEEL_RADIUS = 0.34;

const SPONSORS = ['DUNEBLAZE', 'KESTREL OIL', 'RIDGEBACK', 'QUORRA', 'HOLLOWPEAK', 'SOLANO', 'VANTIX', 'ORBITAL CAFE', 'MAKO TOOLS', 'TRIDENT'];

export type PartName = 'spoiler' | 'splitter' | 'skirtL' | 'skirtR' | 'bumperF' | 'bumperR' | 'hood' | 'wheel0' | 'wheel1' | 'wheel2' | 'wheel3';
export const PART_NAMES: PartName[] = ['spoiler', 'splitter', 'skirtL', 'skirtR', 'bumperF', 'bumperR', 'hood', 'wheel0', 'wheel1', 'wheel2', 'wheel3'];

export interface CarVisual {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[]; // FL, FR, RL, RR
  brakeDiscs: THREE.MeshStandardMaterial[];
  taillights: THREE.MeshStandardMaterial;
  /** Detachable pieces (children of body/root until they come off). */
  parts: Partial<Record<PartName, THREE.Object3D>>;
  /** Meshes that crumple on impact. */
  deformables: THREE.Mesh[];
  paintMats: THREE.MeshPhysicalMaterial[];
  decals: THREE.Object3D[];
  glass: THREE.Object3D[];
  flaps: THREE.Object3D[];
  wiper: THREE.Object3D;
  primary: string;
}

function liveryTexture(primary: string, secondary: string, pattern: number): THREE.CanvasTexture {
  // u spans car length (rear → front), v spans height (ground → 1.2 m)
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = secondary;
  if (pattern === 0) {
    // diagonal sweep
    ctx.beginPath(); ctx.moveTo(380, 256); ctx.lineTo(560, 256); ctx.lineTo(820, 0); ctx.lineTo(640, 0); ctx.fill();
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(590, 256); ctx.lineTo(620, 256); ctx.lineTo(880, 0); ctx.lineTo(850, 0); ctx.fill();
  } else if (pattern === 1) {
    // lower band with flame-like tips
    ctx.beginPath(); ctx.moveTo(0, 256); ctx.lineTo(0, 150);
    for (let x = 0; x <= 1024; x += 64) ctx.lineTo(x, 150 - ((x / 64) % 2 ? 40 : 0) * (x / 1024));
    ctx.lineTo(1024, 256); ctx.fill();
  } else {
    // twin stripes along the side
    ctx.fillRect(0, 120, 1024, 18);
    ctx.fillRect(0, 148, 1024, 8);
  }
  ctx.globalAlpha = 1;
  // rocker panel shading
  const g = ctx.createLinearGradient(0, 256, 0, 200);
  g.addColorStop(0, 'rgba(0,0,0,0.65)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 200, 1024, 56);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function numberDecal(num: number, fill: string, outline: string, sponsor: string, width = 512, height = 420): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `italic 900 ${Math.round(height * 0.72)}px "Barlow Condensed", Impact, sans-serif`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 26;
  ctx.strokeStyle = '#000';
  ctx.strokeText(String(num), width / 2, height * 0.43);
  ctx.lineWidth = 14;
  ctx.strokeStyle = outline;
  ctx.strokeText(String(num), width / 2, height * 0.43);
  ctx.fillStyle = fill;
  ctx.fillText(String(num), width / 2, height * 0.43);
  if (sponsor) {
    ctx.font = `italic 800 ${Math.round(height * 0.13)}px "Barlow Condensed", Impact, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 6;
    ctx.strokeText(sponsor, width / 2, height * 0.9);
    ctx.fillText(sponsor, width / 2, height * 0.9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textDecal(text: string, bg: string | null, fg: string, w = 1024, h = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `italic 900 ${Math.round(h * 0.62)}px "Barlow Condensed", Impact, sans-serif`;
  ctx.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function contrast(hex: string) {
  const c = new THREE.Color(hex);
  return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.55 ? '#111111' : '#ffffff';
}

function decalPlane(w: number, h: number, map: THREE.Texture, transparent = true) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshPhysicalMaterial({ map, transparent, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false }),
  );
}

export function buildCarModel(opts: { number: number; color: string; seed: number }): CarVisual {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const primary = opts.color;
  const secondary = contrast(primary) === '#111111' ? '#1b1b1b' : '#f5f5f5';
  const sponsor = SPONSORS[opts.seed % SPONSORS.length];

  const paint = new THREE.MeshPhysicalMaterial({ color: primary, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  const livery = liveryTexture(primary, secondary, opts.seed % 3);
  livery.repeat.set(1 / 5.4, 1 / 1.25);
  livery.offset.set(2.7 / 5.4, 0);
  const liveryMat = paint.clone();
  liveryMat.color.set(0xffffff);
  liveryMat.map = livery;
  const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.55, metalness: 0.2 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.35, metalness: 0.4 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1118, roughness: 0.02, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.5, transparent: true, opacity: 0.88, side: THREE.DoubleSide });

  // ---------- lower body: extruded side profile with wheel arches ----------
  const s = new THREE.Shape();
  const arch = (cz: number) => {
    const r = 0.42, cy = 0.34;
    s.lineTo(cz - r, 0.17);
    for (let k = 0; k <= 14; k++) {
      const a = Math.PI - (k / 14) * Math.PI;
      s.lineTo(cz + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    s.lineTo(cz + r, 0.17);
  };
  s.moveTo(-2.62, 0.2);
  arch(WHEELBASE_R);
  arch(WHEELBASE_F);
  s.lineTo(2.5, 0.13);
  s.lineTo(2.64, 0.24);
  s.lineTo(2.6, 0.42);
  s.lineTo(2.4, 0.57);
  s.lineTo(2.05, 0.7);
  s.lineTo(1.5, 0.8);
  s.lineTo(0.85, 0.88);
  s.lineTo(-1.3, 0.94);
  s.lineTo(-2.45, 0.99);
  s.lineTo(-2.6, 0.86);
  s.lineTo(-2.64, 0.45);
  s.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: 1.84, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 4, curveSegments: 6 });
  bodyGeo.translate(0, 0, -0.92);
  bodyGeo.rotateY(-Math.PI / 2);
  // shape it like a car: taper nose & tail in plan view, pull the shoulders in (tumblehome)
  const smooth = THREE.MathUtils.smoothstep;
  const shape = (g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number) => {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * fn(p.getX(i), p.getY(i), p.getZ(i)));
    // keep the extruder's smooth bevel normals: the taper is gentle, recomputing would facet the caps
  };
  shape(bodyGeo, (_x, y, z) => (1 - 0.1 * smooth(z, 1.7, 2.75) - 0.05 * smooth(-z, 2.0, 2.75)) * (1 - 0.07 * smooth(y, 0.62, 1.0)));
  const bodyMesh = new THREE.Mesh(bodyGeo, [liveryMat, paint]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  body.add(bodyMesh);

  // ---------- greenhouse: tinted glass front section + painted roof and fastback ----------
  const tumble = (_x: number, y: number) => 1 - 0.3 * THREE.MathUtils.clamp((y - 0.86) / 0.45, 0, 1);
  const g = new THREE.Shape();
  g.moveTo(1.02, 0.84);
  g.lineTo(0.08, 1.25);
  g.lineTo(-0.86, 1.27);
  g.lineTo(-0.86, 0.84);
  g.closePath();
  const cabGeo = new THREE.ExtrudeGeometry(g, { depth: 1.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.04, bevelSegments: 3 });
  cabGeo.translate(0, 0, -0.65);
  cabGeo.rotateY(-Math.PI / 2);
  shape(cabGeo, tumble);
  const cab = new THREE.Mesh(cabGeo, glass);
  body.add(cab);
  const fb = new THREE.Shape();
  fb.moveTo(-0.8, 0.84);
  fb.lineTo(-0.8, 1.27);
  fb.lineTo(-0.9, 1.27);
  fb.lineTo(-1.9, 0.97);
  fb.lineTo(-1.9, 0.84);
  fb.closePath();
  const fbGeo = new THREE.ExtrudeGeometry(fb, { depth: 1.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.04, bevelSegments: 3 });
  fbGeo.translate(0, 0, -0.65);
  fbGeo.rotateY(-Math.PI / 2);
  shape(fbGeo, tumble);
  const fastback = new THREE.Mesh(fbGeo, paint);
  fastback.castShadow = true;
  body.add(fastback);
  // roof panel over the glass, and A-pillars
  const roofHalf = 0.71 * tumble(0, 1.29);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(roofHalf * 2 + 0.02, 0.05, 1.02, 2, 0.02), paint);
  roof.position.set(0, 1.29, -0.38);
  roof.castShadow = true;
  body.add(roof);
  for (const sx of [1, -1]) {
    const a = new THREE.Vector3(sx * 0.73 * tumble(0, 0.88), 0.88, 1.03);
    const b = new THREE.Vector3(sx * roofHalf, 1.27, 0.1);
    const len = a.distanceTo(b);
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, len, 0.09), paint);
    pillar.position.copy(a).lerp(b, 0.5);
    pillar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    body.add(pillar);
  }
  // rear glass on the fastback
  {
    const t0 = tumble(0, 1.26), t1 = tumble(0, 0.99);
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0.6 * t0, 1.285, -0.95), new THREE.Vector3(0.62 * t1, 1.0, -1.9), new THREE.Vector3(-0.62 * t1, 1.0, -1.9),
      new THREE.Vector3(0.6 * t0, 1.285, -0.95), new THREE.Vector3(-0.62 * t1, 1.0, -1.9), new THREE.Vector3(-0.6 * t0, 1.285, -0.95),
    ]);
    geo.computeVertexNormals();
    body.add(new THREE.Mesh(geo, glass));
  }
  // window net on the driver (left) side
  {
    const net = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.24), new THREE.MeshBasicMaterial({ color: 0x111111, wireframe: true }));
    net.rotation.y = Math.PI / 2;
    net.rotation.z = 0.0;
    net.position.set(0.7, 1.02, -0.3);
    body.add(net);
  }

  // ---------- aero bits ----------
  const parts: CarVisual['parts'] = {};
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.04, 0.45), carbon);
  splitter.position.set(0, 0.12, 2.45);
  body.add(splitter);
  parts.splitter = splitter;
  const spoilerG = new THREE.Group();
  spoilerG.position.set(0, 1.1, -2.45);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.2, 0.025), carbon);
  spoiler.rotation.x = -0.35;
  spoiler.castShadow = true;
  spoilerG.add(spoiler);
  for (const sx of [0.92, -0.92]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.24, 0.3), carbon);
    ep.position.set(sx, -0.02, 0.03);
    spoilerG.add(ep);
  }
  body.add(spoilerG);
  parts.spoiler = spoilerG;
  // side skirts
  for (const sx of [1.04, -1.04]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 1.7), carbon);
    sk.position.set(sx, 0.16, 0.05);
    body.add(sk);
    parts[sx > 0 ? 'skirtL' : 'skirtR'] = sk;
  }
  // front fascia / rear valance (bolt-on, can be knocked off)
  const bumperMat = paint;
  const bf = new THREE.Mesh(new RoundedBoxGeometry(1.84, 0.2, 0.2, 2, 0.05), bumperMat);
  bf.position.set(0, 0.24, 2.6);
  bf.castShadow = true;
  body.add(bf);
  parts.bumperF = bf;
  const br = new THREE.Mesh(new RoundedBoxGeometry(1.8, 0.22, 0.16, 2, 0.05), black);
  br.position.set(0, 0.3, -2.64);
  body.add(br);
  parts.bumperR = br;
  // separate hood panel (can fly off in big frontal hits)
  const hoodPanel = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.03, 1.0, 2, 0.012), paint);
  hoodPanel.position.set(0, 0.9, 1.35);
  hoodPanel.rotation.x = 0.1;
  hoodPanel.castShadow = true;
  body.add(hoodPanel);
  parts.hood = hoodPanel;
  // hood vents & pins
  const vent = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.02, 0.35, 2, 0.01), black);
  vent.position.set(0, 0.905, 1.35);
  vent.rotation.x = 0.12;
  body.add(vent);
  // roof flaps (closed; they pop open when the car spins backwards at speed)
  const flaps: THREE.Object3D[] = [];
  for (const sx of [0.3, -0.3]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx, 1.318, -0.67);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.012, 0.16), carbon);
    flap.position.z = -0.08;
    hinge.add(flap);
    body.add(hinge);
    flaps.push(hinge);
  }
  // wiper (only shown in the rain)
  const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.015, 0.025), black);
  wiper.geometry.translate(0.31, 0, 0);
  wiper.position.set(-0.45, 0.93, 0.98);
  wiper.rotation.x = -0.4;
  wiper.visible = false;
  body.add(wiper);
  // exhaust (right side, under door)
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.25, 10), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 1, roughness: 0.3 }));
  exhaust.rotation.z = Math.PI / 2;
  exhaust.position.set(-1.08, 0.2, -0.1);
  body.add(exhaust);

  // ---------- lights (decals, as on real stock cars) ----------
  const hl = textDecal('', null, '#fff', 256, 64);
  {
    const ctx = (hl.image as HTMLCanvasElement).getContext('2d')!;
    ctx.fillStyle = '#e9edf2';
    ctx.beginPath(); ctx.roundRect(8, 10, 240, 44, 18); ctx.fill();
    ctx.fillStyle = '#9aa7b8'; ctx.beginPath(); ctx.arc(60, 32, 16, 0, 7); ctx.arc(190, 32, 16, 0, 7); ctx.fill();
    hl.needsUpdate = true;
  }
  for (const sx of [0.62, -0.62]) {
    const d = decalPlane(0.5, 0.13, hl);
    d.position.set(sx * 0.92, 0.55, 2.55);
    d.rotation.x = -0.92;
    body.add(d);
  }
  const taillights = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1100, emissiveIntensity: 0.15, roughness: 0.3 });
  const tl = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.12), taillights);
  tl.rotation.y = Math.PI;
  tl.position.set(0, 0.78, -2.69);
  body.add(tl);
  // grille
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.16), black);
  grille.position.set(0, 0.34, 2.69);
  grille.rotation.x = 0.2;
  body.add(grille);

  // ---------- numbers & sponsor decals ----------
  const numFill = contrast(primary) === '#111111' ? '#111111' : '#ffffff';
  const numOutline = contrast(primary) === '#111111' ? '#ffffff' : '#111111';
  const doorTex = numberDecal(opts.number, numFill === '#111111' ? '#111' : '#fff', numOutline === '#111111' ? primary : '#ffcc00', sponsor);
  const left = decalPlane(1.15, 0.94, doorTex);
  left.rotation.y = Math.PI / 2;
  left.position.set(0.998, 0.53, -0.15);
  body.add(left);
  const right = decalPlane(1.15, 0.94, doorTex);
  right.rotation.y = -Math.PI / 2;
  right.position.set(-0.998, 0.53, -0.15);
  body.add(right);
  const roofTex = numberDecal(opts.number, '#ffffff', '#111', '', 512, 512);
  const roofNum = decalPlane(0.78, 0.78, roofTex);
  roofNum.rotation.x = -Math.PI / 2;
  roofNum.rotation.z = -Math.PI / 2; // readable from the infield (left side)
  roofNum.position.set(0, 1.318, -0.28);
  body.add(roofNum);
  const hoodTex = textDecal(sponsor, null, numFill === '#111111' ? '#111' : '#fff');
  const hood = decalPlane(1.5, 0.38, hoodTex);
  hood.geometry.rotateX(-Math.PI / 2).rotateY(Math.PI);
  hood.rotation.x = 0.1;
  hood.position.set(0, 0.92, 1.3);
  body.add(hood);
  const bumperTex = textDecal('THUNDER SERIES', '#111', '#ffcc00', 1024, 128);
  const rearBar = decalPlane(1.4, 0.17, bumperTex, false);
  rearBar.rotation.y = Math.PI;
  rearBar.position.set(0, 0.5, -2.71);
  body.add(rearBar);
  const windTex = textDecal('THUNDER', '#111', '#fff', 1024, 128);
  const wind = decalPlane(1.2, 0.12, windTex, false);
  wind.position.set(0, 1.215, 0.22);
  wind.rotation.x = -1.15;
  body.add(wind);

  // ---------- simple interior (visible through glass, cockpit cam later) ----------
  const cage = new THREE.MeshStandardMaterial({ color: 0x2c2f33, metalness: 0.7, roughness: 0.4 });
  const seat = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.7, 0.5, 2, 0.08), black);
  seat.position.set(0.3, 0.75, -0.55);
  body.add(seat);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), new THREE.MeshPhysicalMaterial({ color: primary, clearcoat: 1, roughness: 0.2 }));
  helmet.position.set(0.3, 1.1, -0.45);
  body.add(helmet);
  const bar = (a: THREE.Vector3, b: THREE.Vector3) => {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 6), cage);
    m.position.copy(a).lerp(b, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    body.add(m);
  };
  bar(new THREE.Vector3(0.6, 0.9, 0.85), new THREE.Vector3(0.55, 1.2, 0.05));
  bar(new THREE.Vector3(-0.6, 0.9, 0.85), new THREE.Vector3(-0.55, 1.2, 0.05));
  bar(new THREE.Vector3(0.55, 1.2, 0.05), new THREE.Vector3(-0.55, 1.2, 0.05));
  bar(new THREE.Vector3(0.55, 1.22, -0.8), new THREE.Vector3(-0.55, 1.22, -0.8));
  const wheelSt = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.02, 6, 18), black);
  wheelSt.position.set(0.3, 1.0, 0.0);
  wheelSt.rotation.x = 0.4;
  body.add(wheelSt);

  // ---------- wheels ----------
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.85 });
  const sideTex = textDecal('RIDGEBACK  ·  RACING  ·  RIDGEBACK  ·  RACING', null, '#f2f2f2', 1024, 64);
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.85 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.85, roughness: 0.3 });
  const lugMat = new THREE.MeshStandardMaterial({ color: 0xd8b13a, metalness: 1, roughness: 0.25 });
  const wheels: THREE.Group[] = [];
  const brakeDiscs: THREE.MeshStandardMaterial[] = [];
  const positions: [number, number][] = [
    [TRACK_HALF, WHEELBASE_F], [-TRACK_HALF, WHEELBASE_F], [TRACK_HALF, WHEELBASE_R], [-TRACK_HALF, WHEELBASE_R],
  ];
  for (const [x, z] of positions) {
    const pivot = new THREE.Group(); // steering pivot
    pivot.position.set(x, WHEEL_RADIUS, z);
    const spin = new THREE.Group();
    pivot.add(spin);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 32, 1, true), tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    spin.add(tire);
    const sideRing = new THREE.RingGeometry(0.24, WHEEL_RADIUS, 32);
    // map lettering around the ring
    const uv = sideRing.getAttribute('uv') as THREE.BufferAttribute;
    const p = sideRing.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const a = Math.atan2(p.getY(k), p.getX(k));
      const rr = Math.hypot(p.getX(k), p.getY(k));
      uv.setXY(k, (a / (Math.PI * 2) + 1) % 1, (rr - 0.24) / (WHEEL_RADIUS - 0.24));
    }
    const sidewallMat = sideMat.clone();
    sidewallMat.map = sideTex;
    sidewallMat.color.set(0xffffff);
    const outward = x > 0 ? 1 : -1;
    const sw = new THREE.Mesh(sideRing, sidewallMat);
    sw.rotation.y = outward * Math.PI / 2;
    sw.position.x = outward * 0.15;
    spin.add(sw);
    const swIn = new THREE.Mesh(new THREE.RingGeometry(0.24, WHEEL_RADIUS, 24), tireMat);
    swIn.rotation.y = -outward * Math.PI / 2;
    swIn.position.x = -outward * 0.15;
    spin.add(swIn);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.26, 24), rimMat);
    rim.rotation.z = Math.PI / 2;
    spin.add(rim);
    const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 6), lugMat);
    lug.rotation.z = Math.PI / 2;
    lug.position.x = outward * 0.14;
    spin.add(lug);
    for (let k = 0; k < 5; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.05), rimMat);
      spoke.position.x = outward * 0.135;
      spoke.rotation.x = (k / 5) * Math.PI * 2;
      spoke.translateY(0.1);
      spin.add(spoke);
    }
    // brake disc (glows hot under braking)
    const discMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.9, roughness: 0.4, emissive: 0xff3300, emissiveIntensity: 0 });
    brakeDiscs.push(discMat);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.03, 20), discMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = -outward * 0.02;
    pivot.add(disc);
    root.add(pivot);
    wheels.push(pivot);
  }

  for (let i = 0; i < 4; i++) parts[`wheel${i}` as PartName] = wheels[i];
  hood.name = "hoodDecal";
  const decals: THREE.Object3D[] = [left, right, roofNum, hood, rearBar, wind];
  body.children.forEach((c) => { if ((c as THREE.Mesh).isMesh && ((c as THREE.Mesh).material as THREE.Material).transparent && c !== cab) decals.push(c); });
  return {
    root, body, wheels, brakeDiscs, taillights, parts,
    deformables: [bodyMesh, fastback, cab, roof, hoodPanel, bf],
    paintMats: [paint, liveryMat],
    decals: [...new Set(decals)],
    glass: body.children.filter((c) => (c as THREE.Mesh).material === glass),
    flaps,
    wiper,
    primary,
  };
}
