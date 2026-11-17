import { profile } from '../core/profile';
import { MAX_HUMANS } from '../net/transport';
import type { Room, ArenaLoadout } from '../net/room';
import { CLASSES, BUMPERS, arenaSpec, classById } from '../arena/classes';
import { EVENT_IDS, EVENT_INFO } from '../arena/events';
import { ARENA_PAINTS, VICTORY_EFFECTS, levelOf, xpForLevel, loadArenaProfile, saveArenaProfile, type Reward } from '../arena/rewards';
import type { ArenaResult } from '../arena/arenaSession';
import { CarPreview } from './carPreview';
import { esc, mountScreen, onScreenLeave } from './screens';

/** Most cars in one arena match (humans + AI). */
export const ARENA_MAX = 16;

export interface ArenaLobbyHandlers {
  start(): void;
  leave(): void;
}

/** What a level unlocks (for the results screen). */
export function unlocksAt(lvl: number): string[] {
  const out: string[] = [];
  for (const c of CLASSES) if (c.unlockLevel === lvl) out.push(`Vehicle: ${c.name}`);
  for (const b of BUMPERS) if (b.unlockLevel === lvl) out.push(`Bumper: ${b.name}`);
  for (const p of ARENA_PAINTS) if (p.unlockLevel === lvl && p.id) out.push(`Paint: ${p.name}`);
  for (const v of VICTORY_EFFECTS) if (v.unlockLevel === lvl) out.push(`Victory effect: ${v.name}`);
  return out;
}

/** Livery colour for a loadout (paint job overrides the profile colour). */
export function loadoutColor(paint: string, fallback: string) {
  return ARENA_PAINTS.find((p) => p.id === paint && p.id)?.color || fallback;
}

