import { StemEngine, STEMS, EFFECTS, matchStemFiles } from './engine.js';
import { createDisc, touchAt, levelOnArm, armDistance, ringFraction, offRing } from './disc.js';
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
  if (!files.length) return inIntro() ? introNote('That doesn’t look like an audio file.') : say('That doesn’t look like an audio file.');
  if (inIntro()) introNote('Reading the song…');
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
    if (inIntro()) return introNote('Couldn’t read that file. Try an MP3 or WAV.');
    return say('Couldn’t read that file. Try an MP3 or WAV.');
  }
  loaded();
  if (inIntro()) return enter();
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
  // Every step says what is happening and, where it can, how far along: in the status line,
  // on the button, in the tab's title, and on the disc, where the ring round the middle fills.
  const since = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const steps = {
    checking: () => ['Looking for stems already made…', 'Checking…', null],
    uploading: f => [`Sending the song… ${pct(f)}`, `Sending ${pct(f)}`, f * 0.1],
    waking: () => [`Waking up the separator… ${since()}. After a quiet spell this can take a few minutes; the song keeps playing.`, 'Waking up…', 0.1],
    separating: f => f == null
      ? [`Separating by instrument… ${since()}`, 'Separating…', 0.15]
      : [`Separating by instrument… ${pct(f)}`, `Separating ${pct(f)}`, 0.15 + f * 0.75],
    saving: () => ['Saving the stems…', 'Saving…', 0.92],
    fetching: () => ['Bringing in the stems…', 'Almost there…', 0.97],
  };
  let phase = 'checking', fraction = null;
  const show = () => {
    if (song !== file) return;
    const [line, label, progress] = steps[phase](fraction);
    setStatus(line);
    trueButton.textContent = label;
    separationProgress = progress;
    document.title = `${label} · Stem Player`;
  };
  const tick = setInterval(show, 1000);
  try {
    const urls = await separate(file, (p, f) => { phase = p; fraction = f ?? null; show(); });
    if (song !== file) return;   // another song was loaded meanwhile
    phase = 'fetching'; show();
    const buffers = await Promise.all(['vocals', 'drums', 'bass', 'other'].map(async name => {
      const r = await fetch(urls[name]);
      if (!r.ok) throw new Error(`Couldn’t download the ${name} stem.`);
      return engine.decode(await r.arrayBuffer());
    }));
    if (song !== file) return;
    engine.swapToStems(buffers);
    song = null;
    // Done: a chime, a flash along every strip, and a message that stays long enough to read.
    chime();
    stemsArrived = performance.now();
    say('True stems are in. Solo the vocals (the ring at the end of the top strip) to hear just the voice.', 9000);
  } catch (err) {
    console.error(err);
    if (song === file) say(err.message || 'Couldn’t separate this song.', 6000);
  } finally {
    clearInterval(tick);
    if (separating === file) separating = null;
    separationProgress = null;
    document.title = 'Stem Player';
    trueButton.disabled = false;
    trueButton.textContent = 'Find true stems';
    loaded();
  }
});

let separationProgress = null;   // 0..1 while true stems are being found
let stemsArrived = -Infinity;    // when they last arrived, for the flash
const pct = f => `${Math.round(f * 100)}%`;

