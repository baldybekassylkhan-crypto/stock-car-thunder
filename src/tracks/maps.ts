import * as THREE from 'three';
import type { Track } from './track';
import type { ColliderMesh } from './build';
import type { PitInfo } from '../race/pits';
import type { Series } from '../vehicle/catalog';

export interface Atmosphere {
  sunElevation: number; // degrees
  sunAzimuth: number; // degrees
  turbidity: number;
  rayleigh: number;
  mie: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  envIntensity: number;
  fogColor: number;
  fogDensity: number;
  exposure: number;
  /** 'night' hides the physical sky and uses `background` + `envScene` instead. */
  mode?: 'sky' | 'night' | 'overcast';
  background?: number;
  envScene?: () => THREE.Scene;
}

export interface LoadedMap {
  track: Track;
  group: THREE.Group;
  colliders: ColliderMesh[];
  atmosphere: Atmosphere;
  /** Grid slot → sample index + lateral offset from inner edge. */
  gridSlot(slot: number): { i: number; d: number };
  tvCams: THREE.Vector3[];
  update?(dt: number, camera: THREE.Camera): void;
  /** Speed (m/s) for pace laps; cautions run slightly slower. */
  paceSpeed: number;
  oval: boolean;
  rain: boolean;
  gripScale: number;
  fireworks?: boolean;
  /** Height of the invisible safety floor. */
  groundY?: number;
  /** Lateral distance beyond which a car counts as having left the circuit (auto reset). */
  outOfBounds: number;
  /** Pit lane (pit stops). */
  pit?: PitInfo;
}

export interface GridLayout {
  /** Metres behind the start line to the first row. */
  backM: number;
  /** Metres between rows. */
  rowM: number;
  /** Lateral offsets (from the inner edge) of the two grid columns. */
  lanes: [number, number];
  /** Staggered grid (open-wheel style): the second column sits half a row further back. */
  stagger?: boolean;
}

/** Grid slot → track position, two cars per row, spaced in metres so 32 cars fit on any track. */
export function makeGrid(track: Track, g: GridLayout): (slot: number) => { i: number; d: number } {
  return (slot) => {
    const row = Math.floor(slot / 2), col = slot % 2;
    const back = g.backM + row * g.rowM + (g.stagger && col === 1 ? g.rowM / 2 : 0);
    return { i: track.wrap(-Math.round(back / track.ds)), d: g.lanes[col] };
  };
}

export interface MapLoadOptions {
  rain: boolean;
}

export interface MapDef {
  id: string;
  name: string;
  subtitle: string;
  swatch: string;
  available: boolean;
  /** Rain is offered on this map. */
  weather?: boolean;
  /** Which series race here (the lobby lists these for the room's series). */
  series: Series[];
  load(opts: MapLoadOptions): Promise<LoadedMap>;
}

export const MAPS: MapDef[] = [
  {
    id: 'sunvale',
    name: 'Sunvale Superspeedway',
    subtitle: '2.5 mi tri-oval · 31° banking · desert, golden hour',
    swatch: 'linear-gradient(135deg,#f6a64a,#b4562a)',
    available: true,
    series: ['stock'],
    load: () => import('./sunvale').then((m) => m.loadSunvale()),
  },
  {
    id: 'ironhollow',
    name: 'Iron Hollow Speedway',
    subtitle: '0.5 mi short track · 26° banking · night under lights',
    swatch: 'linear-gradient(135deg,#1d2a4a,#05070d)',
    available: true,
    series: ['stock'],
    load: (o) => import('./ironhollow').then((m) => m.loadIronHollow(o)),
  },
  {
    id: 'cedarridge',
    name: 'Cedar Ridge Road Course',
    subtitle: '2.4 mi · 12 turns · forested mountains, overcast',
    swatch: 'linear-gradient(135deg,#4f6b4a,#22301f)',
    available: true,
    weather: true,
    series: ['stock', 'gp'],
    load: (o) => import('./cedarridge').then((m) => m.loadCedarRidge(o)),
  },
  {
    id: 'harborpoint',
    name: 'Harbor Point Street Circuit',
    subtitle: '2.1 mi · walls, tunnel, hairpin · harbour at night',
    swatch: 'linear-gradient(135deg,#1c2b4a,#e0a040)',
    available: true,
    series: ['gp'],
    load: () => import('./gpCircuits').then((m) => m.loadHarborPoint()),
  },
  {
    id: 'velmont',
    name: 'Velmont Park',
    subtitle: '3.2 mi · fast, hilly parkland · gravel & grass',
    swatch: 'linear-gradient(135deg,#7fbf5a,#2e5a2a)',
    available: true,
    series: ['gp'],
    load: () => import('./gpCircuits').then((m) => m.loadVelmontPark()),
  },
  {
    id: 'desertring',
    name: 'Desert Ring Al-Sahra',
    subtitle: '3.3 mi · long straights, heavy braking · desert dusk',
    swatch: 'linear-gradient(135deg,#f0a050,#7a3a20)',
    available: true,
    series: ['gp'],
    load: () => import('./gpCircuits').then((m) => m.loadDesertRing()),
  },
  {
    id: 'driftpark',
    name: 'Neon Docks Drift Park',
    subtitle: '1.5 mi · wide, walled drift course · container port at night',
    swatch: 'linear-gradient(135deg,#ff2bd6,#2b1a5a)',
    available: true,
    series: ['drift'],
    load: () => import('./driftPark').then((m) => m.loadDriftPark()),
  },
];

/** Tracks the lobby offers for a series (all of them with "any track"). */
export const mapsFor = (series: Series, any = false) => MAPS.filter((m) => any || m.series.includes(series));
