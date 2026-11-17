import * as THREE from 'three';
import type { Track } from '../tracks/track';
import type { Car } from '../vehicle/car';
import { BotDriver } from '../vehicle/bot';

/**
 * Racing-line assist: a ribbon on the road ahead coloured by what to do with the pedals —
 * green: flat out, yellow: lift / ease off, red: brake. Target speeds come from the same corner
 * and braking model the AI uses, for the player's car and current tyres.
 */
const AHEAD = 110; // ribbon samples
const STEP = 2; // track samples per ribbon sample
const HALF_W = 0.4;

export class RacingLine {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private ai: BotDriver;
  private target: Float32Array;
  private lateral: Float32Array;
  private profileT = 0;

  constructor(private car: Car, private track: Track, private oval: boolean) {
    this.ai = new BotDriver(car, track, 1, oval, 0);
    this.target = new Float32Array(track.n);
    this.lateral = new Float32Array(track.n);
    for (let i = 0; i < track.n; i++) this.lateral[i] = this.lineAt(i);
    this.pos = new Float32Array(AHEAD * 2 * 3);
    this.col = new Float32Array(AHEAD * 2 * 4);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    const idx: number[] = [];
    for (let k = 0; k < AHEAD - 1; k++) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.profile();
  }

  /** Racing line lateral offset: the middle groove on ovals, outside-apex-outside on road courses. */
  private lineAt(i: number) {
    const tr = this.track;
    if (this.oval) return tr.width * 0.42;
    let k = 0;
    for (let j = 4; j < 30; j += 2) k += tr.curvature[tr.wrap(i + j)];
    const turn = THREE.MathUtils.clamp((k / 13) * 90, -1, 1);
    return tr.width / 2 - turn * (tr.width / 2 - 2.2);
  }

  /** Target speed around the lap: corner speeds, then braking distances backwards. */
  private profile() {
    const tr = this.track, n = tr.n;
    for (let i = 0; i < n; i++) this.target[i] = this.ai.maxSpeedAt(i, this.lateral[i]);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const next = this.target[(i + 1) % n];
        const v = Math.sqrt(next * next + 2 * this.ai.decelAt(Math.min(next, 90)) * tr.ds);
        if (v < this.target[i]) this.target[i] = v;
      }
    }
  }

  /** The player got a new car (respawn). */
  setCar(car: Car) {
    this.car = car;
    this.ai = new BotDriver(car, this.track, 1, this.oval, 0);
  }

  update(index: number) {
    const tr = this.track;
    // tyres warm up and wear, so refresh the targets now and then
    this.profileT += 1;
    if (this.profileT > 240) { this.profileT = 0; this.profile(); }
    const speed = Math.abs(this.car.telemetry.speed);
    const myLat = tr.lateral(this.car.position, index);
    const p = new THREE.Vector3();
    for (let k = 0; k < AHEAD; k++) {
      const i = tr.wrap(index + 3 + k * STEP);
      // ovals: start from where the car is and blend into the groove
      const lat = this.oval ? THREE.MathUtils.lerp(myLat, this.lateral[i], Math.min(1, k / 40)) : this.lateral[i];
      for (const side of [-1, 1]) {
        p.copy(tr.surface(i, lat + side * HALF_W)).addScaledVector(tr.N[i], 0.03);
        const o = (k * 2 + (side > 0 ? 1 : 0)) * 3;
        this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z;
      }
      // colour: how far above the target speed we'd be arriving here
      const over = speed - this.target[i];
      const [r, g, b] = over > 1.5 ? [0.95, 0.18, 0.15] : over > -4 ? [1, 0.8, 0.15] : [0.2, 0.9, 0.35];
      const a = 0.55 * Math.min(1, k / 6) * Math.min(1, (AHEAD - k) / 20);
      for (let s2 = 0; s2 < 2; s2++) {
        const o = (k * 2 + s2) * 4;
        this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = b; this.col[o + 3] = a;
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
