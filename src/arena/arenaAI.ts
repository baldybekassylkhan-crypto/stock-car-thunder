import * as THREE from 'three';
import type { DriverInput } from '../core/input';
import type { Car } from '../vehicle/car';
import type { AbilityId } from './abilities';
import { SHOCK } from './abilities';

/**
 * Arena AI. Each bot has a personality that changes who it picks on, how much risk it takes
 * and when it backs off:
 *   aggressive — hunts (and prefers) the player, goes for big ramming runs, picks on weak cars
 *   defensive  — avoids head-on hits, turns its damaged side away, keeps its distance when low
 *   tactical   — targets low-HP cars from the side or rear, avoids getting ganged up on
 *   survival   — stays out of big fights near the edge, only strikes at good opportunities
 * Decisions run at ~20 Hz; steering every frame.
 */
export type Personality = 'aggressive' | 'defensive' | 'tactical' | 'survival';
export const PERSONALITIES: Personality[] = ['aggressive', 'tactical', 'defensive', 'survival'];

export interface Combatant {
  slot: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fwd: THREE.Vector3;
  hp: number;
  alive: boolean;
  human: boolean;
}

interface Traits { aggression: number; preferPlayer: number; retreatHp: number; flank: number; crowdFear: number; edgeLove: number }
const TRAITS: Record<Personality, Traits> = {
  aggressive: { aggression: 1.0, preferPlayer: 0.6, retreatHp: 0, flank: 0.1, crowdFear: 0.1, edgeLove: 0 },
  defensive: { aggression: 0.45, preferPlayer: 0, retreatHp: 420, flank: 0.3, crowdFear: 0.5, edgeLove: 0.2 },
  tactical: { aggression: 0.75, preferPlayer: 0.1, retreatHp: 260, flank: 1.0, crowdFear: 0.7, edgeLove: 0 },
  survival: { aggression: 0.3, preferPlayer: 0, retreatHp: 600, flank: 0.5, crowdFear: 1.0, edgeLove: 0.8 },
};

type Mode = 'hunt' | 'retreat' | 'recover' | 'backoff' | 'evade';

export class ArenaAI {
  target = -1;
  mode: Mode = 'hunt';
  private traits: Traits;
  private thinkT = 0;
  private modeT = 0;
  private targetT = 0;
  private stuckT = 0;
  private pushT = 0;
  private goal = new THREE.Vector3();
  private reverse = false;
  private lastHp = 1000;
  /** Ability requests for the session (consumed each frame). */
  wants: AbilityId[] = [];

  constructor(readonly car: Car, readonly slot: number, readonly personality: Personality, private radius: number, private obstacles: { x: number; z: number; r: number }[], seed: number) {
    this.traits = TRAITS[personality];
    this.thinkT = (seed % 7) * 0.013;
  }

  /** Pick who to go after. */
  private chooseTarget(me: Combatant, all: Combatant[]) {
    let best = -1, bestScore = -Infinity;
    for (const o of all) {
      if (o.slot === me.slot || !o.alive) continue;
      const d = o.pos.distanceTo(me.pos);
      let score = -d * 0.04;
      score += (1000 - o.hp) / 1000 * (0.6 + this.traits.flank); // weak cars are tempting
      if (o.human) score += this.traits.preferPlayer;
      // tactical / survival: avoid the middle of a pile-up
      const crowd = all.filter((x) => x.alive && x.slot !== o.slot && x.pos.distanceTo(o.pos) < 15).length;
      score -= crowd * 0.25 * this.traits.crowdFear;
      // stick with the current target a while (no dithering)
      if (o.slot === this.target) score += 0.4;
      if (score > bestScore) { bestScore = score; best = o.slot; }
    }
    if (best !== this.target) this.targetT = 0;
    this.target = best;
  }

