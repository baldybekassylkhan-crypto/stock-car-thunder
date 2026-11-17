import type * as THREE from 'three';
import type { Track } from '../tracks/track';
import type { Car } from '../vehicle/car';
import type { CarSpec } from '../vehicle/catalog';
import { DRY_COMPOUNDS, type Compound } from '../vehicle/tyres';

/**
 * Pit lane description, in track coordinates (sample indices along the lap, lateral offsets from
 * the inner edge; the lane is on the negative side). Built by each track.
 */
export interface PitInfo {
  /** Where the lane splits off the track and where it rejoins (samples; the lane may wrap). */
  entry: number;
  exit: number;
  /** Speed-limit zone. */
  limitFrom: number;
  limitTo: number;
  /** Lateral offset of the fast lane, and of the stalls. */
  lane: number;
  box: number;
  /** A car beyond this lateral offset (more negative) inside [entry, exit] is in the pit lane. */
  inside: number;
  /** First stall and spacing between stalls (samples). */
  boxFrom: number;
  boxSpacing: number;
}

export interface PitPlan {
  /** New tyres to fit ('keep' = no tyre change). */
  tyre: Compound | 'keep';
  /** Fuel to add (kg). */
  fuel: number;
  /** Fix all damage (slow), or just replace the front wing / nose (GP). */
  repair: boolean;
  wing: boolean;
}

/** Distance (m) before the pit entry over which a car moves to the inside of the track. */
export const pitApproach = (trackLength: number) => Math.min(700, trackLength * 0.35);

/** Pit lane speed limits (m/s): 80 km/h for GP cars, 72 km/h for stock cars. */
export const PIT_LIMIT = { gp: 80 / 3.6, stock: 72 / 3.6 };

/** Is index i inside [a, b] going forward around the lap? */
export function within(track: Track, i: number, a: number, b: number) {
  i = track.wrap(i); a = track.wrap(a); b = track.wrap(b);
  return a <= b ? i >= a && i <= b : i >= a || i <= b;
}

export function inPitLane(track: Track, pit: PitInfo, idx: number, lateral: number) {
  return within(track, idx, pit.entry, pit.exit) && lateral < pit.inside;
}

export function boxIndex(track: Track, pit: PitInfo, k: number) {
  return track.wrap(pit.boxFrom + k * pit.boxSpacing);
}

/** A sensible default plan: fresh tyres (a different dry compound for GP), fuel to full, fix damage. */
export function defaultPlan(car: Car, rain: boolean): PitPlan {
  const spec = car.spec;
  let tyre: Compound = 'stock';
  if (spec.series === 'gp') {
    if (rain) tyre = car.tyres.compound === 'wet' ? 'wet' : 'inter';
    else tyre = car.tyres.compound === 'medium' ? 'hard' : 'medium';
  }
  const fuel = spec.series === 'gp' ? 0 : Math.max(0, spec.fuelTank - car.fuel);
  const d = car.damage;
  const hurt = d.integrity < 0.85 || d.engine < 0.9 || d.punctured.some(Boolean) || d.wheelsLost > 0;
  const wingGone = d.parts.splitter === 'gone' || d.parts.bumperF === 'gone' || d.parts.splitter === 'loose';
  return { tyre, fuel, repair: hurt, wing: spec.series === 'gp' && wingGone && !hurt };
}

/** How much damage there is to fix (0 = none). */
export function damageWork(car: Car) {
  const d = car.damage;
  const lost = Object.values(d.parts).filter((v) => v === 'gone').length;
  return Math.max(0, 1 - d.integrity) + (1 - d.engine) * 0.5 + lost * 0.08 + d.punctured.filter(Boolean).length * 0.05;
}

/** No stop ever takes longer than this (s): long waits aren't fun. */
export const MAX_STOP = 10;