// Three rising notes: the stems are in.
function chime() {
  const ctx = engine.ctx;
  [880, 1109, 1319].forEach((frequency, k) => {
    const t = ctx.currentTime + k * 0.11;
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency });
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.linearRampToValueAtTime(0.08, t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.65);
  });
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
// The controls follow the Stem Player:
//   strip            slide to set a layer's volume (in effects mode, an effect's amount)
//   end of a strip   solo that layer; solo several to hear just those
//   middle           tap to play or pause; hold to catch a loop, as long as you hold
//   FX               effects mode: the strips become echo, gate, speed and feedback
//   LOOP             hold to catch a loop as long as you hold; while it loops (LOOP blinks),
//                    press again to stop
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
      const grab = t.grab = { kind: 'button', from: engine.position };
      setTimeout(() => {
        if (t.grab === grab && t.pressed && !fxMode) { grab.looped = true; startLoop(grab.from); }
      }, HOLD);
    }
    else if (under?.kind === 'key' && under.name === 'loop') {
      t.grab = { kind: 'loop' };
      startLoop();
    }
    else if (under?.kind === 'arm') { t.grab = under; setStrip(under.arm, under.level); }
    else if (under?.kind === 'ring') { t.grab = under; seekTo(under.fraction * engine.duration); }
    else if (under) soon(() => activate(under));
    if (t.hand) tick(under ? 'grab' : 'miss');
  } else if (pressed && t.grab?.kind === 'arm') {
    setStrip(t.grab.arm, levelOnArm(t.grab.arm, t.x, t.z));
  } else if (pressed && t.grab?.kind === 'ring') {
    seekTo(ringFraction(t.x, t.z) * engine.duration);
  }
  if (!pressed && t.pressed) {
    if (t.grab?.kind === 'button' && !t.grab.looped) soon(pressMiddle);
    if (t.grab?.kind === 'loop' || t.grab?.looped) endLoop();
    if (t.hand) tick('let go');
  }
  if (!pressed) t.grab = null;
  t.pressed = pressed;
}

// Starting audio and rebuilding sources is the heaviest thing a tap does, so it runs just after
// the screen has answered the tap, not before: the press shows at once, the sound a frame later.
// (Never more than 60 ms later, even if the screen is slow to draw.)
function soon(fn) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(() => setTimeout(run));
  setTimeout(run, 60);
}

// One-shot controls: the middle, the keys, and the solo spots.
function activate(under) {
  if (under.kind === 'button') pressMiddle();
  if (under.kind === 'solo') toggleSolo(under.arm);
  if (under.kind === 'key') pressKey(under.name);
}

const HOLD = 500;   // ms: holding the middle this long loops instead of play/pause
let fxMode = false;
const EFFECT_NAMES = ['Echo', 'Gate', 'Speed', 'Feedback'];

// The middle plays and pauses; in effects mode, like the Stem Player's, it clears the effects.
function pressMiddle() {
  if (fxMode) resetFx(); else togglePlay();
}

function resetFx() {
  EFFECTS.forEach(name => engine.setFx(name, name === 'speed' ? 0.5 : 0));
  if (engine.loopAt !== null) engine.clearLoop();
  say('Effects reset: no echo, gate or feedback, normal speed, no loop.', 2500);
}

function pressKey(name) {
  if (name === 'fx') {
    fxMode = !fxMode;
    document.body.classList.toggle('fx', fxMode);
    say(fxMode ? 'Effects: the strips are now echo, gate, speed and feedback. The middle resets them; FX again goes back.' : 'Back to the layers.', 6000);
  }
  if (name === 'up' || name === 'down') {
    engine.setVolume(engine.volumeLevel + (name === 'up' ? 0.1 : -0.1));
    say(`Volume ${Math.round(engine.volumeLevel * 100)}%`, 1500);
  }
}

// ---------------------------------------------------------------- moving through the song
//
// Three ways: the timeline in the bar, the ring round the middle (drag round it like a jog
// wheel, or hold it with a hand), and the arrow keys. Scrubbing restarts the audio at most
// every 90 ms, so a quick drag sounds like a needle skipping across a record, not a stutter.

const scrub = $('#scrub');
let scrubbing = false;
let seekTimer = null, seekWant = null;

function seekTo(seconds) {
  if (!engine.loaded) return;
  seekWant = Math.max(0, Math.min(engine.duration - 0.05, seconds));
  if (engine.loopAt !== null) { engine.clearLoop(); catching = null; }
  if (seekTimer) return;
  applySeek();
  seekTimer = setTimeout(() => { seekTimer = null; if (seekWant !== null) applySeek(); }, 90);
}
function applySeek() { engine.seek(seekWant); seekWant = null; }

