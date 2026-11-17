import { profile, settings, saveProfile, saveSettings, validNickname, normalizeCode, LIVERY_COLORS, type Quality } from '../core/profile';
import { MAPS } from '../tracks/maps';
import { MAX_GRID, MAX_HUMANS } from '../net/transport';
import type { Room } from '../net/room';
import type { ResultRow } from '../race/race';
import type { GridEntry } from '../core/session';
import { fmtTime } from '../core/progress';
import { carSpec, carsOf, carStats, SERIES_LABEL, type Series } from '../vehicle/catalog';
import { CarPreview } from './carPreview';
import { COMPOUNDS } from '../vehicle/tyres';

const ui = () => document.getElementById('ui')!;

export function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Clean-up for the current screen (e.g. the car preview's WebGL context), run when it is replaced. */
let screenCleanup: (() => void) | null = null;
function runCleanup() {
  const f = screenCleanup;
  screenCleanup = null;
  f?.();
}

/** Mount a screen (other screen modules use this too). */
export function mountScreen(html: string, cleanup?: () => void): HTMLElement {
  const root = mount(html);
  screenCleanup = cleanup ?? null;
  return root;
}
/** Register clean-up for the screen that is showing now. */
export function onScreenLeave(f: () => void) { screenCleanup = f; }

function mount(html: string, withBackdrop = true): HTMLElement {
  runCleanup();
  const root = ui();
  root.innerHTML = (withBackdrop ? '<div class="backdrop"></div>' : '') + html;
  return root;
}

export function clearUI() {
  runCleanup();
  ui().innerHTML = '';
}

export interface Nav {
  host(): void;
  join(code: string): Promise<void>;
  single(): void;
  /** Demolition Arena: play against the AI, or host an online arena. */
  arenaSingle(): void;
  arenaHost(): void;
}

// ---------------- nickname ----------------
export function nicknameScreen(next: () => void) {
  const root = mount(`
    <div class="card stack">
      <h1 class="logo">Stock Car <span>Thunder</span></h1>
      <p class="tag">Browser stock-car racing with up to 10 friends. No account needed: pick a name and race.</p>
      <div>
        <label for="nick">Your nickname</label>
        <input id="nick" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="e.g. Blaze" value="${esc(profile.nickname)}" />
        <div class="err" id="err"></div>
      </div>
      <button class="btn block" id="go">Continue</button>
    </div>`);
  const input = root.querySelector<HTMLInputElement>('#nick')!;
  const err = root.querySelector<HTMLElement>('#err')!;
  const go = () => {
    const e = validNickname(input.value);
    if (e) { err.textContent = e; input.focus(); return; }
    profile.nickname = input.value.trim();
    saveProfile();
    next();
  };
  root.querySelector('#go')!.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  input.focus();
  input.select();
}

// ---------------- main menu ----------------
export function mainMenu(nav: Nav, prefillCode?: string, notice?: string) {
  if (prefillCode) return joinScreen(nav, prefillCode);
  const root = mount(`
    <div class="card wide">
      <h1 class="logo">Stock Car <span>Thunder</span></h1>
      <div class="who">Driving as <b>${esc(profile.nickname)}</b> · #${profile.carNumber}<a id="rename">change</a></div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
      <div class="menu-grid">
        <button class="menu-tile" id="host"><b>Host room</b><span>Get a 6-letter code and share it with up to ${MAX_HUMANS - 1} friends.</span></button>
        <button class="menu-tile" id="join"><b>Join room</b><span>Enter a friend's room code.</span></button>
        <button class="menu-tile" id="single"><b>Single race</b><span>Race AI drivers, or free practice on any track.</span></button>
        <button class="menu-tile" id="garage"><b>Garage &amp; settings</b><span>Car number, colour, graphics, assists.</span></button>
        <button class="menu-tile arena-tile" id="arena"><b>💥 Demolition Arena</b><span>Last car standing wins. Ram, smash and outlast up to 15 opponents.</span></button>
      </div>
    </div>`);
  root.querySelector('#rename')!.addEventListener('click', () => nicknameScreen(() => mainMenu(nav)));
  root.querySelector('#host')!.addEventListener('click', () => nav.host());
  root.querySelector('#join')!.addEventListener('click', () => joinScreen(nav));
  root.querySelector('#single')!.addEventListener('click', () => nav.single());
  root.querySelector('#garage')!.addEventListener('click', () => garageScreen(() => mainMenu(nav)));
  root.querySelector('#arena')!.addEventListener('click', () => arenaMenu(nav));
}

/** Demolition Arena entry: play the AI, host an online arena (code + link), or join one. */
export function arenaMenu(nav: Nav) {
  const root = mount(`
    <div class="card wide">
      <h1 class="logo">Demolition <span>Arena</span></h1>
      <p class="note">Smash, ram and outlast everyone in a floodlit arena. The last car still running wins.</p>
      <div class="menu-grid">
        <button class="menu-tile" id="asingle"><b>Play vs AI</b><span>You against up to 15 AI wreckers.</span></button>
        <button class="menu-tile" id="ahost"><b>Host online arena</b><span>Get a code and a link for up to ${MAX_HUMANS - 1} friends, fill up with AI.</span></button>
        <button class="menu-tile" id="ajoin"><b>Join with a code</b><span>Enter a friend's room code (or open their link).</span></button>
        <button class="menu-tile" id="aback"><b>Back</b><span>Main menu.</span></button>
      </div>
    </div>`);
  root.querySelector('#asingle')!.addEventListener('click', () => nav.arenaSingle());
  root.querySelector('#ahost')!.addEventListener('click', () => nav.arenaHost());
  root.querySelector('#ajoin')!.addEventListener('click', () => joinScreen(nav));
  root.querySelector('#aback')!.addEventListener('click', () => mainMenu(nav));
}

export function messageScreen(title: string, text: string, onOk: () => void) {
  const root = mount(`<div class="card stack"><h2>${esc(title)}</h2><p class="note">${esc(text)}</p><button class="btn block" id="ok">OK</button></div>`);
  root.querySelector('#ok')!.addEventListener('click', onOk);
}

// ---------------- join ----------------
export function joinScreen(nav: Nav, prefill = '') {
  const root = mount(`
    <div class="card stack">
      <h2>Join a room</h2>
      <div>
        <label for="code">Room code</label>
        <input id="code" class="code" type="text" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ABC123" value="${esc(normalizeCode(prefill))}" />
        <div class="err" id="err"></div>
      </div>
      <div class="row">
        <button class="btn ghost" id="back">Back</button>
        <button class="btn" id="go">Join</button>
      </div>
    </div>`);
  const input = root.querySelector<HTMLInputElement>('#code')!;
  const err = root.querySelector<HTMLElement>('#err')!;
  const goBtn = root.querySelector<HTMLButtonElement>('#go')!;
  input.addEventListener('input', () => (input.value = normalizeCode(input.value)));
  const go = async () => {
    if (input.value.length !== 6) { err.textContent = 'Room codes are 6 characters.'; return; }
    err.textContent = '';
    goBtn.disabled = true;
    goBtn.textContent = 'Connecting…';
    try {
      await nav.join(input.value);
    } catch (e) {
      err.textContent = (e as Error).message;
      goBtn.disabled = false;
      goBtn.textContent = 'Join';
    }
  };
  goBtn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(); });
  root.querySelector('#back')!.addEventListener('click', () => { history.replaceState(null, '', location.pathname); mainMenu(nav); });
  input.focus();
  if (prefill.length === 6) void go();
}

