import * as THREE from 'three';
import { Renderer } from '../render/renderer';
import { PhysicsWorld, initPhysics, RAPIER, RAY_TRACK_ONLY } from '../physics/world';
import { Car, type CarContact } from '../vehicle/car';
import { RemoteCar } from '../vehicle/remoteCar';
import { BotDriver, type Traffic } from '../vehicle/bot';
import { CameraRig, CAM_LABEL } from '../render/cameras';
import { Effects } from '../render/effects';
import { Debris } from '../damage/debris';
import { dentCar, charCar } from '../damage/visual';
import { Hud, type TowerRow } from '../ui/hud';
import { EngineAudio } from '../audio/engine';
import { LapProgress } from './progress';
import { readDriverInput, wasPressed, clearPressed, resetHeld, readMouseLook, RESET_HOLD, type DriverInput } from './input';
import { settings } from './profile';
import { encodeState, decodeState } from '../net/codec';
import { RaceDirector, type RaceSnapshot, type ResultRow } from '../race/race';
import { PART_NAMES, type PartName, type CarVisual } from '../vehicle/carModel';
import type { LoadedMap, MapDef } from '../tracks/maps';
import type { Room, RoomSettings } from '../net/room';

export interface GridEntry {
  slot: number;
  nickname: string;
  number: number;
  color: string;
  bot: boolean;
}

export interface SessionCallbacks {
  onPause: (paused: boolean, api: { resume(): void; reset(): void; exit(): void }) => void;
  onResults: (rows: ResultRow[], grid: GridEntry[]) => void;
  onExit: () => void;
}

interface BotEntry { car: Car; ai: BotDriver; input: DriverInput; penalty: number }
interface DentMsg { l: number[]; d: number[]; m: number }

const ENGINE_BAY = new THREE.Vector3(0, 0.85, 1.7);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** One race (or free practice) on one map, for every kind of participant. */
export class Session {
  physics!: PhysicsWorld;
  map!: LoadedMap;
  /** The local player's car. */
  car!: Car;
  progress!: LapProgress;
  time = 0;
  private bots = new Map<number, BotEntry>();
  private remotes = new Map<number, RemoteCar>();
  private carColliders = new Set<number>();
  private director: RaceDirector | null = null;
  private race: RaceSnapshot = { phase: 'loading', flag: 'none', cd: 0, laps: 0, leaderLap: 0, st: [] };
  private rig!: CameraRig;
  private hud: Hud;
  private effects = new Effects();
  private debris!: Debris;
  private audio: EngineAudio | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private paused = false;
  private debug = false;
  private fps = 0;
  private physMs = 0;
  private banner = '';
  private bannerColor = '';
  private bannerUntil = 0;
  private disposed = false;
  private loaded = new Set<number>();
  private started = false;
  private sendT = 0;
  private raceSendT = 0;
  private dentT = 0;
  private dentQueue = new Map<number, DentMsg[]>();
  private penalty = 0;
  private resetHold = 0;
  private spectating = -1;
  private destroyedAt = -1;
  private scrapeLevel = 0;
  private spotter = '';
  private spotterUntil = 0;
  private wasAlongside = false;
  private fireworksT = 0;
  private resultsSent = false;
  private emitAcc = new Map<string, number>();
  private readonly isHost: boolean;
  private readonly self: number;

  constructor(
    private r: Renderer,
    hudRoot: HTMLElement,
    private room: Room,
    private mapDef: MapDef,
    private cfg: RoomSettings,
    readonly grid: GridEntry[],
    private cb: SessionCallbacks,
  ) {
    this.hud = new Hud(hudRoot);
    this.hud.show(false);
    this.isHost = room.isHost;
    this.self = room.selfSlot;
  }

  // ====================================================================== setup
  async load(onProgress: (msg: string) => void) {
    onProgress('Starting physics…');
    await initPhysics();
    onProgress(`Building ${this.mapDef.name}…`);
    await new Promise((res) => setTimeout(res, 30));
    this.map = await this.mapDef.load({ rain: this.cfg.weather === 'rain' && !!this.mapDef.weather });
    onProgress('Rolling cars onto the grid…');
    this.physics = new PhysicsWorld();
    this.physics.addTrack(this.map.colliders, this.map.groundY ?? -0.03);
    this.debris = new Debris(this.physics);
    this.r.scene.add(this.map.group, this.effects.group, this.debris.group);
    this.r.applyAtmosphere(this.map.atmosphere);
    this.r.setQuality(settings.quality);
    this.effects.setRain(this.map.rain);

    const tr = this.map.track;
    const order = this.grid.map((g) => g.slot);
    const gridPos = (slot: number) => this.map.gridSlot(Math.max(0, order.indexOf(slot)));
    for (const g of this.grid) {
      const gp = gridPos(g.slot);
      const pl = tr.placement(gp.i, gp.d, 0.62);
      const opts = { number: g.number, color: g.color, seed: g.number + g.slot * 7 };
      if (g.slot === this.self) {
        this.car = this.makeCar(opts, pl.pos, pl.quat);
      } else if (g.bot && this.isHost) {
        const car = this.makeCar(opts, pl.pos, pl.quat);
        const skill = 0.9 + ((g.slot * 37) % 10) / 100;
        this.bots.set(g.slot, { car, ai: new BotDriver(car, tr, skill, this.map.oval, g.slot), input: { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false }, penalty: 0 });
      } else {
        const rc = new RemoteCar(this.physics, g.slot, opts, pl.pos, pl.quat);
        this.remotes.set(g.slot, rc);
        this.carColliders.add(rc.collider.handle);
        this.r.scene.add(rc.visual.root);
      }
    }
    this.applyAssists();
    this.progress = new LapProgress(tr);
    this.progress.reset(gridPos(this.self).i, 0);

    if (this.isHost) {
      const entrants = this.grid.map((g) => ({
        slot: g.slot,
        pos: () => this.posOf(g.slot),
        speed: () => this.speedOf(g.slot),
        destroyed: () => this.destroyedOf(g.slot),
      }));
      this.director = new RaceDirector(tr, this.cfg.laps, entrants, (slot) => gridPos(slot).i, this.map.paceSpeed);
    }

    this.rig = new CameraRig(this.r.camera, this.map.tvCams);
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    this.rig.occlusion = (from, dir, max) => {
      ray.origin = { x: from.x, y: from.y, z: from.z };
      ray.dir = { x: dir.x, y: dir.y, z: dir.z };
      const hit = this.physics.world.castRay(ray, max, true, undefined, RAY_TRACK_ONLY);
      return hit ? hit.timeOfImpact : Infinity;
    };
    this.hud.setTrack(tr);
    this.hud.show(true);
    try {
      this.audio = new EngineAudio(settings.volume);
      this.audio.resume();
    } catch {
      this.audio = null;
    }
    clearPressed();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);

