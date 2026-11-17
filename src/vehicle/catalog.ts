import { DAMAGE_PROFILES, type DamageProfile } from '../damage/damage';
import type { PartName } from './carModel';

/**
 * Car catalogue: every car is a full physics + geometry spec, so cars differ in how they drive,
 * not just in colour. All names are fictional.
 *
 * Local frame (physics body): +Z forward, +X left, +Y up, origin at the centre of mass;
 * the ground is at y = -geo.comHeight.
 */
export type Series = 'stock' | 'gp';
export type BodyKind = 'stock' | 'openWheel';

export interface CarGeometry {
  /** Centre of mass height above the ground (m). */
  comHeight: number;
  /** Front / rear axle z (m, rear negative). */
  wheelbaseF: number;
  wheelbaseR: number;
  /** Half the track width (m). */
  trackHalf: number;
  wheelRadius: number;
}

export interface CarSpec {
  id: string;
  series: Series;
  body: BodyKind;
  name: string;
  maker: string;
  /** Short character tag shown in the picker ("Torque", "Low drag", …). */
  archetype: string;
  blurb: string;

  mass: number; // kg, with driver
  inertia: { x: number; y: number; z: number }; // pitch, yaw, roll (kg·m²)
  geo: CarGeometry;
  /** Collision hull, one side (mirrored in x). */
  hull: [number, number, number][];

  restLength: number;
  springK: [number, number]; // front, rear N/m
  damperC: [number, number];
  antiRoll: [number, number];
  bumpStop: number;

  mu: number;
  pacejka: { B: number; C: number };
  brakeForce: number; // front wheel N at full pedal
  brakeBias: number;
  /** Steering lock (rad) at walking pace and at ~140 mph. */
  steerLock: [number, number];

  torque: [number, number][]; // rpm → N·m
  idle: number;
  redline: number;
  shiftUpRpm: number;
  shiftDownRpm: number;
  gears: number[];
  reverse: number;
  finalDrive: number;
  /** Engine cylinders (sound). */
  cylinders: number;

  dragCdA: number;
  liftClA: number;
  /** Share of downforce on the front axle. */
  aeroFront: number;
  /** Stock-car roof flaps that pop up when the car goes backwards. */
  roofFlaps: boolean;

  /** Fuel tank (kg) and burn (kg per km at full throttle): used by fuel/pit milestones. */
  fuelTank: number;
  fuelBurn: number;
  /** Tyre wear multiplier (1 = average for the series). */
  tyreWear: number;
  /** Tyre temperature (°C) at the start and after a stop (GP cars use tyre blankets). */
  tyreStartTemp: number;
  /** Carbon brakes: weak until they are hot. */
  carbonBrakes: boolean;
  /** Share of front downforce lost when following right behind another car ("dirty air"). */
  wakeLoss: number;
  /** Drag-reduction flap on the rear wing: drag and rear-downforce multipliers while open. */
  drs: { drag: number; rear: number } | null;
  /** Energy boost: electric power (W) and battery size (J). Charges under braking. */
  ers: { power: number; capacity: number } | null;

  damage: DamageProfile;
}

// ------------------------------------------------------------------ stock cars
const STOCK_GEO: CarGeometry = { comHeight: 0.45, wheelbaseF: 1.45, wheelbaseR: -1.35, trackHalf: 0.79, wheelRadius: 0.34 };
const STOCK_HULL: [number, number, number][] = [
  [0.96, -0.25, 1.85], [0.96, -0.25, -1.8], // floor
  [0.92, -0.18, 2.62], [0.92, 0.12, 2.64], // nose
  [0.92, -0.16, -2.62], [0.92, 0.5, -2.62], // tail
  [0.96, 0.32, 1.9], [0.96, 0.48, -2.4], // body top
  [0.66, 0.42, 1.05], [0.68, 0.84, 0.05], [0.68, 0.86, -0.85], [0.68, 0.5, -1.9], // greenhouse
];
const STOCK_BASE = {
  series: 'stock' as const,
  body: 'stock' as const,
  mass: 1550,
  inertia: { x: 3500, y: 3900, z: 1050 },
  geo: STOCK_GEO,
  hull: STOCK_HULL,
  restLength: 0.3,
  springK: [92000, 84000] as [number, number], // stiff: superspeedway loads reach 2.3 g
  damperC: [7000, 6400] as [number, number],
  antiRoll: [26000, 14000] as [number, number],
  bumpStop: 0.2,
  mu: 1.36,
  pacejka: { B: 10.5, C: 1.9 },
  brakeForce: 9200,
  brakeBias: 0.58,
  steerLock: [0.58, 0.07] as [number, number],
  torque: [[1000, 380], [3000, 520], [5000, 640], [6500, 700], [7800, 670], [8800, 610], [9400, 520]] as [number, number][],
  idle: 1300,
  redline: 9200,
  shiftUpRpm: 8900,
  shiftDownRpm: 6400,
  gears: [3.0, 1.95, 1.42, 1.0],
  reverse: 2.9,
  finalDrive: 3.6,
  cylinders: 8,
  dragCdA: 0.98,
  liftClA: 1.0,
  aeroFront: 0.42,
  roofFlaps: true,
  fuelTank: 64,
  fuelBurn: 0.42,
  tyreWear: 1,
  tyreStartTemp: 45,
  carbonBrakes: false,
  wakeLoss: 0.08,
  drs: null,
  ers: null,
  damage: DAMAGE_PROFILES.stock,
};

