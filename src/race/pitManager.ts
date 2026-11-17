import * as THREE from 'three';
import type { Track } from '../tracks/track';
import type { Car } from '../vehicle/car';
import type { CarVisual } from '../vehicle/carModel';
import type { BotDriver } from '../vehicle/bot';
import { COMPOUNDS, DRY_COMPOUNDS, type Compound } from '../vehicle/tyres';
import { PitCrew } from '../render/pitCrew';
import { PIT_LIMIT, pitApproach, boxIndex, botWantsPit, damageWork, defaultPlan, inPitLane, pitTime, within, type PitInfo, type PitPlan } from './pits';

/** What the pit logic needs from the session. */
export interface PitHost {
  readonly isHost: boolean;
  readonly self: number;
  readonly series: 'stock' | 'gp';
  readonly rain: boolean;
  readonly laps: number;
  readonly scene: THREE.Object3D;
  /** Grid order (slot list): car k uses stall k. */
  readonly order: number[];
  carOf(slot: number): Car | null;
  botOf(slot: number): BotDriver | null;
  visualOf(slot: number): CarVisual | null;
  posOf(slot: number): THREE.Vector3;
  colorOf(slot: number): string;
  nameOf(slot: number): string;
  lapsDone(slot: number): number;
  caution(): boolean;
  send(type: string, payload: unknown): void;
  flash(text: string, sec: number, color?: string): void;
  penalty(slot: number, sec: number, why: string): void;
  /** Swap a car's 3D model in the scene after a repair (local: new visual already built). */
  swapVisual(slot: number, old: CarVisual, now: CarVisual): void;
  /** A remote car was repaired by its owner: rebuild its model. */
  rebuildRemote(slot: number): void;
}

type Phase = 'none' | 'committed' | 'lane' | 'stopping' | 'waiting' | 'service' | 'leaving';

interface LocalState {
  phase: Phase;
  timer: number;
  plan: PitPlan | null;
  limitT: number;
  speeding: boolean;
  idx: number;
  decideT: number;
}

/** The player's pit plan as edited in the pit menu (B, then 1–4). */
export interface PlayerPlan {
  tyre: Compound | 'keep' | null; // null = automatic
  fuel: 'full' | 'half' | 'none';
  repair: 'auto' | 'yes' | 'no';
  wing: boolean;
}

const JACK = 0.07;

export class PitManager {
  readonly limit: number;
  private st = new Map<number, LocalState>();
  private crews = new Map<number, { crew: PitCrew; until: number }>();
  private time = 0;
  /** Host: dry compounds each car has raced on (two are required in dry GP races). */
  private used = new Map<number, Set<Compound>>();
  playerPlan: PlayerPlan = { tyre: null, fuel: 'full', repair: 'auto', wing: false };
  menuOpen = false;

  constructor(private track: Track, readonly info: PitInfo, private host: PitHost) {
    this.limit = PIT_LIMIT[host.series];
  }

  /** Host: remember the starting compound of every car. */
  noteStartTyre(slot: number, c: Compound) {
    this.used.set(slot, new Set([c]));
  }

  private state(slot: number): LocalState {
    let s = this.st.get(slot);
    if (!s) { s = { phase: 'none', timer: 0, plan: null, limitT: 0, speeding: false, idx: -1, decideT: Math.random() }; this.st.set(slot, s); }
    return s;
  }

  private box(slot: number) {
    return boxIndex(this.track, this.info, Math.max(0, this.host.order.indexOf(slot)));
  }

  private ahead(a: number, b: number) { return this.track.wrap(b - a) * this.track.ds; }

  /** Any car (local or remote) currently in the pit lane — race control ignores stopped cars there. */
  inLane(slot: number): boolean {
    const p = this.host.posOf(slot);
    const s = this.st.get(slot);
    const i = this.track.nearest(p, s && s.idx >= 0 ? s.idx : -1, 40);
    return inPitLane(this.track, this.info, i, this.track.lateral(p, i));
  }

  /** Extra speed cap for a local car (pit lane limit), Infinity elsewhere. */
  speedCap(slot: number): number {
    const s = this.st.get(slot);
    if (!s || s.phase === 'none' || s.phase === 'committed') return Infinity;
    return within(this.track, s.idx, this.info.limitFrom, this.info.limitTo) ? this.limit : Infinity;
  }

