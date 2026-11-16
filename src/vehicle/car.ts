import * as THREE from 'three';
import { RAPIER, PhysicsWorld, SURFACE_GRIP, SURFACE_DRAG, GROUP_CAR } from '../physics/world';
import { CarDamage, type DamageLevel } from '../damage/damage';
import { wobble } from '../damage/visual';
import type { DriverInput } from '../core/input';
import type { CarVisual } from './carModel';
import { buildCarModel } from './models';
import { carSpec, type CarSpec } from './catalog';
import { buildLod } from './carLod';
import type { SurfaceKind } from '../tracks/build';

/**
 * Raycast-suspension car on a Rapier rigid body. Everything that makes cars differ (mass, springs,
 * tyres, engine, gearbox, aero, geometry, damage profile) comes from its CarSpec (catalog.ts).
 * Local frame: +Z forward, +X left, +Y up; body origin = center of mass.
 */
function torqueAt(curve: [number, number][], rpm: number) {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, t0] = curve[i - 1], [r1, t1] = curve[i];
      return t0 + ((rpm - r0) / (r1 - r0)) * (t1 - t0);
    }
  }
  return curve[curve.length - 1][1];
}

interface WheelState {
  local: THREE.Vector3;
  front: boolean;
  left: boolean;
  comp: number;
  prevComp: number;
  contact: boolean;
  load: number;
  surface: SurfaceKind;
  omega: number; // rad/s for visuals
  angle: number;
  slip: number; // 0..1+ combined slip intensity (for smoke/sound)
  locked: boolean;
  spinning: boolean;
  point: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _l = new THREE.Vector3();
const _n = new THREE.Vector3();
const _F = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _lin = new THREE.Vector3();
const _ang = new THREE.Vector3();
const _pos = new THREE.Vector3();

export interface CarTelemetry {
  speed: number; // m/s forward
  rpm: number;
  gear: number; // -1 R, 0 N, 1..4
  throttle: number;
  brake: number;
  steer: number;
  limiter: boolean;
  slip: number;
  /** Redline of this car's engine (for the rev bar). */
  maxRpm: number;
}

export interface CarContact {
  world: THREE.Vector3;
  local: THREE.Vector3;
  inwardLocal: THREE.Vector3;
  normalWorld: THREE.Vector3;
  impulse: number;
  slide: number; // tangential sliding speed (m/s)
  other: RAPIER.Collider;
}

export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly damage: CarDamage;
  /** Throttle is cut above this forward speed (pace laps, cautions). */
  speedLimit = Infinity;
  /** Weather grip multiplier. */
  gripScale = 1;
  inputLocked = false;
  wiperOn = false;
  readonly wheelGone = [false, false, false, false];
  flapsOpen = false;
  private flapAngle = 0;
  private visT = 0;
  readonly visual: CarVisual;
  readonly wheels: WheelState[];
  readonly telemetry: CarTelemetry;
  manual = false;
  tractionControl = true;
  abs = true;
  private gear = 1;
  private shiftTimer = 0;
  private steerAngle = 0;
  private reverseTimer = 0;
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private curPos = new THREE.Vector3();
  private curQuat = new THREE.Quaternion();
  /** 0 = clean air, up to ~0.35 = deep in another car's draft (milestone 3+). */
  draft = 0;

  readonly spec: CarSpec;
  /** Static suspension compression and wheel hardpoint height (depend on the spec). */
  private staticComp: number;
  private hardpointY: number;

