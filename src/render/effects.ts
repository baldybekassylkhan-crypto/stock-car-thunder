import * as THREE from 'three';

/**
 * CPU-simulated particle pools rendered as point sprites:
 *  - additive pool: sparks, fire, explosion flash, fireworks
 *  - alpha pool: smoke, dust, tire smoke, spray, glass
 * Plus skid marks (ring buffer of ground quads) and rain.
 */

const VERT = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 pcolor;
varying float vAlpha;
varying vec3 vColor;
uniform float scale;
void main() {
  vAlpha = alpha;
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
uniform sampler2D tex;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(tex, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
}`;

function softTexture(hard = 0.0) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(Math.max(0.01, hard), 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

interface PDesc {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  size: [number, number];
  color: [THREE.Color, THREE.Color];
  alpha: [number, number];
  gravity?: number;
  drag?: number;
}

class Pool {
  readonly points: THREE.Points;
  private n = 0;
  private cap: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private size: Float32Array;
  private s01: Float32Array;
  private alpha: Float32Array;
  private a01: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor(cap: number, blending: THREE.Blending, tex: THREE.Texture) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.s01 = new Float32Array(cap * 2);
    this.alpha = new Float32Array(cap);
    this.a01 = new Float32Array(cap * 2);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { tex: { value: tex }, scale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = blending === THREE.AdditiveBlending ? 3 : 2;
  }

  setScale(s: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = s;
  }

  emit(d: PDesc) {
    let i: number;
    if (this.n < this.cap) i = this.n++;
    else i = Math.floor(Math.random() * this.cap); // overwrite a random one when full
    this.pos.set([d.pos.x, d.pos.y, d.pos.z], i * 3);
    this.vel.set([d.vel.x, d.vel.y, d.vel.z], i * 3);
    this.c0.set([d.color[0].r, d.color[0].g, d.color[0].b], i * 3);
    this.c1.set([d.color[1].r, d.color[1].g, d.color[1].b], i * 3);
    this.s01[i * 2] = d.size[0]; this.s01[i * 2 + 1] = d.size[1];
    this.a01[i * 2] = d.alpha[0]; this.a01[i * 2 + 1] = d.alpha[1];
    this.life[i] = 0;
    this.maxLife[i] = d.life;
    this.grav[i] = d.gravity ?? 0;
    this.drag[i] = d.drag ?? 0;
  }

  update(dt: number) {
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        // swap-remove with last
        const last = --this.n;
        if (i !== last) this.copy(last, i);
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      const k = i * 3;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[k] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt; this.vel[k + 2] *= dr;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      for (let c = 0; c < 3; c++) this.col[k + c] = this.c0[k + c] + (this.c1[k + c] - this.c0[k + c]) * t;
      this.size[i] = this.s01[i * 2] + (this.s01[i * 2 + 1] - this.s01[i * 2]) * t;
      // fade in quickly, then out
      const fin = Math.min(1, t * 8);
      this.alpha[i] = (this.a01[i * 2] + (this.a01[i * 2 + 1] - this.a01[i * 2]) * t) * fin;
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const name of ['position', 'pcolor', 'size', 'alpha']) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  private copy(from: number, to: number) {
    for (const [arr, w] of [[this.pos, 3], [this.vel, 3], [this.c0, 3], [this.c1, 3], [this.col, 3], [this.s01, 2], [this.a01, 2]] as const) {
      for (let c = 0; c < w; c++) arr[to * w + c] = arr[from * w + c];
    }
    this.size[to] = this.size[from]; this.alpha[to] = this.alpha[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from];
  }

  get count() { return this.n; }
}

const C = (hex: number) => new THREE.Color(hex);
const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;
const _v = new THREE.Vector3();

/** Ring-buffered skid marks laid on the surface under sliding tires. */
class SkidMarks {
  readonly mesh: THREE.Mesh;
  private cap = 3000;
  private head = 0;
  private pos: Float32Array;
  private alpha: Float32Array;
  private last = new Map<string, THREE.Vector3>();

  constructor() {
    this.pos = new Float32Array(this.cap * 4 * 3);
    this.alpha = new Float32Array(this.cap * 4);
    const idx: number[] = [];
    for (let q = 0; q < this.cap; q++) { const b = q * 4; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.02,0.02,0.02, vA); }',
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Add a mark for wheel `key` at `p` (surface point) with surface normal `n`, intensity 0..1. */
  add(key: string, p: THREE.Vector3, n: THREE.Vector3, intensity: number) {
    const prev = this.last.get(key);
    const cur = p.clone().addScaledVector(n, 0.02);
    if (!prev || prev.distanceTo(cur) > 3) { this.last.set(key, cur); return; }
    if (prev.distanceTo(cur) < 0.25) return;
    const dir = cur.clone().sub(prev).normalize();
    const side = dir.clone().cross(n).normalize().multiplyScalar(0.14);
    const q = this.head;
    this.head = (this.head + 1) % this.cap;
    const verts = [prev.clone().add(side), prev.clone().sub(side), cur.clone().add(side), cur.clone().sub(side)];
    verts.forEach((v, k) => this.pos.set([v.x, v.y, v.z], (q * 4 + k) * 3));
    const a = Math.min(0.55, 0.15 + intensity * 0.4);
    for (let k = 0; k < 4; k++) this.alpha[q * 4 + k] = a;
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
    this.last.set(key, cur);
  }

  lift(key: string) { this.last.delete(key); }
}

class Rain {
  readonly lines: THREE.LineSegments;
  private count = 2500;
  private pos: Float32Array;
  constructor() {
    this.pos = new Float32Array(this.count * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.35 }));
    this.lines.frustumCulled = false;
    for (let i = 0; i < this.count; i++) this.respawn(i, new THREE.Vector3(), true);
  }
  private respawn(i: number, c: THREE.Vector3, anyHeight = false) {
    const x = c.x + rnd(40), z = c.z + rnd(40), y = c.y + (anyHeight ? Math.random() * 30 : 25 + Math.random() * 5);
    this.pos.set([x, y, z, x + 0.05, y + 0.7, z], i * 6);
  }
  update(dt: number, cam: THREE.Vector3) {
    for (let i = 0; i < this.count; i++) {
      const k = i * 6;
      const dy = 22 * dt;
      this.pos[k + 1] -= dy; this.pos[k + 4] -= dy;
      if (this.pos[k + 1] < cam.y - 8 || Math.abs(this.pos[k] - cam.x) > 45 || Math.abs(this.pos[k + 2] - cam.z) > 45) this.respawn(i, cam);
    }
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class Effects {
  readonly group = new THREE.Group();
  private add: Pool;
  private alpha: Pool;
  readonly skids = new SkidMarks();
  private rain: Rain | null = null;
  // fixed pool of lights (adding lights at runtime would force every shader to recompile)
  private flashes: { light: THREE.PointLight; t: number; dur: number; peak: number }[] = [];

  constructor() {
    const soft = softTexture(0.15);
    this.add = new Pool(4000, THREE.AdditiveBlending, softTexture(0.35));
    this.alpha = new Pool(3500, THREE.NormalBlending, soft);
    this.group.add(this.skids.mesh, this.alpha.points, this.add.points);
    for (let k = 0; k < 3; k++) {
      const light = new THREE.PointLight(0xffa040, 0, 120, 1.6);
      this.group.add(light);
      this.flashes.push({ light, t: 1, dur: 1, peak: 0 });
    }
  }

  setRain(on: boolean) {
    if (on && !this.rain) { this.rain = new Rain(); this.group.add(this.rain.lines); }
    if (!on && this.rain) { this.group.remove(this.rain.lines); this.rain = null; }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportH: number) {
    const s = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.add.setScale(s);
    this.alpha.setScale(s);
    this.add.update(dt);
    this.alpha.update(dt);
    this.rain?.update(dt, camera.position);
    for (const f of this.flashes) {
      f.t += dt;
      f.light.intensity = f.peak * Math.max(0, 1 - f.t / f.dur) ** 2;
    }
  }

  get particleCount() { return this.add.count + this.alpha.count; }

  // ---------------------------------------------------------------- emitters
  sparks(p: THREE.Vector3, vel: THREE.Vector3, n: number, intensity = 1) {
    for (let k = 0; k < n; k++) {
      this.add.emit({
        pos: p.clone().add(_v.set(rnd(0.2), rnd(0.1), rnd(0.2))),
        vel: vel.clone().multiplyScalar(0.6 + Math.random() * 0.4).add(_v.set(rnd(4), Math.random() * 4 * intensity, rnd(4))),
        life: 0.25 + Math.random() * 0.5,
        size: [0.09, 0.02],
        color: [C(0xfff1b0), C(0xff5a10)],
        alpha: [1, 0.6],
        gravity: 9.8,
        drag: 1.2,
      });
    }
  }

  tireSmoke(p: THREE.Vector3, vel: THREE.Vector3, amount: number, color = 0xcfcfcf) {
    this.alpha.emit({
      pos: p.clone().add(_v.set(rnd(0.2), 0.15, rnd(0.2))),
      vel: vel.clone().multiplyScalar(0.25).add(_v.set(rnd(1), 0.8 + Math.random(), rnd(1))),
      life: 1.4 + Math.random() * 1.6,
      size: [0.8, 4.5 + amount * 2],
      color: [C(color), C(color)],
      alpha: [0.35 * Math.min(1, amount), 0],
      drag: 1.6,
      gravity: -0.4,
    });
  }

  dust(p: THREE.Vector3, vel: THREE.Vector3, color: number) {
    this.alpha.emit({
      pos: p.clone().add(_v.set(rnd(0.3), 0.1, rnd(0.3))),
      vel: vel.clone().multiplyScalar(0.3).add(_v.set(rnd(1.5), 1 + Math.random() * 1.5, rnd(1.5))),
      life: 1 + Math.random() * 1.5,
      size: [0.6, 3.5],
      color: [C(color), C(color)],
      alpha: [0.45, 0],
      drag: 1.4,
      gravity: 0.6,
    });
  }

  spray(p: THREE.Vector3, vel: THREE.Vector3, speed: number) {
    this.alpha.emit({
      pos: p.clone().add(_v.set(rnd(0.4), 0.2, rnd(0.4))),
      vel: vel.clone().multiplyScalar(0.4).add(_v.set(rnd(1.5), 1.2 + Math.random() * 1.5, rnd(1.5))),
      life: 0.8 + Math.random() * 0.8,
      size: [1, 3 + speed * 0.03],
      color: [C(0xd8dde2), C(0xc0c6cc)],
      alpha: [0.22, 0],
      drag: 2,
      gravity: 1,
    });
  }

  /** Damage smoke: level 0..1 (white steam → thick black). */
  smoke(p: THREE.Vector3, vel: THREE.Vector3, level: number) {
    const dark = Math.min(1, level * 1.3);
    const c = new THREE.Color(0xd9d9d9).lerp(C(0x161616), dark);
    this.alpha.emit({
      pos: p.clone().add(_v.set(rnd(0.25), 0, rnd(0.25))),
      vel: vel.clone().multiplyScalar(0.5).add(_v.set(rnd(0.6), 1.5 + Math.random() * 2, rnd(0.6))),
      life: 2 + Math.random() * 2 + level * 2,
      size: [0.6, 4 + level * 6],
      color: [c, c.clone().lerp(C(0x555555), 0.3)],
      alpha: [0.25 + level * 0.45, 0],
      drag: 0.9,
      gravity: -0.8,
    });
  }

  fire(p: THREE.Vector3, vel: THREE.Vector3, intensity: number) {
    this.add.emit({
      pos: p.clone().add(_v.set(rnd(0.35), rnd(0.1), rnd(0.35))),
      vel: vel.clone().multiplyScalar(0.6).add(_v.set(rnd(0.6), 2 + Math.random() * 3 * intensity, rnd(0.6))),
      life: 0.35 + Math.random() * 0.45,
      size: [1.0 * intensity + 0.4, 0.2],
      color: [C(0xffd27a), C(0xff2a00)],
      alpha: [0.9, 0],
      drag: 1,
      gravity: -2,
    });
  }

  explosion(p: THREE.Vector3, scale = 1) {
    // core fireball
    for (let k = 0; k < 220 * scale; k++) {
      const d = _v.set(rnd(1), Math.random() * 0.9 + 0.1, rnd(1)).normalize();
      this.add.emit({
        pos: p.clone().addScaledVector(d, Math.random() * 0.8),
        vel: d.clone().multiplyScalar(4 + Math.random() * 16 * scale),
        life: 0.5 + Math.random() * 0.9,
        size: [2.5 + Math.random() * 2.5, 0.6],
        color: [C(0xfff0c0), C(0xff3300)],
        alpha: [1, 0],
        drag: 3,
        gravity: -1.5,
      });
    }
    // burning debris streaks
    for (let k = 0; k < 90 * scale; k++) {
      this.add.emit({
        pos: p.clone(),
        vel: _v.set(rnd(22), 6 + Math.random() * 22, rnd(22)).clone(),
        life: 0.8 + Math.random() * 1.4,
        size: [0.35, 0.1],
        color: [C(0xffe0a0), C(0xff4400)],
        alpha: [1, 0.2],
        gravity: 9.8,
        drag: 0.4,
      });
    }
    // black smoke column
    for (let k = 0; k < 120 * scale; k++) {
      this.alpha.emit({
        pos: p.clone().add(_v.set(rnd(1.5), Math.random() * 2, rnd(1.5))),
        vel: _v.set(rnd(4), 2 + Math.random() * 7, rnd(4)).clone(),
        life: 3 + Math.random() * 4,
        size: [2, 10 + Math.random() * 8],
        color: [C(0x2a2522), C(0x111111)],
        alpha: [0.75, 0],
        drag: 1.1,
        gravity: -0.6,
      });
    }
    this.flash(p, 400 * scale, 1.2, 0xffa040);
  }

  /** Glass / plastic shards. */
  shards(p: THREE.Vector3, vel: THREE.Vector3, n: number, color = 0xcfe3ff) {
    for (let k = 0; k < n; k++) {
      this.alpha.emit({
        pos: p.clone().add(_v.set(rnd(0.5), rnd(0.3), rnd(0.5))),
        vel: vel.clone().multiplyScalar(0.7).add(_v.set(rnd(5), Math.random() * 5, rnd(5))),
        life: 0.8 + Math.random() * 0.8,
        size: [0.08, 0.06],
        color: [C(color), C(color)],
        alpha: [0.9, 0.4],
        gravity: 9.8,
        drag: 0.3,
      });
    }
  }

  firework(p: THREE.Vector3) {
    const hue = Math.random();
    const c0 = new THREE.Color().setHSL(hue, 1, 0.65);
    const c1 = new THREE.Color().setHSL((hue + 0.1) % 1, 1, 0.45);
    for (let k = 0; k < 160; k++) {
      const d = _v.set(rnd(1), rnd(1), rnd(1)).normalize();
      this.add.emit({ pos: p.clone(), vel: d.clone().multiplyScalar(14 + Math.random() * 4), life: 1.4 + Math.random() * 0.8, size: [0.9, 0.2], color: [c0, c1], alpha: [1, 0], gravity: 4, drag: 1.2 });
    }
    this.flash(p, 200, 0.6, c0.getHex());
  }

  flash(p: THREE.Vector3, peak: number, dur: number, color: number) {
    const f = this.flashes.reduce((a, b) => (b.t / b.dur > a.t / a.dur ? b : a));
    f.light.color.set(color);
    f.light.position.copy(p).add(_v.set(0, 2, 0));
    f.t = 0;
    f.dur = dur;
    f.peak = peak;
  }
}
