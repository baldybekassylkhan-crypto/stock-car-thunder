import * as THREE from 'three';
import { initPhysics, PhysicsWorld } from '../physics/world';
import type { Renderer } from '../render/renderer';
import { Effects } from '../render/effects';
import { CameraRig } from '../render/cameras';
import { EngineAudio } from '../audio/engine';
import { Debris } from '../damage/debris';
import { charCar, dentCar } from '../damage/visual';
import { Car } from '../vehicle/car';
import { RemoteCar } from '../vehicle/remoteCar';
import { updateLod, LOD_DISTANCE } from '../vehicle/carLod';
import { PART_NAMES, type CarVisual } from '../vehicle/carModel';
import { encodeState, decodeState } from '../net/codec';
import type { Room } from '../net/room';
import { readDriverInput, wasPressed, clearPressed, readMouseLook, type DriverInput } from '../core/input';
import { settings } from '../core/profile';
import { buildArena, type ArenaMap } from './arenaMap';
import { arenaSpec, classById, type Zone } from './classes';
import { CombatDamage, collisionDamage, zoneOf, PAIR_COOLDOWN } from './combatDamage';
import { AbilitySystem, ABILITIES, NITRO_ACCEL, SHOCK, type AbilityId } from './abilities';
import { ArenaAI, PERSONALITIES, type Combatant, type Personality } from './arenaAI';
import { ArenaEvents, EVENT_INFO, PICKUP_REPAIR, pickEvents } from './events';
import { ArenaHud } from './arenaHud';
import { ArenaAudio } from './arenaAudio';
import { loadArenaProfile, type MatchStats } from './rewards';

/**
 * Demolition Arena match: the combat-vehicle controller and match manager.
 * Phases: intro (cinematic fly-around) → countdown (3, 2, 1, FIGHT!, cars locked) → combat
 * (FINAL TWO when two remain) → victory (cinematic on the winner) → results.
 *
 * Online it works like the races: every player simulates their own car, the host simulates the AI
 * cars and runs the match (phase, clock, eliminations, scoreboard). Each peer works out the damage
 * its own cars take (it sees the real contacts) and reports it, so the host can credit attackers.
 */
export interface ArenaSettings {
  bots: number;
  /** 'off' | 'random' | an event id. */
  events: string;
  /** Match time limit in seconds (0 = none). */
  timeLimit: number;
}

export interface ArenaEntry {
  slot: number;
  nickname: string;
  number: number;
  color: string;
  bot: boolean;
  cls: string;
  bumper: string;
}

export interface ArenaStanding {
  slot: number;
  name: string;
  color: string;
  number: number;
  cls: string;
  place: number;
  kills: number;
  dealt: number;
  taken: number;
  survival: number;
  bot: boolean;
}

export interface ArenaResult {
  standings: ArenaStanding[];
  winner: number;
  me: MatchStats;
  events: string[];
}

export interface ArenaCallbacks {
  onExit(): void;
  onPause(paused: boolean, api: { resume(): void; reset(): void; exit(): void }): void;
  onResults(r: ArenaResult): void;
}

type Phase = 'loading' | 'intro' | 'countdown' | 'combat' | 'victory' | 'done';
const INTRO = 4.5;
const COUNTDOWN = 4;
const VICTORY = 6.5;

interface Local {
  slot: number;
  car: Car;
  dmg: CombatDamage;
  ab: AbilitySystem;
  ai: ArenaAI | null;
  input: DriverInput;
  flipT: number;
}

interface Info {
  slot: number;
  alive: boolean;
  hp: number;
  kills: number;
  dealt: number;
  taken: number;
  deathT: number;
  place: number;
}

const _v = new THREE.Vector3();

export class ArenaSession {
  physics!: PhysicsWorld;
  arena!: ArenaMap;
  time = 0;
  /** Seconds of combat so far (host clock, mirrored by clients). */
  matchT = 0;
  phase: Phase = 'loading';
  phaseT = 0;
  private locals = new Map<number, Local>();
  private remotes = new Map<number, RemoteCar>();
  private colliderSlot = new Map<number, number>();
  private info = new Map<number, Info>();
  private effects = new Effects();
  private debris!: Debris;
  private events!: ArenaEvents;
  private rig!: CameraRig;
  private hud: ArenaHud;
  private engine: EngineAudio | null = null;
  private sfx: ArenaAudio | null = null;
  private pairT = new Map<string, number>();
  private remoteRam = new Map<number, number>();
  private remoteNitro = new Map<number, number>();
  private feed: { text: string; t: number }[] = [];
  private banner = '';
  private bannerColor = '#fff';
  private bannerUntil = 0;
  private hitDir: number | null = null;
  private hitUntil = 0;
  private finalTwo = false;
  private winner = -1;
  private spectating = -1;
  private excitement = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private paused = false;
  private disposed = false;
  private sendT = 0;
  private snapT = 0;
  private hpT = 0;
  private cdSaid = -1;
  private resultsSent = false;
  private scoreT = 0;
  private shockRings: { mesh: THREE.Mesh; t: number }[] = [];
  private emitAcc = new Map<string, number>();
  private readonly isHost: boolean;
  private readonly self: number;
  private readonly seed: number;
  readonly eventIds: string[];

  constructor(
    private r: Renderer,
    hudRoot: HTMLElement,
    private room: Room,
    readonly cfg: ArenaSettings,
    readonly grid: ArenaEntry[],
    seed: number,
    private cb: ArenaCallbacks,
  ) {
    this.isHost = room.isHost;
    this.self = room.selfSlot;
    this.seed = seed;
    this.eventIds = pickEvents(cfg.events, seed);
    this.hud = new ArenaHud(hudRoot);
    this.hud.show(false);
  }

