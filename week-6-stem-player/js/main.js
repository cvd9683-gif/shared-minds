import { StemEngine, STEMS, matchStemFiles } from './engine.js';
import { createDisc, touchAt, levelOnArm } from './disc.js';
import { renderDemo } from './demo.js';
import { available, separate } from './separate.js';

const $ = s => document.querySelector(s);
const engine = new StemEngine();
const disc = createDisc($('#stage'));
const labels = [...document.querySelectorAll('.label')];
const sliders = [...document.querySelectorAll('.levels input')];
const playButton = $('#play');
const status = $('#status');
const hint = $('#hint');

// ---------------------------------------------------------------- loading

let title = '';
let song = null;          // the uploaded file, while it is playing carved
let separating = null;    // the file being split into true stems, if any

async function loadDemo() {
  setStatus('Making the demo loop…');
  engine.loadStems(await renderDemo());
  title = 'Demo loop';
  loaded();
}

async function loadFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|aiff?)$/i.test(f.name));
  if (!files.length) return say('That doesn’t look like an audio file.');
  const wasPlaying = engine.playing;
  engine.pause();
  try {
    if (files.length >= 4 && matchStemFiles(files)) {
      setStatus('Reading four stems…');
      const buffers = await Promise.all(matchStemFiles(files).map(async f => engine.decode(await f.arrayBuffer())));
      engine.loadStems(buffers);
      title = commonName(files) || 'Your stems';
      song = null;
    } else {
      setStatus(`Reading ${files[0].name}…`);
      engine.loadSong(await engine.decode(await files[0].arrayBuffer()));
      title = files[0].name.replace(/\.[^.]+$/, '');
      song = files[0];
    }
  } catch (err) {
    console.error(err);
    loaded();
    return say('Couldn’t read that file. Try an MP3 or WAV.');
  }
  loaded();
  if (wasPlaying) engine.play();
  say(engine.mode === 'carved'
    ? 'Split by sound, not by instrument: each strip is a slice of the mix.'
    : 'Four real stems, playing in lockstep.');
}

function loaded() {
  setStatus(engine.mode === 'carved' ? `${title} · carved from the mix` : `${title} · four stems`);
  document.body.classList.toggle('carved', engine.mode === 'carved');
  trueButton.hidden = !(helper.found && song && engine.mode === 'carved');
}

// ---------------------------------------------------------------- true stems
//
// While a song plays carved from the mix, it can be sent off to be truly separated.
// It keeps playing meanwhile; when the stems arrive they take over at the same moment.

const trueButton = $('#true-stems');
let helper = { found: false, ready: false, missing: [] };
available().then(h => { helper = h; loaded(); });

trueButton.addEventListener('click', async () => {
  if (!helper.ready) {
    if (!helper.missing.length) return say(`The stem helper isn’t working (${helper.error || 'unknown error'}). Check its logs in Vercel.`, 8000);
    return say(`True stems aren’t switched on yet: add ${helper.missing.join(' and ')} in Vercel, then redeploy.`, 8000);
  }
  const file = song;
  separating = file;
  trueButton.disabled = true;
  const started = Date.now();
  const steps = {
    checking: () => 'Looking for stems already made…',
    uploading: f => `Sending the song… ${Math.round(f * 100)}%`,
    separating: () => `Separating by instrument… ${Math.round((Date.now() - started) / 1000)}s (usually 1–2 min)`,
  };
  let phase = '';
  const tick = setInterval(() => { if (song === file && phase === 'separating') setStatus(steps.separating()); }, 1000);
  try {
    const urls = await separate(file, (p, f) => { phase = p; if (song === file) setStatus(steps[p](f)); });
    if (song !== file) return;   // another song was loaded meanwhile
    setStatus('Bringing in the stems…');
    const buffers = await Promise.all(['vocals', 'drums', 'bass', 'other'].map(async name => {
      const r = await fetch(urls[name]);
      if (!r.ok) throw new Error(`Couldn’t download the ${name} stem.`);
      return engine.decode(await r.arrayBuffer());
    }));
    if (song !== file) return;
    engine.swapToStems(buffers);
    song = null;
    say('True stems: the same song, now separated by instrument.');
  } catch (err) {
    console.error(err);
    if (song === file) say(err.message || 'Couldn’t separate this song.', 6000);
  } finally {
    clearInterval(tick);
    if (separating === file) separating = null;
    trueButton.disabled = false;
    loaded();
  }
});

