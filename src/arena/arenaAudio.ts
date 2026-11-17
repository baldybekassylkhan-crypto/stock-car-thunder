/**
 * Arena sound on top of the engine audio (engine, impacts, scrapes, explosions come from
 * EngineAudio): a crowd that roars with the action, an announcer (the browser's speech
 * synthesis, no assets needed), and synthesized stings for FINAL TWO, shockwaves, repairs, nitro.
 */
export class ArenaAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private crowdGain: GainNode;
  private crowdFilter: BiquadFilterNode;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(volume: number) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(this.ctx.destination);
    // crowd: looping pinkish noise through a band-pass, swelling with excitement
    const len = this.ctx.sampleRate * 3;
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.05; b1 = 0.985 * b1 + w * 0.1;
        d[i] = (b0 + b1 + w * 0.05) * (0.8 + 0.2 * Math.sin(i / 3000 + ch));
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.crowdFilter = this.ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 900;
    this.crowdFilter.Q.value = 0.6;
    this.crowdGain = this.ctx.createGain();
    this.crowdGain.gain.value = 0.05;
    src.connect(this.crowdFilter).connect(this.crowdGain).connect(this.master);
    src.start();
    try {
      const pick = () => { this.voice = speechSynthesis.getVoices().find((v) => /en/i.test(v.lang)) ?? null; };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    } catch { /* no speech synthesis */ }
  }

  resume() { void this.ctx.resume(); }
  setVolume(v: number) { this.master.gain.value = v; }

  /** Crowd level 0..1. */
  crowd(excitement: number) {
    const t = this.ctx.currentTime;
    this.crowdGain.gain.setTargetAtTime(0.04 + excitement * 0.22, t, 0.3);
    this.crowdFilter.frequency.setTargetAtTime(700 + excitement * 900, t, 0.3);
  }

  /** The announcer. */
  say(text: string, rate = 1.05) {
    try {
      if (this.master.gain.value <= 0) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = rate;
      u.pitch = 0.8;
      u.volume = Math.min(1, this.master.gain.value * 1.3);
      speechSynthesis.speak(u);
    } catch { /* not supported */ }
  }

  private tone(freqs: number[], dur: number, type: OscillatorType, vol: number, slide = 1) {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(this.master);
    for (const f of freqs) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * slide, t + dur);
      o.connect(g);
      o.start(t);
      o.stop(t + dur);
    }
  }

  private noise(dur: number, from: number, to: number, vol: number) {
    const t = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  countdownBeep(go: boolean) { this.tone(go ? [880, 1320] : [440], go ? 0.6 : 0.25, 'square', 0.12); }
  finalTwo() { this.tone([110, 165, 220], 1.6, 'sawtooth', 0.14, 0.98); this.noise(1.2, 300, 1200, 0.25); }
  shockwave() { this.noise(0.7, 2000, 120, 0.5); this.tone([60], 0.6, 'sine', 0.35, 0.5); }
  boing() { this.tone([180, 360], 0.45, 'sine', 0.18, 2.4); }
  nitro() { this.noise(0.9, 400, 3000, 0.3); }
  pickup() { this.tone([880, 1175, 1568], 0.3, 'triangle', 0.1); }
  victory() { this.tone([262, 330, 392, 523], 2.2, 'sawtooth', 0.12); }

  dispose() {
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    void this.ctx.close();
  }
}