    this.loaded.add(this.self);
    if (this.isHost) {
      if (this.room.offline || this.grid.filter((g) => !g.bot).length === 1) this.begin();
      else setTimeout(() => this.begin(), 25000); // don't wait forever for a slow loader
    } else {
      this.room.sendEvent('loaded', {});
    }
  }

  private makeCar(opts: { number: number; color: string; seed: number }, pos: THREE.Vector3, quat: THREE.Quaternion) {
    const car = new Car(this.physics, opts, pos, quat, this.cfg.damage);
    car.gripScale = this.map.gripScale;
    car.wiperOn = this.map.rain;
    this.carColliders.add(car.collider.handle);
    this.r.scene.add(car.visual.root);
    return car;
  }

  private begin() {
    if (this.started || !this.director) return;
    this.started = true;
    this.director.start();
    this.flash(this.cfg.laps ? `${this.cfg.laps} LAPS — GET READY` : 'FREE PRACTICE', 3);
  }

  applyAssists() {
    if (!this.car) return;
    this.car.manual = settings.manualGears;
    this.car.tractionControl = settings.tractionControl;
    this.car.abs = settings.abs;
    this.audio?.setVolume(settings.volume);
  }

  // ====================================================================== queries
  private carOf(slot: number): Car | null {
    if (slot === this.self) return this.car;
    return this.bots.get(slot)?.car ?? null;
  }
  private posOf(slot: number): THREE.Vector3 {
    const c = this.carOf(slot);
    if (c) return c.position.clone();
    return this.remotes.get(slot)?.pos.clone() ?? new THREE.Vector3();
  }
  private speedOf(slot: number): number {
    const c = this.carOf(slot);
    if (c) return Math.abs(c.telemetry.speed);
    return this.remotes.get(slot)?.speed ?? 0;
  }
  private destroyedOf(slot: number): boolean {
    const c = this.carOf(slot);
    if (c) return c.damage.destroyed || c.damage.engineWear >= 1;
    return !!this.remotes.get(slot)?.latest?.destroyed;
  }
  private visualOf(slot: number): CarVisual | null {
    return this.carOf(slot)?.visual ?? this.remotes.get(slot)?.visual ?? null;
  }
  private entry(slot: number) {
    return this.grid.find((g) => g.slot === slot);
  }

  // ====================================================================== network in
  handleEvent(type: string, p: any, from: number) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!this.map) return;
    switch (type) {
      case 'loaded':
        this.loaded.add(from);
        if (this.isHost && this.grid.filter((g) => !g.bot).every((g) => this.loaded.has(g.slot))) this.begin();
        break;
      case 'race':
        if (!this.isHost) this.applyRace(p as RaceSnapshot);
        break;
      case 'results':
        if (!this.isHost) this.cb.onResults(p.rows as ResultRow[], this.grid);
        break;
      case 'dents': {
        const rc = this.remotes.get(p.s);
        if (!rc) break;
        for (const d of p.list as DentMsg[]) dentCar(rc.visual, _v.fromArray(d.l).clone(), _w.fromArray(d.d).clone(), d.m);
        break;
      }
      case 'detach': {
        const rc = this.remotes.get(p.s);
        if (!rc || rc.goneApplied.has(p.part)) break;
        rc.goneApplied.add(p.part);
        this.releasePart(rc.visual, p.part, new THREE.Vector3().fromArray(p.v));
        break;
      }
      case 'boom': {
        const rc = this.remotes.get(p.s);
        if (rc) { this.explosionFx(p.s, rc.visual, new THREE.Vector3().fromArray(p.p), rc.vel.clone(), new Set(rc.goneApplied)); rc.char(); }
        break;
      }
      case 'respawn': {
        const old = this.remotes.get(p.s);
        const g = this.entry(p.s);
        if (!old || !g) break;
        this.carColliders.delete(old.collider.handle);
        old.dispose(this.r.scene);
        const rc = new RemoteCar(this.physics, p.s, { number: g.number, color: g.color, seed: g.number + g.slot * 7 }, old.pos, old.quat);
        this.remotes.set(p.s, rc);
        this.carColliders.add(rc.collider.handle);
        this.r.scene.add(rc.visual.root);
        break;
      }
      case 'left': {
        const rc = this.remotes.get(p.slot);
        if (rc) {
          this.carColliders.delete(rc.collider.handle);
          rc.dispose(this.r.scene);
          this.remotes.delete(p.slot);
        }
        this.director?.removeEntrant(p.slot);
        const g = this.entry(p.slot);
        if (g) this.flash(`${g.nickname} DISCONNECTED`, 2.5);
        break;
      }
    }
  }

  handleState(buf: ArrayBuffer) {
    const s = decodeState(buf);
    if (!s || s.slot === this.self || this.bots.has(s.slot)) return;
    this.remotes.get(s.slot)?.push(s, performance.now() / 1000);
  }

  private applyRace(s: RaceSnapshot) {
    const prev = this.race;
    this.race = s;
    if (s.msg) this.flash(s.msg, 3, s.flag === 'yellow' ? '#facc15' : s.flag === 'green' ? '#3ad17a' : '');
    if (prev.flag !== s.flag && s.flag === 'white') this.flash('WHITE FLAG — FINAL LAP', 2.5, '#ffffff');
    if (prev.flag !== s.flag && s.flag === 'checkered') this.flash('CHECKERED FLAG!', 3);
  }

  // ====================================================================== pause / exit
  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    // online races keep simulating while paused so nobody falls off the shared timeline
    if (p && this.room.offline) this.audio?.suspend();
    else if (!p) { this.audio?.resume(); this.last = performance.now(); }
    this.cb.onPause(p, { resume: () => this.setPaused(false), reset: () => { this.requestReset(); this.setPaused(false); }, exit: () => this.exit() });
  }

  exit() {
    this.dispose();
    this.cb.onExit();
  }

  private flash(text: string, secs: number, color = '') {
    this.banner = text;
    this.bannerColor = color;
    this.bannerUntil = this.time + secs;
  }

  // ====================================================================== resets
  private requestReset() {
    const practice = this.cfg.laps === 0;
    if (this.car.damage.destroyed) {
      if (practice) this.respawnLocal();
      return;
    }
    const racing = this.race.phase === 'green' || this.race.phase === 'caution';
    this.resetCar(this.car, this.progress);
    if (racing && !practice) {
      this.penalty = 5;
      this.flash('RESET — 5 SECOND PENALTY', 2, '#facc15');
    } else this.flash('RESET', 1.2);
  }

  private resetCar(car: Car, lp: LapProgress | null, slot = this.self) {
    const tr = this.map.track;
    const i = tr.nearest(car.position, lp?.index ?? -1, 120);
    const d = THREE.MathUtils.clamp(tr.lateral(car.position, i), 3, tr.width - 3);
    const pl = tr.placement(i, d, 0.62);
    car.reset(pl.pos, pl.quat);
    this.director?.noteReset(slot, i);
  }

  private respawnLocal() {
    const old = this.car;
    const tr = this.map.track;
    const i = tr.nearest(old.position, this.progress.index, 120);
    const pl = tr.placement(i, tr.width * 0.4, 0.62);
    this.carColliders.delete(old.collider.handle);
    this.physics.world.removeRigidBody(old.body);
    this.r.scene.remove(old.visual.root);
    const g = this.entry(this.self)!;
    this.car = this.makeCar({ number: g.number, color: g.color, seed: g.number + g.slot * 7 }, pl.pos, pl.quat);
    this.applyAssists();
    this.spectating = -1;
    this.destroyedAt = -1;
    this.room.sendEvent('respawn', { s: this.self });
    this.flash('NEW CAR', 1.5);
  }

  // ====================================================================== damage handling
  private handleContacts(slot: number, car: Car, contacts: CarContact[]) {
    const vel = car.body.linvel();
    const v = new THREE.Vector3(vel.x, vel.y, vel.z);
    const camDist = this.r.camera.position.distanceTo(car.position);
    // sparks / scrape sound from sliding contacts
    for (const c of contacts) {
      if (c.slide > 3 && (c.impulse > 25 || this.carColliders.has(c.other.handle) || this.physics.surfaces.get(c.other.handle) === 'wall')) {
        if (Math.random() < 0.6) this.effects.sparks(c.world, v, 3 + Math.min(10, c.slide * 0.3), 1);
        if (slot === this.self) this.scrapeLevel = Math.max(this.scrapeLevel, Math.min(1, c.slide / 25));
      }
    }
    // impact strength from the velocity change the collision caused
    const Jw = car.collisionImpulse(PhysicsWorld.DT);
    const J = Jw.length();
    if (J < 200) return;
    const r = car.body.rotation();
    const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const inv = rot.clone().invert();
    const inwardLocal = Jw.clone().normalize().applyQuaternion(inv);
    // where: the contact closest to the impulse direction, else the hull point facing the hit
    let local: THREE.Vector3;
    let carHit = false;
    let world: THREE.Vector3;
    const hits = contacts.filter((c) => c.other.handle !== undefined);
    if (hits.length) {
      const best = hits.reduce((a, b) => (b.inwardLocal.dot(inwardLocal) > a.inwardLocal.dot(inwardLocal) ? b : a));
      local = best.local.clone();
      world = best.world.clone();
      carHit = this.carColliders.has(best.other.handle);
    } else {
      const d = inwardLocal.clone().negate();
      const k = 1 / Math.max(Math.abs(d.x) / 0.98, Math.abs(d.y) / 0.6, Math.abs(d.z) / 2.6);
      local = d.multiplyScalar(k);
      world = local.clone().applyQuaternion(rot).add(car.position);
    }
    for (const c of [{ local, inwardLocal, world, impulse: J }]) {
      const res = car.damage.impact(c.local, c.inwardLocal, c.impulse, carHit);
      if (res.severity <= 0) continue;
      if (res.dent > 0) {
        dentCar(car.visual, c.local, c.inwardLocal, res.dent);
        const q = this.dentQueue.get(slot) ?? [];
        q.push({ l: c.local.toArray().map((x) => +x.toFixed(2)), d: c.inwardLocal.toArray().map((x) => +x.toFixed(2)), m: +res.dent.toFixed(3) });
        this.dentQueue.set(slot, q);
      }
      this.audio?.impact(Math.min(1, res.severity * 1.5) / (1 + camDist / 25));
      if (slot === this.self) this.rig.addShake(Math.min(1, res.severity * 1.2));
      if (res.severity > 0.35) this.effects.shards(c.world, v, Math.round(10 + res.severity * 25), Math.random() < 0.5 ? 0xcfe3ff : 0x222222);
      if (res.severity > 0.15) this.effects.dust(c.world, v, 0x9a9a9a);
      for (const part of res.detached) this.detachOwned(slot, car, part);
      for (const w of res.punctured) {
        car.visual.wheels[w].children[0]?.scale.set(1, 0.93, 0.93);
        if (slot === this.self) this.flash('PUNCTURE!', 1.5, '#ff6b6b');
      }
      if (res.explode) car.pendingExplode = true;
    }
  }

  private detachOwned(slot: number, car: Car, part: PartName) {
    const obj = car.visual.parts[part];
    if (!obj || obj.userData.gone) return;
    if (part.startsWith('wheel')) car.loseWheel(Number(part.slice(5)));
    const lv = car.body.linvel();
    const v = new THREE.Vector3(lv.x, lv.y, lv.z).multiplyScalar(0.85).add(new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6));
    this.releasePart(car.visual, part, v);
    this.room.sendEvent('detach', { s: slot, part, v: v.toArray().map((x) => +x.toFixed(2)) });
    if (slot === this.self) this.flash(part.startsWith('wheel') ? 'LOST A WHEEL!' : `${part.replace(/[LRF]$/, '').toUpperCase()} GONE`, 1.5, '#ff6b6b');
  }

  private releasePart(v: CarVisual, part: PartName, vel: THREE.Vector3) {
    const obj = v.parts[part];
    if (!obj || obj.userData.gone) return;
    obj.userData.gone = true;
    if (part === 'hood') v.body.getObjectByName('hoodDecal')?.removeFromParent();
    const mass = part.startsWith('wheel') ? 25 : part === 'hood' ? 10 : 6;
    this.debris.release(obj, vel, 8, mass);
  }

  private explodeOwned(slot: number, car: Car) {
    if (car.damage.exploded) return;
    const gone = new Set<PartName>(PART_NAMES.filter((n) => car.damage.parts[n] === 'gone'));
    car.explode();
    const p = car.position.clone();
    const lv = car.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    // bolt-on parts and about half the wheels fly off
    for (const part of PART_NAMES) {
      if (gone.has(part)) continue;
      if (part.startsWith('wheel')) {
        if (Math.random() < 0.5) continue;
        car.loseWheel(Number(part.slice(5)));
      }
      car.damage.parts[part] = 'gone';
    }
    this.explosionFx(slot, car.visual, p, vel, gone);
    this.room.sendEvent('boom', { s: slot, p: p.toArray().map((x) => +x.toFixed(2)) });
    if (slot === this.self) this.flash('YOUR CAR EXPLODED', 3, '#ff3b30');
  }

  /** Visuals + area damage for an explosion (local or remote car). */
  private explosionFx(slot: number, v: CarVisual, p: THREE.Vector3, vel: THREE.Vector3, alreadyGone: Set<PartName>) {
    this.effects.explosion(p, 1);
    this.effects.shards(p, vel, 60);
    charCar(v);
    const own = this.carOf(slot);
    for (const part of PART_NAMES) {
      if (alreadyGone.has(part)) continue;
      // for our own cars, wheels only go if the explosion actually took them
      if (own && part.startsWith('wheel') && !own.wheelGone[Number(part.slice(5))]) continue;
      if (!own && part.startsWith('wheel') && Math.random() < 0.5) continue;
      const out = new THREE.Vector3((Math.random() - 0.5) * 18, 8 + Math.random() * 14, (Math.random() - 0.5) * 18).add(vel.clone().multiplyScalar(0.6));
      this.releasePart(v, part, out);
      this.remotes.get(slot)?.goneApplied.add(part);
    }
    this.debris.burst(p, vel.clone().multiplyScalar(0.5), v.primary, 14);
    const dist = this.r.camera.position.distanceTo(p);
    this.audio?.explosion(1 / (1 + dist / 60));
    this.rig.addShake(Math.min(1, 30 / (dist + 5)));
    // the blast shoves and damages nearby cars that we simulate
    const blast = (c: Car, s: number) => {
      if (s === slot || c.damage.exploded) return;
      const d = c.position.distanceTo(p);
      if (d > 9) return;
      const k = 1 - d / 9;
      const dir = c.position.clone().sub(p).normalize();
      c.body.applyImpulse({ x: dir.x * 7000 * k, y: 4000 * k, z: dir.z * 7000 * k }, true);
      const r = c.body.rotation();
      const inv = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
      const local = p.clone().sub(c.position).applyQuaternion(inv).setLength(1.2);
      const inward = dir.clone().negate().applyQuaternion(inv);
      const res = c.damage.impact(local, inward, 5500 * k, false);
      if (res.dent) dentCar(c.visual, local, inward, res.dent);
      for (const part of res.detached) this.detachOwned(s, c, part);
      if (res.explode) c.pendingExplode = true;
    };
    blast(this.car, this.self);
    for (const [s, b] of this.bots) blast(b.car, s);
  }

  // ====================================================================== effects per car
  private carEffects(dt: number, slot: number, v: CarVisual, speed: number, vel: THREE.Vector3, smoke: number, fire: number, wheels?: Car['wheels'], gone?: boolean[]) {
    const bay = ENGINE_BAY.clone().applyMatrix4(v.root.matrixWorld);
    const rate = (key: string, perSec: number, fn: () => void) => {
      const a = (this.emitAcc.get(key) ?? 0) + perSec * dt;
      let n = Math.floor(a);
      this.emitAcc.set(key, a - n);
      while (n-- > 0) fn();
    };
    if (smoke > 0.15) rate(`s${slot}`, 6 + smoke * 30, () => this.effects.smoke(bay, vel, smoke));
    if (fire > 0.01) {
      rate(`f${slot}`, 20 + fire * 70, () => this.effects.fire(bay.clone().add(_v.set((Math.random() - 0.5) * 1.4, 0, (Math.random() - 0.5) * 3 * fire)), vel, 0.6 + fire));
      rate(`fs${slot}`, 8 + fire * 12, () => this.effects.smoke(bay.clone().add(_v.set(0, 1, 0)), vel, 1));
    }
    if (wheels) {
      wheels.forEach((w, i) => {
        if (gone?.[i]) return;
        const key = `${slot}w${i}`;
        if (!w.contact || speed < 4) { this.effects.skids.lift(key); return; }
        const sliding = w.slip > 1.05 || w.locked;
        if (sliding && (w.surface === 'asphalt' || w.surface === 'concrete' || w.surface === 'curb')) {
          this.effects.skids.add(key, w.point, _v.set(0, 1, 0), Math.min(1, w.slip - 0.8));
          if (!this.map.rain) rate(`t${key}`, 25 * Math.min(2, w.slip - 0.9), () => this.effects.tireSmoke(w.point, vel, Math.min(1.5, w.slip - 0.8)));
        } else this.effects.skids.lift(key);
        if ((w.surface === 'grass' || w.surface === 'gravel' || w.surface === 'sand') && speed > 6) {
          rate(`d${key}`, Math.min(40, speed), () => this.effects.dust(w.point, vel, w.surface === 'grass' ? 0x6f7c4e : 0xb8a684));
        }
      });
    }
    if (this.map.rain && speed > 15) {
      rate(`r${slot}`, Math.min(60, speed * 0.8), () => {
        const rear = _v.set((Math.random() - 0.5) * 1.6, 0.2, -2.4).applyMatrix4(v.root.matrixWorld).clone();
        this.effects.spray(rear, vel, speed);
      });
    }
  }

  // ====================================================================== state out
  private sendStates() {
    const pack = (slot: number, car: Car) => {
      const t = car.body.translation(), r = car.body.rotation(), lv = car.body.linvel();
      this.room.sendState(encodeState({
        slot,
        pos: [t.x, t.y, t.z], quat: [r.x, r.y, r.z, r.w], vel: [lv.x, lv.y, lv.z],
        steer: car.telemetry.steer,
        omega: (car.wheels[2].omega + car.wheels[3].omega) / 2,
        rpm: car.telemetry.rpm,
        throttle: car.telemetry.throttle,
        brake: car.telemetry.brake,
        flaps: car.flapsOpen,
        destroyed: car.damage.destroyed || car.damage.engineWear >= 1,
        exploded: car.damage.exploded,
        wiper: car.wiperOn,
        smoke: car.damage.smoke,
        fire: car.damage.fire,
        gone: PART_NAMES.filter((n) => car.damage.parts[n] === 'gone'),
        punctured: car.damage.punctured.reduce((m, p, i) => m | (p ? 1 << i : 0), 0),
      }));
    };
    pack(this.self, this.car);
    for (const [s, b] of this.bots) pack(s, b.car);
  }

  // ====================================================================== frame
  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
    const nowS = now / 1000;

    if (wasPressed('Escape') || wasPressed('KeyP')) this.setPaused(!this.paused);
    if (this.paused && this.room.offline) return;
    this.simulate(dt, nowS, true);
    this.r.render();
  };

  /** Dev/testing: advance the whole session (bots, race control, damage) without rendering. */
  devAdvance(seconds: number, input?: (s: Session) => DriverInput) {
    const g = window as unknown as { __auto?: (s: Session) => DriverInput };
    const prev = g.__auto;
    if (input) g.__auto = input;
    let now = performance.now() / 1000;
    for (let t = 0; t < seconds; t += 1 / 60) { now += 1 / 60; this.simulate(1 / 60, now, false); }
    g.__auto = prev;
  }

  private simulate(dt: number, nowS: number, interactive: boolean) {
    if (interactive) {
    if (!this.paused) {
      if (wasPressed('KeyC')) {
        if (this.spectating >= 0) this.nextSpectate();
        else this.rig.next();
      }
      wasPressed('KeyR'); // a tap does nothing: reset needs a hold
      if (resetHeld()) {
        this.resetHold += dt;
        if (this.resetHold >= RESET_HOLD) {
          this.requestReset();
          this.resetHold = -Infinity; // release R before it can fire again
        }
      } else this.resetHold = 0;
      if (wasPressed('F3') || wasPressed('Backquote')) this.debug = !this.debug;
      if (wasPressed('KeyM')) { settings.manualGears = !settings.manualGears; this.applyAssists(); this.flash(settings.manualGears ? 'MANUAL GEARS (Q/E)' : 'AUTOMATIC GEARS', 1.5); }
    }
    }

    // ---------------- race control ----------------
    if (this.director) {
      this.director.update(dt);
      const snap = this.director.snapshot();
      this.applyRace(snap);
      this.raceSendT -= dt;
      if (this.raceSendT <= 0 || snap.msg) { this.room.sendEvent('race', snap); this.raceSendT = 0.2; }
      if (snap.phase === 'finished' && !this.resultsSent) {
        this.resultsSent = true;
        const rows = this.director.results();
        this.room.sendEvent('results', { rows });
        setTimeout(() => { if (!this.disposed) this.cb.onResults(rows, this.grid); }, 2500);
      }
    }
    const phase = this.race.phase;
    const limit = phase === 'loading' || phase === 'countdown' ? 0 : phase === 'pace' ? this.map.paceSpeed : phase === 'caution' ? this.map.paceSpeed * 0.9 : Infinity;

    // ---------------- inputs ----------------
    const auto = import.meta.env.DEV ? (window as unknown as { __auto?: (s: Session) => DriverInput }).__auto : undefined;
    const input = this.paused ? { steer: 0, throttle: 0, brake: 0.3, shiftUp: false, shiftDown: false } : auto ? auto(this) : interactive ? readDriverInput(dt, Math.abs(this.car.telemetry.speed)) : { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false };
    if (this.penalty > 0) this.penalty -= dt;
    this.car.inputLocked = limit === 0 || this.penalty > 0;
    this.car.speedLimit = limit;
    this.driveBots(dt, limit);
    this.computeDraft();

    // ---------------- physics ----------------
    const DT = PhysicsWorld.DT;
    this.acc += dt;
    const t0 = performance.now();
    let steps = 0;
    this.scrapeLevel *= 0.85;
    while (this.acc >= DT && steps < 10) {
      for (const rc of this.remotes.values()) rc.sample(nowS);
      this.car.step(input, DT);
      input.shiftUp = input.shiftDown = false;
      for (const b of this.bots.values()) b.car.step(b.input, DT);
      this.physics.step();
      this.car.snapshot();
      for (const b of this.bots.values()) b.car.snapshot();
      this.handleContacts(this.self, this.car, this.car.contacts());
      for (const [s, b] of this.bots) this.handleContacts(s, b.car, b.car.contacts());
      if (this.car.pendingExplode) { this.car.pendingExplode = false; this.explodeOwned(this.self, this.car); }
      for (const [s, b] of this.bots) if (b.car.pendingExplode) { b.car.pendingExplode = false; this.explodeOwned(s, b.car); }
      this.acc -= DT;
      this.time += DT;
      steps++;
    }
    if (steps === 10) this.acc = 0;
    this.physMs += (performance.now() - t0 - this.physMs) * 0.1;

    // ---------------- visuals ----------------
    const alpha = this.acc / DT;
    this.car.sync(alpha, dt);
    for (const b of this.bots.values()) b.car.sync(alpha, dt);
    for (const rc of this.remotes.values()) rc.sync(dt);
    if (this.progress.update(this.car.position, this.time) && this.cfg.laps === 0) this.flash(`LAP ${this.progress.lap - 1}  ${this.progress.lastLap.toFixed(3)}s`, 2.5);

    const effectFor = (slot: number, car: Car) => {
      const lv = car.body.linvel();
      this.carEffects(dt, slot, car.visual, Math.abs(car.telemetry.speed), new THREE.Vector3(lv.x, lv.y, lv.z), car.damage.smoke, car.damage.fire, car.wheels, car.wheelGone);
    };
    effectFor(this.self, this.car);
    for (const [s, b] of this.bots) effectFor(s, b.car);
    for (const [s, rc] of this.remotes) if (rc.latest) this.carEffects(dt, s, rc.visual, rc.speed, rc.vel.clone(), rc.latest.smoke, rc.latest.fire);
    this.debris.update(dt, (p) => { if (Math.random() < 0.5) this.effects.fire(p, _v.set(0, 0, 0), 0.5); });

    // fireworks at the finish (night track)
    if (this.map.fireworks && this.race.flag === 'checkered') {
      this.fireworksT -= dt;
      if (this.fireworksT <= 0) {
        this.fireworksT = 0.35 + Math.random() * 0.5;
        const tr = this.map.track;
        const i = tr.wrap(Math.floor(Math.random() * tr.n));
        this.effects.firework(tr.surface(i, tr.width + 30).add(_v.set(0, 45 + Math.random() * 30, 0)));
      }
    }

    // ---------------- auto-recovery: left the circuit ----------------
    {
      const tr = this.map.track;
      const p = this.car.position;
      const i = tr.nearest(p, this.progress.index, 80);
      const lat = tr.lateral(p, i);
      if (!this.car.damage.destroyed && (lat < -this.map.outOfBounds || lat > tr.width + this.map.outOfBounds || p.y < (this.map.groundY ?? -50) + 8)) {
        this.resetCar(this.car, this.progress);
        this.flash('BACK ON TRACK', 1.5);
      }
    }

    // ---------------- spectate after a wreck ----------------
    if (this.car.damage.destroyed && this.cfg.laps > 0) {
      if (this.destroyedAt < 0) this.destroyedAt = this.time;
      if (this.spectating < 0 && this.time - this.destroyedAt > 4) this.nextSpectate();
    }

    // ---------------- network out ----------------
    this.sendT -= dt;
    if (this.sendT <= 0) { this.sendStates(); this.sendT = 0.05; }
    this.dentT -= dt;
    if (this.dentT <= 0) {
      this.dentT = 0.1;
      for (const [s, list] of this.dentQueue) if (list.length) this.room.sendEvent('dents', { s, list: list.slice(-12) });
      this.dentQueue.clear();
    }

    // ---------------- camera, audio, hud ----------------
    const target = this.spectating >= 0 ? this.visualOf(this.spectating)?.root ?? this.car.visual.root : this.car.visual.root;
    const tSpeed = this.spectating >= 0 ? this.speedOf(this.spectating) : this.car.telemetry.speed;
    if (interactive) { const m = readMouseLook(); this.rig.mouseLook(m.held, m.dx, m.dy, dt); }
    this.rig.update(dt, target, tSpeed);
    const focus = new THREE.Vector3();
    target.getWorldPosition(focus);
    this.r.followShadow(focus);
    this.map.update?.(dt, this.r.camera);
    this.effects.update(dt, this.r.camera, this.r.renderer.domElement.clientHeight);
    const tm = this.car.telemetry;
    if (this.audio) {
      this.audio.damage = 1 - this.car.damage.engine;
      const dead = this.car.damage.destroyed;
      this.audio.update(dead ? 0 : tm.rpm, dead ? 0 : tm.throttle, tm.slip, tm.speed, tm.limiter);
      this.audio.scrape(this.scrapeLevel);
    }
    this.updateSpotter();
    if (interactive) this.updateHud(tm);
  }

  private driveBots(dt: number, limit: number) {
    if (!this.bots.size) return;
    const tr = this.map.track;
    const traffic: Traffic[] = [];
    const addT = (pos: THREE.Vector3, vel: THREE.Vector3, dead: boolean) => { const i = tr.nearest(pos); traffic.push({ pos, vel, i, d: tr.lateral(pos, i), dead: dead || (this.race.phase === 'green' && vel.length() < 3) }); };
    const lv = this.car.body.linvel();
    addT(this.car.position.clone(), new THREE.Vector3(lv.x, lv.y, lv.z), this.car.damage.destroyed);
    for (const [s, rc] of this.remotes) addT(rc.pos.clone(), rc.vel.clone(), this.destroyedOf(s));
    for (const b of this.bots.values()) { const bv = b.car.body.linvel(); addT(b.car.position.clone(), new THREE.Vector3(bv.x, bv.y, bv.z), b.car.damage.destroyed); }
    for (const [slot, b] of this.bots) {
      const others = traffic.filter((t) => t.pos.distanceToSquared(b.car.position) > 0.5);
      b.input = b.ai.drive(dt, others, limit);
      if (b.penalty > 0) b.penalty -= dt;
      b.car.inputLocked = limit === 0 || b.penalty > 0;
      b.car.speedLimit = limit;
      if (b.ai.wantsReset) {
        b.ai.wantsReset = false;
        if (!b.car.damage.destroyed) { this.resetCar(b.car, null, slot); b.penalty = 3; }
      }
    }
  }

  private computeDraft() {
    const cars: { pos: THREE.Vector3 }[] = [{ pos: this.car.position.clone() }];
    for (const b of this.bots.values()) cars.push({ pos: b.car.position.clone() });
    for (const rc of this.remotes.values()) cars.push({ pos: rc.pos.clone() });
    const draftFor = (car: Car) => {
      const p = car.position;
      const v = car.body.linvel();
      const vel = new THREE.Vector3(v.x, v.y, v.z);
      const sp = vel.length();
      if (sp < 25) return 0;
      const fwd = vel.divideScalar(sp);
      let d = 0;
      for (const o of cars) {
        const rel = o.pos.clone().sub(p);
        const along = rel.dot(fwd);
        if (along < 3 || along > 35) continue;
        const lat = rel.clone().addScaledVector(fwd, -along).length();
        if (lat > 2.2) continue;
        d += 0.3 * (1 - along / 35) * (1 - lat / 2.2);
      }
      return Math.min(0.38, d);
    };
    this.car.draft += (draftFor(this.car) - this.car.draft) * 0.2;
    for (const b of this.bots.values()) b.car.draft += (draftFor(b.car) - b.car.draft) * 0.2;
  }

  private nextSpectate() {
    const alive = this.grid.map((g) => g.slot).filter((s) => s !== this.self && !this.destroyedOf(s) && (this.carOf(s) || this.remotes.has(s)));
    if (!alive.length) { this.spectating = -1; return; }
    const idx = alive.indexOf(this.spectating);
    this.spectating = alive[(idx + 1) % alive.length];
  }

  private updateSpotter() {
    const me = this.car;
    if (me.damage.destroyed) { this.spotter = ''; return; }
    const r = me.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    let L = false, R = false;
    const check = (p: THREE.Vector3) => {
      const rel = p.clone().sub(me.position);
      const a = rel.dot(fwd), l = rel.dot(left);
      if (Math.abs(a) < 5.5 && Math.abs(l) > 1.2 && Math.abs(l) < 4.8) { if (l > 0) L = true; else R = true; }
    };
    for (const b of this.bots.values()) check(b.car.position);
    for (const rc of this.remotes.values()) check(rc.pos);
    const oval = this.map.oval;
    if (L && R) this.spotter = 'THREE WIDE!';
    else if (L) this.spotter = oval ? 'CAR INSIDE' : 'CAR LEFT';
    else if (R) this.spotter = oval ? 'CAR OUTSIDE' : 'CAR RIGHT';
    else if (this.wasAlongside) { this.spotter = 'CLEAR'; this.spotterUntil = this.time + 1.2; }
    else if (this.time > this.spotterUntil) this.spotter = '';
    this.wasAlongside = L || R;
  }

  private updateHud(tm: Car['telemetry']) {
    const st = this.race.st;
    const mine = st.find((s) => s.slot === this.self);
    const leader = st[0];
    const ref = leader?.best || leader?.last || this.map.track.length / 55;
    const tower: TowerRow[] = st.slice(0, 10).map((s) => {
      const g = this.entry(s.slot);
      const gapLaps = leader ? leader.lap + leader.frac - (s.lap + s.frac) : 0;
      const gap = s === leader ? (this.cfg.laps ? `L${Math.min(this.cfg.laps, s.lap + 1)}` : 'P1') : gapLaps >= 1 ? `+${Math.floor(gapLaps)}L` : `+${(gapLaps * ref).toFixed(1)}`;
      return { pos: s.pos, number: g?.number ?? 0, color: g?.color ?? '#888', name: g?.nickname ?? '?', gap, self: s.slot === this.self, status: s.status, ping: this.room.pingOf(s.slot) };
    });
    const markers = this.grid.map((g) => {
      const p = this.posOf(g.slot);
      return { x: p.x, z: p.z, color: g.color, self: g.slot === this.self };
    });
    const dmg = this.car.damage;
    let status = '';
    if (this.resetHold > 0.15) status = `KEEP HOLDING R — ${dmg.destroyed && !this.cfg.laps ? 'NEW CAR' : 'RESET'} IN ${Math.max(0, RESET_HOLD - this.resetHold).toFixed(1)}s`;
    else if (dmg.destroyed) status = this.spectating >= 0 ? `DESTROYED — SPECTATING ${this.entry(this.spectating)?.nickname ?? ''} (C: next)` : this.cfg.laps ? 'DESTROYED — DNF' : 'DESTROYED — HOLD R FOR A NEW CAR';
    else if (this.race.phase === 'pace') status = 'PACE LAP — HOLD POSITION';
    else if (this.race.phase === 'caution') status = 'CAUTION — SLOW DOWN';
    else if (this.race.phase === 'loading') status = 'WAITING FOR DRIVERS…';
    else if (dmg.fire > 0) status = 'ON FIRE!';
    else if (dmg.engineWear >= 1) status = 'ENGINE BLOWN';
    else if (dmg.engineTemp > 130) status = 'ENGINE OVERHEATING';
    this.hud.update({
      telemetry: tm,
      lap: mine ? mine.lap + 1 : this.progress.lap,
      totalLaps: this.cfg.laps,
      position: mine?.pos ?? 1,
      cars: this.grid.length,
      current: this.progress.current(this.time),
      last: this.progress.lastLap,
      best: this.progress.bestLap,
      camera: this.spectating >= 0 ? 'Spectator' : CAM_LABEL[this.rig.mode],
      banner: this.time < this.bannerUntil ? this.banner : '',
      bannerColor: this.bannerColor,
      flag: this.race.flag,
      countdown: this.race.phase === 'countdown' ? this.race.cd : 0,
      tower,
      damage: dmg,
      draft: this.car.draft,
      spotter: this.spotter,
      penalty: Math.max(0, this.penalty),
      status,
      markers,
      debug: this.debug
        ? `FPS ${this.fps.toFixed(0)}  physics ${this.physMs.toFixed(2)} ms  particles ${this.effects.particleCount}\n` +
          `speed ${(tm.speed * 2.23694).toFixed(1)} mph  gear ${tm.gear}  rpm ${tm.rpm.toFixed(0)}  draft ${this.car.draft.toFixed(2)}\n` +
          `engine ${(dmg.engine * 100).toFixed(0)}%  temp ${dmg.engineTemp.toFixed(0)}°C  integrity ${(dmg.integrity * 100).toFixed(0)}%  fire ${dmg.fire.toFixed(2)}\n` +
          `phase ${this.race.phase}  flag ${this.race.flag}  remotes ${this.remotes.size}  bots ${this.bots.size}\n` +
          `draw calls ${this.r.renderer.info.render.calls}  tris ${(this.r.renderer.info.render.triangles / 1000).toFixed(0)}k  quality ${settings.quality}`
        : null,
    });
  }

  // ====================================================================== cleanup
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.audio?.dispose();
    this.hud.show(false);
    if (this.map) this.r.scene.remove(this.map.group);
    this.r.scene.remove(this.effects.group);
    if (this.car) this.r.scene.remove(this.car.visual.root);
    for (const b of this.bots.values()) this.r.scene.remove(b.car.visual.root);
    for (const rc of this.remotes.values()) this.r.scene.remove(rc.visual.root);
    this.debris?.dispose();
    this.physics?.world.free();
  }
}
