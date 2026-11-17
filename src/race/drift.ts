/**
 * Drift scoring. While the car slides (body slip angle above ~12° at over ~30 km/h) it earns
 * points every second from angle × speed. Linked drifts build a combo: the multiplier climbs one
 * step every 2.5 s of drifting (up to ×5), and a combo survives short straight bits (1.3 s) so
 * transitions keep it alive. When the combo ends its points × multiplier are banked. Hitting a
 * wall during a combo loses it.
 */
export const DRIFT = {
  minAngle: 10, // degrees
  minSpeed: 7, // m/s
  chainGap: 2, // s without drifting before a combo is banked
  multEvery: 2, // s of drifting per multiplier step
  maxMult: 5,
};

export interface DriftState {
  total: number;
  /** Points of the combo in progress (before the multiplier). */
  combo: number;
  mult: number;
  angle: number; // degrees, current
  drifting: boolean;
  best: number; // best banked combo (after multiplier)
}

export class DriftScorer {
  total = 0;
  combo = 0;
  mult = 1;
  best = 0;
  angle = 0;
  drifting = false;
  private driftT = 0; // drifting time inside this combo
  private gapT = 0;
  private flash: { text: string; color: string; t: number } | null = null;

  /** Per frame: slip angle (rad, signed), forward speed (m/s), and whether the car hit a wall hard this frame. */
  update(dt: number, slip: number, speed: number, crashed: boolean, active: boolean) {
    this.angle = Math.abs(slip) * 57.3;
    if (this.flash) { this.flash.t -= dt; if (this.flash.t <= 0) this.flash = null; }
    if (!active) { this.drifting = false; return; }
    if (crashed && this.combo > 0) {
      this.say(`WALL! −${Math.round(this.combo * this.mult)}`, '#ff4d4d');
      this.reset();
      return;
    }
    this.drifting = this.angle > DRIFT.minAngle && this.angle < 120 && speed > DRIFT.minSpeed;
    if (this.drifting) {
      this.gapT = 0;
      this.driftT += dt;
      // more angle and more speed = more points; a little bonus for the big-angle sweet spot
      const sweet = this.angle > 30 && this.angle < 70 ? 1.25 : 1;
      this.combo += (this.angle - DRIFT.minAngle * 0.8) * speed * 0.45 * sweet * dt;
      const m = Math.min(DRIFT.maxMult, 1 + Math.floor(this.driftT / DRIFT.multEvery));
      if (m > this.mult) this.say(`×${m} COMBO`, '#ffcc00');
      this.mult = m;
    } else if (this.combo > 0) {
      this.gapT += dt;
      if (this.gapT > DRIFT.chainGap) this.bank();
    }
  }

  /** End the combo and add it to the total. */
  bank() {
    if (this.combo <= 0) return;
    const pts = Math.round(this.combo * this.mult);
    this.total += pts;
    this.best = Math.max(this.best, pts);
    const hype = pts > 40000 ? 'LEGENDARY DRIFT! ' : pts > 20000 ? 'INSANE DRIFT! ' : pts > 8000 ? 'GREAT DRIFT! ' : pts > 2500 ? 'NICE! ' : '';
    this.say(`${hype}+${pts.toLocaleString()}`, pts > 20000 ? '#ff4fd8' : pts > 8000 ? '#3ad17a' : '#ffffff');
    this.reset();
  }

  private reset() { this.combo = 0; this.mult = 1; this.driftT = 0; this.gapT = 0; }
  private say(text: string, color: string) { this.flash = { text, color, t: 1.6 }; }

  get message() { return this.flash; }
  state(): DriftState { return { total: this.total, combo: this.combo, mult: this.mult, angle: this.angle, drifting: this.drifting, best: this.best }; }
}

/** Drift HUD: score, combo, angle meter, time left and the live leaderboard. */
export class DriftHud {
  private el: HTMLDivElement;
  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'drift-hud';
    this.el.innerHTML = `
      <div class="dh-time"><b data-k="time">3:00</b><span>TIME LEFT</span></div>
      <div class="dh-score"><b data-k="total">0</b><span>DRIFT SCORE</span></div>
      <div class="dh-combo" data-k="combo"><b data-k="cpts">0</b><i data-k="mult">×1</i></div>
      <div class="dh-angle"><div class="dh-angle-bar"><i data-k="abar"></i></div><span data-k="angle">0°</span></div>
      <div class="dh-flash" data-k="flash"></div>
      <ol class="dh-board" data-k="board"></ol>`;
    root.appendChild(this.el);
  }
  private q(k: string) { return this.el.querySelector<HTMLElement>(`[data-k="${k}"]`)!; }
  update(s: DriftState, timeLeft: number, msg: { text: string; color: string } | null, board: { name: string; score: number; self: boolean }[]) {
    const t = Math.max(0, Math.ceil(timeLeft));
    this.q('time').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.q('time').classList.toggle('low', timeLeft < 15);
    this.q('total').textContent = Math.round(s.total).toLocaleString();
    const combo = this.q('combo');
    combo.classList.toggle('on', s.combo > 0);
    this.q('cpts').textContent = Math.round(s.combo).toLocaleString();
    this.q('mult').textContent = `×${s.mult}`;
    const a = Math.min(90, s.angle);
    this.q('angle').textContent = `${Math.round(a)}°`;
    const bar = this.q('abar');
    bar.style.width = `${(a / 90) * 100}%`;
    bar.style.background = s.drifting ? (a > 30 && a < 70 ? '#3ad17a' : '#ffcc00') : '#555';
    const f = this.q('flash');
    f.textContent = msg?.text ?? '';
    f.style.color = msg?.color ?? '#fff';
    this.q('board').innerHTML = board.slice(0, 8).map((b, i) => `<li class="${b.self ? 'me' : ''}"><span>${i + 1}. ${b.name.replace(/[<>&]/g, '')}</span><b>${Math.round(b.score).toLocaleString()}</b></li>`).join('');
  }
  show(on: boolean) { this.el.style.display = on ? '' : 'none'; }
  dispose() { this.el.remove(); }
}
