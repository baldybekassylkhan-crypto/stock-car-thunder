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

/** `__startTest()`: checks cars stay put through the countdown, then all launch forward. */
export function installStartTest(getSession: () => Session | null) {
  (window as Any).__startTest = () => {
    const S = getSession() as Any;
    const cars: [string, Any][] = [['me', S.car], ...[...S.bots.entries()].map(([k, b]: Any) => [String(k), b.car] as [string, Any])];
    const start = cars.map(([, c]) => c.position.clone());
    const idle = () => ({ steer: 0, throttle: 1, brake: 0, shiftUp: false, shiftDown: false }); // player mashing throttle
    let maxMove = 0, maxBack = 0;
    for (let t = 0; t < 3.7; t += 0.1) {
      S.devAdvance(0.1, idle);
      cars.forEach(([, c], k) => { maxMove = Math.max(maxMove, c.position.distanceTo(start[k])); maxBack = Math.min(maxBack, c.telemetry.speed); });
    }
    const duringCountdown = { phase: S.race.phase, maxMove: +maxMove.toFixed(2), minSpeed: +maxBack.toFixed(2) };
    S.devAdvance(8, idle);
    const tr = S.map.track;
    const after = cars.map(([k, c]) => `${k}:${Math.round(c.telemetry.speed * 2.237)}mph gear${c.telemetry.gear} moved${c.position.distanceTo(start[cars.findIndex(([kk]) => kk === k)]).toFixed(0)}m i${tr.nearest(c.position)}`);
    return JSON.stringify({ duringCountdown, phaseAfter: S.race.phase, flag: S.race.flag, after, laps: S.race.st.map((s: Any) => s.lap) });
  };
}

import { CarDamage } from '../damage/damage';

/**
 * `__damageTest(seconds)`: fast-forwards a pack race (all cars AI-driven) and reports how many cars
 * were destroyed, plus a histogram of impacts by strength and what destroyed each car.
 */
export function installDamageTest(getSession: () => Session | null) {
  (window as Any).__CarDamage = CarDamage;
  (window as Any).__damageTest = (seconds = 300) => {
    const S = getSession() as Any;
    const hist: Record<string, number> = {};
    const causes: string[] = [];
    let maxJ = 0;
    let smallHitKills = 0;
    const seen = new Set<CarDamage>();
    CarDamage.onImpact = (J, carHit, res, d) => {
      const b = `${carHit ? 'car' : 'wall'}<${J < 500 ? 500 : J < 1000 ? 1000 : J < 2000 ? 2000 : J < 4000 ? 4000 : J < 8000 ? 8000 : 'max'}`;
      hist[b] = (hist[b] ?? 0) + 1;
      maxJ = Math.max(maxJ, J);
      if ((d.destroyed || res.explode) && !seen.has(d)) {
        seen.add(d);
        if (J < (carHit ? d.profile.carJ0 : d.profile.wallJ0) * 4) smallHitKills++;
        causes.push(`${carHit ? 'car' : 'wall'} J=${Math.round(J)} sev=${res.severity.toFixed(2)} eng=${d.engine.toFixed(2)} int=${d.integrity.toFixed(2)}${res.explode ? ' DEADLY' : ''}`);
      }
    };
    const out = JSON.parse((window as Any).__race(seconds));
    CarDamage.onImpact = undefined;
    const cars = [S.car, ...[...S.bots.values()].map((b: Any) => b.car)];
    const destroyed = cars.filter((c: Any) => c.damage.destroyed).length;
    return JSON.stringify({
      // a clean pack race should wreck well under one car, and never from a light contact
      pass: destroyed <= 1 && smallHitKills === 0,
      seconds, cars: cars.length, destroyed, smallHitKills,
      exploded: cars.filter((c: Any) => c.damage.exploded).length,
      punctures: cars.reduce((a: number, c: Any) => a + c.damage.punctured.filter(Boolean).length, 0),
      minIntegrity: Math.min(...cars.map((c: Any) => c.damage.integrity)).toFixed(2),
      maxJ: Math.round(maxJ), hist, causes, laps: out.standings.slice(0, 3),
    });
  };
}

/** `await __quickRace(map, damage, bots, laps, series, car)`: from the main menu, start a single race through the lobby UI. */
export function installQuickRace(getSession: () => Session | null) {
  (window as Any).__quickRace = async (map = 'sunvale', damage = 'realistic', bots = 9, laps = 10, series = 'stock', car = '') => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const btn = (pred: (t: string) => boolean) => [...document.querySelectorAll('button')].find((b) => pred(b.textContent ?? ''));
    btn((t) => t.startsWith('Single'))?.click();
    await wait(300);
    const set = (id: string, v: string) => { const el = document.querySelector<HTMLSelectElement>(`#${id}`)!; el.value = v; el.dispatchEvent(new Event('change')); };
    // series first: the track list depends on it
    set('series', series); set('samecar', car); // car = '' → free choice, else everyone drives it
    await wait(100);
    document.querySelector<HTMLElement>(`.map-opt[data-id="${map}"]`)?.click();
    await wait(100);
    set('dmg', damage); set('laps', String(laps)); set('bots', String(bots));
    btn((t) => t === 'Start race')?.click();
    for (let i = 0; i < 80 && !(getSession() as Any)?.bots?.size; i++) await wait(250);
    await wait(3500);
    const S = getSession() as Any;
    return `${S.map.def?.id ?? map} ${S.cfg.damage} bots=${S.bots.size}`;
  };
}

/** `await __quickArena(bots, events, timeLimit)`: from the main menu, start a Demolition Arena match vs AI. */
export function installQuickArena() {
  (window as Any).__quickArena = async (bots = 7, events = 'off', timeLimit = 0) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Play solo → switch the lobby to the Demolition Arena
    document.querySelector<HTMLElement>('#single')?.click();
    await wait(400);
    document.querySelector<HTMLElement>('.mode-tab[data-mode="arena"]')?.click();
    await wait(600);
    const set = (id: string, v: string) => { const el = document.querySelector<HTMLSelectElement>(`#${id}`)!; el.value = v; el.dispatchEvent(new Event('change')); };
    set('bots', String(bots)); set('events', events); set('time', String(timeLimit));
    document.querySelector<HTMLElement>('#start')?.click();
    const A = () => (window as Any).__a();
    for (let i = 0; i < 80 && !(A()?.phase && A().phase !== 'loading'); i++) await wait(250);
    return `${A()?.grid.length} cars, events: ${A()?.eventIds.join(',') || 'none'}`;
  };
}