/**
 * Stationary time for a stop (the host decides it, so everyone agrees). GP crews change four
 * tyres in ~2.5–3.4 s; stock cars change four tyres and refuel in ~7–9 s. Repairs and wing changes
 * add time, and now and then a wheel gun sticks — but a stop never takes more than 10 s.
 */
export function pitTime(spec: CarSpec, plan: PitPlan, work: number, rand: () => number = Math.random): number {
  let t = 0;
  if (spec.series === 'gp') {
    if (plan.tyre !== 'keep') t = 2.4 + rand() * 1.0;
    if (plan.wing) t += 2.5 + rand() * 1.5;
  } else {
    const tyres = plan.tyre !== 'keep' ? 7 + rand() * 1.8 : 0;
    const fuel = plan.fuel / 9; // fast fuel rig, in parallel with the tyres
    t = Math.max(tyres, fuel);
  }
  if (plan.repair) t += 1.5 + Math.min(1.6, work) * 3.5;
  if (plan.tyre !== 'keep' && rand() < 0.06) t += 0.8 + rand() * 1.2; // sticky wheel nut
  return Math.min(MAX_STOP, Math.max(1.5, t + 0.3));
}

/** Bot strategy: should this car stop at the next opportunity, and with what plan? */
export function botWantsPit(car: Car, opts: { lapsLeft: number; caution: boolean; rain: boolean; usedDry: number; totalLaps: number; trackKm: number; ruleLap: number }): PitPlan | null {
  const { lapsLeft, caution, rain } = opts;
  if (lapsLeft < 1) return null;
  const spec = car.spec;
  const d = car.damage;
  const wear = Math.max(...car.tyres.wear);
  const fuelLap = spec.fuelBurn * 0.8 * opts.trackKm;
  const needFuel = spec.series !== 'gp' && car.fuel < fuelLap * Math.min(lapsLeft, 1.4);
  const damaged = d.integrity < 0.55 || d.punctured.some(Boolean) || d.wheelsLost > 0 || d.parts.splitter === 'gone' || d.parts.spoiler === 'gone';
  const wornLimit = car.tyres.compound === 'soft' ? 0.62 : 0.72;
  const worn = wear > wornLimit && lapsLeft > 1;
  const cheapStop = caution && lapsLeft > 3 && (wear > 0.35 || (spec.series !== 'gp' && car.fuel < spec.fuelTank * 0.6));
  // GP dry races need two dry compounds: each car stops on its own lap (spread out, not all at once)
  const rule = spec.series === 'gp' && !rain && opts.totalLaps >= 5 && opts.usedDry < 2 && opts.totalLaps - lapsLeft >= opts.ruleLap && lapsLeft >= 1;
  if (!(needFuel || damaged || worn || cheapStop || rule)) return null;
  const plan = defaultPlan(car, rain);
  if (spec.series === 'gp' && !rain) {
    // the softest tyre that lasts the rest of the race
    let pick: Compound = lapsLeft <= 6 ? 'soft' : lapsLeft <= 12 ? 'medium' : 'hard';
    if (opts.usedDry < 2 && car.tyres.used.has(pick)) pick = DRY_COMPOUNDS.find((c) => !car.tyres.used.has(c)) ?? pick;
    plan.tyre = pick;
  }
  // a lost front wing is a quick swap on a GP car; real damage needs the full repair
  const heavy = d.integrity < 0.55 || d.punctured.some(Boolean) || d.wheelsLost > 0 || d.parts.spoiler === 'gone' || spec.series !== 'gp';
  plan.repair = plan.repair || (damaged && heavy);
  if (spec.series === 'gp' && (d.parts.splitter === 'gone' || d.parts.bumperF === 'gone') && !plan.repair) plan.wing = true;
  return plan;
}

/** Track-coordinate position helpers used by the pit logic. */
export function trackPos(track: Track, pos: THREE.Vector3, hint: number) {
  const i = track.nearest(pos, hint, 40);
  return { i, d: track.lateral(pos, i) };
}