const scaleTorque = (t: [number, number][], f: (rpm: number) => number): [number, number][] => t.map(([r, n]) => [r, Math.round(n * f(r))]);

// ------------------------------------------------------------------ open-wheel GP cars
const GP_GEO: CarGeometry = { comHeight: 0.28, wheelbaseF: 1.75, wheelbaseR: -1.85, trackHalf: 0.8, wheelRadius: 0.36 };
// The hull bottom sits ~15 cm above the road (the visual floor is lower): on banking transitions and
// crests only the wheels may touch the surface, or the nose digs in and the car crashes.
const GP_HULL: [number, number, number][] = [
  [0.95, -0.12, 2.6], [0.95, 0.02, 2.6], // front wing
  [0.98, -0.13, 1.95], [0.98, 0.2, 1.95], // front wheels
  [0.98, -0.13, -1.95], [0.98, 0.24, -1.95], // rear wheels
  [0.6, -0.12, -2.45], [0.55, 0.66, -2.42], // rear wing
  [0.62, -0.13, 0.2], [0.62, 0.18, -0.6], // sidepods
  [0.28, 0.62, -0.55], [0.3, 0.38, 0.65], // airbox, cockpit
];
const GP_BASE = {
  series: 'gp' as const,
  body: 'openWheel' as const,
  mass: 800,
  inertia: { x: 1100, y: 1200, z: 260 },
  geo: GP_GEO,
  hull: GP_HULL,
  restLength: 0.12,
  springK: [180000, 160000] as [number, number], // stiff: the floor runs a few cm off the ground
  damperC: [6500, 6000] as [number, number],
  antiRoll: [32000, 14000] as [number, number], // soft rear bar: the rear stays planted under load
  bumpStop: 0.075,
  mu: 1.7,
  pacejka: { B: 12, C: 1.9 },
  brakeForce: 16000,
  brakeBias: 0.57,
  steerLock: [0.42, 0.085] as [number, number],
  torque: [[3000, 300], [5000, 420], [7000, 520], [9000, 590], [10500, 625], [11800, 620], [12600, 560], [13200, 480]] as [number, number][],
  idle: 4000,
  redline: 12800,
  shiftUpRpm: 12300,
  shiftDownRpm: 9200,
  gears: [3.1, 2.35, 1.9, 1.6, 1.38, 1.22, 1.1, 1.0],
  reverse: 3.2,
  finalDrive: 5.0,
  cylinders: 6,
  dragCdA: 1.25,
  liftClA: 4.2,
  aeroFront: 0.41, // rear-biased downforce: stable at speed
  roofFlaps: false,
  fuelTank: 105,
  fuelBurn: 0.55,
  tyreWear: 1,
  tyreStartTemp: 72,
  carbonBrakes: true,
  wakeLoss: 0.3,
  drs: { drag: 0.78, rear: 0.65 },
  ers: { power: 120000, capacity: 4e6 },
  damage: DAMAGE_PROFILES.openWheel,
};

export const CARS: CarSpec[] = [
  {
    ...STOCK_BASE,
    id: 'stock-balanced',
    name: 'Vanguard SR',
    maker: 'Vanguard',
    archetype: 'Balanced',
    blurb: 'The reference car: no weakness, no party trick.',
  },
  {
    ...STOCK_BASE,
    id: 'stock-torque',
    name: 'Ironhide 427',
    maker: 'Ironhide',
    archetype: 'Torque',
    blurb: 'Big low-end shove off the corners, but heavier and a little draggy at the top.',
    mass: 1575,
    inertia: { x: 3560, y: 3960, z: 1065 },
    mu: 1.385, // wider rear tyres put the torque down
    torque: scaleTorque(STOCK_BASE.torque, (r) => (r < 6000 ? 1.2 : r < 8000 ? 1.07 : 0.975)),
    dragCdA: 1.0,
    gears: [3.15, 2.02, 1.45, 1.0],
    tyreWear: 1.1,
    fuelBurn: 0.45,
  },
  {
    ...STOCK_BASE,
    id: 'stock-aero',
    name: 'Stiletto Aero',
    maker: 'Stiletto',
    archetype: 'Aero',
    blurb: 'Slippery and fast on the big ovals, but light on downforce: loose in traffic.',
    mass: 1525,
    inertia: { x: 3450, y: 3840, z: 1030 },
    torque: scaleTorque(STOCK_BASE.torque, (r) => (r < 6000 ? 0.95 : 1.03)),
    dragCdA: 0.9,
    liftClA: 0.82,
    aeroFront: 0.45,
    wakeLoss: 0.2,
    finalDrive: 3.5,
    tyreWear: 0.95,
    fuelBurn: 0.4,
  },
  {
    ...GP_BASE,
    id: 'gp-balanced',
    name: 'Apex GP-1',
    maker: 'Apex',
    archetype: 'Balanced',
    blurb: 'A well-rounded open-wheeler that works on every kind of circuit.',
  },
  {
    ...GP_BASE,
    id: 'gp-downforce',
    name: 'Titan HD-7',
    maker: 'Titan',
    archetype: 'High downforce',
    blurb: 'Glued down through fast corners and under braking. Pays for it on the straights.',
    dragCdA: 1.45,
    liftClA: 5.0,
    aeroFront: 0.42,
    tyreWear: 0.92,
  },
  {
    ...GP_BASE,
    id: 'gp-lowdrag',
    name: 'Falcon LD-3',
    maker: 'Falcon',
    archetype: 'Low drag',
    blurb: 'Fastest in a straight line and easy on fuel, but nervous in high-speed corners.',
    dragCdA: 1.05,
    liftClA: 3.5,
    aeroFront: 0.405,
    fuelBurn: 0.5,
    tyreWear: 1.08,
  },
];