scrub.addEventListener('pointerdown', () => { scrubbing = true; });
addEventListener('pointerup', () => { scrubbing = false; });
scrub.addEventListener('input', () => seekTo((scrub.value / 1000) * engine.duration));
scrub.addEventListener('change', () => { scrubbing = false; });

// Catching a loop: it starts where you press and ends where you let go. While a loop plays,
// pressing again stops it.
let catching = null;   // { from } while a loop is being caught

function startLoop(from = engine.position) {
  if (engine.loopAt !== null) { engine.clearLoop(); catching = null; return say('Loop off.', 1500); }
  if (!engine.playing) return say('Play first, then hold LOOP to catch a loop.', 3000);
  catching = { from };
  say('Catching a loop… let go to set it.', 10000);
}

function endLoop() {
  if (!catching) return;
  const { from } = catching;
  catching = null;
  let length = engine.position - from;
  if (length < 0) length = engine.duration - from;   // the song wrapped round while holding
  if (length < 0.25) return say('Hold LOOP a little longer to catch a loop.', 2500);
  engine.setLoop(from, length);
  say(`Looping ${length.toFixed(1)} seconds. Press LOOP to stop.`, 3000);
}

function toggleSolo(i) {
  engine.toggleSolo(i);
  const soloed = STEMS.filter((_, k) => engine.solo[k]);
  // On the quick split, a soloed layer is a slice of the mix, so say why it isn't clean.
  if (soloed.length && engine.mode === 'carved') {
    return say(`Solo: ${soloed.join(', ')}. This is the quick split, so other instruments bleed through; Find true stems separates them properly.`, 6000);
  }
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
  if (e.target.closest('input, button, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || inIntro()) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  const n = /^Digit[1-4]$/.test(e.code) ? Number(e.code.slice(5)) - 1 : -1;
  if (n >= 0) e.shiftKey ? toggleSolo(n) : toggleMute(n);
  if (e.code === 'KeyF') pressKey('fx');
  if (e.code === 'KeyL' && !e.repeat) startLoop();
  if (e.code === 'KeyR') resetFx();
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 15 : 5) * (e.code === 'ArrowLeft' ? -1 : 1);
    seekTo(engine.position + step);
  }
  if (e.key === '+' || e.key === '=') pressKey('up');
  if (e.key === '-' || e.key === '_') pressKey('down');
});

