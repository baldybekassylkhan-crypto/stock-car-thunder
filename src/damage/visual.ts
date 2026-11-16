import * as THREE from 'three';
import { charLod } from '../vehicle/carLod';
import type { CarVisual } from '../vehicle/carModel';
import { CAR_COM_HEIGHT } from '../vehicle/carModel';

/**
 * Crumple the car's body meshes around an impact point.
 * `localCom` is in the physics (centre-of-mass) frame; the visual root sits CAR_COM_HEIGHT lower.
 */
export function dentCar(v: CarVisual, localCom: THREE.Vector3, inward: THREE.Vector3, magnitude: number) {
  if (magnitude <= 0.002) return;
  const p = localCom.clone().setY(localCom.y + CAR_COM_HEIGHT);
  const radius = 0.45 + magnitude * 2.2;
  const inv = new THREE.Matrix4();
  const pl = new THREE.Vector3();
  const dl = new THREE.Vector3();
  for (const mesh of v.deformables) {
    if (!mesh.parent) continue;
    mesh.updateMatrix();
    inv.copy(mesh.matrix).invert();
    pl.copy(p).applyMatrix4(inv);
    dl.copy(inward).transformDirection(inv);
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    if (!geo.userData.orig) geo.userData.orig = (pos.array as Float32Array).slice();
    const orig = geo.userData.orig as Float32Array;
    let moved = false;
    const touched = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const d = Math.hypot(x - pl.x, y - pl.y, z - pl.z);
      if (d > radius) continue;
      const f = (1 - d / radius) ** 2;
      // pseudo-random crumple per vertex position so duplicates move together
      const h = Math.abs(Math.sin(orig[i * 3] * 12.9898 + orig[i * 3 + 1] * 78.233 + orig[i * 3 + 2] * 37.719) * 43758.5453) % 1;
      const m = magnitude * f * (0.6 + h * 0.8);
      let nx = x + dl.x * m, ny = y + dl.y * m, nz = z + dl.z * m;
      // never push a vertex more than 0.32 m from where it started
      const ox = orig[i * 3], oy = orig[i * 3 + 1], oz = orig[i * 3 + 2];
      const ddx = nx - ox, ddy = ny - oy, ddz = nz - oz;
      const len = Math.hypot(ddx, ddy, ddz);
      if (len > 0.32) { const k = 0.32 / len; nx = ox + ddx * k; ny = oy + ddy * k; nz = oz + ddz * k; }
      pos.setXYZ(i, nx, ny, nz);
      touched.add(i);
      moved = true;
    }
    if (!moved) continue;
    pos.needsUpdate = true;
    recomputeLocalNormals(geo, touched);
    geo.computeBoundingSphere();
  }
}

/** Faceted normals only on the triangles that moved: reads as crumpled sheet metal. */
function recomputeLocalNormals(geo: THREE.BufferGeometry, touched: Set<number>) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const tri = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    if (!touched.has(i0) && !touched.has(i1) && !touched.has(i2)) continue;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    n.subVectors(c, b).cross(a.sub(b)).normalize();
    nor.setXYZ(i0, n.x, n.y, n.z); nor.setXYZ(i1, n.x, n.y, n.z); nor.setXYZ(i2, n.x, n.y, n.z);
  }
  nor.needsUpdate = true;
}

/** Burnt-out shell after an explosion. */
export function charCar(v: CarVisual) {
  charLod(v);
  for (const m of v.paintMats) {
    m.map = null;
    m.color.set(0x15110e);
    m.roughness = 0.95;
    m.metalness = 0.25;
    m.clearcoat = 0;
    m.needsUpdate = true;
  }
  v.decals.forEach((d) => (d.visible = false));
  v.glass.forEach((g) => (g.visible = false));
  v.taillights.emissiveIntensity = 0;
  v.body.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && 'color' in m && !v.paintMats.includes(m as THREE.MeshPhysicalMaterial) && m.color) {
      if (!m.userData.charred) { m.userData.charred = true; m.color.multiplyScalar(0.35); }
    }
  });
}

/** Hide a part on a car (used when the part flies off or is missing in a state packet). */
export function hidePart(v: CarVisual, obj: THREE.Object3D | undefined, name: string) {
  if (!obj) return;
  obj.visible = false;
  if (name === 'hood') v.body.getObjectByName('hoodDecal')?.removeFromParent();
}

/** Wobble a loose part (called each frame with elapsed time). */
export function wobble(obj: THREE.Object3D | undefined, t: number, speed: number) {
  if (!obj) return;
  if (obj.userData.baseRot === undefined) obj.userData.baseRot = obj.rotation.clone();
  const b = obj.userData.baseRot as THREE.Euler;
  const a = Math.min(0.25, speed * 0.004) * Math.sin(t * 31 + obj.id);
  obj.rotation.set(b.x + a, b.y, b.z + a * 0.4);
}
