import * as THREE from 'three';

export type CamMode = 'chase' | 'far' | 'hood' | 'cockpit' | 'tv';
export const CAM_MODES: CamMode[] = ['chase', 'far', 'hood', 'cockpit', 'tv'];
export const CAM_LABEL: Record<CamMode, string> = { chase: 'Chase', far: 'Far chase', hood: 'Hood', cockpit: 'Cockpit', tv: 'TV' };

const _t = new THREE.Vector3();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  mode: CamMode = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private heading = new THREE.Vector3(0, 0, 1);
  private shake = 0;
  private init = false;

  /** Mouse-look offsets (rad). Held: follow the mouse; released: swing back behind the car. */
  private yaw = 0;
  private pitch = 0;
  private looking = false;

  /** Feed mouse drag (pixels). Call once per frame. */
  mouseLook(held: boolean, dx: number, dy: number, dt: number) {
    this.looking = held;
    if (held) {
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -0.35, 1.1);
      // keep yaw in (-π, π] so the swing-back takes the short way round
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    } else {
      const k = 1 - Math.exp(-dt * 3.5);
      this.yaw -= this.yaw * k;
      this.pitch -= this.pitch * k;
    }
  }

  /** Optional occlusion test: distance from `from` toward `dir` until track geometry (or Infinity). */
  occlusion?: (from: THREE.Vector3, dir: THREE.Vector3, max: number) => number;

  constructor(private cam: THREE.PerspectiveCamera, private tvCams: THREE.Vector3[]) {}

  next() {
    this.mode = CAM_MODES[(CAM_MODES.indexOf(this.mode) + 1) % CAM_MODES.length];
    this.init = false;
  }

  addShake(a: number) {
    this.shake = Math.min(1, this.shake + a);
  }

  update(dt: number, target: THREE.Object3D, speed: number) {
    const cam = this.cam;
    target.getWorldQuaternion(_q);
    _f.set(0, 0, 1).applyQuaternion(_q);
    _u.set(0, 1, 0).applyQuaternion(_q);
    target.getWorldPosition(_t);
    const sp = Math.abs(speed);

    if (this.mode === 'chase' || this.mode === 'far') {
      const far = this.mode === 'far';
      // heading follows the car's horizontal forward with lag (looks great in slides)
      const flat = _f.clone().setY(0).normalize();
      if (!this.init) this.heading.copy(flat);
      this.heading.lerp(flat, 1 - Math.exp(-dt * (far ? 4 : 6))).normalize();
      const dist = (far ? 10.5 : 7.2) + Math.min(sp, 90) * 0.012;
      const height = far ? 3.4 : 2.25;
      // orbit around the car with the mouse offsets
      const elev = THREE.MathUtils.clamp(Math.atan2(height, dist) + this.pitch, 0.08, 1.35);
      const back = this.heading.clone().negate().applyAxisAngle(_Y, this.yaw);
      const radius = Math.hypot(dist, height);
      const want = _t.clone().addScaledVector(back, Math.cos(elev) * radius).add(new THREE.Vector3(0, Math.sin(elev) * radius, 0));
      if (!this.init) { this.pos.copy(want); this.init = true; }
      const orbiting = this.looking || Math.abs(this.yaw) > 0.02 || Math.abs(this.pitch) > 0.02;
      this.pos.lerp(want, 1 - Math.exp(-dt * (orbiting ? 30 : 12)));
      // keep the camera on the car's side of walls / fences
      if (this.occlusion) {
        const from = _t.clone().add(new THREE.Vector3(0, 1.2, 0));
        const dir = this.pos.clone().sub(from);
        const len = dir.length();
        dir.divideScalar(len || 1);
        const hit = this.occlusion(from, dir, len);
        if (hit < len) this.pos.copy(from).addScaledVector(dir, Math.max(0.5, hit - 0.35));
      }
      // look a little ahead when behind the car, straight at it when orbited round
      const ahead = 4 * Math.max(0, Math.cos(this.yaw)) * (1 - Math.min(1, Math.abs(this.pitch)));
      const lookAt = _t.clone().addScaledVector(this.heading, ahead).add(new THREE.Vector3(0, 1.0, 0));
      this.look.copy(lookAt);
      cam.position.copy(this.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      cam.fov = THREE.MathUtils.lerp(58, 72, Math.min(sp / 90, 1));
    } else if (this.mode === 'hood' || this.mode === 'cockpit') {
      const local = this.mode === 'hood' ? new THREE.Vector3(0, 1.22, 1.0) : new THREE.Vector3(0.3, 1.12, -0.45);
      cam.position.copy(local.applyQuaternion(_q).add(_t));
      cam.up.copy(_u);
      // look around inside/over the car
      const dir = _f.clone().applyAxisAngle(_u, this.yaw);
      const side = dir.clone().cross(_u).normalize();
      dir.applyAxisAngle(side, -this.pitch * 0.8);
      cam.lookAt(cam.position.clone().addScaledVector(dir, 20).addScaledVector(_u, this.mode === 'hood' ? -0.6 : -0.9));
      cam.fov = this.mode === 'hood' ? 70 : 75;
      this.init = false;
    } else {
      // TV: nearest trackside camera, zoom by distance
      let best = this.tvCams[0];
      let bd = Infinity;
      for (const c of this.tvCams) { const d = c.distanceToSquared(_t); if (d < bd) { bd = d; best = c; } }
      cam.position.copy(best);
      cam.up.set(0, 1, 0);
      this.look.lerp(_t, this.init ? 1 - Math.exp(-dt * 10) : 1);
      this.init = true;
      cam.lookAt(this.look);
      cam.fov = THREE.MathUtils.clamp(2400 / Math.sqrt(bd), 6, 60);
    }

    if (this.shake > 0.001) {
      const s = this.shake * 0.12;
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake *= Math.exp(-dt * 6);
    }
    // high-speed buffeting
    if (this.mode !== 'tv' && sp > 50) {
      const b = (sp - 50) * 0.00025;
      cam.position.y += (Math.random() - 0.5) * b;
    }
    cam.updateProjectionMatrix();
  }
}