export function arenaLobbyScreen(room: Room, h: ArenaLobbyHandlers) {
  const online = !room.offline;
  const ap = loadArenaProfile();
  const level = levelOf(ap.xp);
  // never keep a locked pick (e.g. after a profile reset)
  if (classById(ap.cls).unlockLevel > level) ap.cls = 'balanced';
  if ((BUMPERS.find((b) => b.id === ap.bumper)?.unlockLevel ?? 0) > level) ap.bumper = 'bar';
  if ((ARENA_PAINTS.find((p) => p.id === ap.paint)?.unlockLevel ?? 0) > level) ap.paint = '';
  const loadout = (): ArenaLoadout & { victory: string } => ({ cls: ap.cls, bumper: ap.bumper, paint: ap.paint, victory: ap.victory });
  room.setLoadout(loadout());
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  const nextXp = xpForLevel(level + 1), prevXp = xpForLevel(level);
  const root = mountScreen(`
    <div class="card wide lobby arena-lobby">
      <h2>💥 ${online ? (room.isHost ? 'Your arena' : 'Arena lobby') : 'Demolition Arena'}</h2>
      ${online ? `
      <div class="room-code">
        <div><label>Room code</label><div class="code">${room.code}</div></div>
        <div class="row" style="flex:none;gap:8px">
          <button class="btn ghost" id="copy">Copy code</button>
          <button class="btn ghost" id="copylink">Copy link</button>
        </div>
      </div>` : ''}
      <div class="arena-level"><b>Level ${level}</b><i><b style="width:${Math.round(((ap.xp - prevXp) / (nextXp - prevXp)) * 100)}%"></b></i><span>${ap.xp - prevXp} / ${nextXp - prevXp} XP · ${ap.credits} credits · ${ap.wins} wins</span></div>
      <div class="room-grid">
        <div class="stack">
          <div class="carpick arena-pick">
            <canvas class="carpick-view" id="carview"></canvas>
            <div class="carpick-info">
              <div class="carpick-head">
                <button class="btn ghost carpick-arrow" id="prev" aria-label="Previous vehicle">‹</button>
                <div class="carpick-name"><b id="cname"></b><small id="crole"></small></div>
                <button class="btn ghost carpick-arrow" id="next" aria-label="Next vehicle">›</button>
              </div>
              <div class="note" id="cblurb"></div>
              <div class="carpick-bars" id="cbars"></div>
            </div>
          </div>
          <div class="row">
            <div><label>Bumper</label><select id="bumper">${BUMPERS.map((b) => `<option value="${b.id}" ${b.unlockLevel > level ? 'disabled' : ''}>${b.name}${b.unlockLevel > level ? ` (level ${b.unlockLevel})` : ''}</option>`).join('')}</select></div>
            <div><label>Paint</label><select id="paint">${ARENA_PAINTS.map((p) => `<option value="${p.id}" ${p.unlockLevel > level ? 'disabled' : ''}>${p.name}${p.unlockLevel > level ? ` (level ${p.unlockLevel})` : ''}</option>`).join('')}</select></div>
            <div><label>Victory</label><select id="victory">${VICTORY_EFFECTS.map((v) => `<option value="${v.id}" ${v.unlockLevel > level ? 'disabled' : ''}>${v.name}${v.unlockLevel > level ? ` (level ${v.unlockLevel})` : ''}</option>`).join('')}</select></div>
          </div>
        </div>
        <div class="stack">
          <div class="row">
            <div><label>AI opponents</label><select id="bots">${Array.from({ length: ARENA_MAX }, (_, i) => `<option value="${i}">${i}</option>`).join('')}</select></div>
            <div><label>Time limit</label><select id="time"><option value="0">None</option><option value="180">3 min</option><option value="300">5 min</option><option value="480">8 min</option></select></div>
          </div>
          <div><label>Arena events</label><select id="events"><option value="off">Off</option><option value="random">Random (two)</option>${EVENT_IDS.map((e) => `<option value="${e}">${EVENT_INFO[e].name}</option>`).join('')}</select><div class="note" id="evnote"></div></div>
          <div><label id="dcount">Drivers</label><ul class="players" id="players"></ul></div>
          ${online ? '<div class="chat"><div class="chat-log" id="chatlog"></div><input id="chatin" type="text" maxlength="200" placeholder="Say something… (Enter)" /></div>' : ''}
        </div>
      </div>
      <div class="row" style="margin-top:16px">
        <button class="btn ghost" id="leave">${online ? 'Leave room' : 'Back'}</button>
        ${room.isHost ? '<button class="btn" id="start">Start match</button>' : '<button class="btn" id="ready">Ready</button>'}
      </div>
      <div class="note" id="hint" style="margin-top:8px"></div>
    </div>`);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const preview = new CarPreview($<HTMLCanvasElement>('#carview'));
  onScreenLeave(() => preview.dispose());
  const botsSel = $<HTMLSelectElement>('#bots'), timeSel = $<HTMLSelectElement>('#time'), evSel = $<HTMLSelectElement>('#events');
  for (const s of [botsSel, timeSel, evSel]) s.disabled = !room.isHost;

  const save = () => { saveArenaProfile(ap); room.setLoadout(loadout()); render(); };
  const render = () => {
    const a = room.settings.arena ?? { bots: 7, events: 'off', timeLimit: 0 };
    const c = classById(ap.cls);
    $('#cname').textContent = c.name;
    $('#crole').textContent = c.unlockLevel > level ? `Unlocks at level ${c.unlockLevel}` : c.role;
    $('#cblurb').textContent = c.blurb;
    const bar = (label: string, v: number) => `<div class="cbar"><span>${label}</span><div class="cbar-track"><div class="cbar-fill" style="width:${Math.round(v * 100)}%"></div></div></div>`;
    $('#cbars').innerHTML = bar('Top speed', c.bars.speed) + bar('Acceleration', c.bars.accel) + bar('Handling', c.bars.handling) + bar('Armour', c.bars.armor) + bar('Ram power', c.bars.ram) + bar('Repairs', c.repairs / 3);
    preview.setCar(arenaSpec(c.id, ap.bumper), loadoutColor(ap.paint, profile.color), profile.carNumber);
    $<HTMLSelectElement>('#bumper').value = ap.bumper;
    $<HTMLSelectElement>('#paint').value = ap.paint;
    $<HTMLSelectElement>('#victory').value = ap.victory;
    const humans = room.humans.length;
    const maxBots = ARENA_MAX - humans;
    botsSel.querySelectorAll('option').forEach((o) => (o.disabled = Number(o.value) > maxBots));
    const bots = Math.min(a.bots, maxBots);
    botsSel.value = String(bots);
    timeSel.value = String(a.timeLimit);
    evSel.value = a.events;
    $('#evnote').textContent = a.events === 'off' ? 'Classic derby: no modifiers.' : a.events === 'random' ? 'Two random modifiers each match.' : EVENT_INFO[a.events as keyof typeof EVENT_INFO]?.blurb ?? '';
    const rows = room.players.map((p) => `<li><span class="num" style="background:${esc(loadoutColor(p.arena?.paint ?? '', p.color))}">${p.number}</span><span class="pname"><span>${esc(p.nickname)}${p.slot === room.selfSlot ? ' <small>(you)</small>' : ''}</span><small class="pcar">${esc(classById(p.arena?.cls).name)}</small></span><span class="tagline">${p.isHost ? 'Host' : p.ready ? '<span style="color:#3ad17a">Ready</span>' : 'Not ready'}${online && !p.isHost ? ` · ${p.ping} ms` : ''}</span></li>`);
    if (bots) rows.push(`<li><span class="num" style="background:#555">AI</span>${bots} AI wreckers<span class="tagline">mixed classes & personalities</span></li>`);
    if (online) for (let i = humans; i < MAX_HUMANS; i++) rows.push('<li class="empty">Open player slot</li>');
    $('#players').innerHTML = rows.join('');
    $('#dcount').textContent = `Vehicles (${humans + bots}/${ARENA_MAX}) · players ${humans}/${MAX_HUMANS}`;
    const startBtn = root.querySelector<HTMLButtonElement>('#start');
    if (startBtn) {
      const waiting = room.humans.filter((p) => !p.isHost && !p.ready).length;
      const total = humans + bots;
      startBtn.disabled = waiting > 0 || total < 2;
      $('#hint').textContent = total < 2 ? 'Add at least one AI opponent (or wait for a friend).' : waiting > 0 ? `Waiting for ${waiting} driver(s) to get ready…` : online && humans === 1 ? 'Share the code above, or start now against the AI.' : '';
    }
    const readyBtn = root.querySelector<HTMLButtonElement>('#ready');
    if (readyBtn) {
      const me = room.self;
      readyBtn.textContent = me?.ready ? 'Not ready' : 'Ready';
      readyBtn.classList.toggle('ghost', !!me?.ready);
      $('#hint').textContent = me?.ready ? 'Waiting for the host to start…' : 'Pick your vehicle, then press Ready.';
    }
  };
  const step = (dir: number) => {
    let i = CLASSES.findIndex((c) => c.id === ap.cls);
    for (let k = 0; k < CLASSES.length; k++) {
      i = (i + dir + CLASSES.length) % CLASSES.length;
      if (CLASSES[i].unlockLevel <= level) break;
    }
    ap.cls = CLASSES[i].id;
    save();
  };
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $<HTMLSelectElement>('#bumper').addEventListener('change', (e) => { ap.bumper = (e.target as HTMLSelectElement).value; save(); });
  $<HTMLSelectElement>('#paint').addEventListener('change', (e) => { ap.paint = (e.target as HTMLSelectElement).value; save(); });
  $<HTMLSelectElement>('#victory').addEventListener('change', (e) => { ap.victory = (e.target as HTMLSelectElement).value; save(); });
  const arenaCfg = () => room.settings.arena ?? { bots: 7, events: 'off', timeLimit: 0 };
  botsSel.addEventListener('change', () => { room.setSettings({ arena: { ...arenaCfg(), bots: Number(botsSel.value) } }); render(); });
  timeSel.addEventListener('change', () => { room.setSettings({ arena: { ...arenaCfg(), timeLimit: Number(timeSel.value) } }); render(); });
  evSel.addEventListener('change', () => { room.setSettings({ arena: { ...arenaCfg(), events: evSel.value } }); render(); });
  $('#leave').addEventListener('click', h.leave);
  root.querySelector('#start')?.addEventListener('click', h.start);
  root.querySelector('#ready')?.addEventListener('click', () => { room.setReady(!room.self?.ready); render(); });
  render();
  room.onLobby = render;

  if (online) {
    const copy = (txt: string, btn: HTMLButtonElement) => {
      navigator.clipboard?.writeText(txt).then(() => { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = t), 1200); }).catch(() => {});
    };
    $<HTMLButtonElement>('#copy').addEventListener('click', (e) => copy(room.code, e.currentTarget as HTMLButtonElement));
    $<HTMLButtonElement>('#copylink').addEventListener('click', (e) => copy(link, e.currentTarget as HTMLButtonElement));
    const log = $('#chatlog');
    const chatIn = $<HTMLInputElement>('#chatin');
    room.onChat = (from, text) => {
      const p = room.players.find((x) => x.slot === from);
      log.insertAdjacentHTML('beforeend', from < 0 ? `<div class="sys">${esc(text)}</div>` : `<div><b style="color:${esc(p?.color ?? '#fff')}">${esc(p?.nickname ?? '?')}:</b> ${esc(text)}</div>`);
      log.scrollTop = log.scrollHeight;
    };
    chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { room.chat(chatIn.value); chatIn.value = ''; } });
  }
}