export const DEFAULT_CAR: Record<Series, string> = { stock: 'stock-balanced', gp: 'gp-balanced' };
export const SERIES_LABEL: Record<Series, string> = { stock: 'Stock Car', gp: 'Open-Wheel GP' };

export function carSpec(id: string | undefined, series?: Series): CarSpec {
  const c = CARS.find((x) => x.id === id && (!series || x.series === series));
  return c ?? CARS.find((x) => x.id === DEFAULT_CAR[series ?? 'stock'])!;
}
export const carsOf = (series: Series) => CARS.filter((c) => c.series === series);

// ------------------------------------------------------------------ stats for the picker
function peakPower(c: CarSpec) {
  return Math.max(...c.torque.map(([r, t]) => (t * r * Math.PI) / 30)); // W
}
/** Rough top speed: drive power = aero drag + rolling resistance. */
function topSpeed(c: CarSpec) {
  const p = peakPower(c) * 0.88;
  let v = 30;
  for (let k = 0; k < 40; k++) v = Math.cbrt(Math.max(0, p - 280 * v) / (0.5 * 1.225 * c.dragCdA));
  return v;
}

export interface CarStats {
  topSpeed: number; // m/s (estimate)
  power: number; // kW
  /** 0..1 bars, relative to the other cars in the series. */
  bars: { label: string; value: number }[];
}

export function carStats(c: CarSpec): CarStats {
  const peers = carsOf(c.series);
  const metric = (f: (x: CarSpec) => number) => {
    const vals = peers.map(f);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    // a 0.35..1 band so the weakest car still shows a bar
    return hi - lo < 1e-9 ? 0.75 : 0.35 + 0.65 * ((f(c) - lo) / (hi - lo));
  };
  const accel = (x: CarSpec) => {
    const low = x.torque.filter(([r]) => r <= x.redline * 0.7);
    return (low.reduce((a, [, t]) => a + t, 0) / low.length) * x.gears[0] * x.finalDrive / x.mass;
  };
  const corner = (x: CarSpec) => x.mu * (1 + (0.5 * 1.225 * x.liftClA * 45 * 45) / (x.mass * 9.81));
  const brake = (x: CarSpec) => x.mu * (1 + (0.5 * 1.225 * x.liftClA * 60 * 60) / (x.mass * 9.81)) + x.brakeForce / x.mass / 40;
  const economy = (x: CarSpec) => 1 / (x.fuelBurn * x.tyreWear);
  return {
    topSpeed: topSpeed(c),
    power: peakPower(c) / 1000,
    bars: [
      { label: 'Top speed', value: metric(topSpeed) },
      { label: 'Acceleration', value: metric(accel) },
      { label: 'Cornering', value: metric(corner) },
      { label: 'Braking', value: metric(brake) },
      { label: 'Fuel & tyres', value: metric(economy) },
    ],
  };
}

/** What each damage part slot is called on this body (HUD messages). */
export const PART_LABEL: Record<BodyKind, Partial<Record<PartName, string>>> = {
  stock: { spoiler: 'SPOILER', splitter: 'SPLITTER', skirtL: 'SIDE SKIRT', skirtR: 'SIDE SKIRT', bumperF: 'FRONT BUMPER', bumperR: 'REAR BUMPER', hood: 'HOOD' },
  openWheel: { spoiler: 'REAR WING', splitter: 'FRONT WING', skirtL: 'SIDEPOD', skirtR: 'SIDEPOD', bumperF: 'NOSE CONE', bumperR: 'DIFFUSER', hood: 'ENGINE COVER' },
};
