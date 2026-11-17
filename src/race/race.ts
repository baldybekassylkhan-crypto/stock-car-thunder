import type * as THREE from 'three';
import { LapProgress } from '../core/progress';
import type { Track } from '../tracks/track';

/**
 * When race control lowers the speed limit (caution), slow down to it gradually (≈4 m/s²) instead
 * of braking hard mid-corner, which spun whole fields. 0 (grid hold) and raising the limit apply at once.
 */
export function easeLimit(prev: number, target: number, speed: number, dt: number): number {
  if (target === 0 || target >= prev) return target;
  const from = Math.min(prev, Math.max(Math.abs(speed), target));
  return Math.max(target, from - 4 * dt);
}

export type Phase = 'loading' | 'countdown' | 'pace' | 'green' | 'caution' | 'finished';
export type Flag = 'none' | 'green' | 'yellow' | 'white' | 'checkered';

export interface Standing {
  slot: number;
  lap: number; // laps completed
  frac: number; // 0..1 around current lap
  last: number;
  best: number;
  status: 0 | 1 | 2; // racing, finished, DNF
  total: number; // finish time (s) once finished
  pos: number;
  /** Time penalties (s), added to the finish time. */
  pen: number;
}

export interface RaceSnapshot {
  phase: Phase;
  flag: Flag;
  cd: number; // countdown seconds remaining
  laps: number;
  leaderLap: number;
  st: Standing[];
  msg?: string;
  /** Track sample indices of recent incidents: local yellow flags around them. */
  yellow: number[];
  /** Drag-reduction flaps are enabled (green flag, racing settled). */
  drs: boolean;
  /** 'sc' safety car, 'vsc' virtual safety car (GP), '' otherwise. */
  sc: '' | 'sc' | 'vsc';
}

export interface Entrant {
  slot: number;
  pos: () => THREE.Vector3;
  speed: () => number;
  destroyed: () => boolean;
  /** In the pit lane (stopping there is not an incident). */
  inPit?: () => boolean;
}

export interface ResultRow {
  slot: number;
  pos: number;
  laps: number;
  best: number;
  total: number;
  status: 0 | 1 | 2;
  pen: number;
}

/** Incidents keep a local yellow flag out this long (s) after the car moves again. */
const YELLOW_HOLD = 8;

/**
 * Host-side race control: standing start (countdown on the grid) → green → cautions for
 * wrecks → white flag → checkered → results. Clients receive RaceSnapshots and mirror them.
 */
export class RaceDirector {
  phase: Phase = 'loading';
  flag: Flag = 'none';
  time = 0;
  private phaseT = 0;
  private progress = new Map<number, LapProgress>();
  private stats = new Map<number, Standing>();
  private stopped = new Map<number, number>();
  private finishOrder: number[] = [];
  private winnerTime = 0;
  private cautionReason = '';
  /** Local yellow flags: incident sample index → time it was last confirmed. */
  private incidents = new Map<number, { i: number; t: number }>();
  private sc: '' | 'sc' | 'vsc' = '';
  /** Cars currently wrecked (they respawn 20 s later and keep racing). */
  private wrecked = new Set<number>();
  msg = '';
  readonly practice: boolean;

  constructor(track: Track, readonly laps: number, private entrants: Entrant[], startIndex: (slot: number) => number, readonly paceSpeed: number, readonly series: 'stock' | 'gp' = 'stock') {
    this.practice = laps === 0;
    for (const e of entrants) {
      const lp = new LapProgress(track);
      lp.reset(startIndex(e.slot), 0);
      this.progress.set(e.slot, lp);
      this.stats.set(e.slot, { slot: e.slot, lap: 0, frac: 0, last: 0, best: 0, status: 0, total: 0, pos: 0, pen: 0 });
    }
  }

  removeEntrant(slot: number) {
    this.entrants = this.entrants.filter((e) => e.slot !== slot);
    const s = this.stats.get(slot);
    if (s && s.status === 0) s.status = 2;
  }

