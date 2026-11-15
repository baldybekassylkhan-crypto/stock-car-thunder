import * as THREE from 'three';
import { RAPIER, GROUP_DEBRIS, GROUP_DEBRIS_EARLY, type PhysicsWorld } from '../physics/world';

interface Piece {
  obj: THREE.Object3D;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  armed: boolean;
  age: number;
  life: number;
  burning: boolean;
}

/**
 * Physical debris: detached parts and explosion chunks become small rigid bodies that tumble,
 * slide along the track and can be hit by other cars. Each client simulates its own copy.
 */
export class Debris {
  private pieces: Piece[] = [];
  readonly group = new THREE.Group();

  constructor(private physics: PhysicsWorld) {}

  /** Detach `obj` (currently somewhere in a car's hierarchy) into a free physics object. */
  release(obj: THREE.Object3D, vel: THREE.Vector3, spin = 6, mass = 12, life = 40) {
    obj.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    obj.matrixWorld.decompose(wp, wq, ws);
    obj.removeFromParent();
    obj.visible = true;
    // wrap so the body origin sits at the visual's bbox centre
    const holder = new THREE.Group();
    holder.position.copy(center);
    this.group.add(holder);
    holder.add(obj);
    obj.position.copy(wp).sub(center);
    obj.quaternion.copy(wq);
    obj.scale.copy(ws);
    obj.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    const hx = Math.max(0.04, size.x / 2), hy = Math.max(0.03, size.y / 2), hz = Math.max(0.04, size.z / 2);
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel({ x: (Math.random() - 0.5) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin })
        .setLinearDamping(0.15)
        .setAngularDamping(0.4)
        .setCcdEnabled(true),
    );
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setMass(mass).setFriction(0.6).setRestitution(0.25).setCollisionGroups(GROUP_DEBRIS_EARLY),
      body,
    );
    this.pieces.push({ obj: holder, body, collider, armed: false, age: 0, life, burning: false });
    if (this.pieces.length > 70) this.remove(0);
  }

  /** Random burning chunks for an explosion. */
  burst(p: THREE.Vector3, baseVel: THREE.Vector3, color: string, n: number) {
    const mats = [new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 })];
    for (let k = 0; k < n; k++) {
      const s = 0.12 + Math.random() * 0.35;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.3, s * (0.6 + Math.random())), mats[k % 2]);
      m.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 1.6, Math.random() * 0.8, (Math.random() - 0.5) * 3));
      this.group.add(m);
      const v = baseVel.clone().add(new THREE.Vector3((Math.random() - 0.5) * 24, 6 + Math.random() * 16, (Math.random() - 0.5) * 24));
      this.release(m, v, 20, 3, 25);
      this.pieces[this.pieces.length - 1].burning = Math.random() < 0.4;
    }
  }

  private remove(i: number) {
    const p = this.pieces[i];
    this.physics.world.removeRigidBody(p.body);
    p.obj.removeFromParent();
    this.pieces.splice(i, 1);
  }

  /** Sync visuals; returns burning piece positions for the fire emitter. */
  update(dt: number, onBurning?: (p: THREE.Vector3) => void) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      // collide with cars only once clear of the car that shed it
      if (!p.armed && p.age > 0.5) { p.armed = true; p.collider.setCollisionGroups(GROUP_DEBRIS); }
      const t = p.body.translation();
      const r = p.body.rotation();
      p.obj.position.set(t.x, t.y, t.z);
      p.obj.quaternion.set(r.x, r.y, r.z, r.w);
      if (p.burning && p.age < 8 && onBurning) onBurning(p.obj.position);
      if (p.age > p.life || t.y < -60) this.remove(i);
    }
  }

  dispose() {
    while (this.pieces.length) this.remove(0);
    this.group.removeFromParent();
  }
}
