import * as THREE from 'three';
import type { DriverInput } from '../core/input';
import type { Track } from '../tracks/track';
import type { Car } from './car';
import { COMPOUNDS } from './tyres';

export interface Traffic {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  i: number;
  d: number;
  /** Wrecked / stopped car: give it a wide berth. */
  dead?: boolean;
}

const G = 9.81;
/** Downforce per mass per (m/s)² of the reference stock car the base grip numbers were tuned on. */
const C_STOCK = (0.5 * 1.225 * 1.0) / 1550;
/** Highest lateral load (g) a bot will plan a corner for. */
const MAX_LAT_G = 3.8;
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
  /** Progress watchdog: a car grinding along a wall can show wheel speed but go nowhere. */
  private progT = 0;
  private progI = -1;
  /** Smoothed throttle: no snapping off the gas mid-corner (lift-off oversteer). */
  private thr = 0;
  wantsReset = false;
  /** Set by the session: shown the blue flag (about to be lapped) → let the faster car by. */
  blue = false;
  /** Slowly filtered wake: plan for dirty air without jumpy target speeds. */
  private wakeF = 0;

  constructor(readonly car: Car, private track: Track, private skill: number, private oval: boolean, seed: number) {
    const r = ((seed * 9301 + 49297) % 233280) / 233280;
    this.lane = oval ? OVAL_IN + 1.5 + r * (track.width - OVAL_IN - OVAL_OUT - 3) : track.width / 2;
    this.laneTarget = this.lane;
  }

  /** Corner speed at sample i for a car at lateral offset `lane` (inside lanes are tighter turns). */
  maxSpeedAt(i: number, lane = this.track.width / 2): number {
    const tr = this.track;
    const kc = tr.curvature[tr.wrap(i)];
    if (Math.abs(kc) < 1e-4) return 200;
    // lateral offsets run from the inner (left) edge: left turns tighten toward d = 0, right turns toward the wall
    const inward = (kc > 0 ? 1 : -1) * (tr.width / 2 - lane);
    const k = 1 / Math.max(5, 1 / Math.abs(kc) - inward);
    const th = Math.abs(tr.bank[tr.wrap(i)]);
    const mu = (this.oval ? 1.05 : 0.98) * this.gripK * this.skill * this.car.gripScale;
    const tan = Math.tan(th);
    // lateral capacity: v²k = [g(μ + tanθ) + μ·c·v²] / (1 − μ·tanθ), where c·v² is the extra
    // downforce (per mass) over the reference car → v² = g(μ + tanθ) / (k(1 − μ·tanθ) − μ·c)
    const den = Math.max(0.15, 1 - mu * tan);
    const lim = k * den - mu * this.aeroC * 0.85;
    // never plan for more lateral load than tyres and suspension really take (banking + downforce
    // multiply in the formula above and would ask for 8 g on a steep short oval)
    const vCap = Math.sqrt((MAX_LAT_G * G) / k);
    if (lim <= 1e-5) return Math.min(200, vCap);
    return Math.min(200, vCap, Math.sqrt((G * (mu + tan)) / lim));
  }

  /** Car grip relative to the reference stock car the base numbers were tuned on. */
  // current tyre grip (temperature, wear, compound) is part of what the car can do right now
  private get gripK() { return (this.car.spec.mu / 1.36) * this.car.tyreGrip; }
  /** Downforce per mass per (m/s)² beyond the reference stock car (negative = less). */
  private get aeroC() {
    // in another car's wake some front downforce is gone: plan corners for what is left
    const wake = 1 - this.car.spec.wakeLoss * this.wakeF * 0.75;
    return (0.5 * 1.225 * this.car.spec.liftClA * wake) / this.car.mass - C_STOCK;
  }
  /** Braking deceleration available at speed v (downforce helps). */
  decelAt(v: number) {
    return (this.oval ? 8.5 : 7) * this.gripK * Math.min(1, this.car.brakeEff / 0.9) * (1 + Math.max(0, this.aeroC) * v * v / G * 0.5);
  }

  drive(dt: number, traffic: Traffic[], raceSpeedLimit: number): DriverInput {
    const car = this.car, tr = this.track;
    const p = car.position;
    this.wakeF += (Math.max(this.wakeF * 0.98, car.wake) - this.wakeF) * Math.min(1, dt * 1.2);
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
    const lock = THREE.MathUtils.lerp(car.spec.steerLock[0], car.spec.steerLock[1], THREE.MathUtils.smoothstep(Math.abs(sp), 3, 62));
    const steer = THREE.MathUtils.clamp(ang / lock, -1, 1);

    // ---------------- speed ----------------
    // in a pack (car alongside or right ahead) leave some grip in hand for bumps and dirty air
    const crowded = traffic.some((o) => {
      let di = o.i - i;
      if (di < -tr.n / 2) di += tr.n;
      if (di > tr.n / 2) di -= tr.n;
      const along = di * tr.ds;
      return along > -6 && along < 14 && Math.abs(o.d - d) < 4;
    });
    let vT = Infinity;
    const horizon = Math.min(tr.n / 3, Math.round(260 / tr.ds));
    for (let j = 0; j < horizon; j += 2) {
      const dist = j * tr.ds;
      const vc = this.maxSpeedAt(i + j, target) * (crowded ? 0.97 : 1);
      const v = Math.sqrt(vc ** 2 + 2 * this.decelAt(Math.min(vc, 90)) * this.skill * this.car.gripScale * dist);
      vT = Math.min(vT, v);
    }
    vT *= 0.97 + 0.03 * this.skill;
    // tyre management: back off a little when the tyres overheat
    const t = this.car.tyres.temp, hi = COMPOUNDS[this.car.tyres.compound].window[1];
    const over = Math.max(0, (t[0] + t[1] + t[2] + t[3]) / 4 - hi);
    if (over > 3) vT *= Math.max(0.95, 1 - over * 0.003);
    // blue flag: lift slightly so the leader can get by
    if (this.blue) vT *= 0.95;
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
      vT = Math.min(vT, Math.sqrt(Math.max(0, vb * vb + 2 * 6 * this.gripK * this.car.gripScale * (gap - 8))));
    }
    vT = Math.min(vT, raceSpeedLimit);
    const err = vT - sp;
    let throttle = THREE.MathUtils.clamp(err * 0.5, 0, 1);
    let brake = THREE.MathUtils.clamp(-err * 0.22, 0, 1);
    // trail braking: the tighter the corner is already loading the tyres, the less brake is left
    const vCorner = this.maxSpeedAt(i, d);
    const latUse = THREE.MathUtils.clamp((sp * sp) / (vCorner * vCorner), 0, 1);
    brake = Math.min(brake, Math.max(0.2, 1 - latUse * 0.95));
    if (Math.abs(sp) < 3 && raceSpeedLimit > 1) { throttle = 1; brake = 0; }
    // sliding (rotating faster than the corner): no power until it's caught, or it spins
    const slide = Math.abs(yawErr);
    if (slide > 0.08) throttle = Math.min(throttle, THREE.MathUtils.clamp(1 - (slide - 0.08) * 6, 0.15, 1));
    // ease off the gas instead of snapping shut, unless we need the brakes
    if (brake > 0.05) this.thr = 0;
    else this.thr = throttle < this.thr ? Math.max(throttle, this.thr - dt * (slide > 0.08 ? 6 : 2.5)) : throttle;
    throttle = this.thr;

    // stuck detection → ask for a reset
    if (raceSpeedLimit > 5 && Math.abs(sp) < 2 && !car.damage.destroyed && car.damage.engineWear < 1) this.stuckT += dt;
    else this.stuckT = 0;
    // reset before race control would throw a caution for a stopped car (3 s)
    if (this.stuckT > 2) { this.wantsReset = true; this.stuckT = 0; }
    if (raceSpeedLimit > 5 && !car.damage.destroyed && car.damage.engineWear < 1) {
      if (this.progI < 0) this.progI = i;
      this.progT += dt;
      if (this.progT > 2.5) {
        let di = i - this.progI;
        if (di < -tr.n / 2) di += tr.n;
        if (di > tr.n / 2) di -= tr.n;
        this.progT = 0;
        this.progI = i;
        if (di * tr.ds < 4) { this.wantsReset = true; this.progI = -1; }
      }
    } else { this.progT = 0; this.progI = -1; }

    // energy boost on straights when there is charge to spare (more eagerly when chasing or defending)
    let boost = false;
    if (this.car.spec.ers && throttle > 0.95 && brake === 0 && sp > 25) {
      let straightAhead = true;
      for (let j = 0; j < Math.round(120 / tr.ds); j += 3) if (Math.abs(tr.curvature[tr.wrap(i + j)]) > 3.5e-3) { straightAhead = false; break; }
      boost = straightAhead && car.telemetry.battery > (gapAhead < 40 ? 0.1 : 0.3);
    }
    return { steer, throttle, brake, shiftUp: false, shiftDown: false, drs: car.drsAllowed, boost };
  }
}
