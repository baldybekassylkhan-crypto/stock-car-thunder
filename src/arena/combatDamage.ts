import * as THREE from 'three';
import type { CombatClass, Zone } from './classes';

/**
 * Vehicle damage system for the Demolition Arena: 1000 HP, armour per zone that wears down, and
 * engine / steering / tyre condition that change how the car drives. Health sets the damage stage:
 *   1 minor (scratches, small sparks) · 2 moderate (smoke, slight handling loss) ·
 *   3 severe (constant smoke, less power, steering problems) · 4 critical (heavy smoke,
 *   overheating, barely drivable) · 5 destroyed (engine stops, eliminated).
 */
export const MAX_HP = 1000;

export class CombatDamage {
  hp = MAX_HP;
  /** Armour condition per zone (1 = intact plating, 0 = gone). */
  readonly armorCond: Record<Zone, number> = { front: 1, rear: 1, left: 1, right: 1 };
  engine = 1;
  steering = 1;
  tires = 1;
  /** Reinforced Ram ability: extra front armour and punch while active. */
  ramActive = false;
  /** Who hit us last and when (for elimination credit). */
  lastAttacker = -1;
  lastHitT = -99;
  /** Overheating cycle at stage 4 (power cuts in and out). */
  private heat = 0;
  damageTaken = 0;

  constructor(readonly cls: CombatClass) {}

  get alive() { return this.hp > 0; }

  get stage(): 1 | 2 | 3 | 4 | 5 {
    const h = this.hp;
    return h <= 0 ? 5 : h <= 250 ? 4 : h <= 520 ? 3 : h <= 800 ? 2 : 1;
  }

  /** Damage reduction of a zone right now. */
  armor(zone: Zone) {
    const a = this.cls.armor[zone] * (0.35 + 0.65 * this.armorCond[zone]);
    return zone === 'front' && this.ramActive ? Math.min(0.75, a + 0.3) : a;
  }

  /** Apply raw damage to a zone; returns HP actually lost. */
  hit(zone: Zone, raw: number, attacker: number, now: number): number {
    if (!this.alive || raw <= 0) return 0;
    const dmg = raw * (1 - this.armor(zone));
    this.hp = Math.max(0, this.hp - dmg);
    this.damageTaken += dmg;
    this.armorCond[zone] = Math.max(0, this.armorCond[zone] - raw / 1400);
    // where it hurts: the engine sits in the nose but big rear hits shake it too, sides bend steering and tyres
    if (zone === 'front') { this.engine -= dmg / 1100; this.steering -= dmg / 2600; }
    if (zone === 'rear') this.engine -= dmg / 2200;
    if (zone === 'left' || zone === 'right') { this.steering -= dmg / 1500; this.tires -= dmg / 1800; }
    this.engine = Math.max(0.15, this.engine);
    this.steering = Math.max(0.35, this.steering);
    this.tires = Math.max(0.45, this.tires);
    if (attacker >= 0) { this.lastAttacker = attacker; this.lastHitT = now; }
    return dmg;
  }

  /** Non-collision damage (fire zones, sudden death, shockwave). */
  burn(amount: number, attacker = -1, now = 0) {
    if (!this.alive) return 0;
    const d = Math.min(this.hp, amount);
    this.hp -= d;
    this.damageTaken += d;
    if (attacker >= 0) { this.lastAttacker = attacker; this.lastHitT = now; }
    return d;
  }

  repair(amount: number) {
    if (!this.alive) return;
    this.hp = Math.min(MAX_HP, this.hp + amount);
    this.engine = Math.min(1, this.engine + 0.25);
    this.steering = Math.min(1, this.steering + 0.2);
    this.tires = Math.min(1, this.tires + 0.2);
    for (const z of Object.keys(this.armorCond) as Zone[]) this.armorCond[z] = Math.min(1, this.armorCond[z] + 0.2);
  }

  /** Per-frame: overheating at critical damage. */
  update(dt: number) {
    if (this.stage === 4) this.heat = (this.heat + dt) % 4;
    else this.heat = 0;
  }

  /** How the damage changes the driving (multipliers for the car). */
  get power() {
    const st = [1, 1, 0.95, 0.8, 0.55, 0][this.stage];
    const overheating = this.stage === 4 && this.heat > 3 ? 0.35 : 1;
    return st * (0.55 + 0.45 * this.engine) * overheating;
  }
  get steer() { return [1, 1, 0.96, 0.85, 0.65, 0][this.stage] * this.steering; }
  get grip() { return (this.stage >= 3 ? 0.93 : 1) * (0.75 + 0.25 * this.tires); }
  /** Engine smoke 0..1 for the effects. */
  get smoke() { return [0, 0, 0.3, 0.6, 0.95, 1][this.stage]; }
  get overheating() { return this.stage === 4; }
}

/** Which zone of a car a local contact point is in (car frame: +Z forward, +X left). */
export function zoneOf(local: THREE.Vector3): Zone {
  const a = Math.atan2(local.x, local.z); // 0 = straight ahead
  if (Math.abs(a) < Math.PI / 4.2) return 'front';
  if (Math.abs(a) > Math.PI - Math.PI / 3.6) return 'rear';
  return a > 0 ? 'left' : 'right';
}

/**
 * Collision damage: from the closing speed along the contact normal, the mass ratio, and the
 * attacker's ramming power. Below 2.5 m/s nothing happens (rubbing, pushing), and a pair of cars
 * only deals damage again after a short cooldown, so staying in contact doesn't drain HP every frame.
 */
export interface HitInput {
  closing: number; // m/s
  myMass: number;
  otherMass: number; // Infinity for walls and obstacles
  /** Where we were hit, and whether the other car hit us with its front. */
  myZone: Zone;
  otherFront: boolean;
  otherRam: number; // attacker's ram multiplier (1 for walls)
  otherRamActive: boolean;
  wall: boolean;
  damageMult: number; // match modifier (double damage)
}

export const MIN_CLOSING = 2.5;
export const PAIR_COOLDOWN = 0.35;

export function collisionDamage(h: HitInput): number {
  if (h.closing < MIN_CLOSING) return 0;
  const massShare = h.wall ? 1 : (2 * h.otherMass) / (h.myMass + h.otherMass);
  let raw = 2.0 * Math.pow(h.closing - MIN_CLOSING * 0.6, 1.8) * massShare;
  if (h.wall) raw *= 0.55; // walls hurt, but ramming each other is what wins
  else if (h.otherFront) raw *= h.otherRam * (h.otherRamActive ? 1.6 : 1);
  // hitting with your own front is the safest way to hit
  if (h.myZone === 'front' && !h.wall) raw *= 0.7;
  return raw * h.damageMult;
}
