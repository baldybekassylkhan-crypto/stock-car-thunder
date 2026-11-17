import type { Track } from '../tracks/track';
import type { CarTelemetry } from '../vehicle/car';
import { COMPOUNDS, type Compound } from '../vehicle/tyres';
import type { CarDamage, PanelName } from '../damage/damage';
import type { Flag } from '../race/race';
import { fmtTime } from '../core/progress';
import { settings } from '../core/profile';

export interface TowerRow {
  pos: number;
  number: number;
  color: string;
  name: string;
  gap: string;
  self: boolean;
  status: 0 | 1 | 2;
  ping?: number;
}

export interface HudState {
  telemetry: CarTelemetry;
  lap: number;
  totalLaps: number;
  position: number;
  cars: number;
  current: number;
  last: number;
  best: number;
  camera: string;
  banner: string;
  bannerColor?: string;
  flag: Flag;
  countdown: number;
  tower: TowerRow[];
  damage: CarDamage | null;
  draft: number;
  spotter: string;
  penalty: number;
  /** Time penalties (s) added to the player's race time. */
  timePenalty: number;
  /** Pit plan menu lines (B to open), or null. */
  pitMenu: string[] | null;
  blue: boolean;
  localYellow: boolean;
  tyres: { temp: number[]; wear: number[]; compound: Compound; window: [number, number] };
  fuel: number;
  fuelLaps: number;
  status: string;
  markers: { x: number; z: number; color: string; self: boolean }[];
  debug: string | null;
}

const FLAG_COLORS: Record<Flag, string> = { none: 'transparent', green: '#22c55e', yellow: '#facc15', white: '#f5f5f5', checkered: 'repeating-conic-gradient(#111 0 25%, #fff 0 50%) 0 0 / 14px 14px' };

const PANEL_RECTS: Record<PanelName, [number, number, number, number]> = {
  // x, y, w, h in a 60×120 top-down view (front at top)
  bumperF: [8, 2, 44, 8], hood: [12, 12, 36, 22], fenderFL: [2, 12, 9, 24], fenderFR: [49, 12, 9, 24],
  doorL: [2, 40, 9, 34], doorR: [49, 40, 9, 34], roof: [14, 42, 32, 30], quarterL: [2, 78, 9, 26],
  quarterR: [49, 78, 9, 26], deck: [12, 92, 36, 16], bumperR: [8, 110, 44, 8],
};

export class Hud {
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private map: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private bounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
  private trackPath: Path2D | null = null;
  private panelEls: Partial<Record<PanelName, SVGRectElement>> = {};
  private towerKey = '';

