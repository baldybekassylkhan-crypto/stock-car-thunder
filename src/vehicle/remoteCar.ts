import * as THREE from 'three';
import { RAPIER, GROUP_CAR, type PhysicsWorld } from '../physics/world';
import { buildCarModel, CAR_COM_HEIGHT, type CarVisual, type PartName } from './carModel';
import type { CarState } from '../net/codec';
import { charCar, hidePart } from '../damage/visual';

const HULL: [number, number, number][] = [
  [0.96, -0.25, 1.85], [0.96, -0.25, -1.8], [0.92, -0.18, 2.62], [0.92, 0.12, 2.64], [0.92, -0.16, -2.62], [0.92, 0.5, -2.62],
  [0.96, 0.32, 1.9], [0.96, 0.48, -2.4], [0.66, 0.42, 1.05], [0.68, 0.84, 0.05], [0.68, 0.86, -0.85], [0.68, 0.5, -1.9],
];

interface Snap { t: number; s: CarState }

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/**
 * Another player's (or a host-run bot's) car. Snapshots are buffered and played back ~120 ms in
 * the past so motion stays smooth despite jitter. A kinematic body follows the interpolated pose,
 * so our car collides with it solidly.
 */
export class RemoteCar {
  readonly visual: CarVisual;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private buf: Snap[] = [];
  latest: CarState | null = null;
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  private wheelAngle = 0;
  private flap = 0;
  private charred = false;
  readonly goneApplied = new Set<PartName>();
  static readonly DELAY = 0.12;

  constructor(private physics: PhysicsWorld, readonly slot: number, opts: { number: number; color: string; seed: number }, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.visual = buildCarModel(opts);
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(quat));
    const hull: number[] = [];
    for (const [x, y, z] of HULL) hull.push(x, y, z, -x, y, z);
    this.collider = physics.world.createCollider(
      (RAPIER.ColliderDesc.roundConvexHull(new Float32Array(hull), 0.03) ?? RAPIER.ColliderDesc.cuboid(0.95, 0.5, 2.6)).setFriction(0.35).setCollisionGroups(GROUP_CAR),
      this.body,
    );
    this.pos.copy(pos);
    this.quat.copy(quat);
  }

  push(s: CarState, now: number) {
    this.latest = s;
    this.buf.push({ t: now, s });
    if (this.buf.length > 30) this.buf.shift();
  }

  get stale() {
    return this.buf.length === 0;
  }

  /** Interpolated pose at `now - DELAY`; sets the kinematic target. */
  sample(now: number) {
    const rt = now - RemoteCar.DELAY;
    const b = this.buf;
    if (!b.length) return;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > rt) i--;
    const s1 = b[i].s;
    if (i === 0 || b[i].t <= rt) {
      // extrapolate a little past the newest snapshot (≤ 250 ms)
      const dt = Math.min(0.25, Math.max(0, rt - b[i].t));
      this.pos.set(...s1.pos).add(_a.set(...s1.vel).multiplyScalar(dt));
      this.quat.set(...s1.quat);
      this.vel.set(...s1.vel);
    } else {
      const s0 = b[i - 1].s;
      const k = THREE.MathUtils.clamp((rt - b[i - 1].t) / Math.max(1e-3, b[i].t - b[i - 1].t), 0, 1);
      this.pos.copy(_a.set(...s0.pos)).lerp(_b.set(...s1.pos), k);
      this.quat.copy(_qa.set(...s0.quat)).slerp(_qb.set(...s1.quat), k);
      this.vel.set(...s0.vel).lerp(_a.set(...s1.vel), k);
    }
    // drop very old snapshots
    while (b.length > 2 && b[1].t < rt - 0.5) b.shift();
    this.body.setNextKinematicTranslation(this.pos);
    this.body.setNextKinematicRotation(this.quat);
  }

  sync(dt: number) {
    const s = this.latest;
    const v = this.visual;
    v.root.quaternion.copy(this.quat);
    v.root.position.copy(this.pos).add(_a.set(0, -CAR_COM_HEIGHT, 0).applyQuaternion(this.quat));
    if (!s) return;
    this.wheelAngle += s.omega * dt;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (this.goneApplied.has(`wheel${i}` as PartName)) continue;
      w.rotation.y = i < 2 ? -s.steer : 0;
      (w.children[0] as THREE.Object3D).rotation.x = this.wheelAngle;
    }
    v.taillights.emissiveIntensity = s.brake > 0.05 ? 3 : 0.15;
    this.flap += ((s.flaps ? 1.1 : 0) - this.flap) * Math.min(1, dt * 12);
    v.flaps.forEach((f) => (f.rotation.x = -this.flap));
    v.wiper.visible = s.wiper;
    if (s.exploded && !this.charred) this.char();
    // parts missing in the state but still attached (e.g. a lost detach event): just hide them
    for (const g of s.gone) if (!this.goneApplied.has(g)) { this.goneApplied.add(g); hidePart(v, v.parts[g], g); }
  }

  char() {
    if (this.charred) return;
    this.charred = true;
    charCar(this.visual);
  }

  get speed() {
    return this.vel.length();
  }

  dispose(scene: THREE.Object3D) {
    scene.remove(this.visual.root);
    this.physics.world.removeRigidBody(this.body);
  }
}
