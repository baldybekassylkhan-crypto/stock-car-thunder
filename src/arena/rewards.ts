/**
 * Arena progression: XP and credits from placement, eliminations, damage dealt, survival time and
 * wins. Levels unlock vehicle classes and cosmetics (paint jobs, bumper designs, victory effects).
 * No pay-to-win: classes are balanced against each other, everything else is cosmetic.
 */
export interface ArenaProfile {
  xp: number;
  credits: number;
  matches: number;
  wins: number;
  eliminations: number;
  /** Chosen class, paint, bumper and victory effect. */
  cls: string;
  paint: string;
  bumper: string;
  victory: string;
}

export interface MatchStats {
  position: number;
  cars: number;
  eliminations: number;
  damageDealt: number;
  damageTaken: number;
  survival: number; // seconds alive
  won: boolean;
}

export interface Reward {
  xp: number;
  credits: number;
  lines: { label: string; xp: number }[];
  levelBefore: number;
  levelAfter: number;
  unlocked: string[];
}

/** Extra paint jobs (on top of the normal livery colours). */
export const ARENA_PAINTS = [
  { id: '', name: 'Livery colour', color: '', unlockLevel: 0 },
  { id: 'rust', name: 'Rust bucket', color: '#8a4b2a', unlockLevel: 1 },
  { id: 'hazard', name: 'Hazard yellow', color: '#f2c200', unlockLevel: 2 },
  { id: 'army', name: 'Army green', color: '#4b5a32', unlockLevel: 3 },
  { id: 'neon', name: 'Neon pink', color: '#ff2fa6', unlockLevel: 5 },
  { id: 'gold', name: 'Champion gold', color: '#d4a833', unlockLevel: 7 },
];
export const VICTORY_EFFECTS = [
  { id: 'fireworks', name: 'Fireworks', unlockLevel: 0 },
  { id: 'confetti', name: 'Confetti storm', unlockLevel: 3 },
  { id: 'inferno', name: 'Inferno', unlockLevel: 6 },
];

const KEY = 'sct.arena';
const DEFAULT: ArenaProfile = { xp: 0, credits: 0, matches: 0, wins: 0, eliminations: 0, cls: 'balanced', paint: '', bumper: 'bar', victory: 'fireworks' };

export function loadArenaProfile(): ArenaProfile {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : { ...DEFAULT };
  } catch {
    return { ...DEFAULT };
  }
}
export function saveArenaProfile(p: ArenaProfile) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

/** Level from XP: each level needs 500 XP more than the last (500, 1500, 3000, …). */
export function levelOf(xp: number) {
  let lvl = 0, need = 500, acc = 0;
  while (xp >= acc + need) { acc += need; lvl++; need += 500; }
  return lvl;
}
export function xpForLevel(lvl: number) {
  let acc = 0;
  for (let k = 0; k < lvl; k++) acc += 500 * (k + 1);
  return acc;
}

/** Work out the rewards for a finished match and store them in the profile. */
export function grantRewards(p: ArenaProfile, s: MatchStats, unlockNames: (lvl: number) => string[]): Reward {
  const lines: { label: string; xp: number }[] = [];
  const place = s.position === 1 ? 500 : s.position === 2 ? 320 : s.position === 3 ? 220 : Math.max(60, 160 - (s.position - 4) * 12);
  lines.push({ label: `Finished #${s.position} of ${s.cars}`, xp: place });
  if (s.eliminations) lines.push({ label: `${s.eliminations} elimination${s.eliminations > 1 ? 's' : ''}`, xp: s.eliminations * 120 });
  if (s.damageDealt > 0) lines.push({ label: `${Math.round(s.damageDealt)} damage dealt`, xp: Math.round(s.damageDealt / 5) });
  lines.push({ label: `Survived ${Math.round(s.survival)} s`, xp: Math.round(s.survival * 2) });
  if (s.won) lines.push({ label: 'Victory bonus', xp: 300 });
  const xp = lines.reduce((a, l) => a + l.xp, 0);
  const before = levelOf(p.xp);
  p.xp += xp;
  p.credits += Math.round(xp / 10);
  p.matches++;
  if (s.won) p.wins++;
  p.eliminations += s.eliminations;
  const after = levelOf(p.xp);
  const unlocked: string[] = [];
  for (let l = before + 1; l <= after; l++) unlocked.push(...unlockNames(l));
  saveArenaProfile(p);
  return { xp, credits: Math.round(xp / 10), lines, levelBefore: before, levelAfter: after, unlocked };
}
