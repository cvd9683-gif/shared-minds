import { StemEngine, STEMS, matchStemFiles } from './engine.js';
import { createDisc, touchAt, levelOnArm } from './disc.js';
import { renderDemo } from './demo.js';

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
    } else {
      setStatus(`Reading ${files[0].name}…`);
      engine.loadSong(await engine.decode(await files[0].arrayBuffer()));
      title = files[0].name.replace(/\.[^.]+$/, '');
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
}

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

function touch(id, point, pressed) {
  let t = touches.get(id);
  if (!point) { if (t) release(id); return; }
  if (!t) { t = { x: point.x, z: point.z, pressed: false, grab: null }; touches.set(id, t); }
  t.x = point.x; t.z = point.z;

  if (pressed && !t.pressed) {
    const under = touchAt(t.x, t.z);
    if (under?.kind === 'button') { togglePlay(); t.grab = { kind: 'button' }; }
    if (under?.kind === 'arm') { t.grab = under; setLevel(under.arm, under.level); }
  } else if (pressed && t.grab?.kind === 'arm') {
    setLevel(t.grab.arm, levelOnArm(t.grab.arm, t.x, t.z));
  }
  if (!pressed) t.grab = null;
  t.pressed = pressed;
}

function release(id) { touches.delete(id); }

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

function setLevel(i, value) {
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
    touch('h' + h.id, { x: h.x, z: h.z }, h.pressed);
  }
  for (const id of handIds) if (!now.has(id)) release(id);
  handIds = now;
  $('#cam-status').textContent = !hands.length ? 'Show a hand'
    : hands.some(h => h.pressed) ? 'Touching' : 'Pinch to touch the disc';
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