  constructor(private physics: PhysicsWorld, opts: { number: number; color: string; seed: number }, pos: THREE.Vector3, quat: THREE.Quaternion, damageLevel: DamageLevel = 'realistic', spec: CarSpec = carSpec(undefined)) {
    this.spec = spec;
    const g = spec.geo;
    this.staticComp = (spec.mass * 9.81) / 4 / ((spec.springK[0] + spec.springK[1]) / 2);
    this.hardpointY = -(g.comHeight - g.wheelRadius) + spec.restLength - this.staticComp;
    this.telemetry = { speed: 0, rpm: spec.idle, gear: 1, throttle: 0, brake: 0, steer: 0, limiter: false, slip: 0, maxRpm: spec.redline };
    this.damage = new CarDamage(damageLevel, spec.mass, spec.damage);
    const w = physics.world;
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(quat)
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setLinearDamping(0.0)
        .setAngularDamping(0.15),
    );
    // car-shaped convex hull from the spec (mirrored in x)
    const hull: number[] = [];
    for (const [x, y, z] of spec.hull) hull.push(x, y, z, -x, y, z);
    const main = (RAPIER.ColliderDesc.roundConvexHull(new Float32Array(hull), 0.03) ?? RAPIER.ColliderDesc.roundCuboid(0.92, 0.36, 2.5, 0.08))
      .setFriction(0.35)
      .setRestitution(0.1)
      .setMassProperties(spec.mass, { x: 0, y: 0, z: 0 }, spec.inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setCollisionGroups(GROUP_CAR);
    this.collider = w.createCollider(main, this.body);

    const mk = (x: number, z: number, front: boolean): WheelState => ({
      local: new THREE.Vector3(x, this.hardpointY, z), front, left: x > 0, comp: this.staticComp, prevComp: this.staticComp, contact: false, load: 0,
      surface: 'asphalt', omega: 0, angle: 0, slip: 0, locked: false, spinning: false, point: new THREE.Vector3(),
    });
    this.wheels = [mk(g.trackHalf, g.wheelbaseF, true), mk(-g.trackHalf, g.wheelbaseF, true), mk(g.trackHalf, g.wheelbaseR, false), mk(-g.trackHalf, g.wheelbaseR, false)];
    this.visual = buildCarModel(opts, spec);
    buildLod(this.visual);
    this.snapshot();
    this.snapshot();
  }

  reset(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.body.setTranslation(pos, true);
    this.body.setRotation(quat, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.wheels.forEach((w) => { w.omega = 0; w.comp = w.prevComp = this.staticComp; });
    this.snapshot();
    this.snapshot();
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return _pos.set(t.x, t.y, t.z);
  }

  /** Called once per physics substep before world.step(). */
  step(input: DriverInput, dt: number) {
    const CAR = this.spec;
    const WHEEL_RADIUS = CAR.geo.wheelRadius;
    const b = this.body;
    const t = b.translation();
    const r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _left.set(1, 0, 0).applyQuaternion(_q);
    const lv = b.linvel();
    const av = b.angvel();
    _lin.set(lv.x, lv.y, lv.z);
    _ang.set(av.x, av.y, av.z);
    const speed = _lin.length();
    const vFwd = _lin.dot(_fwd);

    // ---------- driver controls ----------
    let throttle = input.throttle;
    let brake = input.brake;
    let steerIn = input.steer;
    const held = this.inputLocked || this.damage.destroyed;
    if (held) {
      throttle = 0;
      brake = this.damage.destroyed ? 0.25 : 1;
      steerIn = 0;
      // held on the grid / during a penalty: stay in first, never creep into reverse
      if (this.gear === -1) this.gear = 1;
      this.reverseTimer = 0;
    }
    if (vFwd > this.speedLimit) throttle = 0;
    if (vFwd > this.speedLimit + 4) brake = Math.max(brake, 0.35);
    // reverse: the driver holds the brake when (nearly) stopped
    if (!held && this.gear !== -1 && Math.abs(vFwd) < 1.0 && brake > 0.5 && throttle < 0.1) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.35) this.gear = -1;
    } else this.reverseTimer = 0;
    if (this.gear === -1) {
      if (throttle > 0.1 && vFwd > -1.5) this.gear = 1;
      else { const tmp = throttle; throttle = brake; brake = tmp; }
    }

    const steerLock = THREE.MathUtils.lerp(CAR.steerLock[0], CAR.steerLock[1], THREE.MathUtils.smoothstep(Math.abs(vFwd), 3, 62));
    const targetSteer = steerIn * steerLock * this.damage.steerFactor + this.damage.steerPull;
    const steerRate = 2.2;
    this.steerAngle += THREE.MathUtils.clamp(targetSteer - this.steerAngle, -steerRate * dt, steerRate * dt);

