import { StemEngine, STEMS, EFFECTS, matchStemFiles } from './engine.js';
import { createDisc, touchAt, levelOnArm, armDistance } from './disc.js';
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
    if (helper.environment === 'preview' && helper.missing.includes('REPLICATE_API_TOKEN')) {
      return say('This preview can’t see a Replicate key. In Vercel it may be saved for Production only: '
        + 'add it again with only Preview ticked, then redeploy. Or use the main site, which uses Production.', 10000);
    }
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
// The controls follow the Stem Player:
//   strip            slide to set a layer's volume (in effects mode, an effect's amount)
//   end of a strip   solo that layer; solo several to hear just those
//   middle           tap to play or pause; hold to loop the next two seconds
//   FX               effects mode: the strips become echo, gate, speed and feedback
//   LOOP             loop the next two seconds, or let go of the loop
//   − and +          volume

const touches = new Map();   // id → { x, z, pressed, grab }

function touch(id, point, pressed, extra) {
  let t = touches.get(id);
  if (!point) { if (t) release(id); return; }
  if (!t) { t = { x: point.x, z: point.z, pressed: false, grab: null }; touches.set(id, t); }
  t.x = point.x; t.z = point.z;
  Object.assign(t, extra);

  if (pressed && !t.pressed) {
    const under = touchAt(t.x, t.z);
    // The middle acts on release, so a long press can mean "loop" instead.
    if (under?.kind === 'button') {
      const grab = t.grab = { kind: 'button' };
      setTimeout(() => { if (t.grab === grab && t.pressed) { grab.looped = true; toggleLoop(); } }, HOLD);
    }
    else if (under?.kind === 'arm') { t.grab = under; setStrip(under.arm, under.level); }
    else if (under) activate(under);
    if (t.hand) tick(under ? 'grab' : 'miss');
  } else if (pressed && t.grab?.kind === 'arm') {
    setStrip(t.grab.arm, levelOnArm(t.grab.arm, t.x, t.z));
  }
  if (!pressed && t.pressed) {
    if (t.grab?.kind === 'button' && !t.grab.looped) togglePlay();
    if (t.hand) tick('let go');
  }
  if (!pressed) t.grab = null;
  t.pressed = pressed;
}

// One-shot controls: the middle, the keys, and the solo spots.
function activate(under) {
  if (under.kind === 'button') togglePlay();
  if (under.kind === 'solo') toggleSolo(under.arm);
  if (under.kind === 'key') pressKey(under.name);
}

const HOLD = 500;   // ms: holding the middle this long loops instead of play/pause
let fxMode = false;
const EFFECT_NAMES = ['Echo', 'Gate', 'Speed', 'Feedback'];

function pressKey(name) {
  if (name === 'fx') {
    fxMode = !fxMode;
    document.body.classList.toggle('fx', fxMode);
    say(fxMode ? 'Effects: the strips are now echo, gate, speed and feedback. Press FX again to go back.' : 'Back to the layers.');
  }
  if (name === 'loop') toggleLoop();
  if (name === 'up' || name === 'down') {
    engine.setVolume(engine.volumeLevel + (name === 'up' ? 0.1 : -0.1));
    say(`Volume ${Math.round(engine.volumeLevel * 100)}%`, 1500);
  }
}

function toggleLoop() {
  if (!engine.loaded) return;
  const on = engine.toggleLoop();
  say(on ? 'Looping these two seconds. Press LOOP to let go.' : 'Loop off.', 2500);
}

function toggleSolo(i) {
  engine.toggleSolo(i);
  const soloed = STEMS.filter((_, k) => engine.solo[k]);
  say(soloed.length ? `Solo: ${soloed.join(', ')}` : 'Solo off: every layer back.', 2000);
}

// A strip means a volume, or in effects mode an effect's amount.
function setStrip(i, value) {
  if (fxMode) {
    const step = v => Math.round(v * LIGHTS);
    if (step(value) !== step(engine.fx[EFFECTS[i]]) && handHolds(i)) tick('detent');
    engine.setFx(EFFECTS[i], value);
  } else setLevel(i, value);
}

