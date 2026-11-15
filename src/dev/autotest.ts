/**
 * Dev-only physics test driver (loaded only by `npm run dev`). From the browser console:
 *   __run(startIndex | null, lateral, mph, seconds, targetLateral, maxMph, logEvery)
 * steps the simulation synchronously with a feed-forward autopilot and returns a JSON log.
 */
import type { Session } from '../core/session';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function drive(S: Any, target: number, vmax: number) {
  const car = S.car, tr = S.map.track;
  const p = car.position;
  const i = tr.nearest(p, S.progress.index, 80);
  S.progress.index = i;
  const d = tr.lateral(p, i);
  const sp = car.telemetry.speed;
  const T = tr.T[tr.wrap(i + 3)];
  const r = car.body.rotation();
  const fw = { x: 2 * (r.x * r.z + r.w * r.y), z: 1 - 2 * (r.x * r.x + r.y * r.y) };
  const cr = fw.z * T.x - fw.x * T.z;
  const lv = car.body.linvel();
  const latV = lv.x * tr.R[i].x + lv.z * tr.R[i].z;
  let k = 0;
  for (let j = 0; j < 10; j++) k += tr.curvature[tr.wrap(i + j * 3)];
  k /= 10;
  const ang = -2.8 * k - cr * 0.6 - (d - target) * 0.006 - latV * 0.012;
  const lock = 0.58 + (0.07 - 0.58) * Math.min(1, Math.max(0, (Math.abs(sp) - 3) / 59));
  return { i, d, steer: Math.max(-1, Math.min(1, ang / lock)), throttle: sp * 2.237 < vmax ? 1 : 0 };
}

export function installAutotest(getSession: () => Session | null) {
  (window as Any).__run = (startI: number | null, startD: number, mph: number, seconds: number, target = 8, vmax = 999, every = 120) => {
    const S = getSession() as Any;
    const tr = S.map.track, car = S.car, DT = 1 / 120;
    if (startI !== null) {
      const pl = tr.placement(startI, startD, 0.6);
      car.reset(pl.pos, pl.quat);
      car.body.setLinvel(tr.T[startI].clone().multiplyScalar(mph / 2.237), true);
      car.wheels.forEach((w: Any) => (w.omega = mph / 2.237 / 0.34));
      car.gear = mph > 120 ? 4 : 1;
      S.progress.index = startI;
    }
    const log: unknown[] = [];
    const st = { air: 0, minD: 99, maxD: -99, max: 0, spins: 0 };
    for (let k = 0; k < seconds * 120; k++) {
      const c = drive(S, target, vmax);
      car.step({ steer: c.steer, throttle: c.throttle, brake: 0, shiftUp: false, shiftDown: false }, DT);
      S.physics.step();
      car.snapshot();
      S.time += DT;
      S.progress.update(car.position, S.time);
      if (car.wheels.every((w: Any) => !w.contact)) st.air++;
      if (car.telemetry.speed < 0) st.spins++;
      st.minD = Math.min(st.minD, c.d);
      st.maxD = Math.max(st.maxD, c.d);
      st.max = Math.max(st.max, car.telemetry.speed * 2.237);
      if (k % every === 0) {
        const r = car.body.rotation();
        const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
        log.push([(k * DT).toFixed(2), Math.round(car.telemetry.speed * 2.237), c.i, c.d.toFixed(1), (car.telemetry.steer * 57.3).toFixed(2), upY.toFixed(2), car.wheels.map((w: Any) => (w.contact ? Math.round(w.load / 100) : 'X')).join('/'), car.telemetry.slip.toFixed(2)]);
      }
    }
    return JSON.stringify({ st, lap: S.progress.lap, last: S.progress.lastLap.toFixed(2), best: S.progress.bestLap.toFixed(2), log });
  };
}

import { BotDriver } from '../vehicle/bot';

/** `__race(seconds)`: let an AI drive the local car too and fast-forward the whole session. */
export function installRaceTest(getSession: () => Session | null) {
  let ai: BotDriver | null = null;
  let aiCar: unknown = null;
  (window as Any).__race = (seconds: number) => {
    const S = getSession() as Any;
    if (!ai || aiCar !== S.car) { ai = new BotDriver(S.car, S.map.track, 0.97, S.map.oval, 99); aiCar = S.car; }
    const t0 = performance.now();
    S.devAdvance(seconds, (s: Any) => {
      const lim = s.race.phase === 'loading' || s.race.phase === 'countdown' ? 0 : s.race.phase === 'pace' ? s.map.paceSpeed : Infinity;
      const tr = s.map.track;
      const traffic: Any[] = [];
      const add = (pos: Any, vel: Any, dead: boolean) => { const i = tr.nearest(pos); traffic.push({ pos, vel, i, d: tr.lateral(pos, i), dead }); };
      for (const b of s.bots.values()) { const v = b.car.body.linvel(); add(b.car.position.clone(), { length: () => Math.hypot(v.x, v.y, v.z) }, b.car.damage.destroyed); }
      for (const r of s.remotes.values()) add(r.pos.clone(), r.vel.clone(), !!r.latest?.destroyed);
      return ai!.drive(1 / 60, traffic, lim);
    });
    const cars: Any[] = [['me', S.car], ...[...S.bots.entries()].map(([k, b]: Any) => [k, b.car])];
    return JSON.stringify({
      ms: Math.round(performance.now() - t0),
      phase: S.race.phase, flag: S.race.flag,
      standings: S.race.st.map((s: Any) => `${s.pos}:${s.slot} L${s.lap}+${s.frac.toFixed(2)} ${['run', 'fin', 'DNF'][s.status]}`),
      cars: cars.map(([k, c]: Any) => `${k} ${Math.round(c.telemetry.speed * 2.237)}mph int${Math.round(c.damage.integrity * 100)} eng${Math.round(c.damage.engine * 100)} ${c.damage.exploded ? 'BOOM' : c.damage.destroyed ? 'dead' : ''} parts:${Object.entries(c.damage.parts).filter(([, v]) => v === 'gone').map(([p]) => p).join(',')}`),
    });
  };
}
