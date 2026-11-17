import type * as THREE from 'three';
import type { Track } from '../tracks/track';
import type { Car } from '../vehicle/car';
import type { RaceSnapshot } from './race';

/**
 * Per-car race rules that every peer runs for the cars it simulates:
 *  - drag-reduction flap (DRS) zones: within 1.0 s of the car ahead at the detection point →
 *    the flap may be opened in the next zone (not under yellow flags);
 *  - track limits on road courses: 3 warnings, the 4th time is a 5 s penalty;
 *  - blue flags: a car about to be lapped is shown blue;
 *  - local yellow flags around incidents.
 */
export interface DrsZone {
  /** Detection point and the zone itself (track sample indices; the zone may wrap). */
  detect: number;
  start: number;
  end: number;
}

/** Straights long enough for a flap zone, longest first (up to three). */
export function drsZones(track: Track): DrsZone[] {
  const n = track.n;
  const straight = (i: number) => Math.abs(track.curvature[track.wrap(i)]) < 1.6e-3;
  // start scanning from a corner so a straight isn't split at the wrap
  let s0 = 0;
  while (s0 < n && straight(s0)) s0++;
  const runs: { a: number; len: number }[] = [];
  let a = -1;
  for (let k = 0; k <= n; k++) {
    const i = track.wrap(s0 + k);
    if (straight(i) && k < n) { if (a < 0) a = i; }
    else if (a >= 0) {
      const len = track.wrap(i - a) * track.ds;
      runs.push({ a, len });
      a = -1;
    }
  }
  const good = runs.filter((r) => r.len > 330).sort((x, y) => y.len - x.len);
  const take = good.filter((r, k) => k < 2 || (k === 2 && r.len > 500));
  return take.map((r) => {
    const start = track.wrap(r.a + Math.round(40 / track.ds));
    const end = track.wrap(r.a + Math.round((r.len - 60) / track.ds));
    return { detect: track.wrap(start - Math.round(130 / track.ds)), start, end };
  });
}

/** Is index i inside [a, b] going forward around the lap? */
function within(i: number, a: number, b: number) {
  return a <= b ? i >= a && i <= b : i >= a || i <= b;
}

export interface AidCar {
  slot: number;
  pos: THREE.Vector3;
  speed: number;
  /** The physics car, if this peer simulates it (only those get flaps, warnings, penalties). */
  car: Car | null;
  /** In the pit lane: no drag flap, no track limits. */
  inPit?: boolean;
}

interface CarState { idx: number; eligible: number; offT: number; warn: number; cool: number }

export class RaceAids {
  readonly zones: DrsZone[];
  private st = new Map<number, CarState>();
  /** Results of the last update, per slot. */
  readonly blue = new Set<number>();
  readonly yellow = new Set<number>();
  readonly index = new Map<number, number>();

  constructor(private track: Track, private roadCourse: boolean, private hasDrs: boolean) {
    this.zones = hasDrs ? drsZones(track) : [];
  }

  update(dt: number, cars: AidCar[], race: RaceSnapshot, onWarning: (slot: number, n: number) => void, onPenalty: (slot: number, sec: number, why: string) => void) {
    const tr = this.track;
    const green = race.phase === 'green';
    this.blue.clear();
    this.yellow.clear();
    for (const c of cars) {
      let s = this.st.get(c.slot);
      const idx = tr.nearest(c.pos, s ? s.idx : -1, 30);
      if (!s) { s = { idx, eligible: -1, offT: 0, warn: 0, cool: 0 }; this.st.set(c.slot, s); }
      s.idx = idx;
      this.index.set(c.slot, idx);
    }
    const progress = new Map(race.st.map((x) => [x.slot, x.lap + x.frac]));
    const ahead = (from: number, to: number) => tr.wrap(to - from) * tr.ds; // metres forward
    for (const c of cars) {
      const s = this.st.get(c.slot)!;
      const idx = s.idx;
      // local yellow: from 200 m before an incident to 60 m past it
      for (const y of race.yellow) if (within(idx, tr.wrap(y - Math.round(200 / tr.ds)), tr.wrap(y + Math.round(60 / tr.ds)))) this.yellow.add(c.slot);
      // blue flag: a car at least half a lap up the road is within 1.5 s behind
      const mine = progress.get(c.slot) ?? 0;
      for (const o of cars) {
        if (o.slot === c.slot) continue;
        const behind = ahead(this.st.get(o.slot)!.idx, idx);
        if (behind > 0 && behind < Math.max(20, o.speed * 1.5) && (progress.get(o.slot) ?? 0) - mine >= 0.5) { this.blue.add(c.slot); break; }
      }
      if (!c.car) continue;
      // ---- drag flap ----
      if (this.hasDrs) {
        for (let z = 0; z < this.zones.length; z++) {
          const zone = this.zones[z];
          if (this.crossed(c.slot, zone.detect)) {
            let gap = Infinity;
            for (const o of cars) if (o.slot !== c.slot) { const d = ahead(idx, this.st.get(o.slot)!.idx); if (d > 0.5) gap = Math.min(gap, d); }
            s.eligible = race.drs && gap / Math.max(10, c.speed) < 1.0 ? z : -1;
          }
        }
        const zi = this.zones.findIndex((zone) => within(idx, zone.start, zone.end));
        if (zi < 0 && s.eligible >= 0 && !within(idx, this.zones[s.eligible].detect, this.zones[s.eligible].end)) s.eligible = -1;
        c.car.drsAllowed = race.drs && zi >= 0 && zi === s.eligible && !this.yellow.has(c.slot) && !c.inPit;
      } else c.car.drsAllowed = false;
      // ---- track limits (road courses) ----
      s.cool -= dt;
      if (this.roadCourse && green && c.speed > 15 && !c.inPit) {
        const lat = tr.lateral(c.pos, idx);
        const off = lat < -1.25 || lat > tr.width + 1.25;
        s.offT = off ? s.offT + dt : 0;
        if (s.offT > 0.35 && s.cool <= 0) {
          s.cool = 4;
          s.warn++;
          if (s.warn % 4 === 0) onPenalty(c.slot, 5, 'track limits');
          else onWarning(c.slot, s.warn % 4);
        }
      }
    }
    for (const c of cars) this.last.set(c.slot, this.st.get(c.slot)!.idx);
  }

  private last = new Map<number, number>();
  /** Did this car pass sample `at` since the previous update? */
  private crossed(slot: number, at: number) {
    const prev = this.last.get(slot);
    const now = this.st.get(slot)?.idx;
    if (prev === undefined || now === undefined || prev === now) return false;
    const step = this.track.wrap(now - prev);
    if (step > this.track.n / 2) return false; // went backwards
    return this.track.wrap(at - prev) <= step && this.track.wrap(at - prev) > 0;
  }
}