  constructor(root: HTMLElement) {
    this.root = root;
    const panels = Object.entries(PANEL_RECTS).map(([k, [x, y, w, h]]) => `<rect data-p="${k}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`).join('');
    root.innerHTML = `
      <div class="hud-tl">
        <div class="pos" data-k="pos">P1<small>/1</small></div>
        <div class="lap" data-k="lap">LAP 0</div>
        <div class="times" style="margin-top:8px">
          <div class="cur" data-k="cur">--:--.---</div>
          <div><b>LAST</b><span data-k="last">--:--.---</span></div>
          <div><b>BEST</b><span data-k="best">--:--.---</span></div>
        </div>
        <div class="tower" data-k="tower"></div>
      </div>
      <div class="hud-tc">
        <div class="flag" data-k="flag"></div>
        <div class="flagnote" data-k="flagnote"></div>
        <div class="banner" data-k="banner"></div>
        <div class="countdown" data-k="cd"></div>
        <div class="spotter" data-k="spot"></div>
        <div class="status" data-k="status"></div>
      </div>
      <div class="hud-tr"><canvas class="minimap" width="440" height="320"></canvas></div>
      <div class="hud-br">
        <div class="dmg">
          <svg viewBox="0 0 60 120" class="dmg-car">${panels}</svg>
          <div class="dmg-bars">
            <div><span>ENG</span><i><b data-k="eng"></b></i></div>
            <div><span>TEMP</span><i><b data-k="temp"></b></i></div>
            <div><span>TIRES</span><i><b data-k="tires"></b></i></div>
            <div class="draft" data-k="draft">DRAFT</div>
          </div>
        </div>
        <div class="gp">
          <div class="tyremap" title="Tyre temperature and wear">
            <i data-t="0"></i><i data-t="1"></i><b data-k="cmp">M</b><i data-t="2"></i><i data-t="3"></i>
          </div>
          <div class="gp-bars">
            <div data-k="ersrow"><span>ERS</span><i><b data-k="ers"></b></i></div>
            <div><span>FUEL</span><em data-k="fuel"></em></div>
            <div class="drs" data-k="drs">DRS</div>
          </div>
        </div>
        <div><span class="gear" data-k="gear">1</span><span class="speed" data-k="spd">0<small>MPH</small></span></div>
        <div class="rpm" data-k="rpmwrap"><div data-k="rpm"></div></div>
        <div class="hint" data-k="hint"></div>
      </div>
      <div class="pitmenu" data-k="pitmenu" style="display:none"></div>
      <div class="hud-bl hint">W/S throttle · brake &nbsp; A/D steer &nbsp; B pit plan &nbsp; C camera &nbsp; drag mouse to look &nbsp; hold R reset &nbsp; Esc pause &nbsp; F3 debug</div>
      <div class="debug" data-k="debug" style="display:none"></div>`;
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.els[e.dataset.k!] = e));
    root.querySelectorAll<SVGRectElement>('rect[data-p]').forEach((r) => (this.panelEls[r.dataset.p as PanelName] = r));
    this.map = root.querySelector('canvas')!;
    this.mapCtx = this.map.getContext('2d')!;
  }

  setTrack(track: Track) {
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of track.center) { b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x); b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z); }
    this.bounds = b;
    const path = new Path2D();
    track.center.forEach((p, i) => { const [x, y] = this.project(p.x, p.z); if (i) path.lineTo(x, y); else path.moveTo(x, y); });
    path.closePath();
    this.trackPath = path;
  }

  private project(x: number, z: number): [number, number] {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const W = this.map.width, H = this.map.height, pad = 34;
    const s = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
    return [W / 2 + (x - (minX + maxX) / 2) * s, H / 2 + (z - (minZ + maxZ) / 2) * s];
  }

  show(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  update(s: HudState) {
    const e = this.els;
    const t = s.telemetry;
    const mph = settings.units === 'mph';
    const spd = Math.abs(t.speed) * (mph ? 2.23694 : 3.6);
    e.spd.innerHTML = `${Math.round(spd)}<small>${mph ? 'MPH' : 'KM/H'}</small>`;
    e.gear.textContent = t.gear === -1 ? 'R' : String(t.gear);
    e.rpm.style.width = `${Math.min(100, (t.rpm / (t.maxRpm * 1.02)) * 100)}%`;
    e.rpmwrap.classList.toggle('limit', t.limiter);
    e.pos.innerHTML = `P${s.position}<small>/${s.cars}</small>`;
    e.lap.textContent = s.totalLaps ? `LAP ${Math.min(s.totalLaps, Math.max(1, s.lap))} / ${s.totalLaps}` : s.lap ? `LAP ${s.lap}` : 'OUT LAP';
    e.cur.textContent = fmtTime(s.current);
    e.last.textContent = fmtTime(s.last);
    e.best.textContent = fmtTime(s.best);
    e.hint.textContent = `${s.camera} cam`;
    e.banner.textContent = s.banner;
    e.banner.style.color = s.bannerColor ?? '';
    // blue and local yellow flags are shown to this driver on top of the race flag
    const flagBg = s.blue ? '#2563eb' : s.localYellow ? FLAG_COLORS.yellow : FLAG_COLORS[s.flag];
    e.flag.style.background = flagBg;
    e.flag.style.display = s.flag === 'none' && !s.blue ? 'none' : '';
    e.flagnote.textContent = s.blue ? 'BLUE FLAG' : s.localYellow ? 'LOCAL YELLOW' : '';
    e.cd.textContent = s.countdown > 0 ? String(Math.ceil(s.countdown - 1) || 'GO') : '';
    e.cd.style.display = s.countdown > 0 ? '' : 'none';
    if (s.countdown > 0 && s.countdown < 1) e.cd.textContent = 'GO!';
    e.spot.textContent = s.spotter;
    e.status.textContent = s.penalty > 0 ? `PENALTY ${s.penalty.toFixed(1)}s` : s.status || (s.timePenalty > 0 ? `+${s.timePenalty}s TIME PENALTY` : '');

    e.pitmenu.style.display = s.pitMenu ? '' : 'none';
    if (s.pitMenu) {
      const html = s.pitMenu.map((l, k) => `<div${k === 0 ? ' class="pm-head"' : ''}>${escapeHtml(l)}</div>`).join('');
      if (e.pitmenu.innerHTML !== html) e.pitmenu.innerHTML = html;
    }

    // tyres: colour = temperature against the compound's window, number = wear
    const ty = s.tyres;
    const [lo, hi] = ty.window;
    this.root.querySelectorAll<HTMLElement>('.tyremap i').forEach((el) => {
      const k = Number(el.dataset.t);
      const T = ty.temp[k];
      el.style.background = T < lo - 8 ? '#3b82f6' : T < lo ? '#60c0f0' : T <= hi ? '#3ad17a' : T <= hi + 12 ? '#f59e0b' : '#ef4444';
      el.textContent = String(Math.round((1 - ty.wear[k]) * 100));
    });
    const cmp = COMPOUNDS[ty.compound];
    e.cmp.textContent = cmp.tag;
    e.cmp.style.borderColor = cmp.color;
    e.fuel.textContent = `${s.fuel.toFixed(1)} kg · ${s.fuelLaps >= 99 ? '99+' : s.fuelLaps.toFixed(1)} laps`;
    const hasErs = !Number.isNaN(t.battery);
    e.ersrow.style.display = hasErs ? '' : 'none';
    if (hasErs) {
      e.ers.style.width = `${Math.round(t.battery * 100)}%`;
      e.ers.style.background = t.boosting ? '#f0f' : '#a855f7';
    }
    e.drs.style.display = hasErs ? '' : 'none';
    e.drs.className = `drs ${t.drs === 2 ? 'open' : t.drs === 1 ? 'avail' : ''}`;
    e.debug.style.display = s.debug ? '' : 'none';
    if (s.debug) e.debug.textContent = s.debug;
    e.draft.classList.toggle('on', s.draft > 0.05);
    e.draft.style.opacity = String(0.25 + Math.min(1, s.draft / 0.3) * 0.75);

    // damage diagram
    const d = s.damage;
    if (d) {
      for (const [k, el] of Object.entries(this.panelEls)) {
        const v = Math.min(1, d.panels[k as PanelName]);
        el.style.fill = v < 0.05 ? 'rgba(255,255,255,0.18)' : `hsl(${50 - v * 50}, 90%, ${55 - v * 15}%)`;
      }
      const bar = (el: HTMLElement, v: number, invert = false) => {
        el.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
        const good = invert ? 1 - v : v;
        el.style.background = good > 0.6 ? '#3ad17a' : good > 0.3 ? '#ffcc00' : '#ff3b30';
      };
      bar(e.eng, d.engine);
      bar(e.temp, (d.engineTemp - 80) / 80, true);
      bar(e.tires, 1 - d.punctured.filter(Boolean).length / 4 - d.wheelsLost / 4);
    }

    // leaderboard tower (rebuild only when it changes)
    const key = s.tower.map((r) => `${r.pos}|${r.number}|${r.gap}|${r.status}|${r.self}`).join(';');
    if (key !== this.towerKey) {
      this.towerKey = key;
      e.tower.innerHTML = compactTower(s.tower)
        .map((r) => r === null ? '<div class="trow gap">⋯</div>' : `<div class="trow ${r.self ? 'me' : ''} ${r.status === 2 ? 'dnf' : ''}"><span class="tp">${r.pos}</span><span class="tn" style="background:${r.color}">${r.number}</span><span class="tname">${escapeHtml(r.name)}</span><span class="tg">${r.status === 2 ? 'OUT' : r.status === 1 ? '🏁' : r.gap}</span></div>`)
        .join('');
    }

    const ctx = this.mapCtx;
    ctx.clearRect(0, 0, this.map.width, this.map.height);
    if (this.trackPath) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 14; ctx.stroke(this.trackPath);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 7; ctx.stroke(this.trackPath);
    }
    for (const m of s.markers) {
      const [x, y] = this.project(m.x, m.z);
      ctx.beginPath(); ctx.arc(x, y, m.self ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = m.color; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = m.self ? '#ffcc00' : '#000'; ctx.stroke();
    }
  }
}

/** Big grids: the top 5, then the cars around the player (±3), with gap markers in between. */
const TOWER_FULL = 12;
function compactTower(rows: TowerRow[]): (TowerRow | null)[] {
  if (rows.length <= TOWER_FULL) return rows;
  const me = Math.max(0, rows.findIndex((r) => r.self));
  const keep = new Set<number>();
  for (let i = 0; i < 5; i++) keep.add(i);
  for (let i = Math.max(0, me - 3); i <= Math.min(rows.length - 1, me + 3); i++) keep.add(i);
  const out: (TowerRow | null)[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) out.push(null);
    out.push(rows[i]);
    last = i;
  }
  if (last < rows.length - 1) out.push(null);
  return out;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
