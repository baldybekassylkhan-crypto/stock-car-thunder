import * as THREE from 'three';
import type { DriverInput } from '../core/input';
import type { Track } from '../tracks/track';
import type { Car } from './car';

export interface Traffic {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  i: number;
  d: number;
  /** Wrecked / stopped car: give it a wide berth. */
  dead?: boolean;
}

const G = 9.81;
/** Oval lane limits (m from the inside edge / from the outside wall) so bots don't ride the wall. */
const OVAL_IN = 2.5;
const OVAL_OUT = 3.6;

/**
 * AI driver. Follows a lane with a feed-forward + feedback steering controller, picks its speed
 * from the curvature/banking ahead (with braking distance), drafts and passes slower cars, and
 * lifts when boxed in.
 */
export class BotDriver {
  i = 0;
  d = 0;
  private lane: number;
  private laneTarget: number;
  private passTimer = 0;
  private stuckT = 0;
  /** Smoothed throttle: no snapping off the gas mid-corner (lift-off oversteer). */
  private thr = 0;
  wantsReset = false;

  constructor(readonly car: Car, private track: Track, private skill: number, private oval: boolean, seed: number) {
    const r = ((seed * 9301 + 49297) % 233280) / 233280;
    this.lane = oval ? OVAL_IN + 1.5 + r * (track.width - OVAL_IN - OVAL_OUT - 3) : track.width / 2;
    this.laneTarget = this.lane;
  }

  private maxSpeedAt(i: number): number {
    const tr = this.track;
    const k = Math.abs(tr.curvature[tr.wrap(i)]);
    if (k < 1e-4) return 200;
    const th = Math.abs(tr.bank[tr.wrap(i)]);
    const mu = (this.oval ? 1.05 : 0.98) * this.skill * this.car.gripScale;
    const tan = Math.tan(th);
    const a = (G * (mu + tan)) / Math.max(0.15, 1 - mu * tan);
    return Math.sqrt(a / k);
  }

