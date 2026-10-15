// Stem engine: plays one song as four layers you can turn up and down.
//
// Two ways in:
//   loadSong(buffer)   any song. The four layers are carved out of the mix with filters
//                      (see carve below), so they are a sound sculpture, not true stems.
//   loadStems(buffers) four real stem files, in STEMS order, played in lockstep.
//
// Each layer has a meter that listens *before* its volume, so a layer you have turned
// all the way down can still show that it is there.
//
// Like the Stem Player, it can also solo layers, loop a moment, change speed, and run the
// whole mix through three effects: echo, feedback and gate.

export const STEMS = ['vocals', 'drums', 'bass', 'other'];
// In effects mode the four strips control these instead of the layers' volumes.
export const EFFECTS = ['echo', 'gate', 'speed', 'feedback'];

const LOW = 160;    // Hz: below this is "bass"
const HIGH = 5000;  // Hz: above this is "drums" (cymbals, hats, the crack of a snare)
const EASE = 0.06;  // seconds: how quickly a volume change settles, so moves feel physical

export class StemEngine {
  constructor() {
    this.ctx = new AudioContext();
    // layers → mix → gate → volume → speakers, with echo and feedback sent off the gate.
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.gate = new GainNode(ctx, { gain: 1 });
    this.volume = new GainNode(ctx, { gain: 0.9 });
    this.master.connect(this.gate).connect(this.volume).connect(ctx.destination);
    // Gate: a square wave chops the sound on and off, eight times a second.
    this.gateLfo = new OscillatorNode(ctx, { type: 'square', frequency: 8 });
    this.gateDepth = new GainNode(ctx, { gain: 0 });
    this.gateLfo.connect(this.gateDepth).connect(this.gate.gain);
    this.gateLfo.start();
    // Echo: a dotted-eighth-ish repeat that fades.
    this.echo = this.sendLoop(0.33, 0.45);
    // Feedback: a very short repeat fed back on itself, a metallic ring.
    this.feedback = this.sendLoop(0.011, 0.86);
    this.fx = { echo: 0, gate: 0, speed: 0.5, feedback: 0 };
    this.volumeLevel = 0.9;
    this.solo = STEMS.map(() => false);
    this.rate = 1;
    this.loopAt = null;   // start of the loop, in song seconds, or null
    this.loopLen = 0;     // its length in song seconds
    this.channels = STEMS.map(() => {
      const tap = this.ctx.createGain();
      const gain = this.ctx.createGain();
      const meter = this.ctx.createAnalyser();
      meter.fftSize = 1024;
      tap.connect(gain).connect(this.master);
      tap.connect(meter);
      return { tap, gain, meter, data: new Float32Array(meter.fftSize), peak: 0.05 };
    });
    this.levels = STEMS.map(() => 1);
    this.tracks = [];   // [{ buffer, entry }] – one per audio file feeding the network
    this.nodes = [];    // filter nodes of the current network, so it can be torn down
    this.sources = [];
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.duration = 0;
    this.mode = null;   // 'carved' | 'stems'
  }

  sendLoop(time, feedback) {
    const delay = new DelayNode(this.ctx, { delayTime: time, maxDelayTime: 1 });
    const back = new GainNode(this.ctx, { gain: feedback });
    const wet = new GainNode(this.ctx, { gain: 0 });
    this.gate.connect(delay).connect(back).connect(delay);
    delay.connect(wet).connect(this.volume);
    return wet;
  }

  async decode(arrayBuffer) {
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return toStereo(this.ctx, buffer);
  }

  loadSong(buffer) {
    this.reset();
    const entry = this.node(this.ctx.createGain());
    carve(this, entry, this.channels.map(c => c.tap));
    this.tracks = [{ buffer, entry }];
    this.duration = buffer.duration;
    this.mode = 'carved';
  }