// ---------------- lobby (host, client and offline) ----------------
export interface LobbyHandlers {
  start(): void;
  leave(): void;
}

export function lobbyScreen(room: Room, h: LobbyHandlers) {
  const online = !room.offline;
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  const root = mount(`
    <div class="card wide lobby">
      <h2>${online ? (room.isHost ? 'Your room' : 'Room lobby') : 'Single race'}</h2>
      ${online ? `
      <div class="room-code">
        <div><label>Room code</label><div class="code">${room.code}</div></div>
        <div class="row" style="flex:none;gap:8px">
          <button class="btn ghost" id="copy">Copy code</button>
          <button class="btn ghost" id="copylink">Copy link</button>
        </div>
      </div>` : ''}
      <div class="room-grid">
        <div class="stack">
          <div><label>Track</label><div class="maps" id="maps"></div></div>
          <div class="row">
            <div><label>Laps</label><select id="laps">${[0, 3, 5, 10, 20, 40].map((l) => `<option value="${l}">${l === 0 ? 'Free practice' : l}</option>`).join('')}</select></div>
            <div><label>Damage</label><select id="dmg"><option value="realistic">Realistic</option><option value="brutal">Brutal</option><option value="off">Off (visual only)</option></select></div>
          </div>
          <div class="row">
            <div><label>AI drivers</label><select id="bots">${Array.from({ length: MAX_GRID }, (_, i) => `<option value="${i}">${i}</option>`).join('')}</select></div>
            <div><label>Weather</label><select id="weather"><option value="dry">Dry</option><option value="rain">Rain</option></select></div>
          </div>
          <div class="row">
            <div><label>Series</label><select id="series">${(Object.keys(SERIES_LABEL) as Series[]).map((k) => `<option value="${k}">${SERIES_LABEL[k]}</option>`).join('')}</select></div>
            <div><label>Cars</label><select id="samecar"></select></div>
          </div>
        </div>
        <div class="stack">
          <div><label id="dcount">Drivers</label><ul class="players" id="players"></ul></div>
          ${online ? `<div class="chat"><div class="chat-log" id="chatlog"></div><input id="chatin" type="text" maxlength="200" placeholder="Say something… (Enter)" /></div>` : ''}
        </div>
      </div>
      <div class="carpick" id="carpick">
            <canvas class="carpick-view" id="carview"></canvas>
            <div class="carpick-info">
              <div class="carpick-head">
                <button class="btn ghost carpick-arrow" id="carprev" aria-label="Previous car">‹</button>
                <div class="carpick-name"><b id="carname"></b><small id="cartag"></small></div>
                <button class="btn ghost carpick-arrow" id="carnext" aria-label="Next car">›</button>
              </div>
              <div class="note" id="carblurb"></div>
              <div class="carpick-bars" id="carbars"></div>
              <div class="note" id="carfacts"></div>
              <div class="tyrepick" id="tyrepick">
                <span>Start tyres</span>
                ${(['soft', 'medium', 'hard'] as const).map((t) => `<button class="btn ghost tyre-btn" data-tyre="${t}" title="${COMPOUNDS[t].label}"><b style="border-color:${COMPOUNDS[t].color}">${COMPOUNDS[t].tag}</b>${COMPOUNDS[t].label}</button>`).join('')}
              </div>
            </div>
          </div>
      <div class="row" style="margin-top:16px">
        <button class="btn ghost" id="leave">${online ? 'Leave room' : 'Back'}</button>
        ${room.isHost ? '<button class="btn" id="start">Start race</button>' : '<button class="btn" id="ready">Ready</button>'}
      </div>
      <div class="note" id="hint" style="margin-top:8px"></div>
    </div>`);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  const selects = ['laps', 'dmg', 'bots', 'weather', 'series', 'samecar'].map((id) => $<HTMLSelectElement>(`#${id}`)!);
  const [lapsSel, dmgSel, botsSel, weatherSel, seriesSel, sameSel] = selects;
  if (!room.isHost) selects.forEach((s) => (s.disabled = true));

  // ---- car picker: every player picks a car of the room's series (unless the host forces one) ----
  const preview = new CarPreview($<HTMLCanvasElement>('#carview')!);
  screenCleanup = () => preview.dispose();
  let sameKey = '';
  const myCar = () => {
    const s = room.settings;
    const forced = !!s.sameCar && carSpec(s.sameCar).id === s.sameCar && carSpec(s.sameCar).series === s.series;
    return { spec: forced ? carSpec(s.sameCar) : carSpec(profile.cars[s.series], s.series), forced };
  };
  const renderCar = () => {
    const s = room.settings;
    // the "same car" options depend on the series
    if (sameKey !== s.series) {
      sameKey = s.series;
      sameSel.innerHTML = `<option value="">Free choice</option>${carsOf(s.series).map((c) => `<option value="${c.id}">All drive: ${esc(c.name)}</option>`).join('')}`;
    }
    seriesSel.value = s.series;
    sameSel.value = carsOf(s.series).some((c) => c.id === s.sameCar) ? s.sameCar : '';
    const { spec, forced } = myCar();
    const st = carStats(spec);
    $('#carname')!.textContent = spec.name;
    $('#cartag')!.textContent = `${SERIES_LABEL[spec.series]} · ${spec.archetype}`;
    $('#carblurb')!.textContent = forced ? `${spec.blurb} (The host set the same car for everyone.)` : spec.blurb;
    $('#carbars')!.innerHTML = st.bars.map((b) => `<div class="cbar"><span>${b.label}</span><div class="cbar-track"><div class="cbar-fill" style="width:${Math.round(b.value * 100)}%"></div></div></div>`).join('');
    const kmh = settings.units === 'kmh';
    $('#carfacts')!.textContent = `≈ ${Math.round(st.topSpeed * (kmh ? 3.6 : 2.237))} ${kmh ? 'km/h' : 'mph'} top speed · ${Math.round(st.power * 1.341)} hp · ${spec.mass} kg · ${spec.gears.length}-speed`;
    $<HTMLButtonElement>('#carprev')!.disabled = $<HTMLButtonElement>('#carnext')!.disabled = forced;
    preview.setCar(spec, profile.color, profile.carNumber);
    // GP cars choose a starting compound (in the rain everyone starts on intermediates)
    const tp = $('#tyrepick')!;
    tp.style.display = spec.series === 'gp' ? '' : 'none';
    tp.querySelectorAll<HTMLButtonElement>('.tyre-btn').forEach((b) => b.classList.toggle('sel', b.dataset.tyre === profile.tyre));
  };
  root.querySelectorAll<HTMLButtonElement>('.tyre-btn').forEach((b) => b.addEventListener('click', () => {
    profile.tyre = b.dataset.tyre as typeof profile.tyre;
    saveProfile();
    room.setCars(profile.cars, profile.tyre);
    render();
  }));
  const stepCar = (dir: number) => {
    const s = room.settings;
    const list = carsOf(s.series);
    const i = list.findIndex((c) => c.id === carSpec(profile.cars[s.series], s.series).id);
    profile.cars[s.series] = list[(i + dir + list.length) % list.length].id;
    saveProfile();
    room.setCars(profile.cars, profile.tyre);
    render();
  };
  $('#carprev')!.addEventListener('click', () => stepCar(-1));
  $('#carnext')!.addEventListener('click', () => stepCar(1));
  seriesSel.addEventListener('change', () => { room.setSettings({ series: seriesSel.value as Series, sameCar: '' }); render(); });
  sameSel.addEventListener('change', () => { room.setSettings({ sameCar: sameSel.value }); render(); });

  const render = () => {
    const s = room.settings;
    const map = MAPS.find((m) => m.id === s.map) ?? MAPS[0];
    $('#maps')!.innerHTML = MAPS.map((m) => `
      <div class="map-opt ${m.id === s.map ? 'sel' : ''} ${room.isHost ? '' : 'locked-soft'}" data-id="${m.id}">
        <div class="sw" style="background:${m.swatch}"></div>
        <div><b>${m.name}</b><small>${m.subtitle}</small></div>
      </div>`).join('');
    lapsSel.value = String(s.laps);
    dmgSel.value = s.damage;
    const humans = room.humans.length;
    const maxBots = MAX_GRID - humans;
    botsSel.querySelectorAll('option').forEach((o) => (o.disabled = Number(o.value) > maxBots));
    botsSel.value = String(Math.min(s.bots, maxBots));
    weatherSel.value = s.weather;
    weatherSel.disabled = !room.isHost || !map.weather;
    if (!map.weather) weatherSel.value = 'dry';
    renderCar();
    const forcedCar = myCar().forced ? myCar().spec : null;
    const carOf = (p: Room['players'][number]) => (forcedCar ?? carSpec(p.cars?.[s.series], s.series)).name;
    const rows = room.players.map((p) => `<li><span class="num" style="background:${esc(p.color)}">${p.number}</span><span class="pname"><span>${esc(p.nickname)}${p.slot === room.selfSlot ? ' <small>(you)</small>' : ''}</span><small class="pcar">${esc(carOf(p))}</small></span><span class="tagline">${p.isHost ? 'Host' : p.ready ? '<span style="color:#3ad17a">Ready</span>' : 'Not ready'}${online && !p.isHost ? ` · ${p.ping} ms` : ''}</span></li>`);
    const bots = Math.min(s.bots, maxBots);
    for (let i = 0; i < bots; i++) rows.push(`<li><span class="num" style="background:#555">AI</span>${BOT_NAMES[i % BOT_NAMES.length]}<span class="tagline">AI driver</span></li>`);
    if (online) for (let i = humans; i < MAX_HUMANS; i++) rows.push('<li class="empty">Open player slot</li>');
    $('#players')!.innerHTML = rows.join('');
    $('#dcount')!.textContent = `Drivers (${humans + bots}/${MAX_GRID}) · players ${humans}/${MAX_HUMANS}`;
    root.querySelectorAll<HTMLElement>('.map-opt').forEach((el) => el.addEventListener('click', () => {
      if (room.isHost) { room.setSettings({ map: el.dataset.id!, weather: MAPS.find((m) => m.id === el.dataset.id)?.weather ? room.settings.weather : 'dry' }); render(); }
    }));
    const startBtn = $<HTMLButtonElement>('#start');
    if (startBtn) {
      const waiting = room.humans.filter((p) => !p.isHost && !p.ready).length;
      startBtn.disabled = waiting > 0;
      $('#hint')!.textContent = waiting > 0 ? `Waiting for ${waiting} driver(s) to get ready…` : online && humans === 1 ? 'Share the code above, or start now and race the AI.' : '';
    }
    const readyBtn = $<HTMLButtonElement>('#ready');
    if (readyBtn) {
      const me = room.self;
      readyBtn.textContent = me?.ready ? 'Not ready' : 'Ready';
      readyBtn.classList.toggle('ghost', !!me?.ready);
      $('#hint')!.textContent = me?.ready ? 'Waiting for the host to start…' : 'Press Ready when you are set.';
    }
  };
  render();
  room.onLobby = render;

  lapsSel.addEventListener('change', () => room.setSettings({ laps: Number(lapsSel.value) }));
  dmgSel.addEventListener('change', () => room.setSettings({ damage: dmgSel.value as Room['settings']['damage'] }));
  botsSel.addEventListener('change', () => { room.setSettings({ bots: Number(botsSel.value) }); render(); });
  weatherSel.addEventListener('change', () => room.setSettings({ weather: weatherSel.value as 'dry' | 'rain' }));
  $('#leave')!.addEventListener('click', h.leave);
  $('#start')?.addEventListener('click', h.start);
  $('#ready')?.addEventListener('click', () => { room.setReady(!room.self?.ready); render(); });

  if (online) {
    const copy = (txt: string, btn: HTMLButtonElement) => {
      navigator.clipboard?.writeText(txt).then(() => {
        const t = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = t), 1200);
      }).catch(() => {});
    };
    $<HTMLButtonElement>('#copy')!.addEventListener('click', (e) => copy(room.code, e.currentTarget as HTMLButtonElement));
    $<HTMLButtonElement>('#copylink')!.addEventListener('click', (e) => copy(link, e.currentTarget as HTMLButtonElement));
    const log = $('#chatlog')!;
    const chatIn = $<HTMLInputElement>('#chatin')!;
    for (const line of chatHistory) log.insertAdjacentHTML('beforeend', line);
    log.scrollTop = log.scrollHeight;
    room.onChat = (from, text) => {
      const p = room.players.find((x) => x.slot === from);
      const line = from < 0 ? `<div class="sys">${esc(text)}</div>` : `<div><b style="color:${esc(p?.color ?? '#fff')}">${esc(p?.nickname ?? '?')}:</b> ${esc(text)}</div>`;
      chatHistory.push(line);
      if (chatHistory.length > 60) chatHistory.shift();
      log.insertAdjacentHTML('beforeend', line);
      log.scrollTop = log.scrollHeight;
    };
    chatIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { room.chat(chatIn.value); chatIn.value = ''; }
    });
  }
}
const chatHistory: string[] = [];
export function resetChat() { chatHistory.length = 0; }