addEventListener('keyup', e => { if (e.code === 'KeyL') endLoop(); });

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
let twoHandsShown = false;

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
    // A hand catching a loop lets go of it by moving off the LOOP key.
    if (d.catching && key !== 'key:loop') { d.catching = false; endLoop(); tick('let go'); }
    let progress = 0;

    if (d.held) {
      const grab = touches.get(id)?.grab;
      const arm = grab?.arm;
      const { along, across } = arm === undefined ? {} : armDistance(arm, h.x, h.z);
      const off = grab?.kind === 'ring' ? offRing(h.x, h.z)
        : arm === undefined || across > LET_GO || along < 0.12;
      if (off) { d.held = false; d.done = key; }
    } else if (key === null || key !== d.done) {
      d.done = null;
      if (key === null) d.key = null;
      else if (key !== d.key || Math.hypot(h.x - d.x, h.z - d.z) > STILL) {
        Object.assign(d, { key, since: time, x: h.x, z: h.z });
      } else {
        progress = Math.min(1, (time - d.since) / DWELL);
        if (progress === 1 && key === 'key:loop') { startLoop(); d.catching = !!catching; tick('grab'); d.done = key; d.key = null; }
        else if (progress === 1 && under.kind !== 'arm' && under.kind !== 'ring') { activate(under); tick('grab'); d.done = key; d.key = null; }
        else if (progress === 1) d.held = true;
      }
    }
    touch(id, { x: h.x, z: h.z }, h.pressed || d.held, {
      hand: true, side: h.side, tint: h.tint, closeness: Math.max(h.closeness * 0.6, progress, d.held ? 1 : 0),
    });
  }
  for (const id of handIds) if (!now.has(id)) {
    if (hovers.get(id)?.catching) endLoop();
    release(id);
    hovers.delete(id);
  }
  handIds = now;
  // Say what each hand is doing, by side, so two hands can be told apart.
  const doing = hands.map(h => {
    const t = touches.get('h' + h.id);
    const what = t?.grab?.kind === 'arm' ? `holding ${(fxMode ? EFFECTS : STEMS)[t.grab.arm]}`
      : t?.grab?.kind === 'ring' ? 'scrubbing' : 'free';
    return { side: h.side, held: what !== 'free', text: `${h.side === 'left' ? 'L' : 'R'}: ${what}` };
  }).sort((a, b) => (a.side === 'left' ? -1 : 1));
  const anyHeld = doing.some(d => d.held);
  cam.dataset.state = !hands.length ? 'lost' : anyHeld ? 'held' : 'found';
  $('#cam-status').textContent = !hands.length ? 'No hand yet. Hold one up to the camera'
    : hands.length === 1 && !anyHeld ? 'Hand found. Hold still over a strip to take it'
    : hands.length === 1 && doing[0].text.endsWith('scrubbing') ? 'Scrubbing. Move round the ring; move away to let go'
    : hands.length === 1 ? `Holding ${doing[0].text.split('holding ')[1]}. Slide along it, move off to let go`
    : doing.map(d => d.text).join(' · ');
  if (hands.length === 2 && !twoHandsShown) {
    twoHandsShown = true;
    say('Two hands: each can hold its own strip at once. Try vocals with one and drums with the other.', 6000);
  }
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
    ringFocus: list.some(t => t.grab?.kind === 'ring' || touchAt(t.x, t.z)?.kind === 'ring'),
    keyFocus: list.map(t => touchAt(t.x, t.z)).find(u => u?.kind === 'key')?.name,
    soloFocus: list.map(t => touchAt(t.x, t.z)).find(u => u?.kind === 'solo')?.arm ?? -1,
    fxMode,
    fx: EFFECTS.map(name => engine.fx[name]),
    solo: engine.solo,
    loop: engine.loopAt !== null,
    catching: !!catching,
    separating: !!separating && song === separating,
    separation: separationProgress,
    arrived: (performance.now() - stemsArrived) / 1000,
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

  if (engine.loaded) {
    $('#time').textContent = `${clock(engine.position)} / ${clock(engine.duration)}`;
    if (!scrubbing) scrub.value = Math.round((engine.position / engine.duration) * 1000);
    scrub.style.setProperty('--p', `${scrub.value / 10}%`);
    scrub.setAttribute('aria-valuetext', `${clock(engine.position)} of ${clock(engine.duration)}`);
  }
  canvas.style.cursor = list.some(t => touchAt(t.x, t.z)) ? 'pointer' : 'default';
}

// ---------------------------------------------------------------- the way in
//
// The entry screen: the disc turning slowly in the dark, a few lines, and two ways in.
// Going in, the disc comes forward, light runs out along its strips with a chime, and it plays.

const demoReady = loadDemo();
const inIntro = () => document.body.classList.contains('intro');
const introNote = (text, error = true) => {
  const note = $('#intro-note');
  note.textContent = text;
  note.classList.toggle('error', error && !/^Reading/.test(text));
};

async function enter() {
  if (!inIntro()) return;
  document.body.classList.remove('intro');
  disc.setIntro(false);
  engine.ctx.resume();
  setTimeout(() => { stemsArrived = performance.now(); chime(); }, 450);
  setTimeout(() => { if (!engine.playing) togglePlay(); }, 900);
  setTimeout(() => say('Drag along a strip to turn a layer up or down; its far end solos it. Tap the middle to pause; drag round the ring around it to move through the song.', 8000), 1300);
}

$('#intro-demo').addEventListener('click', async () => { await demoReady; enter(); });
$('#intro-song').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); }
});
$('#intro-demo').focus({ preventScroll: true });
requestAnimationFrame(frame);
