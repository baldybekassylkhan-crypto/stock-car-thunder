import type * as THREE from 'three';
import type { Track } from '../tracks/track';

/** Tracks a car's position around the lap, lap times and simple sector validation. */
export class LapProgress {
  index = 0;
  lap = 0;
  lapStart = 0;
  lastLap = 0;
  bestLap = 0;
  private halfway = false;
  private started = false;
  private quarter = [false, false, false];

  constructor(private track: Track) {}

  reset(index: number, now: number) {
    this.index = index;
    this.lap = 0;
    this.lapStart = now;
    this.halfway = false;
    this.started = false;
    this.quarter = [false, false, false];
  }

  /** Returns true when a lap was completed this update. */
  update(pos: THREE.Vector3, now: number): boolean {
    const n = this.track.n;
    const prev = this.index;
    this.index = this.track.nearest(pos, prev, 40);
    // cross start/finish forward
    const crossed = prev > n * 0.9 && this.index < n * 0.1;
    for (let k = 0; k < 3; k++) if (Math.abs(this.index - n * (k + 1) * 0.25) < n * 0.05) this.quarter[k] = true;
    this.halfway = this.quarter.every(Boolean);
    if (crossed) {
      if (!this.started) {
        this.started = true;
        this.lap = 1;
        this.lapStart = now;
        return false;
      }
      if (this.halfway) {
        this.lastLap = now - this.lapStart;
        if (!this.bestLap || this.lastLap < this.bestLap) this.bestLap = this.lastLap;
        this.lap++;
        this.lapStart = now;
        this.quarter = [false, false, false];
        return true;
      }
    }
    return false;
  }

  current(now: number) {
    return this.started ? now - this.lapStart : 0;
  }
  get fraction() {
    return this.index / this.track.n;
  }
}

export function fmtTime(s: number): string {
  if (!s) return '--:--.---';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
}
