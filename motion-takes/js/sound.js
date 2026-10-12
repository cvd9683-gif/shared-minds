// ------------------------------------------------
// Sound as feedback, not decoration:
//  - count-in beats and record start/stop cues, so a
//    hand performer never has to look at a button
//  - an optional speed tone: pitch and loudness follow
//    the object's speed, so pauses become audible silence
// ------------------------------------------------

export class Sound {
  constructor() {
    this.ctx = null;
    this.cues = true;
    this.speedTone = false;
    this.osc = null;
    this.gain = null;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    return true;
  }

  blip(freq, dur = 0.08, vol = 0.12, type = 'sine') {
    if (!this.cues || !this.ensure()) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  beat(last) { this.blip(last ? 880 : 587, 0.09, 0.14); }
  recStart() { this.blip(1175, 0.16, 0.12, 'triangle'); }
  recStop() { this.blip(784, 0.08, 0.1, 'triangle'); setTimeout(() => this.blip(523, 0.14, 0.1, 'triangle'), 90); }

  // speed: frame-widths per second; null to fade out
  tone(speed) {
    if (!this.speedTone || speed == null) { this.silence(); return; }
    if (!this.ensure()) return;
    const c = this.ctx, t = c.currentTime;
    if (!this.osc) {
      this.osc = c.createOscillator();
      this.gain = c.createGain();
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1400;
      this.osc.type = 'triangle';
      this.gain.gain.value = 0;
      this.osc.connect(lp).connect(this.gain).connect(c.destination);
      this.osc.start();
    }
    const v = Math.min(1, speed / 1.6);
    this.osc.frequency.setTargetAtTime(150 + v * 520, t, 0.03);
    this.gain.gain.setTargetAtTime(v < 0.02 ? 0 : 0.03 + v * 0.07, t, 0.04);
  }

  silence() {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }
}