/** Fictional AI drivers: enough for a full 32-car grid with no repeats. */
export const BOT_NAMES = [
  'R. Castellano', 'J. Whitfield', 'M. Okafor', 'T. Lindqvist', 'D. Haverford', 'K. Mbeki', 'S. Ruiz', 'B. Kowalski',
  'A. Tanaka', 'L. Moreau', 'P. Varga', 'C. Delacroix', 'N. Brandt', 'E. Sorensen', 'F. Abernathy', 'G. Novak',
  'H. Iwata', 'I. Calloway', 'O. Rautio', 'V. Petrakis', 'W. Ashdown', 'Y. Nakamura', 'Z. Quintero', 'R. Holloway',
  'T. Mensah', 'S. Lindgren', 'M. Duarte', 'J. Prescott', 'K. Albrecht', 'D. Oyelaran', 'L. Fairbanks', 'A. Rostova',
];

// ---------------- results ----------------
export function resultsScreen(rows: ResultRow[], grid: GridEntry[], isHost: boolean, h: { lobby(): void; leave(): void }) {
  const name = (s: number) => grid.find((g) => g.slot === s);
  const winner = rows.find((r) => r.status === 1);
  const root = mount(`
    <div class="card wide">
      <h2>Race results</h2>
      ${winner ? `<p class="tag">🏁 Winner: <b>${esc(name(winner.slot)?.nickname ?? '?')}</b></p>` : ''}
      <div class="results-wrap"><table class="results">
        <tr><th>Pos</th><th>Car</th><th>Driver</th><th>Laps</th><th>Best lap</th><th>Time</th><th>Pen.</th><th>Status</th></tr>
        ${rows.map((r) => {
          const g = name(r.slot);
          return `<tr><td>${r.pos}</td><td><span class="num" style="background:${esc(g?.color ?? '#555')}">${g?.number ?? ''}</span></td><td>${esc(g?.nickname ?? '?')}${g?.bot ? ' <small>AI</small>' : ''}</td><td>${r.laps}</td><td>${fmtTime(r.best)}</td><td>${r.status === 1 ? fmtTime(r.total + (r.pen ?? 0)) : '—'}</td><td>${r.pen ? `+${r.pen}s` : ''}</td><td>${r.status === 1 ? 'Finished' : r.status === 2 ? 'DNF' : 'Running'}</td></tr>`;
        }).join('')}
      </table></div>
      <div class="row" style="margin-top:16px">
        <button class="btn ghost" id="leave">Leave</button>
        ${isHost ? '<button class="btn" id="lobby">Back to lobby</button>' : '<div class="note" style="align-self:center">Waiting for the host…</div>'}
      </div>
    </div>`);
  root.querySelector('#leave')!.addEventListener('click', h.leave);
  root.querySelector('#lobby')?.addEventListener('click', h.lobby);
}