function commonName(files) {
  const base = files[0].name.replace(/[-_ ]*(vocals?|drums?|bass|other)[^/]*$/i, '');
  return base.length > 1 ? base : '';
}

$('#file').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- touching the disc
//
// Mouse, fingers and hands all become "touches" on the disc, and they all behave the same:
// press on a strip to grab it, slide along it to set the level, press the middle to play.

const touches = new Map();   // id → { x, z, pressed, grab }

function touch(id, point, pressed, extra) {
  let t = touches.get(id);
  if (!point) { if (t) release(id); return; }
  if (!t) { t = { x: point.x, z: point.z, pressed: false, grab: null }; touches.set(id, t); }
  t.x = point.x; t.z = point.z;
  Object.assign(t, extra);

  if (pressed && !t.pressed) {
    const under = touchAt(t.x, t.z);
    if (under?.kind === 'button') { togglePlay(); t.grab = { kind: 'button' }; }
    if (under?.kind === 'arm') { t.grab = under; setLevel(under.arm, under.level); }
    if (t.hand) tick(under ? 'grab' : 'miss');
  } else if (pressed && t.grab?.kind === 'arm') {
    setLevel(t.grab.arm, levelOnArm(t.grab.arm, t.x, t.z));
  }
  if (!pressed && t.pressed && t.hand) tick('let go');
  if (!pressed) t.grab = null;
  t.pressed = pressed;
}

function release(id) {
  const t = touches.get(id);
  if (t?.pressed && t.hand) tick('let go');
  touches.delete(id);
}

// Small sounds for a hand in the air, where there is nothing to feel: a click when it takes
// hold, a softer one when it lets go, and a faint detent each time a level passes a light.
function tick(kind) {
  const ctx = engine.ctx;
  if (ctx.state !== 'running') return;
  const [frequency, gain, length] = {
    grab: [1400, 0.07, 0.05], miss: [500, 0.04, 0.06], 'let go': [900, 0.045, 0.05], detent: [2200, 0.02, 0.025],
  }[kind];
  const t = ctx.currentTime;
  const osc = new OscillatorNode(ctx, { frequency });
  const amp = new GainNode(ctx, { gain: 0 });
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t); osc.stop(t + length + 0.01);
}