  /** The car is held still by its crew. */
  held(slot: number) {
    const ph = this.st.get(slot)?.phase;
    return ph === 'stopping' || ph === 'waiting' || ph === 'service';
  }

  phaseOf(slot: number) { return this.st.get(slot)?.phase ?? 'none'; }
  timerOf(slot: number) { return this.st.get(slot)?.timer ?? 0; }

  /** The plan the player's crew will follow (menu edits over sensible defaults). */
  planForPlayer(car: Car): PitPlan {
    const base = defaultPlan(car, this.host.rain);
    const pp = this.playerPlan;
    if (pp.tyre) base.tyre = pp.tyre;
    if (car.spec.series !== 'gp') base.fuel = pp.fuel === 'none' ? 0 : Math.max(0, car.spec.fuelTank * (pp.fuel === 'half' ? 0.5 : 1) - car.fuel);
    if (pp.repair !== 'auto') base.repair = pp.repair === 'yes';
    if (car.spec.series === 'gp') base.wing = pp.wing || base.wing;
    return base;
  }

  /** Menu input (session forwards key presses while racing). */
  menuKey(key: 'toggle' | 1 | 2 | 3 | 4, car: Car) {
    if (key === 'toggle') { this.menuOpen = !this.menuOpen; return; }
    if (!this.menuOpen) return;
    const pp = this.playerPlan;
    const gp = car.spec.series === 'gp';
    if (key === 1) {
      const opts: (Compound | 'keep' | null)[] = gp ? [null, 'soft', 'medium', 'hard', 'inter', 'wet', 'keep'] : [null, 'keep'];
      pp.tyre = opts[(opts.indexOf(pp.tyre) + 1) % opts.length];
    } else if (key === 2 && !gp) pp.fuel = pp.fuel === 'full' ? 'half' : pp.fuel === 'half' ? 'none' : 'full';
    else if (key === 3) pp.repair = pp.repair === 'auto' ? 'yes' : pp.repair === 'yes' ? 'no' : 'auto';
    else if (key === 4 && gp) pp.wing = !pp.wing;
  }

  /** Lines for the HUD pit menu. */
  menuLines(car: Car): string[] | null {
    if (!this.menuOpen) return null;
    const plan = this.planForPlayer(car);
    const pp = this.playerPlan;
    const gp = car.spec.series === 'gp';
    const tyre = plan.tyre === 'keep' ? 'No change' : COMPOUNDS[plan.tyre].label;
    const lines = [
      'PIT PLAN — drive into the pit lane to stop',
      `1  Tyres: ${tyre}${pp.tyre === null ? ' (auto)' : ''}`,
    ];
    if (!gp) lines.push(`2  Fuel: ${pp.fuel === 'none' ? 'none' : pp.fuel === 'half' ? 'to half' : 'to full'} (+${plan.fuel.toFixed(0)} kg)`);
    lines.push(`3  Repair damage: ${plan.repair ? 'yes' : 'no'}${pp.repair === 'auto' ? ' (auto)' : ''}`);
    if (gp) lines.push(`4  New front wing: ${plan.wing ? 'yes' : 'no'}`);
    lines.push(`Estimated stop: ${pitTime(car.spec, plan, damageWork(car), () => 0.5).toFixed(1)} s · B closes`);
    return lines;
  }

