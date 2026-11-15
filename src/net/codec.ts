import { PART_NAMES, type PartName } from '../vehicle/carModel';

/** Compact binary car snapshot (sent ~20×/s per car over an unreliable channel). */
export interface CarState {
  slot: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  vel: [number, number, number];
  steer: number;
  omega: number; // wheel spin rad/s
  rpm: number;
  throttle: number;
  brake: number;
  flaps: boolean;
  destroyed: boolean;
  exploded: boolean;
  wiper: boolean;
  smoke: number; // 0..1
  fire: number; // 0..1
  gone: PartName[];
  punctured: number; // bitmask
}

export const STATE_BYTES = 64;

export function encodeState(s: CarState): ArrayBuffer {
  const buf = new ArrayBuffer(STATE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, s.slot);
  v.setUint8(1, (s.flaps ? 1 : 0) | (s.destroyed ? 2 : 0) | (s.exploded ? 4 : 0) | (s.wiper ? 8 : 0));
  v.setUint8(2, Math.round(s.smoke * 255));
  v.setUint8(3, Math.round(s.fire * 255));
  let mask = 0;
  for (const g of s.gone) mask |= 1 << PART_NAMES.indexOf(g);
  v.setUint16(4, mask);
  v.setUint16(6, Math.min(65535, Math.round(s.rpm)));
  let o = 8;
  for (const x of s.pos) { v.setFloat32(o, x); o += 4; }
  for (const x of s.quat) { v.setFloat32(o, x); o += 4; }
  for (const x of s.vel) { v.setFloat32(o, x); o += 4; }
  v.setFloat32(o, s.steer); o += 4;
  v.setFloat32(o, s.omega); o += 4;
  v.setUint8(o++, Math.round(s.throttle * 255));
  v.setUint8(o++, Math.round(s.brake * 255));
  v.setUint8(o++, s.punctured);
  return buf;
}

export function decodeState(buf: ArrayBuffer): CarState | null {
  if (buf.byteLength < STATE_BYTES) return null;
  const v = new DataView(buf);
  const flags = v.getUint8(1);
  const mask = v.getUint16(4);
  let o = 8;
  const f = () => { const x = v.getFloat32(o); o += 4; return x; };
  const pos: [number, number, number] = [f(), f(), f()];
  const quat: [number, number, number, number] = [f(), f(), f(), f()];
  const vel: [number, number, number] = [f(), f(), f()];
  const steer = f();
  const omega = f();
  const throttle = v.getUint8(o++) / 255;
  const brake = v.getUint8(o++) / 255;
  const punctured = v.getUint8(o++);
  if (![...pos, ...quat].every(Number.isFinite)) return null;
  return {
    slot: v.getUint8(0),
    pos, quat, vel, steer, omega,
    rpm: v.getUint16(6),
    throttle, brake,
    flaps: !!(flags & 1),
    destroyed: !!(flags & 2),
    exploded: !!(flags & 4),
    wiper: !!(flags & 8),
    smoke: v.getUint8(2) / 255,
    fire: v.getUint8(3) / 255,
    gone: PART_NAMES.filter((_, i) => mask & (1 << i)),
    punctured,
  };
}
