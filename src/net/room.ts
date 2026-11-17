import Peer, { type DataConnection } from 'peerjs';
import { MAX_HUMANS, peerIdForRoom } from './transport';
import type { Profile } from '../core/profile';
import type { DamageLevel } from '../damage/damage';
import { carSpec, type Series } from '../vehicle/catalog';
import { encodeBatch, splitPacket, statePos } from './codec';

export interface RoomSettings {
  map: string;
  laps: number; // 0 = free practice
  damage: DamageLevel;
  bots: number;
  weather: 'dry' | 'rain';
  /** Which racing series this room runs (cars are picked from it). */
  series: Series;
  /** '' = every driver picks their own car; otherwise everyone races this car id. */
  sameCar: string;
  /** Racing or the Demolition Arena. */
  mode?: 'race' | 'arena';
  /** Arena options: AI opponents, modifiers ('off' | 'random' | an event id), time limit (s, 0 = none). */
  arena?: { bots: number; events: string; timeLimit: number };
}

/** A player's arena loadout: combat class, bumper design and paint job. */
export interface ArenaLoadout { cls: string; bumper: string; paint: string }
const cleanLoadout = (a: unknown): ArenaLoadout => {
  const o = (a ?? {}) as Record<string, unknown>;
  return { cls: String(o.cls ?? 'balanced').slice(0, 20), bumper: String(o.bumper ?? 'bar').slice(0, 12), paint: String(o.paint ?? '').slice(0, 12) };
};

export interface Player {
  slot: number;
  nickname: string;
  number: number;
  color: string;
  ready: boolean;
  isHost: boolean;
  ping: number;
  bot?: boolean;
  /** Picked car per series (car ids); the room's series decides which one races. */
  cars: Record<Series, string>;
  /** Starting tyre for dry GP races. */
  tyre?: DryTyre;
  /** Demolition Arena loadout. */
  arena?: ArenaLoadout;
}

export type DryTyre = 'soft' | 'medium' | 'hard';
const cleanTyre = (t: unknown): DryTyre => (t === 'soft' || t === 'hard' ? t : 'medium');