  drive(dt: number, me: Combatant, all: Combatant[], hp: number, repairsLeft: number, locked: boolean): DriverInput {
    this.wants = [];
    const car = this.car;
    const sp = car.telemetry.speed;
    if (locked) return { steer: 0, throttle: 0, brake: 1, shiftUp: false, shiftDown: false };
    this.modeT += dt;
    this.targetT += dt;
    const tookHit = hp < this.lastHp - 30;
    this.lastHp = hp;

    // ---------- think (~20 Hz) ----------
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.05;
      const tgt = all.find((o) => o.slot === this.target);
      if (!tgt || !tgt.alive || this.targetT > 9 || tookHit && Math.random() < 0.3) this.chooseTarget(me, all);
      // stuck: throttle on, not moving
      if (Math.abs(sp) < 1.2 && this.mode !== 'recover' && this.modeT > 1) this.stuckT += 0.05; else this.stuckT = 0;
      if (this.stuckT > 1.3) this.setMode('recover');
      // retreat when hurt (defensive / survival / tactical)
      if (this.mode === 'hunt' && hp < this.traits.retreatHp && Math.random() < 0.05) this.setMode('retreat');
      if (this.mode === 'retreat' && (hp > this.traits.retreatHp + 150 || this.modeT > 8)) this.setMode('hunt');
      // incoming car: dodge if we're not the aggressive type
      const threat = this.incoming(me, all);
      if (threat && this.mode === 'hunt' && this.traits.aggression < 0.9 && Math.random() < 0.25) this.setMode('evade');
      if (this.mode === 'evade' && this.modeT > 1.2) this.setMode('hunt');
      if (this.mode === 'recover' && this.modeT > 1.4) this.setMode('hunt');
      if (this.mode === 'backoff' && this.modeT > 1.0) this.setMode('hunt');

      // ---------- abilities ----------
      const t2 = all.find((o) => o.slot === this.target);
      if (hp < (this.personality === 'defensive' || this.personality === 'survival' ? 480 : 340) && repairsLeft > 0 && !threat) this.wants.push('repair');
      const near = all.filter((o) => o.alive && o.slot !== me.slot && o.pos.distanceTo(me.pos) < SHOCK.radius * 0.7).length;
      if (near >= 2 || (threat && threat.pos.distanceTo(me.pos) < 7)) this.wants.push('shock');
      if (t2 && this.mode === 'hunt') {
        const toT = t2.pos.clone().sub(me.pos);
        const d = toT.length();
        const ang = me.fwd.angleTo(toT.setY(0).normalize());
        if (ang < 0.22 && d > 12 && d < 40 && sp > 6) this.wants.push('nitro');
        const closing = sp - t2.vel.dot(me.fwd);
        if (ang < 0.35 && d < Math.max(8, closing * 1.3) && closing > 6) this.wants.push('ram');
      }
    }

    // ---------- where to go ----------
    const tgt = all.find((o) => o.slot === this.target);
    const center = new THREE.Vector3();
    if (this.mode === 'recover') {
      // back out of whatever we're stuck on, turning towards the centre
      this.reverse = true;
      this.goal.copy(center);
    } else if (this.mode === 'backoff') {
      this.reverse = true;
      this.goal.copy(tgt ? tgt.pos : center);
    } else if (this.mode === 'retreat' || !tgt) {
      this.reverse = false;
      // quiet spot: away from the nearest enemies, near (not at) the wall for survival types
      const away = new THREE.Vector3();
      for (const o of all) if (o.alive && o.slot !== me.slot) { const d = me.pos.clone().sub(o.pos); const l = d.length(); if (l < 40) away.addScaledVector(d.normalize(), (40 - l) / 40); }
      const edge = this.radius * (0.45 + 0.3 * this.traits.edgeLove);
      const dir = away.lengthSq() > 0.01 ? away.setY(0).normalize() : me.pos.clone().setY(0).normalize();
      this.goal.copy(dir.multiplyScalar(edge));
    } else if (this.mode === 'evade') {
      this.reverse = false;
      const threat = this.incoming(me, all);
      const side = threat ? new THREE.Vector3(-threat.vel.z, 0, threat.vel.x).normalize() : me.fwd.clone();
      if (side.dot(me.pos.clone().negate()) < 0) side.negate(); // dodge towards the centre side
      this.goal.copy(me.pos).addScaledVector(side, 20);
    } else {
      this.reverse = false;
      // hunt: lead the target; tactical drivers aim at its side or rear
      const lead = THREE.MathUtils.clamp(tgt.pos.distanceTo(me.pos) / Math.max(8, Math.abs(sp)), 0, 1.2);
      this.goal.copy(tgt.pos).addScaledVector(tgt.vel, lead);
      if (this.traits.flank > 0.3 && tgt.pos.distanceTo(me.pos) > 9) {
        const side = new THREE.Vector3(-tgt.fwd.z, 0, tgt.fwd.x);
        this.goal.addScaledVector(side, (me.pos.clone().sub(tgt.pos).dot(side) > 0 ? 1 : -1) * 4 * this.traits.flank);
      }
      // pinned against the target with no speed: back off and come again
      if (tgt.pos.distanceTo(me.pos) < 6 && Math.abs(sp) < 3) this.pushT += dt; else this.pushT = 0;
      if (this.pushT > 2.2) { this.pushT = 0; this.setMode('backoff'); }
    }