export function arenaResultsScreen(res: ArenaResult, reward: Reward, canRestart: boolean, h: { again(): void; lobby(): void; menu(): void }) {
  const me = res.me;
  const title = me.won ? '🏆 VICTORY!' : `#${me.position} of ${me.cars}`;
  const root = mountScreen(`
    <div class="card wide arena-results">
      <h2>${title}</h2>
      <p class="tag">${res.winner >= 0 ? `Last one standing: <b>${esc(res.standings.find((s) => s.slot === res.winner)?.name ?? '?')}</b>` : 'No survivors'}${res.events.length ? ` · ${esc(res.events.join(', '))}` : ''}</p>
      <div class="room-grid">
        <div>
          <div class="results-wrap"><table class="results">
            <tr><th>#</th><th>Car</th><th>Driver</th><th>Class</th><th>KO</th><th>Damage</th><th>Survived</th></tr>
            ${res.standings.map((s) => `<tr${s.slot === res.winner ? ' class="win"' : ''}><td>${s.place}</td><td><span class="num" style="background:${esc(s.color)}">${s.number}</span></td><td>${esc(s.name)}${s.bot ? ' <small>AI</small>' : ''}</td><td>${esc(classById(s.cls).name)}</td><td>${s.kills}</td><td>${s.dealt}</td><td>${Math.floor(s.survival / 60)}:${String(s.survival % 60).padStart(2, '0')}</td></tr>`).join('')}
          </table></div>
        </div>
        <div class="stack">
          <div class="arena-stats">
            <div><b>${me.eliminations}</b><span>Eliminations</span></div>
            <div><b>${Math.round(me.damageDealt)}</b><span>Damage dealt</span></div>
            <div><b>${Math.round(me.damageTaken)}</b><span>Damage received</span></div>
            <div><b>${Math.floor(me.survival / 60)}:${String(Math.round(me.survival) % 60).padStart(2, '0')}</b><span>Survival time</span></div>
          </div>
          <div class="arena-reward">
            <h3>Rewards</h3>
            ${reward.lines.map((l) => `<div><span>${esc(l.label)}</span><b>+${l.xp} XP</b></div>`).join('')}
            <div class="total"><span>Total</span><b>+${reward.xp} XP · +${reward.credits} credits</b></div>
            ${reward.levelAfter > reward.levelBefore ? `<div class="levelup">LEVEL UP! Level ${reward.levelAfter}</div>` : ''}
            ${reward.unlocked.map((u) => `<div class="unlock">🔓 ${esc(u)}</div>`).join('')}
          </div>
        </div>
      </div>
      <div class="row" style="margin-top:16px">
        <button class="btn ghost" id="menu">Main menu</button>
        ${canRestart ? '<button class="btn ghost" id="lobby">Lobby</button><button class="btn" id="again">Play again</button>' : '<div class="note" style="align-self:center">Waiting for the host…</div>'}
      </div>
    </div>`);
  root.querySelector('#menu')!.addEventListener('click', h.menu);
  root.querySelector('#again')?.addEventListener('click', h.again);
  root.querySelector('#lobby')?.addEventListener('click', h.lobby);
}