// ---------------- garage / settings ----------------
export function garageScreen(back: () => void, onChange?: () => void) {
  const root = mount(`
    <div class="card wide">
      <h2>Garage &amp; settings</h2>
      <div class="room-grid">
        <div class="stack">
          <div><label>Car number</label><input id="num" type="text" maxlength="2" value="${profile.carNumber}" /></div>
          <div>
            <label>Livery colour</label>
            <div class="row" style="flex-wrap:wrap;gap:8px">${LIVERY_COLORS.map((c) => `<button class="swatch" data-c="${c}" style="flex:none;width:36px;height:36px;border-radius:8px;border:2px solid ${c === profile.color ? '#ffcc00' : 'rgba(255,255,255,.15)'};background:${c};cursor:pointer"></button>`).join('')}</div>
          </div>
          <div><label>Units</label><select id="units"><option value="mph">mph</option><option value="kmh">km/h</option></select></div>
        </div>
        <div class="stack">
          <div><label>Graphics quality</label><select id="q">${(['low', 'medium', 'high', 'ultra'] as Quality[]).map((q) => `<option value="${q}">${q[0].toUpperCase() + q.slice(1)}</option>`).join('')}</select></div>
          <div class="row">
            <div><label>Gearbox</label><select id="gears"><option value="auto">Automatic</option><option value="manual">Manual (Q/E)</option></select></div>
            <div><label>Traction ctrl</label><select id="tc"><option value="1">On</option><option value="0">Off</option></select></div>
          </div>
          <div class="row">
            <div><label>ABS</label><select id="abs"><option value="1">On</option><option value="0">Off</option></select></div>
            <div><label>Racing line</label><select id="line"><option value="0">Off</option><option value="1">On</option></select></div>
          </div>
          <div class="row">
            <div><label>Volume</label><select id="vol">${[0, 0.25, 0.5, 0.7, 1].map((v) => `<option value="${v}">${Math.round(v * 100)}%</option>`).join('')}</select></div>
          </div>
        </div>
      </div>
      <div class="row" style="margin-top:18px"><button class="btn" id="done">Done</button></div>
    </div>`);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  $<HTMLSelectElement>('#units').value = settings.units;
  $<HTMLSelectElement>('#q').value = settings.quality;
  $<HTMLSelectElement>('#gears').value = settings.manualGears ? 'manual' : 'auto';
  $<HTMLSelectElement>('#tc').value = settings.tractionControl ? '1' : '0';
  $<HTMLSelectElement>('#abs').value = settings.abs ? '1' : '0';
  $<HTMLSelectElement>('#line').value = settings.racingLine ? '1' : '0';
  $<HTMLSelectElement>('#vol').value = String(settings.volume);
  root.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) => b.addEventListener('click', () => {
    profile.color = b.dataset.c!;
    root.querySelectorAll<HTMLButtonElement>('.swatch').forEach((x) => (x.style.borderColor = x === b ? '#ffcc00' : 'rgba(255,255,255,.15)'));
  }));
  $('#done').addEventListener('click', () => {
    const n = parseInt($<HTMLInputElement>('#num').value, 10);
    if (n >= 0 && n <= 99) profile.carNumber = n;
    settings.units = $<HTMLSelectElement>('#units').value as 'mph' | 'kmh';
    settings.quality = $<HTMLSelectElement>('#q').value as Quality;
    settings.manualGears = $<HTMLSelectElement>('#gears').value === 'manual';
    settings.tractionControl = $<HTMLSelectElement>('#tc').value === '1';
    settings.abs = $<HTMLSelectElement>('#abs').value === '1';
    settings.racingLine = $<HTMLSelectElement>('#line').value === '1';
    settings.volume = Number($<HTMLSelectElement>('#vol').value);
    saveProfile();
    saveSettings();
    onChange?.();
    back();
  });
}