    // ---------- engine / gearbox ----------
    const ratio = this.gear === -1 ? -CAR.reverse : CAR.gears[this.gear - 1];
    const rearSpeed = (this.wheels[2].omega + this.wheels[3].omega) * 0.5 * WHEEL_RADIUS;
    const wheelRpm = (Math.abs(vFwd * 0.6 + rearSpeed * 0.4) / WHEEL_RADIUS) * (60 / (2 * Math.PI));
    let rpm = wheelRpm * Math.abs(ratio) * CAR.finalDrive;
    const clutchRpm = CAR.idle + throttle * CAR.redline * 0.35;
    if ((this.gear === 1 || this.gear === -1) && rpm < clutchRpm) rpm = clutchRpm; // slipping clutch launch
    rpm = Math.max(CAR.idle, rpm);
    const limiter = rpm >= CAR.redline;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    let torque = 0;
    if (this.shiftTimer <= 0) {
      torque = limiter ? 0 : torqueAt(CAR.torque, rpm) * throttle * this.damage.power;
      if (throttle < 0.05) torque = -(40 + rpm * 0.012) * THREE.MathUtils.clamp(Math.abs(vFwd) / 5, 0, 1); // engine braking (only when rolling)
    }
    let driveForce = (torque * ratio * CAR.finalDrive * 0.88) / WHEEL_RADIUS;
    if (this.gear === -1) driveForce = Math.max(-5000, Math.min(5000, driveForce));

    // automatic / manual shifting
    if (this.gear > 0) {
      if (this.manual) {
        if (input.shiftUp && this.gear < CAR.gears.length) { this.gear++; this.shiftTimer = 0.12; }
        if (input.shiftDown && this.gear > 1) { this.gear--; this.shiftTimer = 0.1; }
      } else if (this.shiftTimer <= 0) {
        if (rpm > CAR.shiftUpRpm && this.gear < CAR.gears.length) { this.gear++; this.shiftTimer = CAR.series === 'gp' ? 0.05 : 0.14; }
        else if (this.gear > 1) {
          const lower = (wheelRpm * CAR.gears[this.gear - 2] * CAR.finalDrive);
          if (lower < CAR.shiftDownRpm) { this.gear--; this.shiftTimer = CAR.series === 'gp' ? 0.04 : 0.1; }
        }
      }
    }

