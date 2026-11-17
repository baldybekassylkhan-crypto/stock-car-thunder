/**
 * Combat abilities with cooldowns:
 *  - Nitro: a short, strong push forward (great for ramming runs).
 *  - Reinforced Ram: for a few seconds the front armour is stronger and hits do much more damage.
 *  - Emergency Repair: restores some HP; limited uses per match.
 *  - Shockwave: a short-range blast that shoves nearby cars away (and dents them a little).
 */
export type AbilityId = 'nitro' | 'ram' | 'repair' | 'shock';
export const ABILITIES: AbilityId[] = ['nitro', 'ram', 'repair', 'shock'];

export const ABILITY_INFO: Record<AbilityId, { name: string; key: string; pad: string; cooldown: number; duration: number }> = {
  nitro: { name: 'Nitro', key: 'Shift / 1', pad: 'A', cooldown: 10, duration: 2.5 },
  ram: { name: 'Reinforced Ram', key: 'F / 2', pad: 'LB', cooldown: 16, duration: 4 },
  repair: { name: 'Emergency Repair', key: 'R / 3', pad: 'B', cooldown: 6, duration: 0 },
  shock: { name: 'Shockwave', key: 'Q / 4', pad: 'RB', cooldown: 20, duration: 0.4 },
};

/** Shockwave reach (m) and strength. */
export const SHOCK = { radius: 13, impulse: 11000, damage: 70 };
/** Nitro push (m/s² of extra acceleration). */
export const NITRO_ACCEL = 7.5;

export class AbilitySystem {
  readonly cd: Record<AbilityId, number> = { nitro: 0, ram: 0, repair: 0, shock: 0 };
  readonly active: Record<AbilityId, number> = { nitro: 0, ram: 0, repair: 0, shock: 0 };
  repairsLeft: number;

  constructor(repairs: number) {
    this.repairsLeft = repairs;
  }

  ready(id: AbilityId) {
    return this.cd[id] <= 0 && (id !== 'repair' || this.repairsLeft > 0);
  }

  /** Try to use an ability; returns true when it fires. */
  use(id: AbilityId): boolean {
    if (!this.ready(id)) return false;
    const info = ABILITY_INFO[id];
    this.cd[id] = info.cooldown;
    this.active[id] = info.duration;
    if (id === 'repair') this.repairsLeft--;
    return true;
  }

  /** Nitro pickup: nitro is ready again right away. */
  refillNitro() { this.cd.nitro = 0; }

  update(dt: number) {
    for (const id of ABILITIES) {
      this.cd[id] = Math.max(0, this.cd[id] - dt);
      this.active[id] = Math.max(0, this.active[id] - dt);
    }
  }

  /** 0..1 cooldown progress for the HUD (1 = ready). */
  progress(id: AbilityId) {
    if (id === 'repair' && this.repairsLeft <= 0) return 0;
    return 1 - this.cd[id] / ABILITY_INFO[id].cooldown;
  }
}