const handHolds = i => [...touches.values()].some(t => t.hand && t.grab?.arm === i);

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
  if (step(value) !== step(engine.levels[i]) && handHolds(i)) tick('detent');
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
  const n = /^Digit[1-4]$/.test(e.code) ? Number(e.code.slice(5)) - 1 : -1;
  if (n >= 0) e.shiftKey ? toggleSolo(n) : toggleMute(n);
  if (e.code === 'KeyF') pressKey('fx');
  if (e.code === 'KeyL') toggleLoop();
  if (e.key === '+' || e.key === '=') pressKey('up');
  if (e.key === '-' || e.key === '_') pressKey('down');
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

// A hand takes hold by hovering: hold it still over a strip and, after a moment, the strip is
// yours; slide along it, then move off to the side to let go. Hovering over the middle plays or
// pauses once. A pinch does the same instantly, for anyone who finds that easier.
const DWELL = 700;      // ms of holding still before a hover takes hold
const STILL = 0.07;     // how far a hand may drift and still count as still (disc radius = 1)
const LET_GO = 0.26;    // how far off to the side of a held strip lets it go
const hovers = new Map();

function onHands(hands) {
  const now = new Set();
  const time = performance.now();
  for (const h of hands) {
    const id = 'h' + h.id;
    now.add(id);
    const d = hovers.get(id) || { key: null, since: 0, x: 0, z: 0, held: false, done: null };
    hovers.set(id, d);
    const under = touchAt(h.x, h.z);
    const key = !under ? null : under.kind === 'arm' ? under.arm
      : under.kind === 'button' ? 'button' : `${under.kind}:${under.name ?? under.arm}`;
    let progress = 0;

    if (d.held) {
      const arm = touches.get(id)?.grab?.arm;
      const { along, across } = arm === undefined ? {} : armDistance(arm, h.x, h.z);
      if (arm === undefined || across > LET_GO || along < 0.12) { d.held = false; d.done = key; }
    } else if (key === null || key !== d.done) {
      d.done = null;
      if (key === null) d.key = null;
      else if (key !== d.key || Math.hypot(h.x - d.x, h.z - d.z) > STILL) {
        Object.assign(d, { key, since: time, x: h.x, z: h.z });
      } else {
        progress = Math.min(1, (time - d.since) / DWELL);
        if (progress === 1 && under.kind !== 'arm') { activate(under); tick('grab'); d.done = key; d.key = null; }
        else if (progress === 1) d.held = true;
      }
    }
    touch(id, { x: h.x, z: h.z }, h.pressed || d.held, {
      hand: true, closeness: Math.max(h.closeness * 0.6, progress, d.held ? 1 : 0),
    });
  }
  for (const id of handIds) if (!now.has(id)) { release(id); hovers.delete(id); }
  handIds = now;
  const held = [...touches.values()].find(t => t.hand && t.grab?.kind === 'arm');
  const state = !hands.length ? ['lost', 'No hand yet. Hold one up to the camera']
    : held ? ['held', `Holding ${(fxMode ? EFFECTS : STEMS)[held.grab.arm]}. Slide along it, move off to let go`]
    : ['found', 'Hand found. Hold still over a strip to take it'];
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
    keyFocus: list.map(t => touchAt(t.x, t.z)).find(u => u?.kind === 'key')?.name,
    soloFocus: list.map(t => touchAt(t.x, t.z)).find(u => u?.kind === 'solo')?.arm ?? -1,
    fxMode,
    fx: EFFECTS.map(name => engine.fx[name]),
    solo: engine.solo,
    loop: engine.loopAt !== null,
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
    const value = fxMode ? engine.fx[EFFECTS[i]] : engine.levels[i];
    el.querySelector('.name').textContent = fxMode ? EFFECT_NAMES[i] : STEMS[i][0].toUpperCase() + STEMS[i].slice(1);
    el.querySelector('.pct').textContent = fxMode && i === 2 ? `${(engine.rate).toFixed(2)}×` : Math.round(value * 100);
    el.classList.toggle('solo', engine.solo[i]);
    el.classList.toggle('silenced', !fxMode && engine.solo.some(Boolean) && !engine.solo[i]);
  });

  if (engine.loaded) $('#time').textContent = `${clock(engine.position)} / ${clock(engine.duration)}`;
  canvas.style.cursor = list.some(t => touchAt(t.x, t.z)) ? 'pointer' : 'default';
}

loadDemo().then(() => say('Press the middle to play, or hold it to loop. Drag along a strip to turn a layer up or down; its far end solos it.', 7000));
requestAnimationFrame(frame);