    // ---------- suspension & tires ----------
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: -_up.x, y: -_up.y, z: -_up.z });
    const maxLen = CAR.restLength + WHEEL_RADIUS;
    const comps = [0, 0, 0, 0];
    const hits: (RAPIER.RayColliderIntersection | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (this.wheelGone[i]) { hits.push(null); comps[i] = 0; continue; }
      _p.copy(w.local).applyQuaternion(_q).add(t as THREE.Vector3Like);
      ray.origin = { x: _p.x, y: _p.y, z: _p.z };
      let hit = this.physics.world.castRayAndGetNormal(ray, maxLen, true, undefined, undefined, undefined, b);
      if (!hit && w.contact) {
        // rays exactly through a mesh vertex can slip through: retry slightly offset
        ray.origin = { x: _p.x + _fwd.x * 0.011, y: _p.y + 0.003, z: _p.z + _fwd.z * 0.011 };
        hit = this.physics.world.castRayAndGetNormal(ray, maxLen, true, undefined, undefined, undefined, b);
      }
      hits.push(hit);
      comps[i] = hit ? maxLen - hit.timeOfImpact : 0;
    }
    const arbF = (comps[0] - comps[1]) * CAR.antiRoll[0];
    const arbR = (comps[2] - comps[3]) * CAR.antiRoll[1];

    let slipSum = 0;
    let driveLeft = driveForce;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const hit = hits[i];
      w.prevComp = w.comp;
      w.comp = comps[i];
      w.contact = !!hit;
      w.slip = 0;
      w.locked = false;
      w.spinning = false;
      if (!hit) {
        w.load = 0;
        w.omega *= 0.995;
        if (!w.front) w.omega += (driveForce / 2 / 40) * dt; // free spin when airborne
        continue;
      }
      const axle = w.front ? 0 : 1;
      const compVel = THREE.MathUtils.clamp((w.comp - w.prevComp) / dt, -2.5, 2.5);
      let fs = CAR.springK[axle] * w.comp + CAR.damperC[axle] * compVel;
      if (w.comp > CAR.bumpStop) fs += (w.comp - CAR.bumpStop) * 600000;
      fs += (i % 2 === 0 ? 1 : -1) * (w.front ? arbF : arbR);
      fs = Math.max(0, fs);
      w.load = fs;
      w.surface = this.physics.surfaces.get(hit.collider.handle) ?? 'asphalt';

      _p.copy(w.local).applyQuaternion(_q).add(t as THREE.Vector3Like);
      const contact = w.point.copy(_p).addScaledVector(_up, -hit.timeOfImpact);
      _n.set(hit.normal.x, hit.normal.y, hit.normal.z);

      // wheel heading
      const steer = (w.front ? this.steerAngle : 0) + this.damage.toe[i];
      _f.copy(_fwd).multiplyScalar(Math.cos(steer)).addScaledVector(_left, -Math.sin(steer));
      _f.addScaledVector(_n, -_f.dot(_n)).normalize();
      _l.crossVectors(_n, _f).normalize();

      // contact velocity
      _v.copy(contact).sub(t as THREE.Vector3Like);
      _v.crossVectors(_ang, _v).add(_lin);
      const vf = _v.dot(_f);
      const vl = _v.dot(_l);

      // grip
      const grip = SURFACE_GRIP[w.surface];
      const loadSens = 1 - Math.min(0.25, (fs / 5000) * 0.07);
      const fMax = CAR.mu * grip * loadSens * fs * this.gripScale * this.damage.cornerGrip(i);
      const mCorner = CAR.mass / 4;

      // lateral demand first (traction control leaves room for it)
      const { B, C } = CAR.pacejka;
      const alpha = Math.atan2(vl, Math.max(Math.abs(vf), 4));
      const fyDemand = fMax * Math.abs(Math.sin(C * Math.atan(B * alpha)));

      // longitudinal
      let fx = 0;
      if (!w.front) {
        let d = driveLeft / 2;
        const limit = this.tractionControl ? Math.sqrt(Math.max(0, (0.95 * fMax) ** 2 - fyDemand * fyDemand)) + fMax * 0.05 : fMax;
        if (Math.abs(d) > limit) {
          if (this.tractionControl) d = Math.sign(d) * limit;
          else { w.spinning = true; d = Math.sign(d) * fMax * 0.82; }
        }
        fx += d;
      }
      const bf = brake * CAR.brakeForce * (w.front ? 1 : (1 - CAR.brakeBias) / CAR.brakeBias);
      if (bf > 0) {
        let fb = bf;
        if (fb > fMax) {
          if (this.abs) fb = fMax * 0.95;
          else { w.locked = true; fb = fMax * 0.78; }
        }
        fb = Math.min(fb, (mCorner * Math.abs(vf)) / dt);
        fx -= Math.sign(vf) * fb;
      }
      fx -= Math.sign(vf) * Math.min(Math.abs(vf) * 20, 70) + vf * SURFACE_DRAG[w.surface] * 60; // rolling resistance / grass drag

      // lateral (simplified Pacejka with low-speed stabilisation)
      let fy = -fMax * Math.sin(C * Math.atan(B * alpha));
      if (w.locked) fy *= 0.35;
      const fyCap = (mCorner * Math.abs(vl)) / dt;
      if (Math.abs(vf) < 6) fy = THREE.MathUtils.clamp(fy, -fyCap, fyCap);

      // friction circle
      const fyAvail = Math.sqrt(Math.max(0, fMax * fMax - fx * fx));
      if (w.spinning) fy = THREE.MathUtils.clamp(fy, -fyAvail * 0.55, fyAvail * 0.55);
      else fy = THREE.MathUtils.clamp(fy, -fyAvail, fyAvail);

      // suspension force at the contact patch; tire forces at the roll centre height so the
      // (grippy, high-downforce) tires can't lever the car onto its roof in a corner
      _F.copy(_up).multiplyScalar(fs);
      b.applyImpulseAtPoint({ x: _F.x * dt, y: _F.y * dt, z: _F.z * dt }, contact, true);
      _F.copy(_f).multiplyScalar(fx).addScaledVector(_l, fy);
      _p.copy(contact).addScaledVector(_up, 0.3);
      b.applyImpulseAtPoint({ x: _F.x * dt, y: _F.y * dt, z: _F.z * dt }, _p, true);

      // wheel spin for visuals / rpm
      const rolling = vf / WHEEL_RADIUS;
      if (w.locked) w.omega = 0;
      else if (w.spinning) w.omega += (Math.sign(driveForce) * 60 - (w.omega - rolling) * 4) * dt;
      else w.omega = rolling;
      const slipRatio = Math.abs(w.omega * WHEEL_RADIUS - vf) / Math.max(5, Math.abs(vf));
      w.slip = Math.max(Math.abs(alpha) / 0.14, slipRatio * 2, w.locked ? 1.2 : 0) * (fs > 500 ? 1 : 0);
      slipSum += w.slip;
    }

    // ---------- aerodynamics ----------
    const rho = 1.225;
    const dragMag = 0.5 * rho * CAR.dragCdA * (1 + this.damage.dragAdd) * (1 - this.draft) * speed * speed;
    if (speed > 0.1) b.applyImpulse({ x: (-_lin.x / speed) * dragMag * dt, y: (-_lin.y / speed) * dragMag * dt, z: (-_lin.z / speed) * dragMag * dt }, true);
    const down = 0.5 * rho * CAR.liftClA * vFwd * vFwd;
    // roof flaps: deploy when travelling backwards/sideways fast, killing lift so the car stays down
    this.flapsOpen = CAR.roofFlaps && speed > 30 && _lin.dot(_fwd) / speed < -0.3;
    if (this.flapsOpen) b.applyImpulse({ x: 0, y: -0.5 * rho * 1.4 * speed * speed * dt, z: 0 }, true);
    for (const [z, share] of [[CAR.geo.wheelbaseF, CAR.aeroFront * this.damage.aeroFront], [CAR.geo.wheelbaseR, (1 - CAR.aeroFront) * this.damage.aeroRear]] as const) {
      _p.set(0, 0, z).applyQuaternion(_q).add(t as THREE.Vector3Like);
      const f = down * share * dt;
      b.applyImpulseAtPoint({ x: -_up.x * f, y: -_up.y * f, z: -_up.z * f }, _p, true);
    }

    // ---------- telemetry ----------
    const tm = this.telemetry;
    tm.speed = vFwd;
    tm.rpm = tm.rpm + (rpm - tm.rpm) * Math.min(1, dt * 25);
    tm.gear = this.gear;
    tm.throttle = throttle;
    tm.brake = brake;
    tm.steer = this.steerAngle;
    tm.limiter = limiter && throttle > 0.5;
    tm.slip = slipSum / 4;
    if (this.damage.tick(dt, rpm, speed)) this.pendingExplode = true;
    const pv = b.linvel();
    this.preVel.set(pv.x, pv.y, pv.z);
  }

  /** Velocity right before the physics step (after our own tire/aero impulses). */
  private preVel = new THREE.Vector3();

  /**
   * Collision impulse (N·s, world) received during the last physics step: the velocity change not
   * explained by our own forces or gravity. Works for CCD-resolved high-speed hits too.
   */
  collisionImpulse(dt: number): THREE.Vector3 {
    const v = this.body.linvel();
    return new THREE.Vector3(v.x - this.preVel.x, v.y - this.preVel.y + 9.81 * dt, v.z - this.preVel.z - 0).multiplyScalar(this.spec.mass);
  }

  /** Set by damage when a burning car should blow up; the session consumes it. */
  pendingExplode = false;

  /** Gather this step's contacts (call after world.step()). */
  contacts(): CarContact[] {
    const w = this.physics.world;
    const out: CarContact[] = [];
    const r = this.body.rotation();
    const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const inv = rot.clone().invert();
    const t = this.body.translation();
    w.contactPairsWith(this.collider, (other) => {
      w.contactPair(this.collider, other, (m, flipped) => {
        const n = m.numContacts();
        if (!n) return;
        let J = 0, slide = 0;
        const lp = new THREE.Vector3();
        let wsum = 0;
        for (let i = 0; i < n; i++) {
          const imp = m.contactImpulse(i);
          J += imp;
          const p = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
          if (p) { const wt = imp + 1e-3; lp.x += p.x * wt; lp.y += p.y * wt; lp.z += p.z * wt; wsum += wt; }
        }
        for (let i = 0; i < m.numSolverContacts(); i++) {
          const tv = m.solverContactTangentVelocity(i);
          slide = Math.max(slide, Math.hypot(tv.x, tv.y, tv.z));
        }
        if (wsum > 0) lp.divideScalar(wsum);
        const nrm = m.normal();
        // manifold normal points from collider1 to collider2; inward = towards our car
        const inward = new THREE.Vector3(nrm.x, nrm.y, nrm.z).multiplyScalar(flipped ? 1 : -1);
        const world = lp.clone().applyQuaternion(rot).add(t as THREE.Vector3Like);
        out.push({ world, local: lp, inwardLocal: inward.clone().applyQuaternion(inv), normalWorld: inward, impulse: J, slide, other });
      });
    });
    return out;
  }

  loseWheel(i: number) {
    this.wheelGone[i] = true;
    this.wheels[i].contact = false;
  }

  /** Blow the car up: kills it and throws it into the air. */
  explode() {
    this.damage.exploded = true;
    this.damage.destroyed = true;
    this.damage.fire = 1;
    const t = this.body.translation();
    const off = { x: t.x + (Math.random() - 0.5) * 1.5, y: t.y - 0.3, z: t.z + (Math.random() - 0.5) * 2.5 };
    this.body.applyImpulseAtPoint({ x: (Math.random() - 0.5) * 3000, y: 9000 + Math.random() * 4000, z: (Math.random() - 0.5) * 3000 }, off, true);
  }

  /** Store post-step pose (call after world.step()). */
  snapshot() {
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Update the visual model, interpolating between the last two physics states. */
  sync(alpha: number, dt: number) {
    const v = this.visual;
    const pos = _pos.copy(this.prevPos).lerp(this.curPos, alpha);
    const quat = _q.copy(this.prevQuat).slerp(this.curQuat, alpha);
    v.root.quaternion.copy(quat);
    v.root.position.copy(pos).add(_v.set(0, -this.spec.geo.comHeight, 0).applyQuaternion(quat));
    this.visT += dt;
    // loose parts rattle
    for (const [name, st] of Object.entries(this.damage.parts)) if (st === 'loose') wobble(v.parts[name as keyof typeof v.parts], this.visT, Math.abs(this.telemetry.speed));
    this.flapAngle += ((this.flapsOpen ? 1.1 : 0) - this.flapAngle) * Math.min(1, dt * 12);
    v.flaps.forEach((f) => (f.rotation.x = -this.flapAngle));
    v.wiper.visible = this.wiperOn;
    if (this.wiperOn) v.wiper.rotation.z = (Math.sin(this.visT * 3.2) * 0.5 + 0.5) * 1.6;
    for (let i = 0; i < 4; i++) {
      if (this.wheelGone[i]) continue;
      const w = this.wheels[i];
      const pivot = v.wheels[i];
      const ext = this.spec.restLength - (w.contact ? w.comp : 0);
      pivot.position.y = this.hardpointY + this.spec.geo.comHeight - ext;
      pivot.rotation.y = w.front ? -this.steerAngle : 0;
      w.angle += w.omega * dt;
      (pivot.children[0] as THREE.Object3D).rotation.x = w.angle;
      const heat = this.telemetry.brake * Math.min(1, Math.abs(this.telemetry.speed) / 30);
      v.brakeDiscs[i].emissiveIntensity += (heat * 2.5 - v.brakeDiscs[i].emissiveIntensity) * Math.min(1, dt * (heat > 0.1 ? 1.5 : 0.4));
    }
    v.taillights.emissiveIntensity = this.telemetry.brake > 0.05 ? 3 : 0.15;
  }
}