const canvas = disc.canvas;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  touch('p' + e.pointerId, disc.toDisc(e.clientX, e.clientY), true);
});
canvas.addEventListener('pointermove', e => {
  touch('p' + e.pointerId, disc.toDisc(e.clientX, e.clientY), e.buttons > 0 || e.pointerType === 'touch');
});
const lift = e => {
  if (e.pointerType === 'mouse') touch('p' + e.pointerId, disc.toDisc(e.clientX, e.clientY), false);
  else release('p' + e.pointerId);
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', e => release('p' + e.pointerId));
canvas.addEventListener('pointerleave', e => { if (!e.buttons) release('p' + e.pointerId); });

// ---------------------------------------------------------------- levels & playback

const LIGHTS = 6;
function setLevel(i, value) {
  const step = v => Math.round(v * LIGHTS);
  if (step(value) !== step(engine.levels[i]) && [...touches.values()].some(t => t.hand && t.grab?.arm === i)) tick('detent');
  engine.setLevel(i, value);
  sliders[i].value = Math.round(value * 100);
  sliders[i].setAttribute('aria-valuetext', `${Math.round(value * 100)} percent`);
}

sliders.forEach((s, i) => s.addEventListener('input', () => setLevel(i, s.value / 100)));

const remembered = STEMS.map(() => 1);
function toggleMute(i) {
  if (engine.levels[i] > 0.02) { remembered[i] = engine.levels[i]; setLevel(i, 0); }
  else setLevel(i, remembered[i] || 1);
}

function togglePlay() {
  if (!engine.loaded) return;
  engine.toggle();
  playButton.textContent = engine.playing ? 'Pause' : 'Play';
  playButton.setAttribute('aria-pressed', engine.playing);
  if (engine.playing) hideHint();
}

playButton.addEventListener('click', togglePlay);

addEventListener('keydown', e => {
  if (e.target.closest('input, button, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  const n = Number(e.key);
  if (n >= 1 && n <= 4) toggleMute(n - 1);
});

// ---------------------------------------------------------------- hands

const handsButton = $('#hands');
const cam = $('#cam');
let stopHands = null;
let handIds = new Set();

handsButton.addEventListener('click', async () => {
  if (stopHands) {
    stopHands();
    stopHands = null;
    cam.hidden = true;
    handsButton.setAttribute('aria-pressed', 'false');
    return;
  }
  handsButton.disabled = true;
  cam.hidden = false;
  $('#cam-status').textContent = 'Starting the camera…';
  try {
    const { startHands } = await import('./hands.js');
    stopHands = await startHands($('#video'), $('#preview'), onHands);
    handsButton.setAttribute('aria-pressed', 'true');
    $('#cam-status').textContent = 'Show a hand';
  } catch (err) {
    console.error(err);
    cam.hidden = true;
    say(err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in the address bar to use your hands.'
      : 'Couldn’t start hand tracking on this device.');
  }
  handsButton.disabled = false;
});

function onHands(hands) {
  const now = new Set();
  for (const h of hands) {
    now.add('h' + h.id);
    touch('h' + h.id, { x: h.x, z: h.z }, h.pressed, { hand: true, closeness: h.closeness });
  }
  for (const id of handIds) if (!now.has(id)) release(id);
  handIds = now;
  const held = [...touches.values()].find(t => t.hand && t.grab);
  const state = !hands.length ? ['lost', 'No hand yet. Hold one up to the camera']
    : held ? ['held', held.grab.kind === 'arm' ? `Holding ${['vocals', 'drums', 'bass', 'other'][held.grab.arm]}` : 'Pressed play']
    : ['found', 'Hand found. Pinch to take hold'];
  cam.dataset.state = state[0];
  $('#cam-status').textContent = state[1];
}

// ---------------------------------------------------------------- messages

let hintTimer;
function say(text, ms = 4200) {
  hint.textContent = text;
  hint.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, ms);
}
function hideHint() { hint.classList.remove('show'); }
function setStatus(text) { status.textContent = text; }

const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- every frame

function frame() {
  requestAnimationFrame(frame);
  const list = [...touches.values()];
  const pressed = list.find(t => t.pressed);
  const lead = pressed || list[0];
  const focusTouch = list.find(t => t.grab?.kind === 'arm') || list.find(t => touchAt(t.x, t.z)?.kind === 'arm');
  const focus = focusTouch ? (focusTouch.grab?.arm ?? touchAt(focusTouch.x, focusTouch.z).arm) : -1;

  disc.render({
    levels: engine.levels,
    meters: STEMS.map((_, i) => (engine.loaded ? engine.meter(i) : 0)),
    progress: engine.loaded ? engine.position / engine.duration : 0,
    playing: engine.playing,
    loaded: engine.loaded,
    focus,
    buttonFocus: list.some(t => touchAt(t.x, t.z)?.kind === 'button'),
    separating: !!separating && song === separating,
    touches: list.slice(0, 3),
    lean: lead && Math.hypot(lead.x, lead.z) < 1.15 ? { x: lead.x, z: lead.z, pressed: !!pressed } : null,
  });

  labels.forEach((el, i) => {
    const p = disc.labelAt(i);
    const half = el.offsetWidth / 2 + 8;
    const x = Math.min(innerWidth - half, Math.max(half, p.x));
    // On a narrow screen the side labels can't sit beside the disc, so lift them above their strip.
    if (x !== p.x) p.y -= 26;
    p.x = x;
    el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    el.classList.toggle('focus', focus === i);
    el.classList.toggle('muted', engine.levels[i] < 0.02);
    el.querySelector('.pct').textContent = Math.round(engine.levels[i] * 100);
  });

  if (engine.loaded) $('#time').textContent = `${clock(engine.position)} / ${clock(engine.duration)}`;
  canvas.style.cursor = list.some(t => touchAt(t.x, t.z)) ? 'pointer' : 'default';
}

loadDemo().then(() => say('Press the middle to play. Drag along a strip to turn a layer up or down.', 6000));
requestAnimationFrame(frame);
