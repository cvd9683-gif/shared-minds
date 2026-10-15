// Stem engine: plays one song as four layers you can turn up and down.
//
// Two ways in:
//   loadSong(buffer)   any song. The four layers are carved out of the mix with filters
//                      (see carve below), so they are a sound sculpture, not true stems.
//   loadStems(buffers) four real stem files, in STEMS order, played in lockstep.
//
// Each layer has a meter that listens *before* its volume, so a layer you have turned
// all the way down can still show that it is there.

export const STEMS = ['vocals', 'drums', 'bass', 'other'];

const LOW = 160;    // Hz: below this is "bass"
const HIGH = 5000;  // Hz: above this is "drums" (cymbals, hats, the crack of a snare)
const EASE = 0.06;  // seconds: how quickly a volume change settles, so moves feel physical

export class StemEngine {
  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
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

  get loaded() { return this.tracks.length > 0; }

  get position() {
    if (!this.playing) return this.offset;
    return Math.max(0, this.ctx.currentTime - this.startedAt) % this.duration;
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
      src.connect(entry);
      src.start(when, this.offset % buffer.duration);
      return src;
    });
    this.startedAt = when - this.offset;
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
    // Squared, because loudness is heard roughly that way: halfway up sounds like halfway.
    this.channels[i].gain.gain.setTargetAtTime(value * value, this.ctx.currentTime, EASE);
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
