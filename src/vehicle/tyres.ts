/**
 * Tyre model: per-wheel temperature and wear, and a compound. Grip depends on all three:
 * cold tyres are slippery, there is an optimal temperature window, overheating costs grip and
 * speeds up wear, and worn tyres lose grip (with a "cliff" near the end of their life).
 */
export type Compound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet' | 'stock';
export const DRY_COMPOUNDS: Compound[] = ['soft', 'medium', 'hard'];

export interface CompoundSpec {
  label: string;
  /** One-letter HUD tag and sidewall colour. */
  tag: string;
  color: string;
  /** Peak grip multiplier on a dry / wet track. */
  dry: number;
  wet: number;
  /** Optimal temperature window (°C). */
  window: [number, number];
  /** Wear rate multiplier. */
  wear: number;
  /** Heat-up rate multiplier. */
  warm: number;
}

export const COMPOUNDS: Record<Compound, CompoundSpec> = {
  soft: { label: 'Soft', tag: 'S', color: '#e8322b', dry: 1.06, wet: 0.55, window: [85, 110], wear: 1.7, warm: 1.3 },
  medium: { label: 'Medium', tag: 'M', color: '#f2d22e', dry: 1.0, wet: 0.53, window: [90, 115], wear: 1.0, warm: 1.0 },
  hard: { label: 'Hard', tag: 'H', color: '#f2f2f2', dry: 0.955, wet: 0.5, window: [95, 125], wear: 0.6, warm: 0.8 },
  inter: { label: 'Intermediate', tag: 'I', color: '#3ac25a', dry: 0.88, wet: 0.96, window: [55, 90], wear: 1.5, warm: 1.1 },
  wet: { label: 'Full wet', tag: 'W', color: '#2f7fe0', dry: 0.8, wet: 1.0, window: [40, 75], wear: 2.4, warm: 1.2 },
  // stock cars run one hard-wearing compound with a wide window
  stock: { label: 'Stock', tag: 'G', color: '#f5f5f5', dry: 1.0, wet: 1.0, window: [50, 125], wear: 0.7, warm: 1.0 },
};

/** Wear per second for typical racing load (~20 minutes for a medium to reach 1). */
const BASE_WEAR = 1.25e-3;

export class TyreSet {
  readonly temp: number[];
  readonly wear = [0, 0, 0, 0];
  /** Dry compounds used this race (the dry-race rule needs two). */
  readonly used = new Set<Compound>();

  constructor(public compound: Compound, startTemp: number, private wearMult = 1) {
    this.temp = [startTemp, startTemp, startTemp, startTemp];
    this.used.add(compound);
  }

  /** Fit a fresh set (pit stop). */
  fit(compound: Compound, startTemp: number) {
    this.compound = compound;
    for (let i = 0; i < 4; i++) { this.temp[i] = startTemp; this.wear[i] = 0; }
    this.used.add(compound);
  }

  /**
   * Grip multiplier for wheel i. `wetTrack` is true in the rain: slicks lose most of their grip,
   * intermediates and wets work. (The track's own wet grip is applied separately.)
   */
  grip(i: number, wetTrack: boolean): number {
    const c = COMPOUNDS[this.compound];
    const T = this.temp[i];
    const [lo, hi] = c.window;
    let g = wetTrack ? c.wet / 0.78 : c.dry; // the rain track already scales grip by 0.78
    if (T < lo) g *= Math.max(0.74, 1 - (lo - T) * 0.0065);
    else if (T > hi) g *= Math.max(0.8, 1 - (T - hi) * 0.008);
    const w = this.wear[i];
    g *= 1 - 0.1 * Math.pow(w, 1.5) - (w > 0.85 ? (w - 0.85) * 1.2 : 0);
    return Math.max(0.35, g);
  }

  /** Average grip (the AI plans corners with it). */
  avgGrip(wetTrack: boolean) {
    return (this.grip(0, wetTrack) + this.grip(1, wetTrack) + this.grip(2, wetTrack) + this.grip(3, wetTrack)) / 4;
  }

  /**
   * Advance temperatures and wear. slip = combined slip intensity (0 rolling, ~1 sliding),
   * loadRatio = tyre load / static load, speed in m/s.
   */
  update(dt: number, i: number, slip: number, loadRatio: number, speed: number, contact: boolean, wetTrack: boolean, ambient: number) {
    const c = COMPOUNDS[this.compound];
    const v = Math.abs(speed);
    // heat and airflow cooling both scale with speed, so the running temperature depends on how
    // hard the tyre works (slip and load), not on how fast the track is. Compounds differ in how
    // quickly they get there, and in which temperature window they like.
    const work = contact ? (1 + Math.min(3, slip)) * Math.sqrt(Math.min(4, loadRatio)) * v : 0;
    const heat = work * 0.06;
    const cool = (this.temp[i] - ambient) * (0.02 + v * 0.0012) * (wetTrack ? 1.8 : 1);
    this.temp[i] = Math.max(ambient, Math.min(160, this.temp[i] + (heat - cool) * c.warm * dt));
    if (!contact || v < 2) return;
    const [, hi] = c.window;
    const over = this.temp[i] > hi ? 1 + (this.temp[i] - hi) / 18 : 1;
    // the wrong tyre for the conditions chews itself up (slicks on a wet track barely wear)
    const cond = wetTrack ? (this.compound === 'wet' || this.compound === 'inter' || this.compound === 'stock' ? 1 : 0.6) : (this.compound === 'wet' ? 1.6 : this.compound === 'inter' ? 1.3 : 1);
    const rate = BASE_WEAR * c.wear * this.wearMult * cond * (0.3 + Math.min(2, slip) * 1.5) * Math.sqrt(Math.min(4, loadRatio)) * over;
    this.wear[i] = Math.min(1, this.wear[i] + rate * dt);
  }
}