  loadStems(buffers) {
    this.reset();
    this.tracks = buffers.map((buffer, i) => ({ buffer, entry: this.channels[i].tap }));
    this.duration = Math.max(...buffers.map(b => b.duration));
    this.mode = 'stems';
  }

  // Swap in true stems for the song that is playing, without losing your place or levels.
  swapToStems(buffers) {
    const at = this.position, wasPlaying = this.playing;
    this.loadStems(buffers);
    this.offset = at % this.duration;
    if (wasPlaying) this.play();
  }

  get loaded() { return this.tracks.length > 0; }

  // Where the song is, in seconds: speed changes how fast it moves, and a loop folds it back.
  get position() {
    if (!this.playing) return this.offset;
    const raw = this.startedAt + Math.max(0, this.ctx.currentTime - this.anchorTime) * this.rate;
    if (this.loopAt !== null && raw >= this.loopAt) return this.loopAt + (raw - this.loopAt) % this.loopLen;
    return raw % this.duration;
  }

  // Re-anchor the clock at the current moment, before changing speed or loop.
  rebase() {
    if (!this.playing) return;
    this.startedAt = this.position;
    this.anchorTime = this.ctx.currentTime;
  }

  play() {
    if (!this.loaded || this.playing) return;
    this.ctx.resume();
    // Every source starts on the same audio clock tick, so the layers never drift.
    const when = this.ctx.currentTime + 0.03;
    this.sources = this.tracks.map(({ buffer, entry }) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = this.rate;
      if (this.loopAt !== null) { src.loopStart = this.loopAt; src.loopEnd = this.loopAt + this.loopLen; }
      src.connect(entry);
      src.start(when, this.offset % buffer.duration);
      return src;
    });
    this.startedAt = this.offset;
    this.anchorTime = when;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSources();
    this.playing = false;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.pause();
    this.offset = ((seconds % this.duration) + this.duration) % this.duration;
    if (wasPlaying) this.play();
  }

  setLevel(i, value) {
    this.levels[i] = value;
    this.applyGain(i);
  }

  // Squared, because loudness is heard roughly that way: halfway up sounds like halfway.
  // While any layer is soloed, the others fall silent but keep their levels.
  applyGain(i) {
    const silenced = this.solo.some(Boolean) && !this.solo[i];
    const value = silenced ? 0 : this.levels[i] * this.levels[i];
    this.channels[i].gain.gain.setTargetAtTime(value, this.ctx.currentTime, EASE);
  }

  toggleSolo(i) {
    this.solo[i] = !this.solo[i];
    STEMS.forEach((_, k) => this.applyGain(k));
  }

  setVolume(value) {
    this.volumeLevel = Math.min(1, Math.max(0, value));
    this.volume.gain.setTargetAtTime(this.volumeLevel ** 2, this.ctx.currentTime, EASE);
  }

  // Loop: keep playing the stretch from `start` for `length` seconds round and round. Set at
  // the moment the stretch ends, so playback simply wraps back to its start.
  setLoop(start, length) {
    this.rebase();
    this.loopAt = start;
    this.loopLen = length;
    for (const src of this.sources) { src.loopStart = start; src.loopEnd = start + length; }
  }

  clearLoop() {
    this.rebase();
    this.loopAt = null;
    for (const src of this.sources) { src.loopStart = 0; src.loopEnd = 0; }
  }

  // value 0..1 for each effect. Speed runs from half to one and a half times, and settles
  // on exactly normal around the middle so it is easy to find again.
  setFx(name, value) {
    this.fx[name] = value;
    const now = this.ctx.currentTime;
    if (name === 'echo') this.echo.gain.setTargetAtTime(value * 0.8, now, EASE);
    if (name === 'feedback') this.feedback.gain.setTargetAtTime(value * 0.5, now, EASE);
    if (name === 'gate') {
      this.gate.gain.setTargetAtTime(1 - value / 2, now, EASE);
      this.gateDepth.gain.setTargetAtTime(value / 2, now, EASE);
    }
    if (name === 'speed') {
      let rate = 0.5 + value;
      if (Math.abs(rate - 1) < 0.05) rate = 1;
      this.rebase();
      this.rate = rate;
      for (const src of this.sources) src.playbackRate.setTargetAtTime(rate, now, 0.02);
    }
  }

  // 0..1: how much is happening in a layer right now, whatever its volume.
  meter(i) {
    const c = this.channels[i];
    c.meter.getFloatTimeDomainData(c.data);
    let sum = 0;
    for (let k = 0; k < c.data.length; k++) sum += c.data[k] * c.data[k];
    const rms = Math.sqrt(sum / c.data.length);
    // Each layer is measured against its own recent loudest moment, so a quiet bass line
    // and a loud vocal both get to fill their lights.
    c.peak = Math.max(rms, c.peak * 0.9995, 0.02);
    return Math.min(1, rms / c.peak);
  }

  stopSources() {
    for (const src of this.sources) { try { src.stop(); } catch {} src.disconnect(); }
    this.sources = [];
  }

  reset() {
    this.stopSources();
    this.playing = false;
    this.offset = 0;
    this.loopAt = null;
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    for (const c of this.channels) c.peak = 0.05;
  }

  node(n) { this.nodes.push(n); return n; }
}

