import * as THREE from 'three';

/**
 * Visible slipstream: when you're tucked in behind another car, white air streaks stream from the
 * leader's tail back past your car (like the slipstream lines in arcade racers), and a meter
 * shows how much of the tow you're getting.
 */
const N = 70;

export class Slipstream {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private col: Float32Array;
  private s = new Float32Array(N); // 0..1 along the leader → you path
  private off: THREE.Vector3[] = [];
  private len = new Float32Array(N);
  private level = 0;
  private meter: HTMLDivElement;

  constructor(scene: THREE.Object3D, hudRoot: HTMLElement) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 6);
    this.col = new Float32Array(N * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    scene.add(this.lines);
    for (let k = 0; k < N; k++) { this.s[k] = Math.random(); this.off.push(this.randOff()); this.len[k] = 2 + Math.random() * 4; }
    this.meter = document.createElement('div');
    this.meter.className = 'slip-meter';
    this.meter.innerHTML = '<span>SLIPSTREAM</span><i><b></b></i>';
    hudRoot.appendChild(this.meter);
  }

  private randOff() {
    // an oval tube around the car: wider than tall, mostly at body height
    const a = Math.random() * Math.PI * 2, r = 0.7 + Math.random() * 0.8;
    return new THREE.Vector3(Math.cos(a) * r * 1.3, 0.75 + Math.sin(a) * r * 0.55, 0);
  }

  /**
   * Per frame. `draft` 0..~0.38 is how much drag you're saved; `leader` the car you're following
   * (its position and travel direction) or null.
   */
  update(dt: number, draft: number, me: THREE.Vector3, leader: { pos: THREE.Vector3; fwd: THREE.Vector3 } | null, speed: number) {
    const target = leader ? Math.min(1, draft / 0.3) : 0;
    this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 2.5 : 4));
    const on = this.level > 0.04 && !!leader;
    (this.lines.material as THREE.LineBasicMaterial).opacity = on ? Math.min(0.85, this.level * 1.1) : 0;
    this.lines.visible = on;
    this.meter.classList.toggle('on', on);
    (this.meter.querySelector('b') as HTMLElement).style.width = `${Math.round(this.level * 100)}%`;
    this.meter.classList.toggle('full', this.level > 0.85);
    if (!on || !leader) return;
    const fwd = leader.fwd;
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const from = leader.pos.clone().addScaledVector(fwd, -2.6); // leader's tail
    const to = me.clone().addScaledVector(fwd, -4); // a little behind you, so streaks rush past
    const span = from.distanceTo(to);
    const flow = (speed * 0.9) / Math.max(8, span); // streaks move back at roughly road speed
    const p = new THREE.Vector3();
    for (let k = 0; k < N; k++) {
      this.s[k] += dt * flow * (0.8 + (k % 5) * 0.08);
      if (this.s[k] > 1) { this.s[k] -= 1; this.off[k] = this.randOff(); this.len[k] = 2 + Math.random() * 4; }
      const t = this.s[k];
      // the tube narrows near the leader and opens around you
      const widen = 0.55 + t * 0.6;
      p.copy(from).lerp(to, t).addScaledVector(right, this.off[k].x * widen);
      p.y += this.off[k].y;
      const i = k * 6;
      this.pos[i] = p.x; this.pos[i + 1] = p.y; this.pos[i + 2] = p.z;
      this.pos[i + 3] = p.x - fwd.x * this.len[k]; this.pos[i + 4] = p.y - fwd.y * this.len[k]; this.pos[i + 5] = p.z - fwd.z * this.len[k];
      // fade in from the leader, fade out after passing you
      const a = Math.min(1, t * 4) * Math.min(1, (1 - t) * 5);
      const tint = [0.75 * a, 0.9 * a, 1.0 * a];
      this.col.set(tint, i); this.col.set([tint[0] * 0.2, tint[1] * 0.2, tint[2] * 0.2], i + 3);
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.meter.remove();
  }
}