  /** Run the pit logic for the cars this peer simulates. */
  update(dt: number, slots: number[]) {
    this.time += dt;
    for (const slot of slots) {
      const car = this.host.carOf(slot);
      if (!car || car.damage.destroyed) continue;
      const s = this.state(slot);
      const pos = car.position;
      s.idx = this.track.nearest(pos, s.idx, 40);
      const lat = this.track.lateral(pos, s.idx);
      const inLane = inPitLane(this.track, this.info, s.idx, lat);
      const bot = this.host.botOf(slot);
      const box = this.box(slot);
      const speed = Math.abs(car.telemetry.speed);

      // AI strategy (host only): commit to a stop when it's worth it and the entry is coming up
      if (bot && this.host.isHost && s.phase === 'none') {
        s.decideT -= dt;
        if (s.decideT <= 0) {
          s.decideT = 1;
          const toEntry = this.ahead(s.idx, this.info.entry);
          const approach = pitApproach(this.track.length);
          if (toEntry > approach + 30 && toEntry < approach + 500) {
            const lapsLeft = this.host.laps ? this.host.laps - this.host.lapsDone(slot) : 99;
            const usedDry = [...car.tyres.used].filter((c) => DRY_COMPOUNDS.includes(c)).length;
            // free practice (laps = 0): stop when tyres or damage need it, no compound rule
            // this car's own lap for the mandatory stop: spread between 30 % and 60 % of the race (room to retry)
            const k = this.host.order.indexOf(slot);
            const ruleLap = Math.max(1, Math.min(this.host.laps - 1, Math.round(this.host.laps * (0.3 + 0.3 * ((k * 0.618) % 1)))));
            const plan = botWantsPit(car, { lapsLeft, caution: this.host.caution(), rain: this.host.rain, usedDry, totalLaps: this.host.laps, trackKm: this.track.length / 1000, ruleLap });
            if (plan) {
              s.plan = plan;
              s.phase = 'committed';
              bot.pit = { info: this.info, box, limit: this.limit, served: false };
            }
          }
        }
      }
      if (s.phase === 'committed') {
        if (inLane) s.phase = 'lane';
        else {
          // missed it: well past the speed-limit line and still not in the lane
          const past = this.ahead(this.info.entry, s.idx), taper = this.ahead(this.info.entry, this.info.limitFrom);
          if (past > taper + 40 && past < this.track.length / 2) { s.phase = 'none'; s.plan = null; if (bot) bot.pit = null; }
        }
      }
      if (s.phase === 'none' && inLane) {
        s.phase = 'lane';
        s.speeding = false;
        s.limitT = 0;
        if (slot === this.host.self) this.host.flash('PIT LANE — LIMITER ON', 1.5, '#facc15');
      }
      // speed limit enforcement (2 s grace after the line)
      if ((s.phase === 'lane' || s.phase === 'leaving') && within(this.track, s.idx, this.info.limitFrom, this.info.limitTo)) {
        s.limitT += dt;
        if (s.limitT > 2 && !s.speeding && speed > this.limit + 2) {
          s.speeding = true;
          this.host.penalty(slot, 5, 'pit lane speeding');
        }
      }
      if (s.phase === 'lane' && !inLane && this.ahead(box, s.idx) > 30 && this.ahead(box, s.idx) < this.track.length / 2) {
        // went through without stopping (too fast at the stall): back to racing
        s.phase = 'none'; s.plan = null; if (bot) bot.pit = null;
      }
      if (s.phase === 'lane') {
        const past = this.ahead(box, s.idx);
        if (past < 6 && speed < this.limit + 4) {
          s.phase = 'stopping';
          if (!s.plan) s.plan = slot === this.host.self ? this.planForPlayer(car) : defaultPlan(car, this.host.rain);
        }
      }
      if (s.phase === 'stopping' && speed < 0.6) {
        if (slot === this.host.self) s.plan = this.planForPlayer(car); // latest menu choices
        const plan = s.plan!;
        if (this.host.isHost) this.startService(slot, pitTime(car.spec, plan, damageWork(car)), plan);
        else { s.phase = 'waiting'; s.timer = 0; this.host.send('pitreq', { s: slot, plan, work: damageWork(car) }); }
      }
      if (s.phase === 'waiting') {
        s.timer += dt;
        if (s.timer > 3) this.startService(slot, pitTime(car.spec, s.plan!, damageWork(car)), s.plan!); // host unreachable: go anyway
      }
      if (s.phase === 'service') {
        s.timer -= dt;
        if (s.timer <= 0) this.finishService(slot, car, s);
      }
      if (s.phase === 'leaving' && !inLane && !within(this.track, s.idx, this.info.entry, this.info.limitTo)) {
        s.phase = 'none';
        s.plan = null;
        if (bot) bot.pit = null;
      }
      if (bot && bot.pit) bot.pit.served = s.phase === 'leaving';
    }
  }

  private startService(slot: number, dur: number, plan: PitPlan) {
    const s = this.state(slot);
    s.phase = 'service';
    s.timer = dur;
    s.plan = plan;
    if (this.host.isHost) this.noteStop(slot, plan, dur);
  }