// Carve one stereo mix into four layers:
//   bass   – everything below LOW
//   drums  – everything above HIGH
//   vocals – the middle band, centre of the stereo image (L+R), where a lead voice sits
//   other  – the middle band, edges of the stereo image (L−R): pads, guitars, room
// All four at full volume add back up to roughly the original song.
function carve(engine, input, [vocals, drums, bass, other]) {
  const { ctx } = engine;
  const filter = (type, frequency) => {
    // Two gentle filters in a row (a Linkwitz–Riley pair) so the bands meet cleanly.
    const a = engine.node(new BiquadFilterNode(ctx, { type, frequency, Q: -3.01 }));
    const b = engine.node(new BiquadFilterNode(ctx, { type, frequency, Q: -3.01 }));
    a.connect(b);
    return { in: a, out: b };
  };
  const gain = value => engine.node(new GainNode(ctx, { gain: value }));

  const low = filter('lowpass', LOW);
  input.connect(low.in); low.out.connect(bass);

  const high = filter('highpass', HIGH);
  input.connect(high.in); high.out.connect(drums);

  const bandLow = filter('highpass', LOW);
  const bandHigh = filter('lowpass', HIGH);
  input.connect(bandLow.in); bandLow.out.connect(bandHigh.in);

  const split = engine.node(ctx.createChannelSplitter(2));
  bandHigh.out.connect(split);

  // Mid = (L + R) / 2, played in the centre.
  const mid = gain(1);
  split.connect(gain(0.5), 0).connect(mid);
  split.connect(gain(0.5), 1).connect(mid);
  mid.connect(vocals);

  // Side = (L − R) / 2, played as +side on the left and −side on the right.
  const side = gain(1);
  split.connect(gain(0.5), 0).connect(side);
  split.connect(gain(-0.5), 1).connect(side);
  const merge = engine.node(ctx.createChannelMerger(2));
  side.connect(merge, 0, 0);
  side.connect(gain(-1)).connect(merge, 0, 1);
  merge.connect(other);
}

function toStereo(ctx, buffer) {
  if (buffer.numberOfChannels >= 2) return buffer;
  const out = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  out.copyToChannel(buffer.getChannelData(0), 0);
  out.copyToChannel(buffer.getChannelData(0), 1);
  return out;
}

// Match four dropped files to the four layers by name ("song_vocals.wav", "Drums.mp3", …).
export function matchStemFiles(files) {
  const patterns = [/vocal|voice|vox|acapella/i, /drum|perc|beat/i, /bass/i, /other|inst|music|accomp|melod/i];
  const picked = patterns.map(p => files.find(f => p.test(f.name)));
  return picked.every(Boolean) && new Set(picked).size === 4 ? picked : null;
}
