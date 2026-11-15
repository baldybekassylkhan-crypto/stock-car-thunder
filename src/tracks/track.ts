import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A closed racing line sampled at (roughly) constant spacing. Every sample has a frame:
 *   T  = tangent (horizontal)        R = right (horizontal, points to the outside of an oval)
 *   B  = banked right (across the racing surface)   N = surface normal
 * The racing surface spans lateral d ∈ [0, width] measured from the inner (left) edge,
 * which sits on the ground (y = 0); banking lifts the outer edge.
 */
export class Track {
  readonly n: number;
  readonly ds: number;
  readonly length: number;
  readonly center: THREE.Vector3[];
  readonly T: THREE.Vector3[] = [];
  readonly R: THREE.Vector3[] = [];
  readonly B: THREE.Vector3[] = [];
  readonly N: THREE.Vector3[] = [];
  readonly inner: THREE.Vector3[] = [];
  readonly bank: number[];
  readonly curvature: number[] = [];
  /** 3D tangent (follows elevation changes). */
  readonly T3: THREE.Vector3[] = [];
  /**
   * 'inner': oval mode. The inner edge sits on the ground and banking pivots around it with a curved
   * transition from the apron. 'center': road-course mode. The surface follows the centreline's
   * elevation and cambers around the centre (bank may be negative for right-handers).
   */
  readonly pivot: 'inner' | 'center';

  constructor(
    center: THREE.Vector3[],
    readonly width: number,
    bankFn: (u: number, kappa: number) => number,
    bankSmoothM = 40,
    pivot: 'inner' | 'center' = 'inner',
  ) {
    this.pivot = pivot;
    this.center = center;
    this.n = center.length;
    let len = 0;
    for (let i = 0; i < this.n; i++) len += center[i].distanceTo(center[(i + 1) % this.n]);
    this.length = len;
    this.ds = len / this.n;

    for (let i = 0; i < this.n; i++) {
      const p = center[(i - 1 + this.n) % this.n];
      const q = center[(i + 1) % this.n];
      const t = q.clone().sub(p).setY(0).normalize();
      this.T.push(t);
      this.T3.push(q.clone().sub(p).normalize());
      this.R.push(t.clone().cross(UP).normalize());
    }
    for (let i = 0; i < this.n; i++) {
      const a = this.T[(i - 1 + this.n) % this.n];
      const b = this.T[(i + 1) % this.n];
      const cross = a.x * b.z - a.z * b.x; // > 0 → turning right in x/z with y up? (sign normalised below)
      const ang = Math.atan2(cross, a.dot(b));
      this.curvature.push(-ang / (2 * this.ds)); // positive = left turn
    }
    const raw = this.curvature.map((k, i) => bankFn(i / this.n, k));
    const w = Math.max(1, Math.round(bankSmoothM / this.ds));
    this.bank = raw.map((_, i) => {
      let s = 0;
      for (let j = -w; j <= w; j++) s += raw[(i + j + this.n) % this.n];
      return s / (2 * w + 1);
    });
    for (let i = 0; i < this.n; i++) {
      const th = this.bank[i];
      const B = this.R[i].clone().multiplyScalar(Math.cos(th)).addScaledVector(UP, Math.sin(th));
      this.B.push(B);
      this.N.push(B.clone().cross(pivot === 'center' ? this.T3[i] : this.T[i]).normalize());
      if (pivot === 'inner') this.inner.push(center[i].clone().addScaledVector(this.R[i], -width / 2).setY(0));
      else this.inner.push(center[i].clone().addScaledVector(B, -width / 2));
    }
  }

  wrap(i: number) {
    return ((i % this.n) + this.n) % this.n;
  }

  /** Width of the curved transition from the flat apron into the banking (metres of surface). */
  static readonly TRANSITION = 4;

  /**
   * Point on the racing surface at sample i, lateral distance d (measured along the surface) from the
   * inner edge. The first TRANSITION metres curve smoothly from flat to full banking, like a real track.
   */
  surface(i: number, d: number, out = new THREE.Vector3()): THREE.Vector3 {
    i = this.wrap(i);
    if (d <= 0) return out.copy(this.inner[i]).addScaledVector(this.R[i], d);
    if (this.pivot === 'center') {
      if (d <= this.width) return out.copy(this.inner[i]).addScaledVector(this.B[i], d);
      return out.copy(this.inner[i]).addScaledVector(this.B[i], this.width).addScaledVector(this.R[i], d - this.width);
    }
    const th = this.bank[i];
    const Dt = Track.TRANSITION;
    if (th < 1e-4) return out.copy(this.inner[i]).addScaledVector(this.R[i], d);
    const rho = Dt / th;
    const phi = Math.min(d, Dt) / rho;
    out.copy(this.inner[i]).addScaledVector(this.R[i], rho * Math.sin(phi)).addScaledVector(UP, rho * (1 - Math.cos(phi)));
    if (d > Dt) out.addScaledVector(this.B[i], d - Dt);
    return out;
  }

  /** Surface normal at lateral d (accounts for the transition curve). */
  normalAt(i: number, d: number, out = new THREE.Vector3()): THREE.Vector3 {
    i = this.wrap(i);
    if (d <= 0) return out.copy(UP);
    if (this.pivot === 'center') return d <= this.width ? out.copy(this.N[i]) : out.copy(UP);
    const phi = this.bank[i] * Math.min(1, d / Track.TRANSITION);
    return out.copy(UP).multiplyScalar(Math.cos(phi)).addScaledVector(this.R[i], -Math.sin(phi));
  }