  /** Host: a stop is confirmed — tell everyone (crew visuals, the client's timer). */
  private noteStop(slot: number, plan: PitPlan, dur: number) {
    if (plan.tyre !== 'keep') this.used.get(slot)?.add(plan.tyre);
    this.host.send('pitgo', { s: slot, dur: +dur.toFixed(2), tyre: plan.tyre });
    this.spawnCrew(slot, dur);
    if (slot === this.host.self) this.host.flash(`PIT STOP — ${dur.toFixed(1)} s`, 1.5, '#facc15');
  }

  private finishService(slot: number, car: Car, s: LocalState) {
    const plan = s.plan!;
    if (plan.tyre !== 'keep') car.tyres.fit(plan.tyre, car.spec.tyreStartTemp);
    car.fuel = Math.min(car.spec.fuelTank, car.fuel + plan.fuel);
    let repair = '';
    if (plan.repair || plan.wing) {
      const old = car.repair(plan.repair);
      this.host.swapVisual(slot, old, car.visual);
      repair = plan.repair ? 'full' : 'wing';
    }
    this.host.send('pitdone', { s: slot, repair });
    s.phase = 'leaving';
    s.limitT = 0;
    if (slot === this.host.self) this.host.flash('GO GO GO!', 1.2, '#3ad17a');
  }

  /** Network events about pit stops. */
  handleEvent(type: string, p: { s: number; dur?: number; plan?: PitPlan; work?: number; repair?: string }, from: number) {
    if (type === 'pitreq' && this.host.isHost && p.s === from && p.plan) {
      const spec = this.specOfRemote(from);
      const dur = spec ? pitTime(spec, p.plan, Math.max(0, Math.min(3, Number(p.work) || 0))) : 3;
      this.noteStop(from, p.plan, dur);
    } else if (type === 'pitgo') {
      if (p.s === this.host.self && !this.host.isHost) {
        const s = this.state(p.s);
        if (s.phase === 'waiting' && s.plan) { s.phase = 'service'; s.timer = p.dur ?? 3; }
      }
      if (!this.host.isHost) this.spawnCrew(p.s, p.dur ?? 3);
    } else if (type === 'pitdone' && p.repair && !this.host.carOf(p.s)) {
      this.host.rebuildRemote(p.s);
    }
  }

  /** Car spec of a remote car (for the host to time its stop). */
  specOfRemote: (slot: number) => Car['spec'] | null = () => null;

  private spawnCrew(slot: number, dur: number) {
    const v = this.host.visualOf(slot);
    if (!v) return;
    this.crews.get(slot)?.crew.group.removeFromParent();
    const spec = this.host.carOf(slot)?.spec ?? this.specOfRemote(slot);
    const geo = spec?.geo ?? { wheelbaseF: 1.45, wheelbaseR: -1.35, trackHalf: 0.79 };
    const crew = new PitCrew(this.host.colorOf(slot), geo, spec?.series !== 'gp');
    this.host.scene.add(crew.group);
    this.crews.set(slot, { crew, until: this.time + dur + 0.4 });
  }

  /** After the cars' visuals are synced: crews follow their car, the car sits on its jacks. */
  updateVisuals(dt: number) {
    for (const [slot, c] of this.crews) {
      const v = this.host.visualOf(slot);
      if (!v || this.time > c.until) {
        c.crew.group.removeFromParent();
        c.crew.dispose();
        this.crews.delete(slot);
        continue;
      }
      v.root.position.y += JACK;
      c.crew.update(dt, v.root);
      c.crew.group.position.y -= JACK;
    }
  }

  /**
   * Host, at the finish: dry GP races of 5+ laps must use two dry compounds. Returns the slots
   * that broke the rule (they get a time penalty).
   */
  ruleBreakers(finished: number[]): number[] {
    if (this.host.series !== 'gp' || this.host.rain || this.host.laps < 5) return [];
    return finished.filter((slot) => [...(this.used.get(slot) ?? [])].filter((c) => DRY_COMPOUNDS.includes(c)).length < 2);
  }

  dispose() {
    for (const c of this.crews.values()) { c.crew.group.removeFromParent(); c.crew.dispose(); }
    this.crews.clear();
  }
}
