import './ui/style.css';
import { Renderer } from './render/renderer';
import { Session, type GridEntry } from './core/session';
import { profile, settings, makeRoomCode } from './core/profile';
import { Room, type RoomSettings } from './net/room';
import { MAPS } from './tracks/maps';
import { MAX_GRID } from './net/transport';
import {
  nicknameScreen, mainMenu, loadingScreen, pauseScreen, garageScreen, clearUI, lobbyScreen, resultsScreen,
  messageScreen, resetChat, BOT_NAMES, type Nav,
} from './ui/screens';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const renderer = new Renderer(canvas);
renderer.setQuality(settings.quality);

let session: Session | null = null;
let room: Room | null = null;
const roomParam = new URLSearchParams(location.search).get('room') ?? undefined;

const DEFAULT_SETTINGS = (): RoomSettings => ({ map: 'sunvale', laps: 10, damage: 'realistic', bots: 5, weather: 'dry' });
const BOT_COLORS = [
  '#2b7de9', '#e9472b', '#14b48c', '#f0a020', '#9b3de0', '#e0e0e0', '#1a1a1a', '#e83e8c', '#5bc0eb', '#8bc34a',
  '#ff7f11', '#0b3d91', '#c81d25', '#2ec4b6', '#ffd23f', '#6a4c93', '#3a3a3a', '#f15bb5', '#00bbf9', '#9ef01a',
  '#8d5524', '#1b998b', '#d7263d', '#f46036', '#2e294e', '#c5d86d', '#4f6d7a', '#ff99c8', '#e4572e', '#76b041', '#a0a4b8',
];

function endSession() {
  session?.dispose();
  session = null;
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

function wireRoom(r: Room) {
  room = r;
  r.onEvent = (type, p, from) => {
    if (type === 'start' && !r.isHost) {
      const msg = p as { grid: GridEntry[]; settings: RoomSettings };
      r.settings = msg.settings;
      r.inRace = true;
      void startSession(msg.grid, msg.settings);
      return;
    }
    if (type === 'lobby-return') {
      r.inRace = false;
      endSession();
      showLobby();
      return;
    }
    session?.handleEvent(type, p, from);
  };
  r.onState = (buf) => session?.handleState(buf);
  r.onClosed = (reason) => {
    endSession();
    room = null;
    messageScreen('Disconnected', reason, () => leaveRoom());
  };
}

function showLobby() {
  if (!room) return;
  const r = room;
  lobbyScreen(r, {
    leave: () => leaveRoom(),
    start: () => {
      const grid = buildGrid(r);
      r.inRace = true;
      r.sendEvent('start', { grid, settings: r.settings });
      void startSession(grid, { ...r.settings });
    },
  });
}

/** Host: humans plus AI drivers in the free slots, in a shuffled starting order. */
function buildGrid(r: Room): GridEntry[] {
  const humans = r.humans.map((p) => ({ slot: p.slot, nickname: p.nickname, number: p.number, color: p.color, bot: false }));
  const used = new Set(humans.map((h) => h.slot));
  const bots: GridEntry[] = [];
  const count = Math.min(r.settings.bots, MAX_GRID - humans.length);
  // AI car numbers: unique and never the same as a human's number
  const takenNumbers = new Set(humans.map((h) => h.number));
  const numbers: number[] = [];
  for (let n = 1; numbers.length < count && n < 100; n += 1 + ((n * 7) % 5)) if (!takenNumbers.has(n)) numbers.push(n);
  for (let n = 1; numbers.length < count && n < 100; n++) if (!takenNumbers.has(n) && !numbers.includes(n)) numbers.push(n);
  let slot = 0;
  for (let i = 0; i < count; i++) {
    while (used.has(slot)) slot++;
    used.add(slot);
    bots.push({ slot, nickname: BOT_NAMES[i % BOT_NAMES.length], number: numbers[i], color: BOT_COLORS[i % BOT_COLORS.length], bot: true });
  }
  const all = [...humans, ...bots];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
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
      const show = () => pauseScreen({ ...api, settings: () => garageScreen(show, () => { session?.applyAssists(); renderer.setQuality(settings.quality); }) }, !r.offline);
      show();
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

const nav: Nav = {
  async host() {
    loadingScreen('Creating room…');
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await Room.host(profile, makeRoomCode(), DEFAULT_SETTINGS());
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
  },
  async join(code: string) {
    const r = await Room.join(profile, code);
    history.replaceState(null, '', `${location.pathname}?room=${code}`);
    wireRoom(r);
    if (r.inRace) messageScreen('Race in progress', 'You will join the next race from the lobby.', () => showLobby());
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
  Object.assign(window, { __r: renderer, __s: () => session, __room: () => room });
  void import('./dev/autotest').then((m) => { m.installAutotest(() => session); m.installRaceTest(() => session); m.installStartTest(() => session); m.installDamageTest(() => session); m.installQuickRace(() => session); });
}