    // ---------- avoid walls and obstacles ----------
    const g = this.goal;
    const gr = Math.hypot(g.x, g.z);
    if (gr > this.radius - 9) g.multiplyScalar((this.radius - 9) / gr);
    const ahead = me.pos.clone().addScaledVector(me.fwd, Math.max(6, Math.abs(sp) * 0.8));
    if (!this.reverse) {
      if (Math.hypot(ahead.x, ahead.z) > this.radius - 5) g.lerp(center, 0.6);
      for (const ob of this.obstacles) {
        const dx = ahead.x - ob.x, dz = ahead.z - ob.z;
        const d = Math.hypot(dx, dz);
        if (d < ob.r + 4) g.add(new THREE.Vector3(dx, 0, dz).normalize().multiplyScalar(10));
      }
    }

    // ---------- steer / pedals ----------
    const r = car.body.rotation();
    const inv = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
    const local = g.clone().sub(me.pos).applyQuaternion(inv);
    const ang = Math.atan2(local.x, local.z); // + = goal on the left
    let steer: number, throttle: number, brake: number;
    if (this.reverse) {
      // reversing: the nose swings the other way
      steer = THREE.MathUtils.clamp(ang * 1.4, -1, 1);
      throttle = 0;
      brake = 1;
    } else {
      steer = THREE.MathUtils.clamp(-ang * 2.0, -1, 1);
      const sharp = Math.abs(ang);
      const want = this.mode === 'retreat' ? 18 : this.mode === 'evade' ? 26 : 22 + 18 * this.traits.aggression;
      const vT = sharp > 1.2 ? 9 : want * (1 - Math.min(0.6, sharp * 0.4));
      throttle = THREE.MathUtils.clamp((vT - sp) * 0.4, 0, 1);
      brake = THREE.MathUtils.clamp((sp - vT) * 0.15, 0, 1);
      // goal right behind and close: three-point turn by reversing
      if (sharp > 2.2 && local.length() < 14 && Math.abs(sp) < 6) { this.setMode('recover'); }
    }
    return { steer, throttle, brake, shiftUp: false, shiftDown: false };
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.modeT = 0;
    this.stuckT = 0;
  }

  /** A car coming at us fast (time to impact < 1.4 s). */
  private incoming(me: Combatant, all: Combatant[]): Combatant | null {
    for (const o of all) {
      if (!o.alive || o.slot === me.slot) continue;
      const rel = me.pos.clone().sub(o.pos);
      const d = rel.length();
      if (d > 30) continue;
      const closing = o.vel.clone().sub(me.vel).dot(rel.normalize());
      if (closing > 8 && d / closing < 1.4) return o;
    }
    return null;
  }
}
