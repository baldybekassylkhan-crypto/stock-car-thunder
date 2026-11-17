import * as THREE from 'three';

/**
 * Visible slipstream: while you're tucked in behind another car, two white air lines stream along
 * both sides of your car — from the leader's tail back past you — with bright dashes rushing
 * backwards along them, and a meter shows how much tow you're getting.
 */
export class Slipstream {
  readonly group = new THREE.Group();
  private sides: THREE.Mesh[] = [];
  private tex: THREE.CanvasTexture;
  private mat: THREE.MeshBasicMaterial;
  private level = 0;
  private scroll = 0;
  private meter: HTMLDivElement;

  constructor(scene: THREE.Object3D, hudRoot: HTMLElement) {
    // rushing white streaks with gaps between them (scrolled backwards each frame) ...
    const c = document.createElement('canvas');
    c.width = 16; c.height = 256;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 16, 256);
    for (const [y0, h, a] of [[10, 70, 1], [110, 40, 0.8], [170, 60, 0.95], [238, 14, 0.6]]) {
      const gr = g.createLinearGradient(0, y0, 0, y0 + h);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.3, `rgba(255,255,255,${a})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, y0, 16, h);
    }
    this.tex = new THREE.CanvasTexture(c);
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    // ... over a faint continuous line that fades out at both ends
    const f = document.createElement('canvas');
    f.width = 4; f.height = 128;
    const fg = f.getContext('2d')!;
    const fade = fg.createLinearGradient(0, 0, 0, 128);
    fade.addColorStop(0, '#000'); fade.addColorStop(0.25, '#fff'); fade.addColorStop(0.75, '#fff'); fade.addColorStop(1, '#000');
    fg.fillStyle = fade;
    fg.fillRect(0, 0, 4, 128);
    const alpha = new THREE.CanvasTexture(f);
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, alphaMap: alpha, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (let k = 0; k < 2; k++) {
      // unit-length tube along +Y, stretched and aimed each frame
      const geo = new THREE.CylinderGeometry(0.02, 0.02, 1, 5, 1, true);
      const m = new THREE.Mesh(geo, this.mat);
      m.frustumCulled = false;
      m.renderOrder = 5;
      this.group.add(m);
      this.sides.push(m);
    }
    this.group.visible = false;
    scene.add(this.group);
    this.meter = document.createElement('div');
    this.meter.className = 'slip-meter';
    this.meter.innerHTML = '<span>SLIPSTREAM</span><i><b></b></i>';
    hudRoot.appendChild(this.meter);
  }

  /**
   * Per frame. `draft` 0..~0.38 is how much drag you're saved; `leader` the car you're following
   * (its position and your travel direction) or null.
   */
  update(dt: number, draft: number, me: THREE.Vector3, leader: { pos: THREE.Vector3; fwd: THREE.Vector3 } | null, speed: number) {
    const target = leader ? Math.min(1, draft / 0.3) : 0;
    this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 2.5 : 4));
    const on = this.level > 0.04 && !!leader;
    this.group.visible = on;
    this.mat.opacity = Math.min(1, this.level * 1.3);
    this.meter.classList.toggle('on', on);
    (this.meter.querySelector('b') as HTMLElement).style.width = `${Math.round(this.level * 100)}%`;
    this.meter.classList.toggle('full', this.level > 0.85);
    if (!on || !leader) return;
    const fwd = leader.fwd;
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const from = leader.pos.clone().addScaledVector(fwd, -2.4); // the leader's tail
    const to = me.clone().addScaledVector(fwd, -14); // and well past you
    const len = from.distanceTo(to);
    this.scroll += dt * speed * 0.06;
    this.tex.repeat.set(1, Math.max(1, len / 9));
    this.tex.offset.set(0, this.scroll);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    this.sides.forEach((m, k) => {
      const side = k === 0 ? 1 : -1;
      // the lines hug the leader's flanks and open out slightly along your car
      const mid = from.clone().lerp(to, 0.5).addScaledVector(right, side * 1.2);
      mid.y += 0.65;
      m.position.copy(mid);
      m.quaternion.copy(q);
      m.scale.set(1, len, 1);
    });
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.sides) m.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
    this.meter.remove();
  }
}
