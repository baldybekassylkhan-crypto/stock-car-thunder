import * as THREE from 'three';
import { rng } from '../tracks/props';
import type { Effects } from '../render/effects';

/**
 * Optional match modifiers and arena events. Never all at once: the lobby picks none, one, or
 * "random" (two different ones). Everything is seeded from the match seed, so every player in an
 * online room sees the same hazards and pickups.
 */
export type EventId = 'double' | 'lowgrav' | 'fire' | 'oil' | 'sudden' | 'pickups';
export const EVENT_INFO: Record<EventId, { name: string; blurb: string }> = {
  double: { name: 'Double Damage', blurb: 'All collisions deal twice the damage.' },
  lowgrav: { name: 'Low Gravity', blurb: 'Cars jump and bounce on every hit.' },
  fire: { name: 'Fire Arena', blurb: 'Burning patches on the floor eat your health.' },
  oil: { name: 'Oil Spill', blurb: 'Slick patches with almost no grip.' },
  sudden: { name: 'Sudden Death', blurb: 'From 1:30 the safe zone shrinks; outside it you burn.' },
  pickups: { name: 'Pickups', blurb: 'Repair and nitro pickups appear around the arena.' },
};
export const EVENT_IDS = Object.keys(EVENT_INFO) as EventId[];

/** Lobby setting → the modifiers for this match. */
export function pickEvents(setting: string, seed: number): EventId[] {
  if (setting === 'off' || !setting) return [];
  if (setting !== 'random') return EVENT_IDS.includes(setting as EventId) ? [setting as EventId] : [];
  const r = rng(seed);
  const pool = [...EVENT_IDS];
  const a = pool.splice(Math.floor(r() * pool.length), 1)[0];
  const b = pool.splice(Math.floor(r() * pool.length), 1)[0];
  return [a, b];
}

interface Zone { x: number; z: number; r: number }
export interface Pickup { id: number; kind: 'repair' | 'nitro'; pos: THREE.Vector3; mesh: THREE.Group; taken: boolean }

const SUDDEN_START = 90;
const SUDDEN_SHRINK = 60;
const PICKUP_EVERY = 18;
export const PICKUP_REPAIR = 250;

export class ArenaEvents {
  readonly group = new THREE.Group();
  readonly fire: Zone[] = [];
  readonly oil: Zone[] = [];
  readonly pickups = new Map<number, Pickup>();
  private spawned = 0;
  private suddenRing: THREE.Mesh | null = null;
  private t = 0;