// ---------------- loading / pause ----------------
export function loadingScreen(msg: string) {
  const el = ui().querySelector('.loading');
  if (el) { el.textContent = msg; return; }
  mount(`<div class="card"><div class="loading">${esc(msg)}</div><p class="note">Generating track, textures and scenery…</p></div>`);
}

export function pauseScreen(api: { resume(): void; reset(): void; exit(): void; settings(): void }, online: boolean) {
  const root = mount(`
    <div class="card pause">
      <h2>Paused</h2>
      ${online ? '<p class="note">Online race: the race keeps running while this menu is open.</p>' : ''}
      <div class="keys">
        <kbd>W / ↑</kbd><span>Throttle</span>
        <kbd>S / ↓</kbd><span>Brake (hold when stopped to reverse)</span>
        <kbd>A D / ← →</kbd><span>Steer</span>
        <kbd>Q / E</kbd><span>Shift down / up (manual), M toggles</span>
        <kbd>C</kbd><span>Change camera / next car when spectating</span>
        <kbd>Mouse drag</kbd><span>Hold a mouse button and drag to look around the car</span>
        <kbd>Hold R 3s</kbd><span>Reset to track (5 s penalty in a race) · new car in practice</span>
        <kbd>F3</kbd><span>Debug overlay</span>
        <kbd>Gamepad</kbd><span>Stick steer, RT/LT throttle/brake, LB/RB shift, Y cam, hold X reset</span>
      </div>
      <button class="btn block" id="resume">Resume</button>
      <button class="btn ghost block" id="reset">Reset car</button>
      <button class="btn ghost block" id="settings">Settings</button>
      <button class="btn red block" id="exit">${online ? 'Leave race' : 'Quit to menu'}</button>
    </div>`);
  root.querySelector('#resume')!.addEventListener('click', api.resume);
  root.querySelector('#reset')!.addEventListener('click', api.reset);
  root.querySelector('#settings')!.addEventListener('click', api.settings);
  root.querySelector('#exit')!.addEventListener('click', api.exit);
}