  // ====================================================================== setup
  async load(onProgress: (msg: string) => void) {
    onProgress('Starting physics…');
    await initPhysics();
    onProgress('Building the arena…');
    await new Promise((res) => setTimeout(res, 30));
    this.arena = buildArena();
    this.physics = new PhysicsWorld();
    this.physics.addTrack(this.arena.colliders, -0.03);
    this.debris = new Debris(this.physics);
    this.events = new ArenaEvents(this.eventIds as never, this.arena.radius, this.seed);
    this.physics.world.gravity = { x: 0, y: this.events.gravity, z: 0 };
    this.r.scene.add(this.arena.group, this.effects.group, this.debris.group, this.events.group);
    this.r.applyAtmosphere(this.arena.atmosphere);
    this.r.setQuality(settings.quality);

    onProgress('Rolling the wrecks in…');
    this.grid.forEach((g, k) => {
      const { pos, quat } = this.arena.spawn(k, this.grid.length);
      const spec = arenaSpec(g.cls, g.bumper);
      const opts = { number: g.number, color: g.color, seed: g.number + g.slot * 7 };
      this.info.set(g.slot, { slot: g.slot, alive: true, hp: 1000, kills: 0, dealt: 0, taken: 0, deathT: -1, place: 0 });
      if (g.slot === this.self || (g.bot && this.isHost)) {
        const car = new Car(this.physics, opts, pos, quat, 'off', spec);
        car.gripScale = 1;
        this.colliderSlot.set(car.collider.handle, g.slot);
        this.r.scene.add(car.visual.root);
        // a little battle-worn already
        for (let d = 0; d < 3; d++) dentCar(car.visual, new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 0.5, (Math.random() - 0.5) * 5), new THREE.Vector3(Math.random() - 0.5, -0.2, Math.random() - 0.5).normalize(), 0.03 + Math.random() * 0.04);
        const cls = classById(g.cls);
        const personality: Personality = PERSONALITIES[(k * 3 + this.seed) % PERSONALITIES.length];
        this.locals.set(g.slot, {
          slot: g.slot, car, dmg: new CombatDamage(cls), ab: new AbilitySystem(cls.repairs),
          ai: g.bot ? new ArenaAI(car, g.slot, personality, this.arena.radius, this.arena.obstacles, g.slot + this.seed) : null,
          input: { steer: 0, throttle: 0, brake: 1, shiftUp: false, shiftDown: false }, flipT: 0,
        });
      } else {
        const rc = new RemoteCar(this.physics, g.slot, opts, pos, quat, spec);
        this.remotes.set(g.slot, rc);
        this.colliderSlot.set(rc.collider.handle, g.slot);
        this.r.scene.add(rc.visual.root);
      }
    });

    this.rig = new CameraRig(this.r.camera, this.arena.tvCams);
    try {
      this.engine = new EngineAudio(settings.volume);
      this.engine.resume();
      this.sfx = new ArenaAudio(settings.volume);
      this.sfx.resume();
    } catch { this.engine = null; this.sfx = null; }
    this.hud.show(true);
    clearPressed();
    this.setPhase('intro');
    this.sfx?.say('Welcome to the Demolition Arena!');
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private get me(): Local | undefined { return this.locals.get(this.self); }
  private name(slot: number) { return slot < 0 ? 'the arena' : this.grid.find((g) => g.slot === slot)?.nickname ?? '?'; }
  private entry(slot: number) { return this.grid.find((g) => g.slot === slot); }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private flash(text: string, sec: number, color = '#ffffff') {
    this.banner = text;
    this.bannerColor = color;
    this.bannerUntil = this.time + sec;
  }

  private addFeed(text: string) {
    this.feed.unshift({ text, t: this.time });
    this.feed.length = Math.min(this.feed.length, 6);
  }

  // ====================================================================== queries
  private posOf(slot: number): THREE.Vector3 {
    const l = this.locals.get(slot);
    if (l) return l.car.position.clone();
    return this.remotes.get(slot)?.pos.clone() ?? new THREE.Vector3();
  }
  private velOf(slot: number): THREE.Vector3 {
    const l = this.locals.get(slot);
    if (l) { const v = l.car.body.linvel(); return new THREE.Vector3(v.x, v.y, v.z); }
    return this.remotes.get(slot)?.vel.clone() ?? new THREE.Vector3();
  }
  private quatOf(slot: number): THREE.Quaternion {
    const l = this.locals.get(slot);
    if (l) { const q = l.car.body.rotation(); return new THREE.Quaternion(q.x, q.y, q.z, q.w); }
    return this.remotes.get(slot)?.quat.clone() ?? new THREE.Quaternion();
  }
  private visualOf(slot: number): CarVisual | null {
    return this.locals.get(slot)?.car.visual ?? this.remotes.get(slot)?.visual ?? null;
  }
  private massOf(slot: number) {
    const g = this.entry(slot);
    return g ? arenaSpec(g.cls).mass : 1600;
  }
  private alive(slot: number) { return this.info.get(slot)?.alive ?? false; }
  private aliveSlots() { return [...this.info.values()].filter((i) => i.alive).map((i) => i.slot); }

