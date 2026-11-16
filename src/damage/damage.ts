import * as THREE from 'three';
import type { PartName } from '../vehicle/carModel';

export type DamageLevel = 'off' | 'realistic' | 'brutal';

/**
 * Damage model for one car. Impacts arrive as (local point, local inward direction, impulse N·s).
 * They feed body panels, then mechanical systems (engine, cooling, suspension corners, steering,
 * tires, aero parts) that change how the car drives. Enough damage, or one deadly hit, sets the car
 * on fire and then it explodes.
 *
 * Local frame = physics body frame: +Z forward, +X left, +Y up, origin at the centre of mass
 * (the ground is at y ≈ -0.45).
 */

export const PANELS = {
  bumperF: new THREE.Vector3(0, -0.15, 2.55),
  hood: new THREE.Vector3(0, 0.42, 1.55),
  fenderFL: new THREE.Vector3(0.9, 0.05, 1.5),
  fenderFR: new THREE.Vector3(-0.9, 0.05, 1.5),
  doorL: new THREE.Vector3(0.97, 0.05, 0),
  doorR: new THREE.Vector3(-0.97, 0.05, 0),
  quarterL: new THREE.Vector3(0.9, 0.1, -1.6),
  quarterR: new THREE.Vector3(-0.9, 0.1, -1.6),
  bumperR: new THREE.Vector3(0, -0.1, -2.6),
  deck: new THREE.Vector3(0, 0.52, -2.1),
  roof: new THREE.Vector3(0, 0.85, -0.4),
};
export type PanelName = keyof typeof PANELS;
const PANEL_NAMES = Object.keys(PANELS) as PanelName[];

const CORNER_PANELS: PanelName[][] = [
  ['fenderFL', 'bumperF'], ['fenderFR', 'bumperF'], ['quarterL', 'bumperR'], ['quarterR', 'bumperR'],
];

export interface ImpactResult {
  /** Visual dent strength (m), 0 = none. */
  dent: number;
  detached: PartName[];
  punctured: number[];
  /** True when this impact (or accumulated damage) destroys the car. */
  explode: boolean;
  /** Effective damage dealt. */
  severity: number;
}

/**
 * How tough a class of car is. Impacts below the thresholds only scuff paint; above them damage
 * grows faster than linearly, so taps stay cosmetic and only big hits really hurt.
 */
export interface DamageProfile {
  /** Impulse (N·s) below which a wall hit does nothing. */
  wallJ0: number;
  /** Impulse (N·s) below which car-to-car contact does nothing (rubbing, bump drafting). */
  carJ0: number;
  /** Impulse above the threshold that counts as one unit of damage. */
  refJ: number;
  /** Damage curve exponent (>1 = small hits matter less, big hits more). */
  curve: number;
  /** Single-hit severity that ruptures fuel/oil lines and starts a fire. */
  igniteSeverity: number;
  /** Scales how easily bolt-on parts (wings, bumpers, spoiler) come loose and fall off. */
  partFragility: number;
  /** Scales suspension damage per hit. */
  suspensionFragility: number;
}

export const DAMAGE_PROFILES = {
  // 1550 kg: one damage unit ≈ a 33 mph (15 m/s) full stop into the wall; fire needs ≈ 75+ mph
  stock: { wallJ0: 1200, carJ0: 1800, refJ: 23000, curve: 1.35, igniteSeverity: 3.2, partFragility: 1, suspensionFragility: 1 },
  /** Open-wheel cars (~800 kg) shed wings and suspension easily, but the tub is very strong and rarely burns. */
  openWheel: { wallJ0: 600, carJ0: 900, refJ: 12000, curve: 1.3, igniteSeverity: 4.5, partFragility: 1.8, suspensionFragility: 1.6 },
} satisfies Record<string, DamageProfile>;

const MULT: Record<DamageLevel, number> = { off: 0.6, realistic: 1, brutal: 1.8 };
/** Brutal also lowers the thresholds and the severity needed to start a fire. */
const THRESH: Record<DamageLevel, number> = { off: 1, realistic: 1, brutal: 0.7 };
const IGNITE: Record<DamageLevel, number> = { off: Infinity, realistic: 1, brutal: 0.65 };
/** Velocity change (m/s) within ~0.1 s that destroys a car outright: a top-speed head-on into the wall. */
const DEADLY_DV: Record<DamageLevel, number> = { off: Infinity, realistic: 40, brutal: 30 };
/** Only hits this many times the threshold count toward the deadly velocity-change window. */
const HARD_HIT = 4;
/** A corner needs a hit at least this strong before a puncture is possible. */
const PUNCTURE_MIN = 0.12;

