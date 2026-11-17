import './ui/style.css';
import { Renderer } from './render/renderer';
import { Session, type GridEntry } from './core/session';
import { profile, settings, makeRoomCode } from './core/profile';
import { Room, type RoomSettings } from './net/room';
import { MAPS } from './tracks/maps';
import { carSpec, carsOf } from './vehicle/catalog';
import { MAX_GRID } from './net/transport';
import {
  nicknameScreen, mainMenu, loadingScreen, pauseScreen, garageScreen, clearUI, lobbyScreen, resultsScreen, driftResultsScreen,
  messageScreen, resetChat, BOT_NAMES, type Nav,
} from './ui/screens';
import { ArenaSession, type ArenaEntry, type ArenaSettings } from './arena/arenaSession';
import { CLASSES, BUMPERS } from './arena/classes';
import { grantRewards, loadArenaProfile } from './arena/rewards';
import { arenaLobbyScreen, arenaResultsScreen, loadoutColor, unlocksAt, ARENA_MAX } from './ui/arenaScreens';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const renderer = new Renderer(canvas);
renderer.setQuality(settings.quality);

let session: Session | null = null;
let arena: ArenaSession | null = null;
let room: Room | null = null;
const roomParam = new URLSearchParams(location.search).get('room') ?? undefined;

const DEFAULT_SETTINGS = (): RoomSettings => ({ map: 'sunvale', laps: 10, damage: 'realistic', bots: 5, weather: 'dry', series: 'stock', sameCar: '', mode: 'race', arena: { bots: 7, events: 'off', timeLimit: 0 } });
const BOT_COLORS = [
  '#2b7de9', '#e9472b', '#14b48c', '#f0a020', '#9b3de0', '#e0e0e0', '#1a1a1a', '#e83e8c', '#5bc0eb', '#8bc34a',
  '#ff7f11', '#0b3d91', '#c81d25', '#2ec4b6', '#ffd23f', '#6a4c93', '#3a3a3a', '#f15bb5', '#00bbf9', '#9ef01a',
  '#8d5524', '#1b998b', '#d7263d', '#f46036', '#2e294e', '#c5d86d', '#4f6d7a', '#ff99c8', '#e4572e', '#76b041', '#a0a4b8',
];

function endSession() {
  session?.dispose();
  session = null;
  arena?.dispose();
  arena = null;
}

function leaveRoom(notice?: string) {
  endSession();
  if (room) {
    room.onClosed = () => {};
    room.close();
  }
  room = null;
  resetChat();
  history.replaceState(null, '', location.pathname);
  mainMenu(nav, undefined, notice);
}

/** Host: what the race/match in progress was started with (sent to late joiners, who spectate). */
let currentStart: { grid: GridEntry[] | ArenaEntry[]; settings: RoomSettings; seed?: number } | null = null;

function wireRoom(r: Room) {
  room = r;

  r.onEvent = (type, p, from) => {
    if (type === 'start' && !r.isHost) {
      const msg = p as { grid: GridEntry[] | ArenaEntry[]; settings: RoomSettings; seed?: number };
      r.settings = msg.settings;
      r.inRace = true;
      if (msg.settings.mode === 'arena') void startArena(msg.grid as ArenaEntry[], msg.settings, msg.seed ?? 1);
      else void startSession(msg.grid as GridEntry[], msg.settings);
      return;
    }
    // a player who joined mid-race asks for the race in progress and watches it
    if (type === 'spectate' && r.isHost) {
      if (r.inRace && currentStart) r.sendEventTo(from, 'start', { ...currentStart, spectate: true });
      return;
    }
    if (type === 'lobby-return') {
      r.inRace = false;
      endSession();
      showLobby();
      return;
    }
    session?.handleEvent(type, p, from);
    arena?.handleEvent(type, p, from);
  };
  r.onState = (buf) => { session?.handleState(buf); arena?.handleState(buf); };
  r.onClosed = (reason) => {
    endSession();
    room = null;
    messageScreen('Disconnected', reason, () => leaveRoom());
  };
}

/** Host: stop the race / match for everyone and go back to the lobby. */
function endToLobby(r: Room) {
  r.inRace = false;
  r.sendEvent('lobby-return', {});
  endSession();
  showLobby();
}

/** The room's one lobby: the host picks racing or the Demolition Arena in it. */
function showLobby() {
  if (!room) return;
  const r = room;
  const mode = r.settings.mode ?? 'race';
  const setMode = (m: 'race' | 'arena' | 'drift') => {
    const s = r.settings;
    // drift runs the drift series on the drift park; leaving drift goes back to stock cars
    if (m === 'drift') r.setSettings({ mode: m, series: 'drift', sameCar: '', map: 'driftpark', driftMinutes: s.driftMinutes ?? 3 });
    else r.setSettings({ mode: m, arena: s.arena ?? { bots: 7, events: 'off', timeLimit: 0 }, ...(s.series === 'drift' ? { series: 'stock' as const, sameCar: '', map: 'sunvale' } : {}) });
    showLobby();
  };
  r.onLobby = () => {}; // the previous lobby's listener must not fire while the new one is built
  if (mode === 'arena') arenaLobbyScreen(r, { leave: () => leaveRoom(), start: () => startArenaMatch(), mode: setMode });
  else showRaceLobby(r, setMode);
  // clients: when the host switches the mode, show the other lobby
  const render = r.onLobby;
  r.onLobby = () => { if ((r.settings.mode ?? 'race') !== mode) showLobby(); else render(); };
}

