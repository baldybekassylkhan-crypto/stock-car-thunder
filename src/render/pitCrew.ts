import * as THREE from 'three';

/**
 * A pit crew around a car during a stop: tyre changers at each wheel, front and rear jack men, a
 * fuel man for stock cars and a lollipop man. Simple low-poly figures in the team colour, kneeling
 * and bobbing while they work. Positions are in the car's model frame (+Z forward, +X left).
 */
const bodyGeo = new THREE.CapsuleGeometry(0.2, 0.7, 4, 8);
const headGeo = new THREE.SphereGeometry(0.15, 10, 8);
const gunGeo = new THREE.BoxGeometry(0.1, 0.1, 0.35);
const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35 });
const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 });

export class PitCrew {
  readonly group = new THREE.Group();
  private people: { obj: THREE.Object3D; base: THREE.Vector3; phase: number; kneel: boolean }[] = [];
  private t = 0;
  private suit: THREE.MeshStandardMaterial;

  constructor(color: string, geo: { wheelbaseF: number; wheelbaseR: number; trackHalf: number }, refuel: boolean) {
    this.suit = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const add = (x: number, z: number, faceX: number, faceZ: number, kneel: boolean, gun = false) => {
      const p = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, this.suit);
      body.position.y = kneel ? 0.45 : 0.65;
      if (kneel) body.scale.set(1, 0.72, 1);
      body.castShadow = true;
      const head = new THREE.Mesh(headGeo, helmetMat);
      head.position.y = kneel ? 0.95 : 1.35;
      p.add(body, head);
      if (gun) {
        const g = new THREE.Mesh(gunGeo, gunMat);
        g.position.set(0, kneel ? 0.5 : 0.8, 0.3);
        p.add(g);
      }
      p.position.set(x, 0, z);
      p.rotation.y = Math.atan2(faceX, faceZ);
      this.group.add(p);
      this.people.push({ obj: p, base: p.position.clone(), phase: Math.random() * 6, kneel });
    };
    const { wheelbaseF: f, wheelbaseR: r, trackHalf: w } = geo;
    for (const [z, side] of [[f, 1], [f, -1], [r, 1], [r, -1]] as const) add(side * (w + 0.75), z, -side, 0, true, true);
    add(0, f + 1.6, 0, -1, false); // front jack
    add(0, r - 1.6, 0, 1, false); // rear jack
    if (refuel) add(w + 0.9, r + 0.9, -1, 0, false); // fuel man
    add(-(w + 0.6), f + 2.6, 0.6, -1, false); // lollipop / release
  }

  /** Follow the car (model frame = car visual root) and animate. */
  update(dt: number, root: THREE.Object3D) {
    this.t += dt;
    this.group.position.copy(root.position);
    this.group.quaternion.copy(root.quaternion);
    for (const p of this.people) {
      const bob = p.kneel ? Math.sin(this.t * 9 + p.phase) * 0.04 : Math.sin(this.t * 3 + p.phase) * 0.02;
      p.obj.position.set(p.base.x, bob, p.base.z);
    }
  }

  dispose() {
    this.suit.dispose();
  }
}