export class CarDamage {
  /** Dev hook: called for every impact that passes the threshold (used by the damage regression test). */
  static onImpact?: (impulse: number, carHit: boolean, res: ImpactResult, d: CarDamage) => void;
  panels: Record<PanelName, number> = Object.fromEntries(PANEL_NAMES.map((p) => [p, 0])) as Record<PanelName, number>;
  engine = 1; // health 0..1
  cooling = 1;
  steering = 1;
  corner = [1, 1, 1, 1]; // suspension health per wheel
  toe = [0, 0, 0, 0]; // alignment error (rad) per wheel
  punctured = [false, false, false, false];
  parts: Partial<Record<PartName, 'ok' | 'loose' | 'gone'>> = {};
  engineTemp = 90; // °C
  /** Heat wear 0..1; at 1 the engine is blown (no power, heavy smoke) but it doesn't burn. */
  engineWear = 0;
  fire = 0; // 0..1 intensity
  fireTime = 0;
  destroyed = false;
  exploded = false;
  private recentDV = 0;

  constructor(readonly level: DamageLevel, private mass: number, readonly profile: DamageProfile = DAMAGE_PROFILES.stock) {}

  get mechanical() {
    return this.level !== 'off';
  }

  /** 1 = pristine, 0 = wrecked. */
  get integrity(): number {
    const vals = PANEL_NAMES.map((p) => Math.min(1.4, this.panels[p]));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const max = Math.max(...vals);
    return Math.max(0, 1 - avg * 0.75 - max * 0.12 - (1 - this.engine) * 0.35);
  }

  /** Engine torque multiplier. */
  get power(): number {
    if (!this.mechanical) return 1;
    if (this.engine <= 0 || this.destroyed || this.engineWear >= 1) return 0;
    const heat = this.engineTemp > 125 ? Math.max(0.35, 1 - (this.engineTemp - 125) / 60) : 1;
    return (0.45 + 0.55 * this.engine) * heat * (1 - this.engineWear * 0.5);
  }
  get steerFactor() { return this.mechanical ? 0.55 + 0.45 * this.steering : 1; }
  get steerPull() { return this.mechanical ? (this.toe[0] + this.toe[1]) * 0.5 : 0; }
  cornerGrip(i: number) {
    if (!this.mechanical) return 1;
    return (this.punctured[i] ? 0.35 : 1) * (0.7 + 0.3 * Math.max(0, this.corner[i]));
  }
  get aeroFront() { return this.parts.splitter === 'gone' ? 0.45 : this.parts.bumperF === 'gone' ? 0.75 : 1; }
  get aeroRear() { return this.parts.spoiler === 'gone' ? 0.2 : this.parts.spoiler === 'loose' ? 0.65 : 1; }
  get dragAdd() {
    const body = PANEL_NAMES.reduce((a, p) => a + Math.min(1, this.panels[p]), 0) / PANEL_NAMES.length;
    return body * 0.35 + (this.parts.hood === 'gone' ? 0.08 : 0);
  }
  get wheelsLost() {
    return [0, 1, 2, 3].filter((i) => this.parts[`wheel${i}` as PartName] === 'gone').length;
  }
  /** Smoke 0..1 from the engine bay. */
  get smoke(): number {
    if (this.exploded) return 1;
    const s = Math.max(1 - this.engine, (this.engineTemp - 110) / 40, 1 - this.cooling * 1.2, this.engineWear >= 1 ? 0.8 : this.engineWear * 0.6);
    return THREE.MathUtils.clamp(s, 0, 1);
  }

  /** Per-step update: temperature, fire progression. Returns true when the car should explode now. */
  tick(dt: number, rpm: number, speed: number): boolean {
    this.recentDV *= Math.exp(-dt / 0.12); // one collision event, not a series of tumbles
    if (!this.mechanical || this.exploded) return false;
    // cooling: airflow helps, damaged radiator doesn't
    const working = this.engineWear < 1 ? rpm / 9000 : 0;
    const heatIn = 5 + working * 16 + (1 - this.engine) * 18;
    const cool = (14 + Math.min(1, speed / 60) * 20) * (0.45 + 0.55 * this.cooling);
    this.engineTemp = THREE.MathUtils.clamp(this.engineTemp + (heatIn - cool) * dt * 0.5, 85, 175);
    if (this.engineTemp > 145) this.engineWear = Math.min(1, this.engineWear + dt * 0.008);
    // fire only comes from big crashes (see impact), never from wear or overheating
    if (this.fire > 0) {
      this.fireTime += dt;
      this.fire = Math.min(1, this.fire + dt * 0.12);
      this.engine = Math.max(0, this.engine - dt * 0.08);
      // a car fully ablaze blows up after a few seconds
      if (this.fireTime > 6 + (this.level === 'brutal' ? -2 : 0)) return true;
    }
    return false;
  }

