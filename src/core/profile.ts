/** Local player profile + settings, persisted in localStorage (guarded). */
import { DEFAULT_CAR, type Series } from '../vehicle/catalog';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface Profile {
  nickname: string;
  carNumber: number;
  color: string;
  /** Picked car per series. */
  cars: Record<Series, string>;
}

export interface Settings {
  quality: Quality;
  units: 'mph' | 'kmh';
  manualGears: boolean;
  tractionControl: boolean;
  abs: boolean;
  volume: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export const LIVERY_COLORS = ['#d7261e', '#1f5fd6', '#ffcc00', '#18a058', '#f47a1f', '#7d3ad1', '#101317', '#f2f2f2', '#14b4c8', '#e83e8c'];

export const profile: Profile = load('sct.profile', {
  nickname: '',
  carNumber: 10 + Math.floor(Math.random() * 89),
  color: LIVERY_COLORS[Math.floor(Math.random() * LIVERY_COLORS.length)],
  cars: { ...DEFAULT_CAR },
});
// profiles saved before car choice existed (or with a removed car) get valid picks
profile.cars = { ...DEFAULT_CAR, ...(profile.cars ?? {}) };
export const settings: Settings = load('sct.settings', {
  quality: 'high' as Quality,
  units: 'mph' as const,
  manualGears: false,
  tractionControl: true,
  abs: true,
  volume: 0.7,
});

export const saveProfile = () => save('sct.profile', profile);
export const saveSettings = () => save('sct.settings', settings);

export function validNickname(n: string): string | null {
  const t = n.trim();
  if (t.length < 3) return 'Nickname must be at least 3 characters.';
  if (t.length > 16) return 'Nickname can be at most 16 characters.';
  if (!/^[\p{L}\p{N} _\-.]+$/u.test(t)) return 'Use letters, numbers, spaces, - _ . only.';
  return null;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeRoomCode(): string {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
