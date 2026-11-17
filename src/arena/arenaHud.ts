import { settings } from '../core/profile';
import { ABILITIES, ABILITY_INFO, type AbilityId } from './abilities';
import type { Zone } from './classes';

/**
 * Combat HUD for the Demolition Arena, in the racing HUD's visual style.
 *  top:          match timer · vehicles left · position · eliminations (+ active modifiers)
 *  bottom left:  health bar and damage stage, engine, armour diagram, speed
 *  bottom right: Nitro / Ram / Shockwave tiles with cooldown rings
 *  overlays:     countdown, FIGHT / FINAL TWO banners, kill feed, low-health vignette,
 *                critical-engine warning, hit-direction and incoming-car indicators
 */
export interface ArenaHudState {
  timer: number;
  alive: number;
  total: number;
  position: number;
  kills: number;
  hp: number;
  stage: number;
  engine: number;
  armor: Record<Zone, number>;
  speed: number;
  abilities: { id: AbilityId; progress: number; active: boolean; uses?: number }[];
  countdown: string;
  banner: string;
  bannerColor: string;
  feed: string[];
  lowHealth: boolean;
  criticalEngine: boolean;
  /** Direction of the last hit / of an incoming car, in radians relative to our heading (0 = ahead). */
  hitDir: number | null;
  incoming: number | null;
  status: string;
  modifiers: string[];
}

const STAGE_LABEL = ['', 'MINOR DAMAGE', 'MODERATE DAMAGE', 'SEVERE DAMAGE', 'CRITICAL', 'DESTROYED'];
const STAGE_COLOR = ['', '#3ad17a', '#c6d83a', '#f59e0b', '#ef4444', '#555'];
const ICON: Record<AbilityId, string> = { nitro: '🔥', ram: '🛡', shock: '💥' };

export class ArenaHud {
  private els: Record<string, HTMLElement> = {};
  private feedKey = '';

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="ah-top">
        <div class="ah-stat"><b data-k="timer">0:00</b><span>TIME</span></div>
        <div class="ah-stat"><b data-k="alive">0/0</b><span>VEHICLES</span></div>
        <div class="ah-stat"><b data-k="pos">#1</b><span>POSITION</span></div>
        <div class="ah-stat"><b data-k="kills">0</b><span>ELIMINATIONS</span></div>
      </div>
      <div class="ah-mods" data-k="mods"></div>
      <div class="ah-feed" data-k="feed"></div>
      <div class="ah-center">
        <div class="ah-cd" data-k="cd"></div>
        <div class="ah-banner" data-k="banner"></div>
        <div class="ah-status" data-k="status"></div>
      </div>
      <div class="ah-vignette" data-k="vig"></div>
      <div class="ah-hit" data-k="hit"></div>
      <div class="ah-incoming" data-k="inc">▲<small>INCOMING</small></div>
      <div class="ah-bl">
        <div class="ah-stage" data-k="stage">MINOR DAMAGE</div>
        <div class="ah-hp"><div data-k="hpbar"></div><span data-k="hptext">1000</span></div>
        <div class="ah-row">
          <svg viewBox="0 0 40 60" class="ah-armor">
            <rect data-z="front" x="6" y="1" width="28" height="9" rx="2"/>
            <rect data-z="left" x="1" y="12" width="7" height="36" rx="2"/>
            <rect data-z="right" x="32" y="12" width="7" height="36" rx="2"/>
            <rect data-z="rear" x="6" y="50" width="28" height="9" rx="2"/>
            <rect x="10" y="13" width="20" height="34" rx="3" fill="rgba(255,255,255,0.12)"/>
          </svg>
          <div class="ah-bars">
            <div><span>ENGINE</span><i><b data-k="eng"></b></i></div>
            <div class="ah-warn" data-k="warn"></div>
          </div>
          <div class="ah-speed" data-k="spd">0<small>MPH</small></div>
        </div>
      </div>
      <div class="ah-br">${ABILITIES.map((id) => `
        <div class="ah-ab" data-a="${id}">
          <div class="ah-ring"></div>
          <div class="ah-icon">${ICON[id]}</div>
          <div class="ah-name">${ABILITY_INFO[id].name}</div>
          <div class="ah-key">${ABILITY_INFO[id].key}</div>
          <div class="ah-uses"></div>
        </div>`).join('')}
      </div>
      <div class="ah-hint">W/S drive · A/D steer · C camera · Esc pause</div>`;
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.els[e.dataset.k!] = e));
  }

  show(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  update(s: ArenaHudState) {
    const e = this.els;
    const m = Math.floor(s.timer / 60), sec = Math.floor(s.timer % 60);
    e.timer.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    e.alive.textContent = `${s.alive}/${s.total}`;
    e.pos.textContent = `#${s.position}`;
    e.kills.textContent = String(s.kills);
    e.mods.textContent = s.modifiers.join(' · ');
    e.cd.textContent = s.countdown;
    e.cd.style.display = s.countdown ? '' : 'none';
    e.banner.textContent = s.banner;
    e.banner.style.color = s.bannerColor;
    e.status.textContent = s.status;
    const key = s.feed.join('|');
    if (key !== this.feedKey) { this.feedKey = key; e.feed.innerHTML = s.feed.map((l) => `<div>${l}</div>`).join(''); }