  constructor(readonly events: EventId[], private radius: number, private seed: number) {
    const r = rng(seed * 31 + 7);
    const spot = (minD: number, maxD: number): Zone => {
      const a = r() * Math.PI * 2, d = minD + r() * (maxD - minD);
      return { x: Math.cos(a) * d, z: Math.sin(a) * d, r: 0 };
    };
    if (this.has('fire')) {
      for (let k = 0; k < 3; k++) {
        const z = { ...spot(12, radius - 18), r: 6.5 };
        this.fire.push(z);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 40), new THREE.MeshStandardMaterial({ color: 0x2a0d02, emissive: 0xff4a10, emissiveIntensity: 1.6, roughness: 1, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -3 }));
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(z.x, 0.03, z.z);
        this.group.add(disc);
      }
    }
    if (this.has('oil')) {
      for (let k = 0; k < 4; k++) {
        const z = { ...spot(8, radius - 12), r: 7.5 };
        this.oil.push(z);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 40), new THREE.MeshPhysicalMaterial({ color: 0x050505, roughness: 0.05, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -3 }));
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(z.x, 0.025, z.z);
        this.group.add(disc);
      }
    }
    if (this.has('sudden')) {
      this.suddenRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 128), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
      this.suddenRing.rotation.x = Math.PI / 2;
      this.suddenRing.position.y = 0.15;
      this.suddenRing.visible = false;
      this.group.add(this.suddenRing);
    }
  }

  has(id: EventId) { return this.events.includes(id); }
  get damageMult() { return this.has('double') ? 2 : 1; }
  get gravity() { return this.has('lowgrav') ? -4.2 : -9.81; }

  /** Safe radius under Sudden Death (Infinity before it starts / when off). */
  safeRadius(matchT: number) {
    if (!this.has('sudden') || matchT < SUDDEN_START) return Infinity;
    const k = Math.min(1, (matchT - SUDDEN_START) / SUDDEN_SHRINK);
    return THREE.MathUtils.lerp(this.radius, 22, k);
  }
  suddenActive(matchT: number) { return this.safeRadius(matchT) < Infinity; }

  /** Hazards where a car is: HP lost per second and a grip multiplier. */
  hazardAt(p: THREE.Vector3, matchT: number) {
    let burn = 0, grip = 1, fire = false;
    for (const z of this.fire) if (Math.hypot(p.x - z.x, p.z - z.z) < z.r) { burn += 45; fire = true; }
    for (const z of this.oil) if (Math.hypot(p.x - z.x, p.z - z.z) < z.r) grip = 0.35;
    if (Math.hypot(p.x, p.z) > this.safeRadius(matchT)) burn += 30;
    return { burn, grip, fire };
  }

  /**
   * Pickups appear on a fixed schedule from the match clock (same for everyone); the host
   * confirms who took one.
   */
  updatePickups(matchT: number) {
    if (!this.has('pickups')) return;
    while (matchT > (this.spawned + 1) * PICKUP_EVERY) {
      const id = this.spawned++;
      const r = rng(this.seed * 13 + id * 101);
      const a = r() * Math.PI * 2, d = 10 + r() * (this.radius - 20);
      const kind: Pickup['kind'] = id % 2 === 0 ? 'repair' : 'nitro';
      const pos = new THREE.Vector3(Math.cos(a) * d, 1.2, Math.sin(a) * d);
      const mesh = new THREE.Group();
      const color = kind === 'repair' ? 0x3ad17a : 0x34b6ff;
      const core = new THREE.Mesh(kind === 'repair' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.OctahedronGeometry(0.75), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.2 }));
      mesh.add(core);
      if (kind === 'repair') {
        const crossMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        mesh.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 1.02), crossMat), new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 1.02), crossMat));
      }
      const halo = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.5, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = -1.1;
      mesh.add(halo);
      mesh.position.copy(pos);
      this.group.add(mesh);
      this.pickups.set(id, { id, kind, pos, mesh, taken: false });
    }
  }

  /** A live pickup within reach of this position. */
  pickupNear(p: THREE.Vector3): Pickup | null {
    for (const pk of this.pickups.values()) if (!pk.taken && pk.pos.distanceTo(p.clone().setY(1.2)) < 2.6) return pk;
    return null;
  }

  takePickup(id: number) {
    const pk = this.pickups.get(id);
    if (!pk || pk.taken) return null;
    pk.taken = true;
    pk.mesh.removeFromParent();
    return pk;
  }

  /** Visuals: flames over the fire zones, spinning pickups, the shrinking sudden-death ring. */
  update(dt: number, matchT: number, effects: Effects) {
    this.t += dt;
    for (const z of this.fire) {
      const n = Math.random() < dt * 25 ? 1 : 0;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * z.r;
        effects.fire(new THREE.Vector3(z.x + Math.cos(a) * d, 0.2, z.z + Math.sin(a) * d), new THREE.Vector3(0, 1.5, 0), 0.9);
      }
    }
    for (const pk of this.pickups.values()) {
      if (pk.taken) continue;
      pk.mesh.rotation.y += dt * 1.8;
      pk.mesh.position.y = pk.pos.y + Math.sin(this.t * 2.5 + pk.id) * 0.25;
    }
    if (this.suddenRing) {
      const sr = this.safeRadius(matchT);
      this.suddenRing.visible = sr < Infinity;
      if (sr < Infinity) this.suddenRing.scale.setScalar(sr);
    }
  }
}