  drive(dt: number, traffic: Traffic[], raceSpeedLimit: number): DriverInput {
    const car = this.car, tr = this.track;
    const p = car.position;
    this.i = tr.nearest(p, this.i || -1, 60);
    const i = this.i;
    const d = (this.d = tr.lateral(p, i));
    const sp = car.telemetry.speed;
    const lv = car.body.linvel();

    // ---------------- racing line / lane choice ----------------
    let target: number;
    if (this.oval) {
      target = this.lane;
    } else {
      // road course: drift to the inside of upcoming corners (apex), outside on entry
      let k = 0;
      for (let j = 4; j < 30; j += 2) k += tr.curvature[tr.wrap(i + j)];
      k /= 13;
      const turn = THREE.MathUtils.clamp(k * 90, -1, 1);
      target = tr.width / 2 - turn * (tr.width / 2 - 2.2);
    }

    // traffic: look for a car ahead in our lane
    let blocker: Traffic | null = null;
    let gapAhead = Infinity;
    for (const o of traffic) {
      let di = o.i - i;
      if (di < -tr.n / 2) di += tr.n;
      if (di > tr.n / 2) di -= tr.n;
      const gap = di * tr.ds;
      const width = o.dead ? 3.6 : 2.6;
      if (gap > 2 && gap < (o.dead ? 90 : 45) && Math.abs(o.d - (this.oval ? this.laneTarget : d)) < width && gap < gapAhead) {
        gapAhead = gap;
        blocker = o;
      }
    }
    this.passTimer -= dt;
    if (blocker && (this.passTimer <= 0 || blocker.dead)) {
      const closing = sp - blocker.vel.length();
      if (closing > 0.5 || gapAhead < 14 || blocker.dead) {
        // choose a side with room
        const off = blocker.dead ? 4.6 : 3.6;
        const sides = [blocker.d - off, blocker.d + off].filter((x) => x > (this.oval ? OVAL_IN : 2) && x < tr.width - (this.oval ? OVAL_OUT : 2));
        const free = sides.filter((x) => !traffic.some((o) => {
          let di = o.i - i;
          if (di < -tr.n / 2) di += tr.n;
          if (di > tr.n / 2) di -= tr.n;
          return Math.abs(di * tr.ds) < 9 && Math.abs(o.d - x) < 2.4;
        }));
        if (free.length) {
          this.laneTarget = free.sort((a, b) => Math.abs(a - d) - Math.abs(b - d))[0];
          this.passTimer = 3;
          if (this.oval) this.lane = this.laneTarget;
        }
      }
    }
    if (this.oval) target = this.laneTarget;
    else if (this.passTimer > 0) target = THREE.MathUtils.lerp(target, this.laneTarget, 0.7);
    target = this.oval ? THREE.MathUtils.clamp(target, OVAL_IN, tr.width - OVAL_OUT) : THREE.MathUtils.clamp(target, 2, tr.width - 2);

    // ---------------- steering ----------------
    const T = tr.T[tr.wrap(i + 3)];
    const r = car.body.rotation();
    const fw = { x: 2 * (r.x * r.z + r.w * r.y), z: 1 - 2 * (r.x * r.x + r.y * r.y) };
    const cr = fw.z * T.x - fw.x * T.z;
    const latV = lv.x * tr.R[i].x + lv.z * tr.R[i].z;
    let k = 0;
    for (let j = 0; j < 10; j++) k += tr.curvature[tr.wrap(i + j * 2)];
    k /= 10;
    let ang = -2.8 * k - cr * 0.65 - (d - target) * (this.oval ? 0.006 : 0.012) - latV * 0.014;
    // wall avoidance: steer away harder the closer the car drifts to either edge
    const wallGap = tr.width - d;
    if (wallGap < 2.8) ang -= (2.8 - wallGap) * 0.025;
    if (d < 1.2) ang += (1.2 - d) * 0.025;
    // yaw damping: countersteer when the car rotates faster (or slower) than the corner needs
    const yawErr = car.body.angvel().y - sp * tr.curvature[i];
    ang += THREE.MathUtils.clamp(yawErr, -1.5, 1.5) * 0.12;
    const lock = THREE.MathUtils.lerp(0.58, 0.07, THREE.MathUtils.smoothstep(Math.abs(sp), 3, 62));
    const steer = THREE.MathUtils.clamp(ang / lock, -1, 1);

    // ---------------- speed ----------------
    let vT = Infinity;
    const horizon = Math.min(tr.n / 3, Math.round(260 / tr.ds));
    for (let j = 0; j < horizon; j += 2) {
      const dist = j * tr.ds;
      const v = Math.sqrt(this.maxSpeedAt(i + j) ** 2 + 2 * (this.oval ? 8.5 : 7) * this.skill * this.car.gripScale * dist);
      vT = Math.min(vT, v);
    }
    vT *= 0.97 + 0.03 * this.skill;
    // drifting toward the outside wall: lift a little
    if (wallGap < 3) vT *= 0.985 - Math.max(0, 3 - wallGap) * 0.01;
    // don't drive into the back of a slower car: keep a braking gap to anything ahead in our line
    for (const o of traffic) {
      let di = o.i - i;
      if (di < -tr.n / 2) di += tr.n;
      if (di > tr.n / 2) di -= tr.n;
      const gap = di * tr.ds;
      if (gap < 3 || gap > 60 || Math.abs(o.d - d) > (o.dead ? 3.4 : 2.4)) continue;
      const vb = o.vel.length();
      vT = Math.min(vT, Math.sqrt(Math.max(0, vb * vb + 2 * 6 * this.car.gripScale * (gap - 8))));
    }
    vT = Math.min(vT, raceSpeedLimit);
    const err = vT - sp;
    let throttle = THREE.MathUtils.clamp(err * 0.5, 0, 1);
    let brake = THREE.MathUtils.clamp(-err * 0.22, 0, 1);
    if (Math.abs(sp) < 3 && raceSpeedLimit > 1) { throttle = 1; brake = 0; }
    // ease off the gas instead of snapping shut, unless we need the brakes
    if (brake > 0.05) this.thr = 0;
    else this.thr = throttle < this.thr ? Math.max(throttle, this.thr - dt * 2.5) : throttle;
    throttle = this.thr;

    // stuck detection → ask for a reset
    if (raceSpeedLimit > 5 && Math.abs(sp) < 2 && !car.damage.destroyed && car.damage.engineWear < 1) this.stuckT += dt;
    else this.stuckT = 0;
    if (this.stuckT > 4) { this.wantsReset = true; this.stuckT = 0; }

    return { steer, throttle, brake, shiftUp: false, shiftDown: false };
  }
}