  start() {
    this.phase = 'countdown';
    this.phaseT = 0;
  }

  /** Speed cap all cars must respect right now (m/s). */
  get speedLimit(): number {
    if (this.phase === 'countdown' || this.phase === 'loading') return 0;
    if (this.phase === 'pace') return this.paceSpeed;
    if (this.phase === 'caution') return this.sc === 'vsc' ? this.paceSpeed * 1.35 : this.paceSpeed * 0.9;
    return Infinity;
  }

  update(dt: number) {
    this.time += dt;
    this.phaseT += dt;
    if (this.phase === 'countdown' && this.phaseT >= 4) {
      // standing start: everyone launches from the grid on GO
      this.phase = 'green';
      this.flag = 'green';
      this.phaseT = 0;
      this.msg = this.practice ? 'GO!' : 'GREEN FLAG — GO!';
    }
    let leaderStarted = false;
    for (const e of this.entrants) {
      const lp = this.progress.get(e.slot)!;
      const st = this.stats.get(e.slot)!;
      if (this.phase === 'countdown' || this.phase === 'loading') continue;
      const completed = lp.update(e.pos(), this.time);
      if (lp.lap >= 1) leaderStarted = true;
      st.frac = lp.fraction;
      st.lap = Math.max(0, lp.lap - 1);
      st.last = lp.lastLap;
      st.best = lp.bestLap;
      // a wreck brings out the yellow, but the car respawns and stays in the race
      if (st.status === 0 && e.destroyed()) {
        if (!this.wrecked.has(e.slot)) {
          this.wrecked.add(e.slot);
          this.incidents.set(e.slot, { i: lp.index, t: this.time });
          if (!this.practice && this.phase === 'green') this.caution('Wreck', 'sc');
        }
      } else this.wrecked.delete(e.slot);
      if (completed && st.status === 0 && !this.practice && (this.flag === 'checkered' || st.lap >= this.laps)) {
        st.status = 1;
        st.total = this.time;
        this.finishOrder.push(e.slot);
        if (this.finishOrder.length === 1) { this.flag = 'checkered'; this.winnerTime = this.time; }
      }
      // stopped car on track → caution
      if (this.phase === 'green' && !this.practice && st.status === 0) {
        if (e.speed() < 4 && !e.inPit?.() && !this.wrecked.has(e.slot)) {
          const t = (this.stopped.get(e.slot) ?? 0) + dt;
          this.stopped.set(e.slot, t);
          if (t > 1.5) this.incidents.set(e.slot, { i: lp.index, t: this.time });
          // stock cars: caution after 3 s; GP: a local yellow first, a virtual safety car if it stays there
          if (this.series === 'gp' ? t > 10 : t > 3) { this.caution('Stopped car', 'vsc'); this.stopped.set(e.slot, -15); }
        } else if ((this.stopped.get(e.slot) ?? 0) > 0) this.stopped.set(e.slot, 0);
      }
      // wrecks stay a local yellow until the car is back
      if (this.wrecked.has(e.slot) && this.incidents.has(e.slot)) this.incidents.get(e.slot)!.t = this.time;
    }
    if (this.phase === 'pace' && leaderStarted) {
      this.phase = 'green';
      this.flag = 'green';
      this.phaseT = 0;
      this.msg = 'GREEN FLAG!';
    }
    for (const [k, inc] of this.incidents) if (this.time - inc.t > YELLOW_HOLD) this.incidents.delete(k);
    if (this.phase === 'caution' && this.phaseT > (this.sc === 'vsc' ? 14 : 22) && this.flag !== 'checkered') {
      this.sc = '';
      this.phase = 'green';
      this.flag = 'green';
      this.phaseT = 0;
      this.msg = 'GREEN FLAG — RACING RESUMES';
    }
    // white flag
    const ordered = this.standings();
    const leader = ordered[0];
    if (!this.practice && leader && this.flag === 'green' && leader.lap === this.laps - 1) this.flag = 'white';
    // everybody out (or finished) → race over
    if (!this.practice && this.phase !== 'finished' && this.phase !== 'countdown' && this.phase !== 'loading' && ordered.length && ordered.every((s) => s.status !== 0)) {
      if (this.flag !== 'checkered') this.flag = 'checkered';
      this.phase = 'finished';
    }
    // end of race
    if (!this.practice && this.flag === 'checkered' && this.phase !== 'finished') {
      const racing = ordered.filter((s) => s.status === 0);
      if (racing.length === 0 || this.time - this.winnerTime > 45) {
        for (const s of racing) s.status = s.status || 0;
        this.phase = 'finished';
      }
    }
  }

