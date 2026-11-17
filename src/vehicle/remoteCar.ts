import * as THREE from 'three';
import { RAPIER, GROUP_CAR, type PhysicsWorld } from '../physics/world';
import type { CarVisual, PartName } from './carModel';
import { buildCarModel } from './models';
import { carSpec, type CarSpec } from './catalog';
import { buildLod } from './carLod';
import type { CarState } from '../net/codec';
import { charCar, hidePart } from '../damage/visual';


interface Snap { t: number; s: CarState }

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/**
 * Another player's (or a host-run bot's) car. Snapshots are buffered and played back a little in
 * the past so motion stays smooth despite jitter: the delay adapts to each connection (about
 * 100 ms on a steady link, up to 300 ms on a jittery one), and when a late packet forces a
 * correction the difference is blended out over ~0.15 s instead of snapping. A kinematic body
 * follows the smoothed pose, so our car collides with it solidly.
 */
export class RemoteCar {
  visual: CarVisual;
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
  private opts: { number: number; color: string; seed: number };
  static readonly DELAY = 0.12;
  /** Playback delay for this car (s), adapted to the measured packet jitter. */
  private delay = RemoteCar.DELAY;
  private lastArrival = -1;
  private avgGap = 0.05;
  private jitter = 0.01;
  /** Visual correction still to blend out (m), and the pose we showed last frame. */
  private corr = new THREE.Vector3();
  private shown = new THREE.Vector3();
  private shownT = -1;

  constructor(private physics: PhysicsWorld, readonly slot: number, opts: { number: number; color: string; seed: number }, pos: THREE.Vector3, quat: THREE.Quaternion, readonly spec: CarSpec = carSpec(undefined)) {
    this.opts = opts;
    this.visual = buildCarModel(opts, spec);
    buildLod(this.visual);
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(quat));
    const hull: number[] = [];
    for (const [x, y, z] of spec.hull) hull.push(x, y, z, -x, y, z);
    this.collider = physics.world.createCollider(
      (RAPIER.ColliderDesc.roundConvexHull(new Float32Array(hull), 0.03) ?? RAPIER.ColliderDesc.cuboid(0.95, 0.5, 2.6)).setFriction(0.35).setCollisionGroups(GROUP_CAR),
      this.body,
    );
    this.pos.copy(pos);
    this.quat.copy(quat);
  }

  push(s: CarState, now: number) {
    this.latest = s;
    // measure how evenly packets arrive and size the playback delay to cover the jitter
    if (this.lastArrival >= 0) {
      const gap = Math.min(0.5, now - this.lastArrival);
      this.avgGap += (gap - this.avgGap) * 0.05;
      this.jitter += (Math.abs(gap - this.avgGap) - this.jitter) * 0.05;
      const want = THREE.MathUtils.clamp(this.avgGap * 1.5 + this.jitter * 3 + 0.02, 0.09, 0.3);
      // grow quickly when the link gets worse, shrink slowly when it calms down
      this.delay += (want - this.delay) * (want > this.delay ? 0.2 : 0.01);
    }
    this.lastArrival = now;
    this.buf.push({ t: now, s });
    if (this.buf.length > 40) this.buf.shift();
  }

  get stale() {
    return this.buf.length === 0;
  }

  /** Interpolated pose at `now - DELAY`; sets the kinematic target. */
  sample(now: number) {
    const rt = now - this.delay;
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
    // smooth corrections: if the new target is off from where the car was heading, keep showing
    // the old path and blend the difference out (big jumps — respawns, resets — snap at once)
    if (this.shownT >= 0) {
      const dt = Math.min(0.1, Math.max(0, now - this.shownT));
      const expected = _a.copy(this.shown).addScaledVector(this.vel, dt);
      const err = _b.copy(expected).sub(this.pos);
      if (err.lengthSq() < 9) this.corr.copy(err);
      else this.corr.set(0, 0, 0);
      this.corr.multiplyScalar(Math.exp(-dt / 0.12));
      this.pos.add(this.corr);
    }
    this.shown.copy(this.pos);
    this.shownT = now;
    this.body.setNextKinematicTranslation(this.pos);
    this.body.setNextKinematicRotation(this.quat);
  }

  sync(dt: number) {
    const s = this.latest;
    const v = this.visual;
    v.root.quaternion.copy(this.quat);
    v.root.position.copy(this.pos).add(_a.set(0, -v.comHeight, 0).applyQuaternion(this.quat));
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
    // on open-wheelers the flap bit carries the drag-reduction flap
    if (v.drsFlap) v.drsFlap.rotation.x += ((s.flaps ? -0.25 : 0.45) - v.drsFlap.rotation.x) * Math.min(1, dt * 14);
    v.wiper.visible = s.wiper;
    if (s.exploded && !this.charred) this.char();
    // parts missing in the state but still attached (e.g. a lost detach event): just hide them
    for (const g of s.gone) if (!this.goneApplied.has(g)) { this.goneApplied.add(g); hidePart(v, v.parts[g], g); }
  }

  /** The owner repaired the car in the pits: fresh bodywork. Returns the old visual to remove from the scene. */
  rebuild(): CarVisual {
    const old = this.visual;
    this.visual = buildCarModel(this.opts, this.spec);
    buildLod(this.visual);
    this.goneApplied.clear();
    this.charred = false;
    return old;
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