  // ====================================================================== network in
  handleEvent(type: string, p: any, from: number) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!this.arena) return;
    switch (type) {
      case 'asnap':
        if (!this.isHost) this.applySnapshot(p);
        break;
      case 'ahp': {
        // a player reports their own car's health
        const i = this.info.get(from);
        if (this.isHost && i && i.alive) { i.hp = Number(p.hp) || 0; i.taken = Number(p.taken) || 0; }
        break;
      }
      case 'admg': {
        // damage a player took, credited to whoever hit them
        if (this.isHost && p.v === from) for (const [a, d] of Object.entries(p.by as Record<string, number>)) { const i = this.info.get(Number(a)); if (i) i.dealt += Math.min(1000, Number(d) || 0); }
        break;
      }
      case 'aelim':
        if (this.isHost && p.v === from) this.eliminate(p.v, p.k);
        else if (!this.isHost) this.onEliminated(p.v, p.k, p.place);
        break;
      case 'aab':
        if (p.id === 'ram') this.remoteRam.set(p.s, this.time + 4);
        if (p.id === 'nitro') this.remoteNitro.set(p.s, this.time + 2.5);
        break;
      case 'ashock':
        this.shockwave(p.s, new THREE.Vector3().fromArray(p.p));
        break;
      case 'apickreq':
        if (this.isHost && p.s === from) this.confirmPickup(p.id, p.s);
        break;
      case 'apick':
        if (!this.isHost) this.applyPickup(p.id, p.s);
        break;
      case 'aresults':
        if (!this.isHost) this.finish(p.standings, p.winner);
        break;
      case 'left': {
        const i = this.info.get(p.slot);
        if (i && i.alive && this.isHost) this.eliminate(p.slot, -1);
        const rc = this.remotes.get(p.slot);
        if (rc) { rc.dispose(this.r.scene); this.remotes.delete(p.slot); }
        break;
      }
    }
  }

  handleState(buf: ArrayBuffer) {
    const s = decodeState(buf);
    if (!s) return;
    this.remotes.get(s.slot)?.push(s, performance.now() / 1000);
  }

  private applySnapshot(p: { ph: Phase; pt: number; mt: number; info: [number, number, number, number, number, number, number][]; w: number; f2: boolean }) {
    if (p.ph !== this.phase) {
      if (p.ph === 'combat' && this.phase !== 'combat') this.startCombatFx();
      if (p.ph === 'victory' && this.phase !== 'victory') this.victoryFx(p.w);
      this.phase = p.ph;
    }
    this.phaseT = p.pt;
    this.matchT = p.mt;
    this.winner = p.w;
    if (p.f2 && !this.finalTwo) this.finalTwoFx();
    for (const [slot, alive, hp, kills, dealt, taken, place] of p.info) {
      const i = this.info.get(slot);
      if (!i) continue;
      // our own car's health is ours to say
      if (!this.locals.has(slot)) { i.hp = hp; i.taken = taken; }
      i.alive = alive === 1 && (this.locals.get(slot)?.dmg.alive ?? true);
      i.kills = kills; i.dealt = dealt; i.place = place;
    }
  }

  // ====================================================================== match control (host)
  private hostUpdate(dt: number) {
    this.phaseT += dt;
    if (this.phase === 'intro' && this.phaseT > INTRO) this.setPhase('countdown');
    else if (this.phase === 'countdown' && this.phaseT > COUNTDOWN) { this.setPhase('combat'); this.startCombatFx(); }
    else if (this.phase === 'combat') {
      this.matchT += dt;
      const alive = this.aliveSlots();
      if (alive.length === 2 && !this.finalTwo && this.grid.length > 2) this.finalTwoFx();
      let over = alive.length <= 1;
      if (!over && this.cfg.timeLimit > 0 && this.matchT >= this.cfg.timeLimit) {
        // time up: rank the survivors by health
        const byHp = alive.sort((a, b) => this.info.get(a)!.hp - this.info.get(b)!.hp);
        for (const s of byHp.slice(0, -1)) this.eliminate(s, -1, true);
        over = true;
      }
      if (over) {
        this.winner = this.aliveSlots()[0] ?? -1;
        const wi = this.info.get(this.winner);
        if (wi) wi.place = 1;
        this.setPhase('victory');
        this.victoryFx(this.winner);
      }
    } else if (this.phase === 'victory' && this.phaseT > VICTORY && !this.resultsSent) {
      this.resultsSent = true;
      const st = this.standings();
      this.room.sendEvent('aresults', { standings: st, winner: this.winner });
      this.finish(st, this.winner);
    }
    this.snapT -= dt;
    if (this.snapT <= 0) {
      this.snapT = 0.2;
      this.room.sendEvent('asnap', {
        ph: this.phase, pt: +this.phaseT.toFixed(2), mt: +this.matchT.toFixed(2), w: this.winner, f2: this.finalTwo,
        info: [...this.info.values()].map((i) => [i.slot, i.alive ? 1 : 0, Math.round(i.hp), i.kills, Math.round(i.dealt), Math.round(i.taken), i.place]),
      });
    }
  }

  /** Host: a car is out. */
  private eliminate(slot: number, killer: number, timeUp = false) {
    const i = this.info.get(slot);
    if (!i || !i.alive) return;
    const place = this.aliveSlots().length;
    i.alive = false;
    i.hp = 0;
    i.place = place;
    i.deathT = this.matchT;
    const k = this.info.get(killer);
    if (k && killer !== slot) k.kills++;
    this.room.sendEvent('aelim', { v: slot, k: timeUp ? -2 : killer, place });
    this.onEliminated(slot, timeUp ? -2 : killer, place);
  }

  /** Everyone: show an elimination (explosion for cars we don't simulate, feed, announcer). */
  private onEliminated(slot: number, killer: number, place: number) {
    const i = this.info.get(slot);
    if (i) { i.alive = false; i.place = place; i.hp = 0; if (i.deathT < 0) i.deathT = this.matchT; }
    if (!this.locals.has(slot)) {
      const rc = this.remotes.get(slot);
      if (rc) this.explodeFx(rc.visual, rc.pos.clone(), rc.vel.clone());
    }
    const text = killer === -2 ? `⏱ ${this.name(slot)} out on time` : killer >= 0 && killer !== slot ? `💥 ${this.name(killer)} wrecked ${this.name(slot)}` : `💥 ${this.name(slot)} is out`;
    this.addFeed(text);
    if (slot === this.self) { this.flash('ELIMINATED', 3, '#ff3b30'); this.sfx?.say('You have been eliminated!'); }
    else if (killer === this.self) { this.flash(`YOU WRECKED ${this.name(slot).toUpperCase()}!`, 2.5, '#ffcc00'); this.sfx?.say('Elimination!'); }
    else this.sfx?.say(`${this.name(slot)} is out!`, 1.15);
    this.excitement = Math.min(1, this.excitement + 0.5);
  }

  private standings(): ArenaStanding[] {
    const list = this.grid.map((g) => {
      const i = this.info.get(g.slot)!;
      return {
        slot: g.slot, name: g.nickname, color: g.color, number: g.number, cls: g.cls, bot: g.bot,
        place: i.alive ? 1 : i.place, kills: i.kills, dealt: Math.round(i.dealt), taken: Math.round(i.taken),
        survival: Math.round(i.deathT >= 0 ? i.deathT : this.matchT),
      };
    });
    return list.sort((a, b) => a.place - b.place);
  }

  private finish(standings: ArenaStanding[], winner: number) {
    if (this.phase === 'done') return;
    this.phase = 'done';
    const mine = standings.find((s) => s.slot === this.self);
    const me: MatchStats = {
      position: mine?.place ?? standings.length, cars: standings.length, eliminations: mine?.kills ?? 0,
      damageDealt: mine?.dealt ?? 0, damageTaken: this.me?.dmg.damageTaken ?? mine?.taken ?? 0,
      survival: mine?.survival ?? 0, won: winner === this.self,
    };
    setTimeout(() => { if (!this.disposed) this.cb.onResults({ standings, winner, me, events: this.eventIds.map((e) => EVENT_INFO[e as keyof typeof EVENT_INFO].name) }); }, 400);
  }

  // ====================================================================== effects for big moments
  private startCombatFx() {
    this.flash('FIGHT!', 1.6, '#ff3b30');
    this.sfx?.countdownBeep(true);
    this.sfx?.say('Fight!', 1.2);
    this.excitement = 0.8;
  }

  private finalTwoFx() {
    this.finalTwo = true;
    const [a, b] = this.aliveSlots();
    this.flash('FINAL TWO!', 3, '#ffcc00');
    this.addFeed(`⚔ FINAL TWO: ${this.name(a)} vs ${this.name(b)}`);
    this.sfx?.finalTwo();
    this.sfx?.say(`Final two! ${this.name(a)} versus ${this.name(b)}!`);
    this.excitement = 1;
  }

  private victoryFx(winner: number) {
    this.winner = winner;
    this.flash(winner === this.self ? 'VICTORY!' : winner >= 0 ? `${this.name(winner).toUpperCase()} WINS!` : 'NO SURVIVORS', 6, '#ffcc00');
    this.sfx?.victory();
    this.sfx?.say(winner === this.self ? 'Victory! You are the last one standing!' : winner >= 0 ? `${this.name(winner)} is the last one standing!` : 'No survivors!');
    this.excitement = 1;
  }

  private celebrateT = 0;
  /** Victory celebration: the winner's chosen effect if it's us, fireworks otherwise. */
  private victoryShow(dt: number) {
    this.celebrateT -= dt;
    if (this.celebrateT > 0 || this.winner < 0) return;
    this.celebrateT = 0.3;
    const p = this.posOf(this.winner);
    const kind = this.winner === this.self ? loadArenaProfile().victory : 'fireworks';
    if (kind === 'confetti') {
      for (let k = 0; k < 6; k++) this.effects.sparks(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 10, 8 + Math.random() * 6, (Math.random() - 0.5) * 10)), new THREE.Vector3(0, -2, 0), 14, 1.4);
    } else if (kind === 'inferno') {
      for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2 + this.time; this.effects.fire(p.clone().add(new THREE.Vector3(Math.cos(a) * 5, 0.3, Math.sin(a) * 5)), new THREE.Vector3(0, 3, 0), 1.2); }
    } else {
      const a = Math.random() * Math.PI * 2;
      this.effects.firework(new THREE.Vector3(Math.cos(a) * 40, 30 + Math.random() * 15, Math.sin(a) * 40));
    }
  }

  private explodeFx(v: CarVisual, p: THREE.Vector3, vel: THREE.Vector3) {
    this.effects.explosion(p, 1);
    this.effects.shards(p, vel, 50);
    charCar(v);
    this.debris.burst(p, vel.clone().multiplyScalar(0.5), v.primary, 12);
    for (const part of PART_NAMES) {
      if (part.startsWith('wheel') || Math.random() < 0.4) continue;
      const obj = v.parts[part];
      if (!obj || obj.userData.gone) continue;
      obj.userData.gone = true;
      this.debris.release(obj, new THREE.Vector3((Math.random() - 0.5) * 14, 6 + Math.random() * 10, (Math.random() - 0.5) * 14).add(vel.clone().multiplyScalar(0.5)), 8, 8);
    }
    const dist = this.r.camera.position.distanceTo(p);
    this.engine?.explosion(1 / (1 + dist / 50));
    this.rig.addShake(Math.min(1, 25 / (dist + 5)));
  }

  /** Shockwave from `slot`: visual for everyone, push + damage for the cars we simulate. */
  private shockwave(slot: number, p: THREE.Vector3) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.15, 8, 48), new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.9 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(p).setY(0.6);
    this.r.scene.add(ring);
    this.shockRings.push({ mesh: ring, t: 0 });
    this.effects.flash(p.clone().setY(1.5), 3, 0.25, 0x8fd8ff);
    this.effects.dust(p, new THREE.Vector3(), 0x9b7650);
    const dist = this.r.camera.position.distanceTo(p);
    if (dist < 120) this.sfx?.shockwave();
    this.rig.addShake(Math.min(0.8, 12 / (dist + 4)));
    for (const l of this.locals.values()) {
      if (l.slot === slot || !l.dmg.alive) continue;
      const d = l.car.position.distanceTo(p);
      if (d > SHOCK.radius) continue;
      const k = 1 - d / SHOCK.radius;
      const dir = l.car.position.clone().sub(p).setY(0).normalize();
      l.car.body.applyImpulse({ x: dir.x * SHOCK.impulse * k, y: 2500 * k, z: dir.z * SHOCK.impulse * k }, true);
      const lost = l.dmg.burn(SHOCK.damage * k * this.events.damageMult, slot, this.matchT);
      this.creditDamage(l.slot, slot, lost);
    }
  }

  // ====================================================================== abilities
  private useAbility(l: Local, id: AbilityId) {
    if (this.phase !== 'combat' || !l.dmg.alive || !l.ab.use(id)) return;
    const me = l.slot === this.self;
    if (id === 'repair') {
      l.dmg.repair(classById(this.entry(l.slot)?.cls).repairHp);
      this.effects.flash(l.car.position.clone().setY(1.5), 2, 0.4, 0x3ad17a);
      if (me) { this.sfx?.repair(); this.flash('REPAIRED', 1.2, '#3ad17a'); }
    } else if (id === 'shock') {
      const p = l.car.position.clone();
      this.room.sendEvent('ashock', { s: l.slot, p: p.toArray().map((x) => +x.toFixed(2)) });
      this.shockwave(l.slot, p);
    } else {
      this.room.sendEvent('aab', { s: l.slot, id });
      if (me && id === 'nitro') this.sfx?.nitro();
      if (me && id === 'ram') this.flash('REINFORCED RAM', 1.2, '#ffcc00');
    }
  }

  // ====================================================================== damage
  private pendingDmg = new Map<number, Record<number, number>>();

  /** Book damage `victim` took from `attacker` (host tallies; clients report in batches). */
  private creditDamage(victim: number, attacker: number, amount: number) {
    if (amount <= 0) return;
    const vi = this.info.get(victim);
    if (vi) vi.taken += amount;
    if (attacker < 0 || attacker === victim) return;
    if (this.isHost) { const a = this.info.get(attacker); if (a) a.dealt += amount; }
    else {
      const rec = this.pendingDmg.get(victim) ?? {};
      rec[attacker] = (rec[attacker] ?? 0) + amount;
      this.pendingDmg.set(victim, rec);
    }
  }

  private handleContacts(l: Local) {
    const car = l.car;
    const now = this.time;
    // closing speeds must use velocities from BEFORE the step: afterwards the collision is
    // already resolved and the cars are separating
    const vMe = car.preStepVel;
    for (const c of car.contacts()) {
      const surface = this.physics.surfaces.get(c.other.handle);
      if (surface === 'dirt' || surface === 'grass') continue; // the floor
      const other = this.colliderSlot.get(c.other.handle);
      const isCar = other !== undefined;
      if (!isCar && !surface) continue; // debris
      // sparks for any scraping contact
      if (c.slide > 3 && Math.random() < 0.5) this.effects.sparks(c.world, vMe, 3 + Math.min(10, c.slide * 0.3), 1);
      const key = `${l.slot}:${isCar ? other : 'w' + c.other.handle}`;
      if (now - (this.pairT.get(key) ?? -9) < PAIR_COOLDOWN) continue;
      const vOther = isCar ? (this.locals.get(other)?.car.preStepVel ?? this.velOf(other)) : new THREE.Vector3();
      const closing = vOther.clone().sub(vMe).dot(c.normalWorld);
      if (closing < 2.5) continue;
      this.pairT.set(key, now);
      const myZone = zoneOf(c.local);
      let otherFront = false, otherRam = 1, otherRamActive = false;
      if (isCar) {
        const inv = this.quatOf(other).invert();
        otherFront = zoneOf(c.world.clone().sub(this.posOf(other)).applyQuaternion(inv)) === 'front';
        otherRam = classById(this.entry(other)?.cls).ram;
        otherRamActive = (this.locals.get(other)?.ab.active.ram ?? 0) > 0 || (this.remoteRam.get(other) ?? 0) > now;
      }
      const raw = collisionDamage({
        closing, myMass: car.mass, otherMass: isCar ? this.massOf(other) : Infinity, myZone, otherFront, otherRam, otherRamActive,
        wall: !isCar, damageMult: this.events.damageMult,
      });
      if (this.phase !== 'combat') continue;
      const lost = l.dmg.hit(myZone, raw, isCar ? other : -1, this.matchT);
      if (isCar) this.creditDamage(l.slot, other, lost); else this.creditDamage(l.slot, -1, lost);
      // visible damage: dents and parts coming off scale with the hit
      const res = car.damage.impact(c.local, c.inwardLocal, 900 + raw * 55, isCar);
      if (res.dent > 0) dentCar(car.visual, c.local, c.inwardLocal, Math.min(0.2, res.dent * 1.4 + raw / 3000));
      for (const part of res.detached) {
        const obj = car.visual.parts[part];
        if (!obj || obj.userData.gone) continue;
        if (part.startsWith('wheel')) continue; // keep the wheels on: arena cars must keep fighting
        obj.userData.gone = true;
        this.debris.release(obj, vMe.clone().multiplyScalar(0.8).add(new THREE.Vector3((Math.random() - 0.5) * 6, 3, (Math.random() - 0.5) * 6)), 8, 6);
      }
      // feedback
      const strength = Math.min(1, raw / 250);
      if (raw > 60) this.effects.shards(c.world, vMe, Math.round(6 + strength * 20), Math.random() < 0.5 ? 0xcfe3ff : 0x333333);
      if (raw > 30) this.effects.sparks(c.world, vMe, 10 + strength * 30, 1.5);
      if (raw > 120) this.effects.dust(c.world, vMe, 0x9b7650);
      const camDist = this.r.camera.position.distanceTo(c.world);
      this.engine?.impact(strength / (1 + camDist / 30));
      if (l.slot === this.self) {
        this.rig.addShake(Math.min(1, strength * 1.2));
        this.hitDir = Math.atan2(c.local.x, c.local.z);
        this.hitUntil = this.time + 0.7;
      }
      if (isCar && raw > 150) this.excitement = Math.min(1, this.excitement + strength * 0.4);
      // ramming adds a shove: side hits spin you, rear hits push you on
      if (isCar && otherRamActive) car.body.applyImpulse({ x: c.normalWorld.x * car.mass * 2, y: 300, z: c.normalWorld.z * car.mass * 2 }, true);
    }
  }

  /** One of our cars is destroyed. */
  private ownedDestroyed(l: Local) {
    const killer = this.matchT - l.dmg.lastHitT < 8 ? l.dmg.lastAttacker : -1;
    l.car.damage.destroyed = true;
    l.car.damage.exploded = true;
    l.car.combat.push = 0;
    const lv = l.car.body.linvel();
    l.car.body.applyImpulse({ x: 0, y: 6000, z: 0 }, true);
    this.explodeFx(l.car.visual, l.car.position.clone(), new THREE.Vector3(lv.x, lv.y, lv.z));
    if (this.isHost) this.eliminate(l.slot, killer);
    else this.room.sendEvent('aelim', { v: l.slot, k: killer });
  }

  // ====================================================================== pickups
  private confirmPickup(id: number, slot: number) {
    if (!this.events.pickups.get(id) || this.events.pickups.get(id)!.taken) return;
    this.room.sendEvent('apick', { id, s: slot });
    this.applyPickup(id, slot);
  }
  private applyPickup(id: number, slot: number) {
    const pk = this.events.takePickup(id);
    if (!pk) return;
    const l = this.locals.get(slot);
    if (l) {
      if (pk.kind === 'repair') l.dmg.repair(PICKUP_REPAIR); else l.ab.refillNitro();
      if (slot === this.self) { this.sfx?.pickup(); this.flash(pk.kind === 'repair' ? 'REPAIR PICKUP' : 'NITRO READY', 1.4, pk.kind === 'repair' ? '#3ad17a' : '#34b6ff'); }
    }
    this.effects.flash(pk.pos.clone(), 2.5, 0.3, pk.kind === 'repair' ? 0x3ad17a : 0x34b6ff);
  }

  // ====================================================================== frame
  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (wasPressed('Escape') || wasPressed('KeyP')) this.setPaused(!this.paused);
    if (this.paused && this.room.offline) return;
    this.simulate(dt, true);
    this.r.render();
  };

  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    if (!p) this.last = performance.now();
    this.cb.onPause(p, { resume: () => this.setPaused(false), reset: () => { const l = this.me; if (l) this.unflip(l); this.setPaused(false); }, exit: () => this.exit() });
  }

  exit() {
    this.dispose();
    this.cb.onExit();
  }

  /** Dev/testing: advance the whole match without rendering. */
  devAdvance(seconds: number, input?: (s: ArenaSession) => DriverInput) {
    const g = window as unknown as { __arenaAuto?: (s: ArenaSession) => DriverInput };
    const prev = g.__arenaAuto;
    if (input) g.__arenaAuto = input;
    for (let t = 0; t < seconds; t += 1 / 60) this.simulate(1 / 60, false);
    g.__arenaAuto = prev;
  }

  private unflip(l: Local) {
    const p = l.car.position.clone();
    const r = Math.hypot(p.x, p.z);
    if (r > this.arena.radius - 4) p.multiplyScalar((this.arena.radius - 6) / r);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quatOf(l.slot));
    const yaw = Math.atan2(fwd.x, fwd.z);
    l.car.reset(p.setY(0.9), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  }

  private simulate(dt: number, interactive: boolean) {
    this.time += dt;
    const me = this.me;
    if (interactive && !this.paused) {
      if (wasPressed('KeyC')) { if (me && !me.dmg.alive) this.nextSpectate(); else this.rig.next(); }
      if (me && this.phase === 'combat') {
        const map: [AbilityId, string[]][] = [['nitro', ['ShiftLeft', 'ShiftRight', 'Digit1']], ['ram', ['KeyF', 'Digit2']], ['repair', ['KeyR', 'Digit3']], ['shock', ['KeyQ', 'Digit4']]];
        for (const [id, keys] of map) if (keys.some((k) => wasPressed(k))) this.useAbility(me, id);
        const pad = navigator.getGamepads?.().find((p) => p && p.connected);
        if (pad) {
          if (pad.buttons[0]?.pressed) this.useAbility(me, 'nitro');
          if (pad.buttons[4]?.pressed) this.useAbility(me, 'ram');
          if (pad.buttons[1]?.pressed) this.useAbility(me, 'repair');
          if (pad.buttons[5]?.pressed) this.useAbility(me, 'shock');
        }
      }
    }

    // ---------------- match control ----------------
    if (this.isHost) this.hostUpdate(dt);
    else if (this.phase !== 'done') { this.phaseT += dt; if (this.phase === 'combat') this.matchT += dt; }
    if (this.phase === 'countdown') {
      const left = Math.ceil(COUNTDOWN - 1 - this.phaseT);
      if (left !== this.cdSaid && left >= 1 && left <= 3) { this.cdSaid = left; this.sfx?.countdownBeep(false); this.sfx?.say(String(left), 1.2); }
    }
    const locked = this.phase !== 'combat';

    // ---------------- inputs, AI, abilities ----------------
    const combatants: Combatant[] = this.grid.map((g) => {
      const q = this.quatOf(g.slot);
      return { slot: g.slot, pos: this.posOf(g.slot), vel: this.velOf(g.slot), fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize(), hp: this.locals.get(g.slot)?.dmg.hp ?? this.info.get(g.slot)?.hp ?? 0, alive: this.alive(g.slot), human: !g.bot };
    });
    const auto = import.meta.env.DEV ? (window as unknown as { __arenaAuto?: (s: ArenaSession) => DriverInput }).__arenaAuto : undefined;
    for (const l of this.locals.values()) {
      l.dmg.update(dt);
      l.ab.update(dt);
      const alive = l.dmg.alive;
      if (l.ai) {
        const meC = combatants.find((c) => c.slot === l.slot)!;
        l.input = alive ? l.ai.drive(dt, meC, combatants.filter((c) => c.alive), l.dmg.hp, l.ab.repairsLeft, locked) : { steer: 0, throttle: 0, brake: 1, shiftUp: false, shiftDown: false };
        for (const id of l.ai.wants) this.useAbility(l, id);
      } else if (l.slot === this.self) {
        l.input = this.paused ? { steer: 0, throttle: 0, brake: 0.3, shiftUp: false, shiftDown: false } : auto ? auto(this) : interactive ? readDriverInput(dt, Math.abs(l.car.telemetry.speed)) : { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false };
      }
      // the car's systems follow the damage
      const hz = this.events.hazardAt(l.car.position, this.matchT);
      l.car.inputLocked = locked || !alive;
      l.car.manual = false;
      l.car.combat.power = alive ? l.dmg.power : 0;
      l.car.combat.steer = l.dmg.steer;
      l.car.combat.grip = l.dmg.grip * hz.grip;
      l.car.combat.push = l.ab.active.nitro > 0 && alive && !locked ? l.car.mass * NITRO_ACCEL : 0;
      l.dmg.ramActive = l.ab.active.ram > 0;
      if (hz.burn > 0 && alive && !locked) {
        const lost = l.dmg.burn(hz.burn * dt, -1, this.matchT);
        this.creditDamage(l.slot, -1, lost);
      }
      if (!locked && alive) {
        // pickups
        const pk = this.events.pickupNear(l.car.position);
        if (pk) { if (this.isHost) this.confirmPickup(pk.id, l.slot); else if (l.slot === this.self) this.room.sendEvent('apickreq', { id: pk.id, s: l.slot }); }
        // upside down or stuck on its side for a while: the marshals tip it back
        const q = this.quatOf(l.slot);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        l.flipT = up.y < 0.35 && Math.abs(l.car.telemetry.speed) < 3 ? l.flipT + dt : 0;
        if (l.flipT > 2.5) { l.flipT = 0; this.unflip(l); }
      }
    }
    if (!locked) this.events.updatePickups(this.matchT);

    // ---------------- physics ----------------
    const DT = PhysicsWorld.DT;
    this.acc += dt;
    let steps = 0;
    const nowS = performance.now() / 1000;
    while (this.acc >= DT && steps < 10) {
      for (const rc of this.remotes.values()) rc.sample(nowS);
      for (const l of this.locals.values()) l.car.step(l.input, DT);
      this.physics.step();
      for (const l of this.locals.values()) l.car.snapshot();
      for (const l of this.locals.values()) if (l.dmg.alive) this.handleContacts(l);
      for (const l of this.locals.values()) if (l.dmg.hp <= 0 && !l.car.damage.exploded) this.ownedDestroyed(l);
      this.acc -= DT;
      steps++;
    }
    if (steps === 10) this.acc = 0;

    // ---------------- visuals ----------------
    const alpha = this.acc / DT;
    for (const l of this.locals.values()) l.car.sync(alpha, dt);
    for (const rc of this.remotes.values()) rc.sync(dt);
    this.debris.update(dt, (p) => { if (Math.random() < 0.4) this.effects.fire(p, _v.set(0, 0, 0), 0.5); });
    for (const l of this.locals.values()) this.carFx(dt, l.slot, l.car.visual, l.car, l.dmg.smoke, l.dmg.alive ? (l.dmg.stage >= 4 ? 0.35 : 0) + (this.events.hazardAt(l.car.position, this.matchT).fire ? 0.6 : 0) : 0.8, l.ab.active.nitro > 0, l.ab.active.ram > 0);
    for (const [s, rc] of this.remotes) if (rc.latest) this.carFx(dt, s, rc.visual, null, rc.latest.smoke, rc.latest.fire, (this.remoteNitro.get(s) ?? 0) > this.time, (this.remoteRam.get(s) ?? 0) > this.time);
    this.events.update(dt, this.matchT, this.effects);
    if (this.phase === 'victory') this.victoryShow(dt);
    for (const sr of this.shockRings) {
      sr.t += dt;
      sr.mesh.scale.setScalar(1 + sr.t * 40);
      (sr.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - sr.t * 2.2);
    }
    this.shockRings = this.shockRings.filter((sr) => { if (sr.t > 0.45) { sr.mesh.removeFromParent(); sr.mesh.geometry.dispose(); return false; } return true; });

    // ---------------- network out ----------------
    this.sendT -= dt;
    if (this.sendT <= 0) { this.sendStates(); this.sendT = 0.05; }
    if (!this.isHost) {
      this.hpT -= dt;
      if (this.hpT <= 0 && me) {
        this.hpT = 0.25;
        this.room.sendEvent('ahp', { hp: Math.round(me.dmg.hp), taken: Math.round(me.dmg.damageTaken) });
        for (const [v, by] of this.pendingDmg) this.room.sendEvent('admg', { v, by });
        this.pendingDmg.clear();
      }
    }
    // our own cars' health is always ours to report
    for (const l of this.locals.values()) { const i = this.info.get(l.slot); if (i && i.alive) i.hp = l.dmg.hp; }

    // ---------------- camera, audio, hud ----------------
    this.updateCamera(dt, interactive);
    const lodDist = LOD_DISTANCE[settings.quality] ?? 70;
    const cam = this.r.camera.position;
    for (const l of this.locals.values()) updateLod(l.car.visual, cam.distanceTo(l.car.position), lodDist);
    for (const rc of this.remotes.values()) updateLod(rc.visual, cam.distanceTo(rc.pos), lodDist);
    this.r.followShadow(this.focusPoint());
    this.effects.update(dt, this.r.camera, this.r.renderer.domElement.clientHeight);
    this.excitement = Math.max(this.phase === 'combat' ? 0.25 : 0.1, this.excitement - dt * 0.12);
    this.arena.update(dt, this.excitement);
    this.sfx?.crowd(this.excitement);
    if (me && this.engine) {
      const tm = me.car.telemetry;
      this.engine.damage = 1 - me.dmg.engine;
      const dead = !me.dmg.alive;
      this.engine.update(dead ? 0 : tm.rpm, dead ? 0 : tm.throttle, tm.slip, tm.speed, tm.limiter);
    }
    this.scoreT -= dt;
    if (this.scoreT <= 0) { this.scoreT = 0.5; this.updateScoreboard(); }
    if (interactive) this.updateHud();
  }

  private sendStates() {
    const out: ArrayBuffer[] = [];
    for (const l of this.locals.values()) {
      const car = l.car;
      const t = car.body.translation(), q = car.body.rotation(), lv = car.body.linvel();
      out.push(encodeState({
        slot: l.slot,
        pos: [t.x, t.y, t.z], quat: [q.x, q.y, q.z, q.w], vel: [lv.x, lv.y, lv.z],
        steer: car.telemetry.steer, omega: (car.wheels[2].omega + car.wheels[3].omega) / 2,
        rpm: car.telemetry.rpm, throttle: car.telemetry.throttle, brake: car.telemetry.brake,
        flaps: false, destroyed: !l.dmg.alive, exploded: !l.dmg.alive, wiper: false,
        smoke: l.dmg.smoke, fire: !l.dmg.alive ? 0.8 : l.dmg.stage >= 4 ? 0.35 : 0,
        gone: PART_NAMES.filter((n) => car.damage.parts[n] === 'gone'),
        punctured: 0,
      }));
    }
    this.room.sendStates(out);
  }

  /** Smoke, fire, nitro flames, ram glow sparks, tyre smoke and skid marks for one car. */
  private carFx(dt: number, slot: number, v: CarVisual, car: Car | null, smoke: number, fire: number, nitro: boolean, ram: boolean) {
    const rate = (key: string, perSec: number, fn: () => void) => {
      const a = (this.emitAcc.get(key) ?? 0) + perSec * dt;
      let n = Math.floor(a);
      this.emitAcc.set(key, a - n);
      while (n-- > 0) fn();
    };
    const vel = car ? (() => { const lv = car.body.linvel(); return new THREE.Vector3(lv.x, lv.y, lv.z); })() : this.remotes.get(slot)?.vel.clone() ?? new THREE.Vector3();
    const bay = v.engineBay.clone().applyMatrix4(v.root.matrixWorld);
    if (smoke > 0.1) rate(`s${slot}`, 5 + smoke * 26, () => this.effects.smoke(bay, vel, smoke));
    if (fire > 0.05) rate(`f${slot}`, 10 + fire * 50, () => this.effects.fire(bay.clone().add(_v.set((Math.random() - 0.5), 0, (Math.random() - 0.5) * 2)), vel, 0.5 + fire));
    if (nitro) rate(`n${slot}`, 60, () => {
      const rear = _v.set((Math.random() - 0.5) * 0.6, 0.35, -2.7).applyMatrix4(v.root.matrixWorld).clone();
      this.effects.fire(rear, vel.clone().multiplyScalar(0.6), 0.9);
    });
    if (ram) rate(`r${slot}`, 20, () => {
      const front = _v.set((Math.random() - 0.5) * 2, 0.45, 2.9).applyMatrix4(v.root.matrixWorld).clone();
      this.effects.sparks(front, vel, 2, 1.2);
    });
    if (car) {
      car.wheels.forEach((w, i) => {
        const key = `${slot}w${i}`;
        if (!w.contact || Math.abs(car.telemetry.speed) < 3) { this.effects.skids.lift(key); return; }
        if (w.slip > 1.05 || w.locked) {
          this.effects.skids.add(key, w.point, _v.set(0, 1, 0), Math.min(1, w.slip - 0.8));
          rate(`t${key}`, 18 * Math.min(2, w.slip - 0.9), () => this.effects.tireSmoke(w.point, vel, Math.min(1.5, w.slip - 0.8), 0xb59a7a));
        } else this.effects.skids.lift(key);
      });
    }
  }

  private focusPoint() {
    const s = this.cameraTarget();
    return s >= 0 ? this.posOf(s) : new THREE.Vector3();
  }

  private cameraTarget(): number {
    if (this.phase === 'victory' || this.phase === 'done') return this.winner >= 0 ? this.winner : this.self;
    const me = this.me;
    if (me && !me.dmg.alive && this.time - (this.info.get(this.self)?.deathT ?? 0) > 0) {
      if (this.spectating < 0 || !this.alive(this.spectating)) this.nextSpectate();
      return this.spectating >= 0 ? this.spectating : this.self;
    }
    return this.self;
  }

  private nextSpectate() {
    const alive = this.aliveSlots().filter((s) => s !== this.self);
    if (!alive.length) { this.spectating = -1; return; }
    this.spectating = alive[(alive.indexOf(this.spectating) + 1) % alive.length];
  }

  private updateCamera(dt: number, interactive: boolean) {
    const cam = this.r.camera;
    if (this.phase === 'intro' || this.phase === 'loading') {
      // cinematic fly-around of the arena, ending behind the player's car
      const t = this.phaseT;
      const a = t * 0.35 + 0.6;
      const radius = 95 - t * 8, h = 34 - t * 4;
      cam.position.set(Math.cos(a) * radius, h, Math.sin(a) * radius);
      cam.lookAt(0, 2, 0);
      return;
    }
    if (this.phase === 'victory' || this.phase === 'done') {
      const p = this.focusPoint();
      const a = this.phaseT * 0.5;
      cam.position.set(p.x + Math.cos(a) * 9, p.y + 3.2, p.z + Math.sin(a) * 9);
      cam.lookAt(p.x, p.y + 0.8, p.z);
      return;
    }
    const target = this.visualOf(this.cameraTarget())?.root;
    if (!target) return;
    if (interactive) { const m = readMouseLook(); this.rig.mouseLook(m.held, m.dx, m.dy, dt); }
    this.rig.update(dt, target, this.locals.get(this.cameraTarget())?.car.telemetry.speed ?? this.remotes.get(this.cameraTarget())?.speed ?? 0);
  }

  private updateScoreboard() {
    const alive = this.aliveSlots().length;
    if (this.phase === 'intro') this.arena.scoreboard(['DEMOLITION', `${this.grid.length} VEHICLES`, this.eventIds.map((e) => EVENT_INFO[e as keyof typeof EVENT_INFO].name).join(' · ') || 'NO MODIFIERS']);
    else if (this.phase === 'countdown') this.arena.scoreboard([String(Math.max(1, Math.ceil(COUNTDOWN - 1 - this.phaseT))), 'GET READY'], '#ff3b30');
    else if (this.phase === 'victory' || this.phase === 'done') this.arena.scoreboard(['WINNER', this.winner >= 0 ? this.name(this.winner).toUpperCase() : 'NOBODY'], '#ffcc00');
    else {
      const m = Math.floor(this.matchT / 60), s = Math.floor(this.matchT % 60);
      const top = [...this.info.values()].sort((a, b) => b.kills - a.kills)[0];
      this.arena.scoreboard([this.finalTwo ? 'FINAL TWO' : `${alive} LEFT`, `${m}:${String(s).padStart(2, '0')}${this.events.suddenActive(this.matchT) ? ' · SUDDEN DEATH' : ''}`, top && top.kills ? `TOP: ${this.name(top.slot)} ${top.kills} KO` : ''], this.finalTwo ? '#ffcc00' : '#ff3b30');
    }
  }

  private updateHud() {
    const me = this.me;
    const alive = this.aliveSlots();
    const myInfo = this.info.get(this.self);
    // position: survivors ranked by health; the eliminated keep their finishing place
    const pos = myInfo && !myInfo.alive ? myInfo.place : 1 + alive.filter((s) => s !== this.self && (this.info.get(s)?.hp ?? 0) > (me?.dmg.hp ?? 0)).length;
    let countdown = '';
    if (this.phase === 'countdown') { const left = COUNTDOWN - 1 - this.phaseT; countdown = left > 0 ? String(Math.ceil(left)) : 'FIGHT!'; }
    // incoming car warning: someone closing fast within 25 m
    let incoming: number | null = null;
    if (me && me.dmg.alive && this.phase === 'combat') {
      const mp = me.car.position, mv = this.velOf(this.self);
      const inv = this.quatOf(this.self).invert();
      for (const s of alive) {
        if (s === this.self) continue;
        const rel = mp.clone().sub(this.posOf(s));
        const d = rel.length();
        if (d > 25) continue;
        const closing = this.velOf(s).sub(mv).dot(rel.normalize());
        if (closing > 9 && d / closing < 1.6) {
          const l = this.posOf(s).sub(mp).applyQuaternion(inv);
          incoming = Math.atan2(l.x, l.z);
          break;
        }
      }
    }
    const dmg = me?.dmg;
    const armor = { front: 1, rear: 1, left: 1, right: 1 } as Record<Zone, number>;
    if (dmg) for (const z of Object.keys(armor) as Zone[]) armor[z] = dmg.armorCond[z];
    let status = '';
    if (me && !me.dmg.alive && this.phase === 'combat') status = this.spectating >= 0 ? `SPECTATING ${this.name(this.spectating).toUpperCase()} (C: next)` : 'ELIMINATED';
    else if (this.phase === 'intro') status = `${this.grid.length} vehicles · last one standing wins`;
    else if (this.phase === 'combat' && this.events.suddenActive(this.matchT) && me && Math.hypot(me.car.position.x, me.car.position.z) > this.events.safeRadius(this.matchT)) status = 'OUTSIDE THE SAFE ZONE!';
    this.hud.update({
      timer: this.cfg.timeLimit > 0 ? Math.max(0, this.cfg.timeLimit - this.matchT) : this.matchT,
      alive: alive.length,
      total: this.grid.length,
      position: pos,
      kills: myInfo?.kills ?? 0,
      hp: dmg?.hp ?? 0,
      stage: dmg?.stage ?? 5,
      engine: dmg?.engine ?? 0,
      armor,
      speed: me?.car.telemetry.speed ?? 0,
      abilities: ABILITIES.map((id) => ({ id, progress: me ? me.ab.progress(id) : 0, active: (me?.ab.active[id] ?? 0) > 0, uses: id === 'repair' ? me?.ab.repairsLeft : undefined })),
      countdown,
      banner: this.time < this.bannerUntil ? this.banner : '',
      bannerColor: this.bannerColor,
      feed: this.feed.filter((f) => this.time - f.t < 8).map((f) => f.text),
      lowHealth: !!dmg && dmg.alive && dmg.hp < 300,
      criticalEngine: !!dmg && dmg.overheating,
      hitDir: this.time < this.hitUntil ? this.hitDir : null,
      incoming,
      status,
      modifiers: this.eventIds.map((e) => EVENT_INFO[e as keyof typeof EVENT_INFO].name),
    });
  }

  // ====================================================================== cleanup
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.engine?.dispose();
    this.sfx?.dispose();
    this.hud.show(false);
    if (this.arena) this.r.scene.remove(this.arena.group);
    this.r.scene.remove(this.effects.group, this.events?.group ?? new THREE.Group());
    for (const l of this.locals.values()) this.r.scene.remove(l.car.visual.root);
    for (const rc of this.remotes.values()) this.r.scene.remove(rc.visual.root);
    for (const sr of this.shockRings) sr.mesh.removeFromParent();
    this.debris?.dispose();
    this.physics?.world.free();
  }
}