  /**
   * Full-course yellow. Stock cars call it a caution; GP races deploy the safety car for wrecks
   * and a virtual safety car (everyone slows to a set speed, no bunching) for stopped cars.
   */
  caution(reason: string, kind: 'sc' | 'vsc' = 'sc') {
    if (this.phase !== 'green' || this.flag === 'checkered' || this.flag === 'white') return;
    this.phase = 'caution';
    this.flag = 'yellow';
    this.phaseT = 0;
    this.cautionReason = reason;
    this.sc = this.series === 'gp' ? kind : '';
    this.msg = this.series === 'gp' ? `${kind === 'vsc' ? 'VIRTUAL SAFETY CAR' : 'SAFETY CAR'} — ${reason.toUpperCase()}` : `CAUTION — ${reason.toUpperCase()}`;
  }

  /** Time penalty (s) for a car, e.g. causing a collision or track limits. */
  addPenalty(slot: number, sec: number, why: string, name: string) {
    const st = this.stats.get(slot);
    if (!st || st.status === 2) return;
    st.pen += sec;
    this.msg = `${sec} SEC PENALTY: ${name.toUpperCase()} — ${why.toUpperCase()}`;
  }

  /** Drag-reduction flaps: green flag, after the first lap and 20 s after any restart. */
  get drsEnabled() {
    return this.phase === 'green' && !this.practice && this.phaseT > 20 && (this.standings()[0]?.lap ?? 0) >= 1;
  }

  standings(): Standing[] {
    const arr = [...this.stats.values()];
    arr.sort((a, b) => {
      if (a.status === 1 && b.status === 1) return a.total + a.pen - (b.total + b.pen);
      if (a.status === 1) return -1;
      if (b.status === 1) return 1;
      if (a.status === 2 && b.status !== 2) return 1;
      if (b.status === 2 && a.status !== 2) return -1;
      return b.lap + b.frac - (a.lap + a.frac);
    });
    arr.forEach((s, k) => (s.pos = k + 1));
    return arr;
  }

  snapshot(): RaceSnapshot {
    const st = this.standings();
    const snap: RaceSnapshot = {
      phase: this.phase,
      flag: this.flag,
      cd: this.phase === 'countdown' ? Math.max(0, 4 - this.phaseT) : 0,
      laps: this.laps,
      leaderLap: st[0]?.lap ?? 0,
      st,
      yellow: [...this.incidents.values()].map((x) => x.i),
      drs: this.drsEnabled,
      sc: this.phase === 'caution' ? this.sc : '',
    };
    if (this.msg) { snap.msg = this.msg; this.msg = ''; }
    return snap;
  }

  results(): ResultRow[] {
    return this.standings().map((s) => ({ slot: s.slot, pos: s.pos, laps: s.lap, best: s.best, total: s.total, status: s.status, pen: s.pen }));
  }

  /** Reset a slot's lap tracking after a respawn (keeps laps). */
  noteReset(slot: number, index: number) {
    const lp = this.progress.get(slot);
    if (lp) lp.index = index;
  }

  get reason() { return this.cautionReason; }
}
