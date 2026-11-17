import { carSpec, type CarSpec } from '../vehicle/catalog';

/**
 * Demolition Arena combat vehicle classes. Each one is a stock-car body with a derby kit and its
 * own physics (mass, power, grip) plus combat stats. Heavier armour always costs speed or agility,
 * so no class dominates.
 */
export type Zone = 'front' | 'rear' | 'left' | 'right';

export interface CombatClass {
  id: string;
  name: string;
  role: string;
  blurb: string;
  /** Damage reduction per zone (0..0.6) while that zone's armour is intact. */
  armor: Record<Zone, number>;
  /** Damage multiplier when this car hits with its front. */
  ram: number;
  /** Repair kits per match and HP restored per kit. */
  repairs: number;
  repairHp: number;
  /** Player level needed to drive it (progression; all classes are balanced). */
  unlockLevel: number;
  /** 0..1 bars for the picker. */
  bars: { speed: number; accel: number; handling: number; armor: number; ram: number };
  spec: CarSpec;
}

const base = carSpec('stock-balanced');
/** Arena gearing: three short gears, ~160 km/h top speed, strong launches. */
const ARENA = {
  gears: [2.4, 1.6, 1.2],
  finalDrive: 6.2,
  shiftUpRpm: 8700,
  shiftDownRpm: 5600,
  dragCdA: 1.05,
  liftClA: 0.6,
  roofFlaps: false,
  fuelTank: 60,
  fuelBurn: 0,
  // a tough body for the visual damage model (gameplay damage is the arena's own health system)
  damage: { ...base.damage, wallJ0: 700, carJ0: 700, igniteSeverity: 999 },
};

function make(id: string, tune: Partial<CarSpec>, torqueK: number): CarSpec {
  const mass = tune.mass ?? base.mass;
  const k = mass / base.mass;
  return {
    ...base,
    ...ARENA,
    ...tune,
    id: `arena-${id}`,
    inertia: { x: base.inertia.x * k, y: base.inertia.y * k, z: base.inertia.z * k },
    torque: base.torque.map(([r, t]) => [r, Math.round(t * torqueK)] as [number, number]),
    kit: { cls: id, bumper: 'bar' },
  };
}

export const CLASSES: CombatClass[] = [
  {
    id: 'balanced', name: 'Balanced Stock Car', role: 'All-rounder', unlockLevel: 0,
    blurb: 'Average speed, armour and punch. A safe pick that does a bit of everything.',
    armor: { front: 0.25, rear: 0.2, left: 0.2, right: 0.2 }, ram: 1.0, repairs: 2, repairHp: 200,
    bars: { speed: 0.6, accel: 0.6, handling: 0.6, armor: 0.55, ram: 0.55 },
    spec: make('balanced', { mass: 1600 }, 1.0),
  },
  {
    id: 'speed', name: 'Speed Demon', role: 'Hit and run', unlockLevel: 0,
    blurb: 'Light, quick and agile. Paper armour: strike from the side and get away.',
    armor: { front: 0.08, rear: 0.05, left: 0.05, right: 0.05 }, ram: 0.85, repairs: 2, repairHp: 200,
    bars: { speed: 0.95, accel: 0.95, handling: 0.95, armor: 0.2, ram: 0.35 },
    spec: make('speed', { mass: 1320, mu: 1.46, steerLock: [0.62, 0.09] }, 1.12),
  },
  {
    id: 'tank', name: 'Heavy Tanker', role: 'Unstoppable', unlockLevel: 0,
    blurb: 'Enormously tough and heavy: wins every shoving match, but slow to get going.',
    armor: { front: 0.42, rear: 0.4, left: 0.38, right: 0.38 }, ram: 1.15, repairs: 2, repairHp: 200,
    bars: { speed: 0.4, accel: 0.3, handling: 0.35, armor: 0.95, ram: 0.75 },
    spec: make('tank', { mass: 2150, mu: 1.3, steerLock: [0.52, 0.07] }, 1.08),
  },
  {
    id: 'rammer', name: 'Rammer', role: 'Battering ram', unlockLevel: 2,
    blurb: 'A reinforced plough on the front hits harder than anything else. Weak at the back.',
    armor: { front: 0.55, rear: 0.08, left: 0.15, right: 0.15 }, ram: 1.45, repairs: 2, repairHp: 200,
    bars: { speed: 0.65, accel: 0.7, handling: 0.5, armor: 0.5, ram: 1.0 },
    spec: make('rammer', { mass: 1820 }, 1.1),
  },
  {
    id: 'survivor', name: 'Survivor', role: 'Last one standing', unlockLevel: 4,
    blurb: 'Well armoured, handles nicely and carries an extra repair kit. Low punch.',
    armor: { front: 0.3, rear: 0.3, left: 0.3, right: 0.3 }, ram: 0.85, repairs: 3, repairHp: 240,
    bars: { speed: 0.55, accel: 0.55, handling: 0.8, armor: 0.75, ram: 0.4 },
    spec: make('survivor', { mass: 1680, mu: 1.42 }, 1.0),
  },
];

export const classById = (id: string | undefined) => CLASSES.find((c) => c.id === id) ?? CLASSES[0];

/** Bumper designs (cosmetic; unlocked through progression). */
export const BUMPERS = [
  { id: 'bar', name: 'Steel bar', unlockLevel: 0 },
  { id: 'plow', name: 'Plough', unlockLevel: 2 },
  { id: 'cage', name: 'Cow catcher', unlockLevel: 5 },
];

/** Car spec for a class with a chosen bumper design. */
export function arenaSpec(clsId: string, bumper = 'bar'): CarSpec {
  const c = classById(clsId);
  // the rammer always carries its plough
  return { ...c.spec, kit: { cls: c.id, bumper: c.id === 'rammer' ? 'plow' : bumper } };
}
