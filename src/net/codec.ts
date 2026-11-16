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

/**
 * Wire format (40 bytes): slot u8, flags u8, smoke u8, fire u8, lost-parts u16, rpm u16,
 * position 3×f32 (tracks are kilometres wide), rotation 4×i16 (unit quaternion),
 * velocity 3×i16 (cm/s), steer i8, wheel spin i16 (0.1 rad/s), throttle u8, brake u8, punctures u8.
 */
export const STATE_BYTES = 40;
/** First byte of a host batch packet (never a valid slot). */
export const BATCH_MARK = 0xff;

const Q = 32767;
const clampI16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x)));

export function writeState(v: DataView, o: number, s: CarState) {
  v.setUint8(o, s.slot);
  v.setUint8(o + 1, (s.flaps ? 1 : 0) | (s.destroyed ? 2 : 0) | (s.exploded ? 4 : 0) | (s.wiper ? 8 : 0));
  v.setUint8(o + 2, Math.round(s.smoke * 255));
  v.setUint8(o + 3, Math.round(s.fire * 255));
  let mask = 0;
  for (const g of s.gone) mask |= 1 << PART_NAMES.indexOf(g);
  v.setUint16(o + 4, mask);
  v.setUint16(o + 6, Math.min(65535, Math.max(0, Math.round(s.rpm))));
  let k = o + 8;
  for (const x of s.pos) { v.setFloat32(k, x); k += 4; }
  const [qx, qy, qz, qw] = s.quat;
  const ql = Math.hypot(qx, qy, qz, qw) || 1;
  for (const x of s.quat) { v.setInt16(k, clampI16((x / ql) * Q)); k += 2; }
  for (const x of s.vel) { v.setInt16(k, clampI16(x * 100)); k += 2; }
  v.setInt8(k++, Math.max(-127, Math.min(127, Math.round(s.steer * 200)))); // ±0.635 rad
  v.setInt16(k, clampI16(s.omega * 10)); k += 2;
  v.setUint8(k++, Math.round(s.throttle * 255));
  v.setUint8(k++, Math.round(s.brake * 255));
  v.setUint8(k++, s.punctured);
}

export function readState(v: DataView, o: number): CarState | null {
  if (v.byteLength < o + STATE_BYTES) return null;
  const flags = v.getUint8(o + 1);
  const mask = v.getUint16(o + 4);
  let k = o + 8;
  const f = () => { const x = v.getFloat32(k); k += 4; return x; };
  const i16 = (scale: number) => { const x = v.getInt16(k) / scale; k += 2; return x; };
  const pos: [number, number, number] = [f(), f(), f()];
  const quat: [number, number, number, number] = [i16(Q), i16(Q), i16(Q), i16(Q)];
  const vel: [number, number, number] = [i16(100), i16(100), i16(100)];
  const steer = v.getInt8(k++) / 200;
  const omega = i16(10);
  const throttle = v.getUint8(k++) / 255;
  const brake = v.getUint8(k++) / 255;
  const punctured = v.getUint8(k++);
  if (!pos.every(Number.isFinite) || Math.hypot(...quat) < 0.5) return null;
  return {
    slot: v.getUint8(o),
    pos, quat, vel, steer, omega,
    rpm: v.getUint16(o + 6),
    throttle, brake,
    flaps: !!(flags & 1),
    destroyed: !!(flags & 2),
    exploded: !!(flags & 4),
    wiper: !!(flags & 8),
    smoke: v.getUint8(o + 2) / 255,
    fire: v.getUint8(o + 3) / 255,
    gone: PART_NAMES.filter((_, i) => mask & (1 << i)),
    punctured,
  };
}

export function encodeState(s: CarState): ArrayBuffer {
  const buf = new ArrayBuffer(STATE_BYTES);
  writeState(new DataView(buf), 0, s);
  return buf;
}

export function decodeState(buf: ArrayBuffer): CarState | null {
  return readState(new DataView(buf), 0);
}

/** Host batch: [BATCH_MARK, count, count × state]. */
export function encodeBatch(states: ArrayBuffer[]): ArrayBuffer {
  const out = new Uint8Array(2 + states.length * STATE_BYTES);
  out[0] = BATCH_MARK;
  out[1] = states.length;
  states.forEach((b, i) => out.set(new Uint8Array(b, 0, STATE_BYTES), 2 + i * STATE_BYTES));
  return out.buffer;
}

/** Split a received packet (single state or host batch) into single-state buffers. */
export function splitPacket(buf: ArrayBuffer): ArrayBuffer[] {
  const u = new Uint8Array(buf);
  if (u[0] !== BATCH_MARK) return u.length >= STATE_BYTES ? [buf] : [];
  const n = Math.min(u[1], Math.floor((u.length - 2) / STATE_BYTES));
  return Array.from({ length: n }, (_, i) => buf.slice(2 + i * STATE_BYTES, 2 + (i + 1) * STATE_BYTES));
}

/** Position straight from an encoded state (host relay uses it for distance-based send rates). */
export function statePos(buf: ArrayBuffer): [number, number, number] {
  const v = new DataView(buf);
  return [v.getFloat32(8), v.getFloat32(12), v.getFloat32(16)];
}
