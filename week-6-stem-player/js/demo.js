// A short demo loop, synthesised in the browser as four separate parts, so the player has
// something to hold before you upload a song – and so you can hear what true stems feel like.
// Four bars of Am – F – C – G at 100 bpm.

const BPM = 100;
const BEAT = 60 / BPM;
const BARS = 4;
const LENGTH = BARS * 4 * BEAT;
const RATE = 44100;

const ROOTS = [57, 53, 48, 55];                       // A, F, C, G (MIDI)
const CHORDS = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];
// The voice's tune: [bar, beat, length in beats, MIDI note]
const TUNE = [
  [0, 0, 1.5, 69], [0, 1.5, 0.5, 72], [0, 2, 2, 76],
  [1, 0, 1.5, 77], [1, 1.5, 0.5, 76], [1, 2, 2, 72],
  [2, 0, 1, 72], [2, 1, 1, 74], [2, 2, 2, 76],
  [3, 0, 1.5, 74], [3, 1.5, 0.5, 71], [3, 2, 2, 67],
];

const hz = midi => 440 * 2 ** ((midi - 69) / 12);

export async function renderDemo() {
  const parts = [vocals, drums, bass, other];
  return Promise.all(parts.map(async part => {
    const ctx = new OfflineAudioContext(2, Math.ceil(LENGTH * RATE), RATE);
    part(ctx);
    return ctx.startRendering();
  }));
}

function envelope(ctx, param, t, attack, hold, release, peak) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
}

function vocals(ctx) {
  // A sawtooth through vowel-like resonances, with a little vibrato: an "ahh".
  const out = new GainNode(ctx, { gain: 0.5 });
  out.connect(ctx.destination);
  const formants = [[700, 6, 1], [1220, 8, 0.5], [2600, 10, 0.25]].map(([frequency, Q, gain]) => {
    const f = new BiquadFilterNode(ctx, { type: 'bandpass', frequency, Q });
    f.connect(new GainNode(ctx, { gain })).connect(out);
    return f;
  });
  for (const [bar, beat, len, note] of TUNE) {
    const t = (bar * 4 + beat) * BEAT;
    const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz(note) });
    const vib = new OscillatorNode(ctx, { frequency: 5.5 });
    vib.connect(new GainNode(ctx, { gain: hz(note) * 0.012 })).connect(osc.frequency);
    const amp = new GainNode(ctx, { gain: 0 });
    envelope(ctx, amp.gain, t, 0.06, len * BEAT - 0.15, 0.25, 0.35);
    osc.connect(amp);
    formants.forEach(f => amp.connect(f));
    osc.start(t); vib.start(t);
    osc.stop(t + len * BEAT + 0.3); vib.stop(t + len * BEAT + 0.3);
  }
}

function drums(ctx) {
  const noise = new AudioBuffer({ length: RATE, sampleRate: RATE, numberOfChannels: 1 });
  noise.getChannelData(0).forEach((_, i, d) => { d[i] = Math.random() * 2 - 1; });
  const hit = (t, type, frequency, gain, decay, pan = 0) => {
    const src = new AudioBufferSourceNode(ctx, { buffer: noise });
    const amp = new GainNode(ctx, { gain: 0 });
    envelope(ctx, amp.gain, t, 0.001, 0, decay, gain);
    src.connect(new BiquadFilterNode(ctx, { type, frequency }))
      .connect(amp).connect(new StereoPannerNode(ctx, { pan })).connect(ctx.destination);
    src.start(t); src.stop(t + decay + 0.05);
  };
  for (let b = 0; b < BARS * 4; b++) {
    const t = b * BEAT;
    if (b % 2 === 0 || b % 8 === 7) {
      // Kick: a sine that drops in pitch.
      const osc = new OscillatorNode(ctx, { frequency: 140 });
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      const amp = new GainNode(ctx, { gain: 0 });
      envelope(ctx, amp.gain, t, 0.002, 0.02, 0.3, 0.9);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.4);
    }
    if (b % 2 === 1) hit(t, 'bandpass', 1800, 0.5, 0.18);      // snare
    hit(t, 'highpass', 8000, 0.18, 0.05, 0.3);                  // hats on every 8th
    hit(t + BEAT / 2, 'highpass', 8000, 0.1, 0.04, 0.3);
  }
}

function bass(ctx) {
  const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 420, Q: 4 });
  lp.connect(ctx.destination);
  ROOTS.forEach((root, bar) => {
    [0, 1.5, 2.5, 3].forEach((beat, k) => {
      const t = (bar * 4 + beat) * BEAT;
      const len = (k === 0 ? 1.4 : 0.45) * BEAT;
      const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz(root - 24 + (k === 2 ? 12 : 0)) });
      const amp = new GainNode(ctx, { gain: 0 });
      envelope(ctx, amp.gain, t, 0.01, len * 0.6, len * 0.5, 0.55);
      osc.connect(amp).connect(lp);
      osc.start(t); osc.stop(t + len * 1.2);
    });
  });
}

function other(ctx) {
  // Soft chord pads, spread wide across the stereo field.
  const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1600 });
  lp.connect(new GainNode(ctx, { gain: 0.16 })).connect(ctx.destination);
  ROOTS.forEach((root, bar) => {
    const t = bar * 4 * BEAT;
    CHORDS[bar].forEach((interval, k) => {
      [-1, 1].forEach(side => {
        const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz(root + interval) * (1 + side * 0.004) });
        const amp = new GainNode(ctx, { gain: 0 });
        envelope(ctx, amp.gain, t, 0.4, 4 * BEAT - 0.6, 0.5, 0.5);
        osc.connect(amp).connect(new StereoPannerNode(ctx, { pan: side * (0.5 + k * 0.2) })).connect(lp);
        osc.start(t); osc.stop(t + 4 * BEAT + 0.4);
      });
    });
  });
}