  ignite() {
    this.destroyed = true;
    if (this.fire === 0) this.fire = 0.25;
  }

  /**
   * Apply an impact. `impulse` in N·s accumulated this physics step, `carHit` softens car-to-car
   * contact (remote cars are infinitely heavy kinematic proxies locally).
   */
  impact(local: THREE.Vector3, inward: THREE.Vector3, impulse: number, carHit: boolean): ImpactResult {
    const res: ImpactResult = { dent: 0, detached: [], punctured: [], explode: false, severity: 0 };
    if (this.exploded) return res;
    const pr = this.profile;
    const J0 = (carHit ? pr.carJ0 : pr.wallJ0) * THRESH[this.level];
    if (impulse < J0) return res;
    if (impulse > J0 * HARD_HIT) this.recentDV += impulse / this.mass;
    const e = Math.pow((impulse - J0) / pr.refJ, pr.curve) * MULT[this.level] * (carHit ? 0.7 : 1);
    res.severity = e;
    res.dent = Math.min(0.22, Math.pow(e, 0.8) * 0.12);

    // distribute over panels by proximity
    const w: Record<string, number> = {};
    let tot = 0;
    for (const p of PANEL_NAMES) {
      const d2 = PANELS[p].distanceToSquared(local);
      w[p] = Math.exp(-d2 / 0.7);
      tot += w[p];
    }
    for (const p of PANEL_NAMES) {
      w[p] /= tot || 1;
      this.panels[p] = Math.min(1.6, this.panels[p] + e * w[p] * 1.6);
    }

    // parts
    const loosen = (part: PartName, value: number, looseAt: number, goneAt: number) => {
      const st = this.parts[part] ?? 'ok';
      if (st === 'gone') return;
      value *= pr.partFragility;
      if (value >= goneAt) { this.parts[part] = 'gone'; res.detached.push(part); }
      else if (value >= looseAt) this.parts[part] = 'loose';
    };
    loosen('bumperF', this.panels.bumperF, 0.5, 0.95);
    loosen('splitter', this.panels.bumperF, 0.4, 0.75);
    loosen('hood', this.panels.hood + this.panels.bumperF * 0.4, 0.7, 1.25);
    loosen('bumperR', this.panels.bumperR, 0.5, 0.95);
    loosen('spoiler', this.panels.deck + this.panels.bumperR * 0.3, 0.45, 0.9);
    loosen('skirtL', this.panels.doorL, 0.5, 0.85);
    loosen('skirtR', this.panels.doorR, 0.5, 0.85);

    if (this.mechanical) {
      // only hits to the nose reach the engine bay
      this.engine = Math.max(0, this.engine - e * (w.bumperF * 0.45 + w.hood * 0.6 + (w.fenderFL + w.fenderFR) * 0.06));
      this.cooling = Math.max(0, this.cooling - e * (w.bumperF * 0.4 + w.hood * 0.15));
      this.steering = Math.max(0, this.steering - e * (w.fenderFL + w.fenderFR) * 0.35);
      for (let i = 0; i < 4; i++) {
        const cw = CORNER_PANELS[i].reduce((a, p, k) => a + w[p] * (k === 0 ? 1 : 0.25), 0);
        const hit = e * cw * pr.suspensionFragility;
        if (hit < 0.02) continue;
        this.corner[i] -= hit * 0.9;
        this.toe[i] += (Math.random() - 0.5) * hit * 0.05 + (i % 2 === 0 ? -1 : 1) * hit * 0.012;
        if (!this.punctured[i] && hit > PUNCTURE_MIN && Math.random() < (hit - PUNCTURE_MIN) * 0.6) { this.punctured[i] = true; res.punctured.push(i); }
        const wheel = `wheel${i}` as PartName;
        if (this.corner[i] < -0.15 && this.parts[wheel] !== 'gone') { this.parts[wheel] = 'gone'; res.detached.push(wheel); }
      }
      const ignite = pr.igniteSeverity * IGNITE[this.level];
      if (this.recentDV > DEADLY_DV[this.level]) res.explode = true;
      // fire needs one massive hit, or a big hit on a car that is already wrecked
      else if (e >= ignite || (e >= ignite * 0.25 && (this.engine <= 0.05 || this.integrity <= 0))) this.ignite();
      // an engine knocked out by smaller hits just dies (smoke, no power) instead of burning
      else if (this.engine <= 0.02) this.engineWear = 1;
    }
    CarDamage.onImpact?.(impulse, carHit, res, this);
    return res;
  }
}