type Msg =
  | { t: 'hello'; nickname: string; number: number; color: string; cars: Record<Series, string>; tyre?: DryTyre; arena?: ArenaLoadout }
  | { t: 'car'; cars: Record<Series, string>; tyre?: DryTyre; arena?: ArenaLoadout }
  | { t: 'welcome'; slot: number; players: Player[]; settings: RoomSettings; inRace: boolean }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: Player[]; settings: RoomSettings }
  | { t: 'ready'; ready: boolean }
  | { t: 'chat'; f?: number; text: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  | { t: 'ev'; e: string; p: unknown; f?: number };

/** Validate car picks from the network: unknown ids fall back to the series default. */
function cleanCars(c: unknown): Record<Series, string> {
  const o = (c ?? {}) as Record<string, unknown>;
  return { stock: carSpec(String(o.stock), 'stock').id, gp: carSpec(String(o.gp), 'gp').id };
}

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

interface ClientLink {
  slot: number;
  ev: DataConnection;
  st?: DataConnection;
  /** Version of each car's state last sent to this client (only changes are sent). */
  sent: Map<number, number>;
}

/** Cars closer than this to a client's own car get every snapshot; farther ones every FAR_EVERY-th. */
const NEAR_M = 220;
const FAR_EVERY = 3;
/** States per batch packet, kept small enough to avoid fragmenting on the unreliable channel. */
const BATCH_MAX = 24;
/** Relay entries older than this (s) are stale (car gone, previous race) and are not sent. */
const STALE_S = 1.5;

/**
 * A game room over PeerJS / WebRTC (star topology, the host relays).
 * The host's peer id is derived from the room code, so joining only needs the code.
 * PeerJS's free public broker is used just to exchange connection offers; game data then goes
 * browser-to-browser. An `offline` room has the same API with no networking (solo races).
 */
export class Room {
  players: Player[] = [];
  settings: RoomSettings;
  selfSlot = 0;
  inRace = false;
  closed = false;

  onLobby: () => void = () => {};
  onChat: (from: number, text: string) => void = () => {};
  onEvent: (type: string, payload: unknown, from: number) => void = () => {};
  onState: (buf: ArrayBuffer) => void = () => {};
  onClosed: (reason: string) => void = () => {};

  private peer?: Peer;
  private links = new Map<string, ClientLink>(); // host: peerId → link
  private pendingSt = new Map<string, DataConnection>(); // state channels that opened before the hello
  private hostEv?: DataConnection; // client
  private hostSt?: DataConnection; // client
  private pingTimer = 0;
  // host relay: latest snapshot per car slot
  private relay = new Map<number, { buf: ArrayBuffer; ver: number; t: number }>();
  private relayVer = 0;
  private relayTick = 0;

  private constructor(readonly code: string, readonly isHost: boolean, readonly offline: boolean, settings: RoomSettings) {
    this.settings = settings;
  }

  get self(): Player | undefined {
    return this.players.find((p) => p.slot === this.selfSlot);
  }
  get humans() {
    return this.players.filter((p) => !p.bot);
  }

  static offline(profile: Profile, settings: RoomSettings): Room {
    const r = new Room('', true, true, settings);
    r.players = [{ slot: 0, nickname: profile.nickname, number: profile.carNumber, color: profile.color, ready: true, isHost: true, ping: 0, cars: { ...profile.cars }, tyre: profile.tyre }];
    return r;
  }

  static host(profile: Profile, code: string, settings: RoomSettings): Promise<Room> {
    return new Promise((resolve, reject) => {
      const r = new Room(code, true, false, settings);
      r.players = [{ slot: 0, nickname: profile.nickname, number: profile.carNumber, color: profile.color, ready: true, isHost: true, ping: 0, cars: { ...profile.cars }, tyre: profile.tyre }];
      const peer = new Peer(peerIdForRoom(code), PEER_OPTS);
      r.peer = peer;
      const timeout = setTimeout(() => { peer.destroy(); reject(new Error('Could not reach the matchmaking server. Check your connection.')); }, 15000);
      peer.on('open', () => {
        clearTimeout(timeout);
        r.pingTimer = window.setInterval(() => { r.broadcast({ t: 'ping', ts: performance.now() }); if (!r.inRace) r.pushLobby(); }, 2000);
        resolve(r);
      });
      peer.on('error', (err) => {
        clearTimeout(timeout);
        if (err.type === 'unavailable-id') reject(Object.assign(new Error('code-taken'), { code: 'taken' }));
        else if (!r.closed && r.peer?.open) console.warn('peer error', err);
        else reject(new Error(`Network error: ${err.type}`));
      });
      peer.on('disconnected', () => { if (!r.closed) peer.reconnect(); });
      peer.on('connection', (conn) => r.acceptConnection(conn));
    });
  }

  static join(profile: Profile, code: string): Promise<Room> {
    return new Promise((resolve, reject) => {
      const r = new Room(code, false, false, { map: 'sunvale', laps: 10, damage: 'realistic', bots: 0, weather: 'dry', series: 'stock', sameCar: '', mode: 'race' });
      const peer = new Peer(PEER_OPTS);
      r.peer = peer;
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        peer.destroy();
        reject(new Error(msg));
      };
      const timeout = setTimeout(() => fail('Room not found, or the host could not be reached.'), 15000);
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') fail('Room not found. Check the code.');
        else if (!settled) fail(`Network error: ${err.type}`);
        else console.warn('peer error', err);
      });
      peer.on('open', () => {
        const hostId = peerIdForRoom(code);
        const ev = peer.connect(hostId, { label: 'ev', reliable: true, serialization: 'json' });
        const st = peer.connect(hostId, { label: 'st', reliable: false, serialization: 'raw' });
        r.hostEv = ev;
        r.hostSt = st;
        st.on('data', (d) => { if (d instanceof ArrayBuffer) for (const b of splitPacket(d)) r.onState(b); });
        ev.on('open', () => ev.send({ t: 'hello', nickname: profile.nickname, number: profile.carNumber, color: profile.color, cars: { ...profile.cars }, tyre: profile.tyre } satisfies Msg));
        ev.on('data', (raw) => {
          const m = raw as Msg;
          if (m.t === 'welcome') {
            r.selfSlot = m.slot;
            r.players = m.players;
            r.settings = m.settings;
            r.inRace = m.inRace;
            if (!settled) { settled = true; clearTimeout(timeout); resolve(r); }
            return;
          }
          if (m.t === 'reject') return fail(m.reason);
          r.handleFromHost(m);
        });
        ev.on('close', () => { if (settled && !r.closed) r.shutdown('The host left the room.'); });
        ev.on('error', (e) => console.warn('conn error', e));
      });
    });
  }

  // ------------------------------------------------------------------ host side
  private acceptConnection(conn: DataConnection) {
    if (conn.label === 'st') {
      conn.on('open', () => {
        this.pendingSt.set(conn.peer, conn);
        const link = this.links.get(conn.peer);
        if (link) link.st = conn;
      });
      conn.on('data', (d) => {
        if (!(d instanceof ArrayBuffer)) return;
        const link = this.links.get(conn.peer);
        if (!link || new Uint8Array(d)[0] !== link.slot) return; // a client may only send its own car
        this.storeRelay(link.slot, d);
        this.onState(d);
      });
      return;
    }
    conn.on('data', (raw) => {
      const m = raw as Msg;
      const link = this.links.get(conn.peer);
      if (m.t === 'hello') {
        if (this.humans.length >= MAX_HUMANS) return this.rejectConn(conn, `Room full (max ${MAX_HUMANS} players).`);
        if (this.inRace) return this.rejectConn(conn, 'A race is in progress. Try again when it ends.');
        const used = new Set(this.players.map((p) => p.slot));
        let slot = 1;
        while (used.has(slot)) slot++;
        this.links.set(conn.peer, { slot, ev: conn, st: this.pendingSt.get(conn.peer), sent: new Map() });
        this.players.push({ slot, nickname: String(m.nickname).slice(0, 16), number: Number(m.number) | 0, color: String(m.color), ready: false, isHost: false, ping: 0, cars: cleanCars(m.cars), tyre: cleanTyre(m.tyre), arena: cleanLoadout(m.arena) });
        conn.send({ t: 'welcome', slot, players: this.players, settings: this.settings, inRace: this.inRace } satisfies Msg);
        this.pushLobby();
        this.onChat(-1, `${m.nickname} joined`);
        return;
      }
      if (!link) return;
      switch (m.t) {
        case 'ready': {
          const p = this.players.find((x) => x.slot === link.slot);
          if (p) p.ready = !!m.ready;
          this.pushLobby();
          break;
        }
        case 'car': {
          const p = this.players.find((x) => x.slot === link.slot);
          if (p) { p.cars = cleanCars(m.cars); p.tyre = cleanTyre(m.tyre); if (m.arena) p.arena = cleanLoadout(m.arena); }
          this.pushLobby();
          break;
        }
        case 'chat': {
          const text = String(m.text).slice(0, 200);
          this.broadcast({ t: 'chat', f: link.slot, text });
          this.onChat(link.slot, text);
          break;
        }
        case 'pong': {
          const p = this.players.find((x) => x.slot === link.slot);
          if (p) p.ping = Math.round(performance.now() - m.ts);
          break;
        }
        case 'ev':
          this.onEvent(m.e, m.p, link.slot);
          for (const [pid, l] of this.links) if (pid !== conn.peer) l.ev.send({ t: 'ev', e: m.e, p: m.p, f: link.slot } satisfies Msg);
          break;
      }
    });
    conn.on('close', () => this.dropPeer(conn.peer));
    conn.on('error', () => this.dropPeer(conn.peer));
  }

  private rejectConn(conn: DataConnection, reason: string) {
    conn.send({ t: 'reject', reason } satisfies Msg);
    setTimeout(() => conn.close(), 400);
  }

  private dropPeer(pid: string) {
    const link = this.links.get(pid);
    if (!link) return;
    this.links.delete(pid);
    this.pendingSt.delete(pid);
    this.relay.delete(link.slot);
    const p = this.players.find((x) => x.slot === link.slot);
    this.players = this.players.filter((x) => x.slot !== link.slot);
    this.pushLobby();
    if (p) this.onChat(-1, `${p.nickname} left`);
    this.onEvent('left', { slot: link.slot }, link.slot);
    this.broadcast({ t: 'ev', e: 'left', p: { slot: link.slot }, f: 0 });
  }

  private broadcast(m: Msg) {
    for (const l of this.links.values()) if (l.ev.open) l.ev.send(m);
  }

  pushLobby() {
    if (!this.isHost) return;
    // periodic pings are folded into lobby updates
    this.broadcast({ t: 'lobby', players: this.players, settings: this.settings });
    this.onLobby();
  }

  setSettings(s: Partial<RoomSettings>) {
    if (!this.isHost) return;
    Object.assign(this.settings, s);
    this.pushLobby();
  }

  // ------------------------------------------------------------------ client side
  private handleFromHost(m: Msg) {
    switch (m.t) {
      case 'lobby':
        this.players = m.players;
        this.settings = m.settings;
        this.onLobby();
        break;
      case 'chat':
        this.onChat(m.f ?? -1, m.text);
        break;
      case 'ping':
        this.hostEv?.send({ t: 'pong', ts: m.ts } satisfies Msg);
        break;
      case 'ev':
        this.onEvent(m.e, m.p, m.f ?? 0);
        break;
    }
  }

  // ------------------------------------------------------------------ shared
  setReady(ready: boolean) {
    const me = this.self;
    if (me) me.ready = ready;
    if (this.isHost) this.pushLobby();
    else this.hostEv?.send({ t: 'ready', ready } satisfies Msg);
  }

  /** Change this player's arena loadout. */
  setLoadout(a: ArenaLoadout) {
    const me = this.self;
    if (me) me.arena = { ...a };
    if (this.isHost) this.pushLobby();
    else this.hostEv?.send({ t: 'car', cars: me?.cars ?? { stock: 'stock-balanced', gp: 'gp-balanced' }, tyre: me?.tyre, arena: { ...a } } satisfies Msg);
  }

  /** Change this player's car picks (host applies them, clients ask the host). */
  setCars(cars: Record<Series, string>, tyre?: DryTyre) {
    const me = this.self;
    if (me) { me.cars = { ...cars }; me.tyre = tyre ?? me.tyre; }
    if (this.isHost) this.pushLobby();
    else this.hostEv?.send({ t: 'car', cars: { ...cars }, tyre: tyre ?? me?.tyre } satisfies Msg);
  }

  chat(text: string) {
    text = text.trim().slice(0, 200);
    if (!text) return;
    if (this.isHost) {
      this.broadcast({ t: 'chat', f: this.selfSlot, text });
      this.onChat(this.selfSlot, text);
    } else this.hostEv?.send({ t: 'chat', text } satisfies Msg);
  }

  /** Reliable game event to everyone else. */
  sendEvent(e: string, p: unknown) {
    if (this.offline) return;
    if (this.isHost) this.broadcast({ t: 'ev', e, p, f: this.selfSlot });
    else if (this.hostEv?.open) this.hostEv.send({ t: 'ev', e, p } satisfies Msg);
  }

  private storeRelay(slot: number, buf: ArrayBuffer) {
    this.relay.set(slot, { buf, ver: ++this.relayVer, t: performance.now() / 1000 });
  }

  /**
   * Unreliable car snapshots for the cars this peer simulates (first byte = slot). A client sends
   * its own car to the host. The host batches its cars plus the latest state of every client into
   * one packet per client per tick: only changed cars, and far-away cars at a lower rate.
   */
  sendStates(bufs: ArrayBuffer[]) {
    if (this.offline) return;
    if (!this.isHost) {
      if (this.hostSt?.open) for (const b of bufs) this.hostSt.send(b);
      return;
    }
    for (const b of bufs) this.storeRelay(new Uint8Array(b)[0], b);
    const now = performance.now() / 1000;
    const tick = this.relayTick++;
    let k = 0;
    for (const l of this.links.values()) {
      k++;
      if (!l.st?.open) continue;
      const me = this.relay.get(l.slot);
      const mp = me ? statePos(me.buf) : null;
      const out: ArrayBuffer[] = [];
      for (const [slot, e] of this.relay) {
        if (slot === l.slot || l.sent.get(slot) === e.ver || now - e.t > STALE_S) continue;
        if (mp) {
          const p = statePos(e.buf);
          const far = Math.hypot(p[0] - mp[0], p[1] - mp[1], p[2] - mp[2]) > NEAR_M;
          // spread far updates over ticks so packets stay even
          if (far && (tick + k + slot) % FAR_EVERY !== 0) continue;
        }
        l.sent.set(slot, e.ver);
        out.push(e.buf);
      }
      for (let i = 0; i < out.length; i += BATCH_MAX) l.st.send(encodeBatch(out.slice(i, i + BATCH_MAX)));
    }
  }

  pingOf(slot: number) {
    return this.players.find((p) => p.slot === slot)?.ping ?? 0;
  }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.peer?.destroy();
    this.onClosed(reason);
  }

  close() {
    this.shutdown('left');
  }
}
