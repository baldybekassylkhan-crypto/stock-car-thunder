import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarVisual } from './carModel';

/**
 * Level of detail for cars. A full car is ~80 meshes (draw calls); with 32 cars that dominates the
 * frame. Far away, each car is swapped for one merged, vertex-coloured mesh with no shadow.
 */
interface LodState {
  mesh: THREE.Mesh;
  far: boolean;
  /** Middle distance: tiny bits (interior, cage, vents, small decals) are hidden. */
  mid: boolean;
  details: THREE.Object3D[];
  hiddenDetails: THREE.Object3D[];
  /** Children we hid when going far (restored when coming back; others stay as they were). */
  hidden: THREE.Object3D[];
}

const lods = new WeakMap<CarVisual, LodState>();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/** Distance (m) at which cars switch to the low-detail mesh, per graphics quality. */
export const LOD_DISTANCE: Record<string, number> = { low: 45, medium: 70, high: 95, ultra: 130 };

/** Build the merged low-detail mesh for a freshly built car (call before any parts come off). */
export function buildLod(v: CarVisual): void {
  v.root.updateMatrixWorld(true);
  _inv.copy(v.root.matrixWorld).invert();
  const paint = new THREE.Color(v.primary);
  const geos: THREE.BufferGeometry[] = [];
  v.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    // decals, glass and wireframe nets don't matter at a distance
    if (!mat || mat.transparent || (mat as unknown as { wireframe?: boolean }).wireframe) return;
    const src = mesh.geometry;
    if (!src.attributes.position || !src.attributes.normal) return;
    const g = src.index ? src.toNonIndexed() : src.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.morphAttributes = {};
    _m.multiplyMatrices(_inv, mesh.matrixWorld);
    g.applyMatrix4(_m);
    const c = v.paintMats.includes(mat as THREE.MeshPhysicalMaterial) ? paint : mat.color ?? paint;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  });
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }));
  mesh.name = 'lod';
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  v.root.add(mesh);
  // small body bits that can't be seen from more than ~25 m (never detachable parts)
  const keep = new Set<THREE.Object3D>();
  for (const p of Object.values(v.parts)) p?.traverse((o) => keep.add(o));
  for (const d of v.deformables) keep.add(d);
  const details: THREE.Object3D[] = [];
  const sphere = new THREE.Sphere();
  v.body.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || keep.has(m) || o === v.body) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    sphere.copy(m.geometry.boundingSphere!);
    const sc = m.getWorldScale(new THREE.Vector3());
    if (sphere.radius * Math.max(sc.x, sc.y, sc.z) < 0.33) details.push(m);
  });
  lods.set(v, { mesh, far: false, hidden: [], mid: false, details, hiddenDetails: [] });
}

/** Switch a car between full detail and the merged mesh based on camera distance (with hysteresis). */
export function updateLod(v: CarVisual, camDist: number, lodDist: number): void {
  const s = lods.get(v);
  if (!s) return;
  const midDist = Math.min(28, lodDist * 0.4);
  const mid = s.mid ? camDist > midDist * 0.9 : camDist > midDist;
  if (mid !== s.mid) {
    s.mid = mid;
    if (mid) { s.hiddenDetails = s.details.filter((d) => d.visible); s.hiddenDetails.forEach((d) => (d.visible = false)); }
    else { s.hiddenDetails.forEach((d) => (d.visible = true)); s.hiddenDetails = []; }
  }
  const far = s.far ? camDist > lodDist * 0.9 : camDist > lodDist;
  if (far === s.far) return;
  s.far = far;
  if (far) {
    s.hidden = v.root.children.filter((c) => c !== s.mesh && c.visible);
    s.hidden.forEach((c) => (c.visible = false));
  } else {
    s.hidden.forEach((c) => { if (c.parent === v.root) c.visible = true; });
    s.hidden = [];
  }
  s.mesh.visible = far;
}

/** Burnt-out wreck: darken the low-detail mesh too. */
export function charLod(v: CarVisual): void {
  const s = lods.get(v);
  if (s) (s.mesh.material as THREE.MeshStandardMaterial).color.setScalar(0.12);
}
