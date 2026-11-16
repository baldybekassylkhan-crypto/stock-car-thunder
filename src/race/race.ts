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
}

export interface RaceSnapshot {
  phase: Phase;
  flag: Flag;
  cd: number; // countdown seconds remaining
  laps: number;
  leaderLap: number;
  st: Standing[];
  msg?: string;
}

export interface Entrant {
  slot: number;
  pos: () => THREE.Vector3;
  speed: () => number;
  destroyed: () => boolean;
}

export interface ResultRow {
  slot: number;
  pos: number;
  laps: number;
  best: number;
  total: number;
  status: 0 | 1 | 2;
}

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
  msg = '';
  readonly practice: boolean;

  constructor(track: Track, readonly laps: number, private entrants: Entrant[], startIndex: (slot: number) => number, readonly paceSpeed: number) {
    this.practice = laps === 0;
    for (const e of entrants) {
      const lp = new LapProgress(track);
      lp.reset(startIndex(e.slot), 0);
      this.progress.set(e.slot, lp);
      this.stats.set(e.slot, { slot: e.slot, lap: 0, frac: 0, last: 0, best: 0, status: 0, total: 0, pos: 0 });
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
    if (this.phase === 'caution') return this.paceSpeed * 0.9;
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
      if (st.status === 0 && e.destroyed()) {
        st.status = 2;
        if (!this.practice && this.phase === 'green') this.caution('Wreck');
      }
      if (completed && st.status === 0 && !this.practice && (this.flag === 'checkered' || st.lap >= this.laps)) {
        st.status = 1;
        st.total = this.time;
        this.finishOrder.push(e.slot);
        if (this.finishOrder.length === 1) { this.flag = 'checkered'; this.winnerTime = this.time; }
      }
      // stopped car on track → caution
      if (this.phase === 'green' && !this.practice && st.status === 0) {
        if (e.speed() < 4) {
          const t = (this.stopped.get(e.slot) ?? 0) + dt;
          this.stopped.set(e.slot, t);
          if (t > 3) { this.caution('Stopped car'); this.stopped.set(e.slot, -15); }
        } else if ((this.stopped.get(e.slot) ?? 0) > 0) this.stopped.set(e.slot, 0);
      }
    }
    if (this.phase === 'pace' && leaderStarted) {
      this.phase = 'green';
      this.flag = 'green';
      this.phaseT = 0;
      this.msg = 'GREEN FLAG!';
    }
    if (this.phase === 'caution' && this.phaseT > 22 && this.flag !== 'checkered') {
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

  caution(reason: string) {
    if (this.phase !== 'green' || this.flag === 'checkered' || this.flag === 'white') return;
    this.phase = 'caution';
    this.flag = 'yellow';
    this.phaseT = 0;
    this.cautionReason = reason;
    this.msg = `CAUTION — ${reason.toUpperCase()}`;
  }

  standings(): Standing[] {
    const arr = [...this.stats.values()];
    const fin = (s: Standing) => this.finishOrder.indexOf(s.slot);
    arr.sort((a, b) => {
      if (a.status === 1 && b.status === 1) return fin(a) - fin(b);
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
    };
    if (this.msg) { snap.msg = this.msg; this.msg = ''; }
    return snap;
  }

  results(): ResultRow[] {
    return this.standings().map((s) => ({ slot: s.slot, pos: s.pos, laps: s.lap, best: s.best, total: s.total, status: s.status }));
  }

  /** Reset a slot's lap tracking after a respawn (keeps laps). */
  noteReset(slot: number, index: number) {
    const lp = this.progress.get(slot);
    if (lp) lp.index = index;
  }

  get reason() { return this.cautionReason; }
}
