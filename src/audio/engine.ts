/** Synthesised V8 engine + tire squeal + wind (sample-free). Milestone 7 will add recorded layers. */
export class EngineAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private oscA: OscillatorNode;
  private oscB: OscillatorNode;
  private oscC: OscillatorNode;
  private filter: BiquadFilterNode;
  private engineGain: GainNode;
  private squealGain: GainNode;
  private squealFilter: BiquadFilterNode;
  private windGain: GainNode;
  private windFilter: BiquadFilterNode;
  private scrapeGain: GainNode;
  private scrapeFilter: BiquadFilterNode;
  private noiseBuf: AudioBuffer;
  private lastImpact = 0;
  /** 0..1 engine damage: makes the note rough and misfiring. */
  damage = 0;

  constructor(volume: number) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(this.ctx.destination);

    const shaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.6); }
    shaper.curve = curve;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 3;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.2;
    const mix = this.ctx.createGain();
    mix.gain.value = 0.5;
    this.oscA = this.ctx.createOscillator(); this.oscA.type = 'sawtooth';
    this.oscB = this.ctx.createOscillator(); this.oscB.type = 'square';
    this.oscC = this.ctx.createOscillator(); this.oscC.type = 'sawtooth';
    const gB = this.ctx.createGain(); gB.gain.value = 0.35;
    const gC = this.ctx.createGain(); gC.gain.value = 0.25;
    this.oscA.connect(mix); this.oscB.connect(gB).connect(mix); this.oscC.connect(gC).connect(mix);
    mix.connect(shaper).connect(this.filter).connect(this.engineGain).connect(this.master);

    const noise = this.noiseSource();
    this.squealFilter = this.ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1400;
    this.squealFilter.Q.value = 12;
    this.squealGain = this.ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(this.squealFilter).connect(this.squealGain).connect(this.master);

    const noise2 = this.noiseSource();
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    noise2.connect(this.windFilter).connect(this.windGain).connect(this.master);

    const noise3 = this.noiseSource();
    this.scrapeFilter = this.ctx.createBiquadFilter();
    this.scrapeFilter.type = 'bandpass';
    this.scrapeFilter.frequency.value = 2400;
    this.scrapeFilter.Q.value = 4;
    this.scrapeGain = this.ctx.createGain();
    this.scrapeGain.gain.value = 0;
    noise3.connect(this.scrapeFilter).connect(this.scrapeGain).connect(this.master);
    this.noiseBuf = (noise3 as AudioBufferSourceNode).buffer!;

    this.oscA.start(); this.oscB.start(); this.oscC.start();
  }

  /** Metal-on-metal / wall scrape loudness 0..1 (continuous). */
  scrape(level: number) {
    const t = this.ctx.currentTime;
    this.scrapeGain.gain.setTargetAtTime(Math.min(1, level) * 0.35, t, 0.04);
    this.scrapeFilter.frequency.setTargetAtTime(1800 + Math.random() * 1500, t, 0.05);
  }

  /** One-shot crunch: strength 0..1 (+ distance attenuation already applied). */
  impact(strength: number) {
    const now = this.ctx.currentTime;
    if (strength < 0.04 || now - this.lastImpact < 0.07) return;
    this.lastImpact = now;
    const s = Math.min(1, strength);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600 + s * 3000;
    const ring = this.ctx.createBiquadFilter();
    ring.type = 'peaking';
    ring.frequency.value = 300 + Math.random() * 500;
    ring.Q.value = 6;
    ring.gain.value = 12;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9 * s, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25 + s * 0.6);
    src.connect(lp).connect(ring).connect(g).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 1.2);
  }

  /** Big boom with a long rumble tail. */
  explosion(volume: number) {
    const now = this.ctx.currentTime;
    const v = Math.min(1, volume);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2500, now);
    lp.frequency.exponentialRampToValueAtTime(120, now + 2.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1.6 * v, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 3.5);
    src.connect(lp).connect(g).connect(this.master);
    src.start(now);
    src.stop(now + 3.6);
    const thump = this.ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90, now);
    thump.frequency.exponentialRampToValueAtTime(30, now + 0.8);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(1.2 * v, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 1);
    thump.connect(tg).connect(this.master);
    thump.start(now);
    thump.stop(now + 1.1);
  }

  private noiseSource() {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    return src;
  }

  resume() { void this.ctx.resume(); }
  suspend() { void this.ctx.suspend(); }
  setVolume(v: number) { this.master.gain.value = v; }

  update(rpm: number, throttle: number, slip: number, speed: number, limiter: boolean) {
    const t = this.ctx.currentTime;
    const fire = (rpm / 60) * 4; // V8 firing frequency
    const misfire = this.damage > 0.3 && Math.random() < this.damage * 0.35;
    const wob = (limiter ? (Math.random() < 0.5 ? 0.6 : 1) : 1) * (misfire ? 0.25 : 1) * (rpm < 50 ? 0 : 1);
    this.oscA.frequency.setTargetAtTime(fire / 2, t, 0.02);
    this.oscB.frequency.setTargetAtTime(fire / 4, t, 0.02);
    this.oscC.frequency.setTargetAtTime(fire * 1.005, t, 0.02);
    this.filter.frequency.setTargetAtTime(400 + throttle * 2200 + rpm * 0.25, t, 0.05);
    this.engineGain.gain.setTargetAtTime((0.09 + throttle * 0.16) * wob, t, 0.03);
    const sq = Math.max(0, Math.min(1, (slip - 0.6) * 1.2)) * Math.min(1, Math.abs(speed) / 6);
    this.squealGain.gain.setTargetAtTime(sq * 0.22, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(1100 + sq * 700, t, 0.1);
    const ws = Math.min(1, Math.abs(speed) / 90);
    this.windGain.gain.setTargetAtTime(ws * ws * 0.25, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + ws * 1500, t, 0.1);
  }

  dispose() { void this.ctx.close(); }
}