    // health
    const frac = Math.max(0, s.hp / 1000);
    e.hpbar.style.width = `${frac * 100}%`;
    e.hpbar.style.background = STAGE_COLOR[s.stage];
    e.hptext.textContent = String(Math.ceil(s.hp));
    e.stage.textContent = STAGE_LABEL[s.stage];
    e.stage.style.color = STAGE_COLOR[s.stage];
    e.eng.style.width = `${s.engine * 100}%`;
    e.eng.style.background = s.engine > 0.6 ? '#3ad17a' : s.engine > 0.35 ? '#f59e0b' : '#ef4444';
    e.warn.textContent = s.criticalEngine ? 'ENGINE OVERHEATING' : s.lowHealth ? 'LOW HEALTH' : '';
    this.root.querySelectorAll<SVGRectElement>('rect[data-z]').forEach((r) => {
      const v = s.armor[r.dataset.z as Zone];
      r.style.fill = v > 0.66 ? '#9aa3b2' : v > 0.33 ? '#f59e0b' : '#ef4444';
    });
    const mph = settings.units === 'mph';
    e.spd.innerHTML = `${Math.round(Math.abs(s.speed) * (mph ? 2.237 : 3.6))}<small>${mph ? 'MPH' : 'KM/H'}</small>`;
    e.vig.style.opacity = s.lowHealth ? String(0.35 + 0.25 * Math.sin(performance.now() / 180)) : '0';

    // abilities: conic cooldown ring, glow while active
    for (const a of s.abilities) {
      const el = this.root.querySelector<HTMLElement>(`.ah-ab[data-a="${a.id}"]`)!;
      const ring = el.querySelector<HTMLElement>('.ah-ring')!;
      const ready = a.progress >= 1;
      ring.style.background = `conic-gradient(${ready ? '#ffcc00' : '#6b7280'} ${a.progress * 360}deg, rgba(0,0,0,0.55) 0)`;
      el.classList.toggle('ready', ready);
      el.classList.toggle('active', a.active);
      el.querySelector<HTMLElement>('.ah-uses')!.textContent = a.uses !== undefined ? `×${a.uses}` : '';
    }

    // direction indicators (rotate an arrow around the screen centre)
    e.hit.style.display = s.hitDir === null ? 'none' : '';
    if (s.hitDir !== null) e.hit.style.transform = `translate(-50%, -50%) rotate(${-s.hitDir}rad)`;
    e.inc.style.display = s.incoming === null ? 'none' : '';
    if (s.incoming !== null) e.inc.style.transform = `translate(-50%, -50%) rotate(${-s.incoming}rad) translateY(-150px)`;
  }
}