function showRaceLobby(r: Room, setMode: (m: 'race' | 'arena' | 'drift') => void) {
  lobbyScreen(r, {
    mode: setMode,
    leave: () => leaveRoom(),
    start: () => {
      const grid = buildGrid(r);
      r.inRace = true;
      r.reserved = new Set(grid.map((g) => g.slot));
      // drift: a free session (no laps, no AI) that the session clock ends
      const cfg = r.settings.mode === 'drift' ? { ...r.settings, laps: 0, bots: 0 } : { ...r.settings };
      currentStart = { grid, settings: cfg };
      r.sendEvent('start', { grid, settings: cfg });
      void startSession(grid, cfg);
    },
  });
}

/** Host: humans plus AI drivers in the free slots, in a shuffled starting order. */
function buildGrid(r: Room): GridEntry[] {
  const series = r.settings.series;
  // a forced car (if valid for the series) overrides everyone's pick
  const forced = r.settings.sameCar && carSpec(r.settings.sameCar).id === r.settings.sameCar && carSpec(r.settings.sameCar).series === series ? r.settings.sameCar : '';
  const humans = r.humans.map((p) => ({ slot: p.slot, nickname: p.nickname, number: p.number, color: p.color, bot: false, car: forced || carSpec(p.cars?.[series], series).id, tyre: p.tyre ?? 'medium' as const }));
  const pool = carsOf(series);
  const used = new Set(humans.map((h) => h.slot));
  const bots: GridEntry[] = [];
  const count = r.settings.mode === 'drift' ? 0 : Math.min(r.settings.bots, MAX_GRID - humans.length);
  // AI car numbers: unique and never the same as a human's number
  const takenNumbers = new Set(humans.map((h) => h.number));
  const numbers: number[] = [];
  for (let n = 1; numbers.length < count && n < 100; n += 1 + ((n * 7) % 5)) if (!takenNumbers.has(n)) numbers.push(n);
  for (let n = 1; numbers.length < count && n < 100; n++) if (!takenNumbers.has(n) && !numbers.includes(n)) numbers.push(n);
  let slot = 0;
  for (let i = 0; i < count; i++) {
    while (used.has(slot)) slot++;
    used.add(slot);
    // AI drivers: an even mix of the series' cars, shuffled by slot
    bots.push({ slot, nickname: BOT_NAMES[i % BOT_NAMES.length], number: numbers[i], color: BOT_COLORS[i % BOT_COLORS.length], bot: true, car: forced || pool[(i * 7 + slot * 3) % pool.length].id, tyre: (['medium', 'soft', 'hard', 'medium'] as const)[i % 4] });
  }
  const all = [...humans, ...bots];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

/** Host: arena grid — every human's loadout, AI wreckers in a mix of classes, random spawn order. */
function buildArenaGrid(r: Room): ArenaEntry[] {
  const humans: ArenaEntry[] = r.humans.map((p) => ({
    slot: p.slot, nickname: p.nickname, number: p.number, color: loadoutColor(p.arena?.paint ?? '', p.color), bot: false,
    cls: CLASSES.some((c) => c.id === p.arena?.cls) ? p.arena!.cls : 'balanced', bumper: p.arena?.bumper ?? 'bar',
  }));
  const cfg = r.settings.arena ?? { bots: 7, events: 'off', timeLimit: 0 };
  const count = Math.min(cfg.bots, ARENA_MAX - humans.length);
  const used = new Set(humans.map((h) => h.slot));
  const taken = new Set(humans.map((h) => h.number));
  const bots: ArenaEntry[] = [];
  let slot = 0, num = 2;
  for (let i = 0; i < count; i++) {
    while (used.has(slot)) slot++;
    used.add(slot);
    while (taken.has(num)) num++;
    taken.add(num);
    bots.push({ slot, nickname: BOT_NAMES[i % BOT_NAMES.length], number: num, color: BOT_COLORS[i % BOT_COLORS.length], bot: true, cls: CLASSES[(i * 3 + 1) % CLASSES.length].id, bumper: BUMPERS[i % BUMPERS.length].id });
  }
  const all = [...humans, ...bots];
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return all;
}

function startArenaMatch() {
  if (!room) return;
  const r = room;
  const grid = buildArenaGrid(r);
  const seed = Math.floor(Math.random() * 1e6);
  r.inRace = true;
  currentStart = { grid, settings: { ...r.settings }, seed };
  r.reserved = new Set(grid.map((g) => g.slot));
  r.sendEvent('start', { grid, settings: r.settings, seed });
  void startArena(grid, { ...r.settings }, seed);
}

async function startArena(grid: ArenaEntry[], cfg: RoomSettings, seed: number) {
  if (!room) return;
  endSession();
  const r = room;
  loadingScreen('Loading the arena…');
  const acfg: ArenaSettings = cfg.arena ?? { bots: 7, events: 'off', timeLimit: 0 };
  const a = new ArenaSession(renderer, hudRoot, r, acfg, grid, seed, {
    onExit: () => leaveRoom(),
    onPause: (paused, api) => {
      if (!paused) return clearUI();
      const show = () => pauseScreen({ ...api, settings: () => garageScreen(show, () => renderer.setQuality(settings.quality)), endToLobby: r.isHost ? () => endToLobby(r) : undefined }, !r.offline);
      show();
    },
    onResults: (res) => {
      const reward = a.spectator ? null : grantRewards(loadArenaProfile(), res.me, unlocksAt);
      arenaResultsScreen(res, reward, r.isHost, {
        again: () => startArenaMatch(),
        lobby: () => { r.inRace = false; r.sendEvent('lobby-return', {}); endSession(); showLobby(); },
        menu: () => leaveRoom(),
      });
    },
  });
  arena = a;
  try {
    await a.load((m) => loadingScreen(m));
    if (arena === a) clearUI();
  } catch (e) {
    console.error(e);
    messageScreen('Could not load the arena', (e as Error).message, () => leaveRoom());
  }
}

async function startSession(grid: GridEntry[], cfg: RoomSettings) {
  if (!room) return;
  endSession();
  const r = room;
  const map = MAPS.find((m) => m.id === cfg.map) ?? MAPS[0];
  loadingScreen('Loading…');
  const s = new Session(renderer, hudRoot, r, map, cfg, grid, {
    onExit: () => leaveRoom(),
    onPause: (paused, api) => {
      if (!paused) return clearUI();
      const show = () => pauseScreen({ ...api, settings: () => garageScreen(show, () => { session?.applyAssists(); renderer.setQuality(settings.quality); }), endToLobby: r.isHost ? () => endToLobby(r) : undefined }, !r.offline);
      show();
    },
    onDriftResults: (rows) => {
      driftResultsScreen(rows, r.selfSlot, r.isHost, {
        leave: () => leaveRoom(),
        lobby: () => { r.inRace = false; r.sendEvent('lobby-return', {}); endSession(); showLobby(); },
      });
    },
    onResults: (rows, g) => {
      resultsScreen(rows, g, r.isHost, {
        leave: () => leaveRoom(),
        lobby: () => {
          r.inRace = false;
          r.sendEvent('lobby-return', {});
          endSession();
          showLobby();
        },
      });
    },
  });
  session = s;
  try {
    await s.load((m) => loadingScreen(m));
    if (session === s) clearUI();
  } catch (e) {
    console.error(e);
    messageScreen('Could not load the race', (e as Error).message, () => leaveRoom());
  }
}

async function hostRoom(settingsFor: () => RoomSettings) {
  loadingScreen('Creating room…');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await Room.host(profile, makeRoomCode(), settingsFor());
      wireRoom(r);
      showLobby();
      return;
    } catch (e) {
      if ((e as { code?: string }).code === 'taken') continue;
      messageScreen('Could not create a room', (e as Error).message, () => mainMenu(nav));
      return;
    }
  }
  messageScreen('Could not create a room', 'Please try again.', () => mainMenu(nav));
}

const nav: Nav = {
  host() { void hostRoom(DEFAULT_SETTINGS); },
  async join(code: string) {
    const r = await Room.join(profile, code);
    history.replaceState(null, '', `${location.pathname}?room=${code}`);
    wireRoom(r);
    // mid-race: the host sends the race in progress and we watch it as a spectator
    if (r.inRace) {
      loadingScreen('Race in progress — joining as a spectator…');
      r.sendEvent('spectate', {});
    }
    else showLobby();
  },
  single() {
    const r = Room.offline(profile, DEFAULT_SETTINGS());
    wireRoom(r);
    showLobby();
  },
};

if (profile.nickname) mainMenu(nav, roomParam);
else nicknameScreen(() => mainMenu(nav, roomParam));

// dev-only handles for live tuning / automated testing from the console
if (import.meta.env.DEV) {
  Object.assign(window, { __r: renderer, __s: () => session, __a: () => arena, __room: () => room });
  void import('./dev/autotest').then((m) => { m.installAutotest(() => session); m.installRaceTest(() => session); m.installStartTest(() => session); m.installDamageTest(() => session); m.installQuickRace(() => session); m.installQuickArena(); m.installSweep(() => session); });
}