  /** Nearest sample to a world position. `hint` limits the search window for speed. */
  nearest(pos: THREE.Vector3, hint = -1, window = 60): number {
    let best = 0;
    let bestD = Infinity;
    const scan = (i: number) => {
      const c = this.center[i];
      const d = (c.x - pos.x) ** 2 + (c.z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    };
    if (hint < 0) for (let i = 0; i < this.n; i++) scan(i);
    else {
      for (let k = -window; k <= window; k++) scan(this.wrap(hint + k));
      // the hint was stale (teleport/reset): fall back to a full search
      if (bestD > 80 * 80) for (let i = 0; i < this.n; i++) scan(i);
    }
    return best;
  }

  /** Lateral distance from inner edge (along banked surface) for a world position near sample i. */
  lateral(pos: THREE.Vector3, i: number): number {
    i = this.wrap(i);
    const rel = pos.clone().sub(this.inner[i]);
    const h = rel.dot(this.R[i]);
    if (h <= 0) return h;
    if (this.pivot === 'center') {
      const d = rel.dot(this.B[i]);
      if (d <= this.width) return d;
      return this.width + pos.clone().sub(this.surface(i, this.width)).dot(this.R[i]);
    }
    // measure from the end of the transition curve, along the banked plane
    const end = this.surface(i, Track.TRANSITION);
    return Track.TRANSITION + pos.clone().sub(end).dot(this.B[i]);
  }

  /** World transform for a car placed on the surface (forward = +Z of the car). */
  placement(i: number, d: number, lift: number): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    i = this.wrap(i);
    const up = this.normalAt(i, d);
    const pos = this.surface(i, d).addScaledVector(up, lift);
    const fwd = this.T3[i].clone().addScaledVector(up, -this.T3[i].dot(up)).normalize();
    const right = fwd.clone().cross(up).normalize();
    // car local axes: +X = left? We use +X = right-hand side ... build basis: X = -right(left), Y = up, Z = fwd
    const m = new THREE.Matrix4().makeBasis(right.clone().negate(), up, fwd);
    return { pos, quat: new THREE.Quaternion().setFromRotationMatrix(m) };
  }
}

/** Gaussian smoothing of a closed polyline (sigma in samples). */
export function smoothClosed(pts: THREE.Vector3[], sigma: number): THREE.Vector3[] {
  const n = pts.length;
  const r = Math.ceil(sigma * 3);
  const wts: number[] = [];
  let tot = 0;
  for (let k = -r; k <= r; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    wts.push(w);
    tot += w;
  }
  return pts.map((_, i) => {
    const o = new THREE.Vector3();
    for (let k = -r; k <= r; k++) o.addScaledVector(pts[(i + k + n) % n], wts[k + r] / tot);
    return o;
  });
}

/** Resample a closed polyline to `n` points at equal arc length. */
export function resampleClosed(pts: THREE.Vector3[], n: number): THREE.Vector3[] {
  const m = pts.length;
  const cum = [0];
  for (let i = 0; i < m; i++) cum.push(cum[i] + pts[i].distanceTo(pts[(i + 1) % m]));
  const L = cum[m];
  const out: THREE.Vector3[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * L;
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push(pts[j].clone().lerp(pts[(j + 1) % m], t));
  }
  return out;
}

/** Signed area in the (x, -z) plane; > 0 means counter-clockwise from above = left turns. */
export function signedArea(pts: THREE.Vector3[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * -q.z - q.x * -p.z;
  }
  return a / 2;
}

/** Build a stadium oval (two straights + two semicircles) with optional tri-oval dogleg. */
export function ovalCenterline(opts: {
  straight: number; // length of backstretch straight portion
  radius: number;
  triBulge: number; // outward offset of the frontstretch apex (0 = plain oval)
  smoothSigmaM: number;
  targetLength: number;
}): THREE.Vector3[] {
  const { straight, radius, triBulge } = opts;
  const raw: THREE.Vector3[] = [];
  const step = 1;
  const hs = straight / 2;
  // frontstretch along +x at z = +radius (toward viewer), traveling -x ... we fix direction after.
  for (let x = -hs; x < hs; x += step) {
    const tent = triBulge * Math.max(0, 1 - Math.abs(x) / hs);
    raw.push(new THREE.Vector3(x, 0, radius + tent));
  }
  for (let a = 0; a < Math.PI; a += step / radius) raw.push(new THREE.Vector3(hs + Math.sin(a) * radius, 0, Math.cos(a) * radius));
  for (let x = hs; x > -hs; x -= step) raw.push(new THREE.Vector3(x, 0, -radius));
  for (let a = 0; a < Math.PI; a += step / radius) raw.push(new THREE.Vector3(-hs - Math.sin(a) * radius, 0, -Math.cos(a) * radius));

  let pts = resampleClosed(raw, Math.round(raw.length));
  pts = smoothClosed(pts, opts.smoothSigmaM / step);
  if (signedArea(pts) < 0) pts.reverse();
  // scale to target length
  let len = 0;
  for (let i = 0; i < pts.length; i++) len += pts[i].distanceTo(pts[(i + 1) % pts.length]);
  const k = opts.targetLength / len;
  pts.forEach((p) => p.multiplyScalar(k));
  // start/finish at frontstretch apex (max z)
  let start = 0;
  pts.forEach((p, i) => { if (p.z > pts[start].z) start = i; });
  pts = pts.slice(start).concat(pts.slice(0, start));
  return resampleClosed(pts, Math.round(opts.targetLength / 2));
}
