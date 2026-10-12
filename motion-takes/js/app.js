// ------------------------------------------------
// Motion Takes — perform a movement, see it replay,
// try another interpretation, decide what to develop.
//
// Modes:
//   live       input → smoothing → object, nothing kept
//   countdown  three beats, then recording begins
//   recording  raw input is sampled with elapsed time
//   review     a take replays (or is scrubbed); ghosts compare
// ------------------------------------------------

import {
  analyze, compactRaw, createFilter, derived, effectiveSmoothing, effectiveSpeed,
  exampleTakes, fmtTime, makeTake, playDuration, sampleAt, speedAt, stepFilter, tauFor, validTake,
} from './takes.js';
import { Stage } from './stage.js';
import { Timeline } from './timeline.js';
import { HandInput } from './hand.js';
import { Sound } from './sound.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'motion-takes:v1';
const BEAT_MS = 600;
const BEATS = 3;
const MIN_TAKE_MS = 250;

// ---------- project ----------

const defaults = () => ({
  version: 1,
  takes: exampleTakes(),
  selectedId: null,
  compare: [],
  counter: 0,
  settings: { smoothing: 0.35, limit: 5000, shape: 'circle', text: 'hello', cues: true, speedTone: false, loop: true, firstTakeHidden: false },
});

function load() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!p || p.version !== 1 || !Array.isArray(p.takes)) return null;
    p.takes = p.takes.filter(validTake);
    p.settings = { ...defaults().settings, ...(p.settings || {}) };
    p.compare = Array.isArray(p.compare) ? p.compare : [];
    return p;
  } catch { return null; }
}

let saveTimer = 0;
let storageOk = true;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    project.compare = [...compareIds];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(project)); }
    catch {
      if (storageOk) toast('This browser is not saving the project locally. Use Project → Download to keep your takes.');
      storageOk = false;
    }
  }, 250);
}

const project = load() || defaults();
const S = project.settings;
if (!project.selectedId && project.takes[0]) project.selectedId = project.takes[0].id;
const compareIds = new Set(project.compare.filter(id => project.takes.some(t => t.id === id)));
if (!project.compare.length && project.takes.length === 2 && project.takes.every(t => t.example)) compareIds.add(project.takes[1].id);

const byId = id => project.takes.find(t => t.id === id);
const selected = () => byId(project.selectedId);

// ---------- runtime state ----------

const st = {
  mode: 'live',
  input: 'cursor',
  playing: false,
  playhead: 0,          // ms, display time (after speed adjustments)
  endHold: 0,
  countStart: 0,
  lastBeat: -1,
  pointer: { x: 0.5, y: 0.5, moved: false },
  rawLast: { x: 0.5, y: 0.5 },
  trail: [],
  respBuf: [],
  rec: null,
  last: performance.now(),
};
const live = createFilter(0.5, 0.5);
live.t = performance.now();

// ---------- modules ----------

const stage = new Stage($('stage-canvas'));
const sound = new Sound();
sound.cues = S.cues; sound.speedTone = S.speedTone;
const hand = new HandInput($('cam-video'));
const timeline = new Timeline(
  { body: $('tl-body'), tracks: $('tracks'), ruler: $('ruler'), playhead: $('playhead') },
  {
    onSelect: id => selectTake(id),
    onCompare: id => { compareIds.has(id) ? compareIds.delete(id) : compareIds.add(id); save(); timeline.select(project.selectedId, compareIds); ui(); },
    onRename: (id, name) => { const t = byId(id); if (t) { t.name = name; save(); refresh(); } },
    onDelete: id => deleteTake(id),
    onScrub: (ms, id, first) => scrub(ms, id, first),
  },
);
timeline.setLimit(S.limit);

new ResizeObserver(() => stage.resize()).observe($('stage'));

// ---------- recording ----------

function toggleRecord() {
  if (st.mode === 'recording') return stopRecording();
  if (st.mode === 'countdown') return toLive();
  if (st.input === 'hand' && hand.state !== 'ready') {
    toast('Turn the camera on in the Mapping panel first, or switch input to Cursor.');
    return;
  }
  sound.ensure();
  st.playing = false;
  st.mode = 'countdown';
  st.countStart = performance.now();
  st.lastBeat = -1;
  ui();
}

function beginRecording(now) {
  st.mode = 'recording';
  const f = createFilter(live.x, live.y, live.lost, Math.max(0, live.recoverUntil - now));
  st.rec = {
    start: now,
    startState: { x: live.x, y: live.y, lost: live.lost, recoverLeft: Math.max(0, live.recoverUntil - now) },
    filter: f,
    smoothing: S.smoothing,
    input: st.input,
    raw: [],
    path: { t: [], x: [], y: [], tracked: [], n: 0, holds: [], lostSpans: [], speed: [] },
  };
  sound.recStart();
  ui();
}

function stopRecording() {
  const rec = st.rec;
  st.rec = null;
  sound.recStop();
  sound.silence();
  // the live filter continues from where the performance ended
  live.x = rec.filter.x; live.y = rec.filter.y; live.lost = rec.filter.lost; live.t = performance.now();
  const dur = rec.raw.length ? rec.raw[rec.raw.length - 1][0] : 0;
  if (dur < MIN_TAKE_MS) { st.mode = 'live'; toast('That take was too short to keep.'); ui(); return; }
  project.counter += 1;
  const take = makeTake({
    name: `Take ${project.counter}`,
    raw: compactRaw(rec.raw),
    input: rec.input,
    smoothing: rec.smoothing,
    start: rec.startState,
  });
  project.takes.push(take);
  project.selectedId = take.id;
  S.firstTakeHidden = true;
  save();
  st.mode = 'review';
  st.playhead = 0;
  st.endHold = 0;
  st.playing = true;
  refresh();
}

// ---------- playback ----------

function reviewDuration() {
  const p = selected();
  let d = p ? playDuration(p) : 0;
  for (const id of compareIds) { const t = byId(id); if (t) d = Math.max(d, playDuration(t)); }
  return d;
}

function togglePlay() {
  if (st.mode === 'recording' || st.mode === 'countdown') return;
  if (!selected()) { toast('Record a take first. Press R.'); return; }
  if (st.mode === 'review' && st.playing) { st.playing = false; sound.silence(); ui(); return; }
  sound.ensure();
  if (st.mode !== 'review' || st.playhead >= reviewDuration() - 1) st.playhead = 0;
  st.mode = 'review';
  st.playing = true;
  st.endHold = 0;
  ui();
}

function toLive() {
  st.mode = 'live';
  st.playing = false;
  st.rec = null;
  sound.silence();
  countdownEl.textContent = '';
  ui();
}

function stop() {
  if (st.mode === 'recording') stopRecording();
  else if (st.mode !== 'live') toLive();
}

function scrub(ms, id, first) {
  if (st.mode === 'recording' || st.mode === 'countdown') return;
  if (id && id !== project.selectedId) { project.selectedId = id; compareIds.delete(id); save(); timeline.select(id, compareIds); }
  if (!selected()) return;
  st.mode = 'review';
  st.playing = false;
  sound.silence();
  st.playhead = Math.max(0, Math.min(ms, reviewDuration()));
  if (first) ui();
}

function selectTake(id) {
  if (st.mode === 'recording' || st.mode === 'countdown') return;
  project.selectedId = id;
  compareIds.delete(id);
  save();
  if (st.mode !== 'review') { st.mode = 'review'; st.playhead = 0; st.playing = true; }
  st.playhead = Math.min(st.playhead, reviewDuration());
  timeline.select(id, compareIds);
  ui();
}

let undo = null;
function deleteTake(id) {
  const i = project.takes.findIndex(t => t.id === id);
  if (i < 0) return;
  const [take] = project.takes.splice(i, 1);
  const wasCompared = compareIds.delete(id);
  const wasSelected = project.selectedId === id;
  if (wasSelected) {
    const next = project.takes[Math.min(i, project.takes.length - 1)];
    project.selectedId = next ? next.id : null;
    if (next) compareIds.delete(next.id);
    if (!next) toLive();
  }
  undo = { take, i, wasSelected, wasCompared };
  save();
  refresh();
  toast(`Deleted “${take.name}”.`, 'Undo', () => {
    if (!undo) return;
    project.takes.splice(Math.min(undo.i, project.takes.length), 0, undo.take);
    if (undo.wasSelected) project.selectedId = undo.take.id;
    if (undo.wasCompared) compareIds.add(undo.take.id);
    undo = null;
    save(); refresh();
  });
}

// ---------- input ----------

const stageEl = $('stage');
stageEl.addEventListener('pointermove', e => {
  const r = stageEl.getBoundingClientRect();
  const p = stage.toFrame(e.clientX - r.left, e.clientY - r.top);
  st.pointer.x = Math.max(-0.05, Math.min(1.05, p.x));
  st.pointer.y = Math.max(-0.05, Math.min(1.05, p.y));
  st.pointer.moved = true;
});
stageEl.addEventListener('pointerdown', e => {
  if (e.target.closest('.first-take')) return;
  stageEl.dispatchEvent(new PointerEvent('pointermove', e));
});

function readInput() {
  if (st.input === 'cursor') return { x: st.pointer.x, y: st.pointer.y, tracked: true };
  if (hand.state === 'ready' && hand.tracked && hand.pos) {
    st.rawLast = { ...hand.pos };
    return { ...hand.pos, tracked: true };
  }
  return { ...st.rawLast, tracked: false };
}

function setInput(mode) {
  if (st.mode === 'recording' || st.mode === 'countdown') return;
  st.input = mode;
  document.querySelectorAll('[data-input]').forEach(b => {
    const on = b.dataset.input === mode;
    b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on);
  });
  $('cam').hidden = mode !== 'hand';
  $('cursor-note').hidden = mode !== 'cursor';
  $('input-title').textContent = mode === 'hand' ? 'Index fingertip' : 'Cursor position';
  if (mode === 'cursor') {
    if (hand.state !== 'off' && hand.state !== 'error') hand.disable();
    live.lost = false;
  } else {
    $('cam-error').hidden = true;
    st.rawLast = { x: live.x, y: live.y };
  }
  ui();
}

hand.onChange(() => {
  const s = hand.state;
  $('btn-cam-on').hidden = s === 'ready' || s === 'starting' || s === 'loading';
  $('btn-cam-off').hidden = !$('btn-cam-on').hidden;
  $('cam-empty').hidden = s === 'ready' || s === 'loading';
  $('btn-cam-on').textContent = s === 'error' ? 'Try the camera again' : 'Enable camera';
  if (s === 'error') {
    $('cam-error').textContent = hand.error;
    $('cam-error').hidden = false;
    setInput('cursor');
  }
  camStatus(true);
  ui();
});

let lastCamStatus = '';
function camStatus(force) {
  let cls = '', text = 'Camera off';
  if (hand.state === 'starting') { cls = 'is-loading'; text = 'Waiting for camera permission…'; }
  else if (hand.state === 'loading') { cls = 'is-loading'; text = 'Loading hand model…'; }
  else if (hand.state === 'ready') {
    if (hand.tracked) { cls = 'is-tracking'; text = 'Tracking index fingertip'; }
    else if (hand.everTracked) { cls = 'is-lost'; text = 'Hand lost · holding position'; }
    else { cls = 'is-searching'; text = 'Show one hand to the camera'; }
  }
  const key = cls + text;
  if (!force && key === lastCamStatus) return;
  lastCamStatus = key;
  $('cam-status').className = 'cam-status ' + cls;
  $('cam-status-text').textContent = text;
}

// ---------- the loop ----------

const countdownEl = $('countdown');
const respCanvas = $('response');

function frame(now) {
  const dt = Math.min(100, now - st.last);
  st.last = now;

  hand.update(now);
  if (st.input === 'hand') camStatus(false);
  const raw = readInput();
  let objX, objY, lost = false;

  if (st.mode === 'countdown') {
    const beat = Math.floor((now - st.countStart) / BEAT_MS);
    if (beat !== st.lastBeat && beat < BEATS) {
      st.lastBeat = beat;
      sound.beat(beat === BEATS - 1);
      countdownEl.innerHTML = `<span>${BEATS - beat}</span>`;
      ui();
    }
    if (beat >= BEATS) { countdownEl.textContent = ''; beginRecording(now); }
  }

  if (st.mode === 'recording') {
    const rec = st.rec;
    const t = now - rec.start;
    const tt = Math.min(t, S.limit);
    rec.raw.push([tt, raw.x, raw.y, raw.tracked ? 1 : 0]);
    stepFilter(rec.filter, raw.x, raw.y, raw.tracked, tt, rec.smoothing);
    const p = rec.path;
    p.t.push(tt); p.x.push(rec.filter.x); p.y.push(rec.filter.y); p.tracked.push(raw.tracked ? 1 : 0); p.n++;
    objX = rec.filter.x; objY = rec.filter.y; lost = rec.filter.lost && hand.everTracked;
    if (st.input === 'cursor') lost = false;
    if (t >= S.limit) { stopRecording(); return requestAnimationFrame(frame); }
  } else {
    stepFilter(live, raw.x, raw.y, raw.tracked, now, S.smoothing);
    objX = live.x; objY = live.y;
    lost = st.input === 'hand' && hand.state === 'ready' && live.lost && hand.everTracked;
  }

  // trail & response buffers (live output)
  st.trail.push({ t: now, x: objX, y: objY });
  while (st.trail.length && now - st.trail[0].t > 800) st.trail.shift();
  st.respBuf.push({ t: now, r: raw.x, o: objX, tr: raw.tracked });
  while (st.respBuf.length && now - st.respBuf[0].t > 2200) st.respBuf.shift();

  // playback advances by elapsed time, never by frame count
  let review = null;
  if (st.mode === 'review') {
    const total = reviewDuration();
    if (st.playing) {
      if (st.playhead >= total) {
        st.endHold += dt;
        if (!S.loop) { st.playing = false; sound.silence(); ui(); }
        else if (st.endHold > 450) { st.playhead = 0; st.endHold = 0; }
      } else {
        st.playhead = Math.min(total, st.playhead + dt);
      }
    }
    const p = selected();
    if (!p) { toLive(); }
    else {
      const ghosts = [...compareIds].map(byId).filter(Boolean).map(t => ({
        d: derived(t), t: st.playhead * effectiveSpeed(t), label: t.name,
      }));
      review = { primary: { d: derived(p), t: st.playhead * effectiveSpeed(p) }, ghosts };
      if (st.playing) sound.tone(speedAt(review.primary.d, review.primary.t) * effectiveSpeed(p));
    }
  }
  if (st.mode === 'recording' && st.trail.length > 2) {
    const a = st.trail[st.trail.length - 3], b = st.trail[st.trail.length - 1];
    sound.tone(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.001, (b.t - a.t) / 1000));
  }

  const showCross = st.input === 'hand' && hand.state === 'ready' && hand.tracked && hand.pos;
  stage.draw({
    mode: st.mode,
    now,
    shape: S.shape,
    text: S.text,
    live: { x: objX, y: objY },
    lost,
    trail: st.trail,
    cross: showCross ? hand.pos : null,
    rec: st.rec ? st.rec.path : null,
    recProgress: st.rec ? (now - st.rec.start) / S.limit : 0,
    review,
  });

  // panel readouts
  $('ro-in-x').textContent = raw.x.toFixed(3);
  $('ro-in-y').textContent = raw.y.toFixed(3);
  const shown = review ? sampleAt(review.primary.d, review.primary.t) : { x: objX, y: objY };
  $('ro-out-x').textContent = shown.x.toFixed(3);
  $('ro-out-y').textContent = shown.y.toFixed(3);
  const n = st.trail.length;
  const v = n > 3 ? Math.hypot(st.trail[n - 1].x - st.trail[n - 4].x, st.trail[n - 1].y - st.trail[n - 4].y) / Math.max(0.001, (st.trail[n - 1].t - st.trail[n - 4].t) / 1000) : 0;
  const act = st.mode === 'review' ? 0 : Math.min(1, v * 1.2);
  $('wire-1').style.setProperty('--activity', raw.tracked ? Math.min(1, act + 0.15 * (act > 0.02)) : 0);
  $('wire-2').style.setProperty('--activity', act);
  drawResponse();
  if (hand.state === 'ready' && st.input === 'hand') drawCamOverlay();

  // timeline
  if (st.mode === 'recording') {
    const d = st.rec.path;
    analyze(d);
    timeline.showRecording(d);
    timeline.setPlayhead(now - st.rec.start, true);
    $('tl-elapsed').textContent = fmtTime(Math.min(S.limit, now - st.rec.start));
    $('mode-text').textContent = `Rec ${fmtTime(Math.min(S.limit, now - st.rec.start))}`;
  } else if (st.mode === 'review') {
    timeline.setPlayhead(st.playhead);
    $('tl-elapsed').textContent = fmtTime(st.playhead);
    if (!st.playing) $('mode-text').textContent = `Paused · ${fmtTime(st.playhead)}`;
  } else {
    timeline.setPlayhead(0);
    $('tl-elapsed').textContent = fmtTime(0);
  }

  requestAnimationFrame(frame);
}

function drawResponse() {
  const c = respCanvas.getContext('2d');
  const r = respCanvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (respCanvas.width !== Math.round(r.width * dpr)) { respCanvas.width = Math.round(r.width * dpr); respCanvas.height = Math.round(r.height * dpr); }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, r.width, r.height);
  const buf = st.respBuf;
  if (buf.length < 2) return;
  const now = buf[buf.length - 1].t;
  const X = t => r.width - ((now - t) / 2000) * r.width;
  const Y = v => 5 + (1 - Math.max(-0.05, Math.min(1.05, v))) * (r.height - 10);
  const line = (key, color, w) => {
    c.strokeStyle = color; c.lineWidth = w; c.beginPath();
    buf.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
  };
  line('r', stage.col.faint, 1);
  line('o', stage.col.accent, 1.75);
}

function drawCamOverlay() {
  const cv = $('cam-overlay'), v = $('cam-video');
  const box = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(box.width * dpr)) { cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, box.width, box.height);
  // match the video's object-fit: cover
  const vw = v.videoWidth || 4, vh = v.videoHeight || 3;
  const k = Math.max(box.width / vw, box.height / vh);
  const dw = vw * k, dh = vh * k, ox = (box.width - dw) / 2, oy = (box.height - dh) / 2;
  const P = (x, y) => [ox + x * dw, oy + y * dh];
  const reg = hand.region();
  const [rx, ry] = P(reg.x, reg.y);
  c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1; c.setLineDash([4, 3]);
  c.strokeRect(rx, ry, reg.w * dw, reg.h * dh);
  c.setLineDash([]);
  c.font = `500 9px ${stage.v('--mono')}`; c.fillStyle = 'rgba(255,255,255,0.75)';
  c.fillText('FRAME', rx + 4, ry + 11);
  if (hand.landmarks && hand.tracked) {
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (const p of hand.landmarks) { const [x, y] = P(p.x, p.y); c.beginPath(); c.arc(x, y, 1.6, 0, 7); c.fill(); }
    const [tx, ty] = P(hand.landmarks[8].x, hand.landmarks[8].y);
    c.fillStyle = stage.col.accent; c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(tx, ty, 5, 0, 7); c.fill(); c.stroke();
  }
}

// ---------- UI state that changes on events (not every frame) ----------

function ui() {
  const m = st.mode, take = selected();
  const chip = $('mode-chip');
  chip.className = 'stage-chip' + (m === 'recording' ? ' is-rec' : m === 'countdown' ? ' is-count' : m === 'review' ? ' is-replay' : '');
  const sub = $('mode-sub');
  const ghostN = [...compareIds].filter(byId).length;
  if (m === 'live') {
    $('mode-text').textContent = `Live · ${st.input === 'hand' ? 'Hand' : 'Cursor'}`;
    sub.textContent = st.input === 'hand' && hand.state !== 'ready'
      ? 'Turn the camera on in the Mapping panel, or switch input to Cursor.'
      : 'Rehearse freely; nothing is kept. Press R to record a take.';
  } else if (m === 'countdown') {
    $('mode-text').textContent = 'Get ready';
    sub.textContent = 'Recording starts after the count-in. Esc cancels.';
  } else if (m === 'recording') {
    sub.textContent = `Up to ${S.limit / 1000} s. Press R or Esc to stop.`;
  } else if (m === 'review' && take) {
    if (st.playing) $('mode-text').textContent = 'Replay';
    sub.textContent = `${take.name}${ghostN ? ` · compared with ${ghostN} ghost${ghostN > 1 ? 's' : ''}` : ''}. Esc returns to live.`;
  }

  const recording = m === 'recording' || m === 'countdown';
  $('btn-record').classList.toggle('is-live', recording);
  $('btn-record').querySelector('.tool-text').textContent = m === 'recording' ? 'Recording' : m === 'countdown' ? 'Cancel' : 'Record';
  $('btn-stop').disabled = m === 'live';
  const playing = m === 'review' && st.playing;
  for (const id of ['btn-replay', 'tl-play']) {
    const b = $(id);
    b.disabled = recording || !take;
    b.querySelector('span').className = playing ? 'ico-pause' : 'ico-play';
  }
  $('btn-replay').querySelector('.tool-text').textContent = playing ? 'Pause' : 'Replay';
  $('tl-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  document.querySelectorAll('[data-input]').forEach(b => { b.disabled = recording; });
  $('smooth').disabled = m === 'recording';

  // the mapping is idle while a take replays: the take, not the input, drives the object
  $('chain-wrap').classList.toggle('is-idle', m === 'review');
  const note = $('panel-note');
  note.textContent = m === 'review'
    ? 'Replaying a recorded take, so the mapping is idle. Press Esc to perform live.'
    : 'How live input moves the object. The timeline below holds what you recorded.';
  note.classList.toggle('is-note', m === 'review');

  const userTakes = project.takes.some(t => !t.example);
  const ft = $('first-take');
  ft.hidden = S.firstTakeHidden || userTakes;
  ft.classList.toggle('is-muted', recording);
  $('ft-step1').textContent = st.input === 'hand' ? 'Raise one hand; your index fingertip leads' : 'Move your cursor over the frame';

  $('tl-total').textContent = fmtTime(m === 'review' ? reviewDuration() : S.limit);
  $('tl-loop').classList.toggle('is-on', S.loop);
  $('tl-loop').setAttribute('aria-pressed', S.loop);
  inspector();
}

function inspector() {
  const take = selected();
  const el = $('inspector');
  el.hidden = !take;
  if (!take) return;
  $('insp-name').textContent = take.name;
  $('insp-name').title = take.name;
  $('insp-speed').value = String(effectiveSpeed(take));
  const s = effectiveSmoothing(take);
  $('insp-smooth').value = Math.round(s * 100);
  $('insp-smooth-val').textContent = `${Math.round(s * 100)}%`;
  const changed = effectiveSpeed(take) !== 1 || Math.abs(s - take.smoothing) > 0.001;
  $('insp-orig').textContent = changed ? `adjusted · recorded at ${Math.round(take.smoothing * 100)}%, 1×` : `as performed`;
  $('insp-orig').classList.toggle('is-changed', changed);
  $('insp-reset').disabled = !changed;
  const recording = st.mode === 'recording' || st.mode === 'countdown';
  for (const id of ['insp-speed', 'insp-smooth']) $(id).disabled = recording;
}

function refresh() {
  timeline.render(project, project.selectedId, compareIds);
  ui();
}

// ---------- controls ----------

$('btn-record').addEventListener('click', toggleRecord);
$('btn-stop').addEventListener('click', stop);
$('btn-replay').addEventListener('click', togglePlay);
$('tl-play').addEventListener('click', togglePlay);
$('tl-loop').addEventListener('click', () => { S.loop = !S.loop; save(); ui(); });

document.querySelectorAll('[data-input]').forEach(b => b.addEventListener('click', () => setInput(b.dataset.input)));
$('btn-cam-on').addEventListener('click', () => { $('cam-error').hidden = true; hand.enable(); });
$('btn-cam-off').addEventListener('click', () => hand.disable());

function setSmoothing(v) {
  S.smoothing = v;
  $('smooth').value = Math.round(v * 100);
  $('smooth-val').textContent = `${Math.round(v * 100)}%`;
  $('smooth-lag').textContent = `${Math.round(tauFor(v))} ms`;
}
$('smooth').addEventListener('input', e => { setSmoothing(e.target.value / 100); save(); });

function setShape(shape) {
  S.shape = shape;
  document.querySelectorAll('[data-shape]').forEach(b => {
    const on = b.dataset.shape === shape;
    b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on);
  });
  $('shape-text').hidden = shape !== 'text';
}
document.querySelectorAll('[data-shape]').forEach(b => b.addEventListener('click', () => { setShape(b.dataset.shape); save(); }));
$('shape-text').addEventListener('input', e => { S.text = e.target.value; save(); });

$('limit').addEventListener('change', e => {
  S.limit = +e.target.value;
  $('ft-limit').textContent = S.limit / 1000;
  timeline.setLimit(S.limit);
  save(); refresh();
});

// take adjustments: stored beside the take, original samples untouched
$('insp-speed').addEventListener('change', e => {
  const t = selected(); if (!t) return;
  const before = effectiveSpeed(t);
  t.adjust = { ...t.adjust, speed: +e.target.value };
  st.playhead = st.playhead * before / t.adjust.speed; // keep the same moment of the take
  save(); refresh();
});
$('insp-smooth').addEventListener('input', e => {
  const t = selected(); if (!t) return;
  t.adjust = { ...t.adjust, smoothing: e.target.value / 100 };
  save(); timeline.redraw(); inspector();
});
$('insp-smooth').addEventListener('change', () => refresh());
$('insp-reset').addEventListener('click', () => {
  const t = selected(); if (!t) return;
  const before = effectiveSpeed(t);
  t.adjust = { speed: 1, smoothing: t.smoothing };
  st.playhead = st.playhead * before;
  save(); refresh();
});

$('first-take-close').addEventListener('click', () => { S.firstTakeHidden = true; save(); ui(); });

$('opt-cues').addEventListener('change', e => { S.cues = sound.cues = e.target.checked; save(); });
$('opt-speedtone').addEventListener('change', e => { S.speedTone = sound.speedTone = e.target.checked; if (!e.target.checked) sound.silence(); else sound.ensure(); save(); });

// menus
document.querySelectorAll('.menu').forEach(menu => {
  const btn = menu.querySelector('[data-menu-toggle]');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = !menu.classList.contains('is-open');
    document.querySelectorAll('.menu.is-open').forEach(m => { m.classList.remove('is-open'); m.querySelector('[data-menu-toggle]').setAttribute('aria-expanded', 'false'); });
    menu.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open);
  });
  menu.querySelector('.menu-pop').addEventListener('click', e => { if (e.target.closest('.menu-item')) menu.classList.remove('is-open'); e.stopPropagation(); });
});
document.addEventListener('click', () => document.querySelectorAll('.menu.is-open').forEach(m => m.classList.remove('is-open')));

$('act-download').addEventListener('click', async () => {
  const data = {
    format: 'motion-takes-project',
    version: 1,
    note: 'Motion Takes project data: per-frame input positions with elapsed time for each take. Positions are in frame units (0–1) of a 16:9 frame. This is not a Lottie or After Effects file.',
    exportedAt: new Date().toISOString(),
    settings: S,
    selectedId: project.selectedId,
    compare: [...compareIds],
    counter: project.counter,
    takes: project.takes,
  };
  const json = JSON.stringify(data, null, 1);
  const filename = `motion-takes-${new Date().toISOString().slice(0, 10)}.json`;
  const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: json }); }
    catch (err) { if (err && err.code !== 'declined') toast('This view can’t save files.'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('act-open').addEventListener('click', () => $('file-open').click());
$('file-open').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.format !== 'motion-takes-project' || !Array.isArray(data.takes)) throw new Error('format');
    const takes = data.takes.filter(validTake);
    if (!takes.length) throw new Error('empty');
    const apply = () => openProject(data, takes);
    if (project.takes.some(t => !t.example)) toast(`Replace your ${project.takes.length} takes with the ${takes.length} in this file?`, 'Replace', apply);
    else apply();
  } catch {
    toast('That file is not Motion Takes project data.');
  }
});
function openProject(data, takes) {
    toLive();
    project.takes = takes;
    project.counter = Math.max(data.counter || 0, takes.length);
    project.selectedId = takes.some(t => t.id === data.selectedId) ? data.selectedId : takes[0].id;
    compareIds.clear();
    (data.compare || []).forEach(id => { if (id !== project.selectedId && takes.some(t => t.id === id)) compareIds.add(id); });
    save(); refresh();
    toast(`Opened ${takes.length} take${takes.length > 1 ? 's' : ''}.`);
}
$('act-examples').addEventListener('click', () => {
  project.takes.push(...exampleTakes());
  save(); refresh();
});
$('act-clear').addEventListener('click', () => {
  if (!project.takes.length) return;
  toast(`Delete all ${project.takes.length} takes? This can’t be undone.`, 'Delete all', () => {
    toLive();
    project.takes = [];
    project.selectedId = null;
    compareIds.clear();
    save(); refresh();
  });
});

// keyboard: the performer's hand stays in the air
const typing = el => el && (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox') || el.isContentEditable);
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  const k = e.key;
  if (k === 'r' || k === 'R') { if (!e.repeat) toggleRecord(); e.preventDefault(); }
  else if (k === ' ') { if (!e.repeat) togglePlay(); e.preventDefault(); }
  else if (k === 'Escape') { stop(); }
  else if (/^[1-9]$/.test(k)) { const t = project.takes[+k - 1]; if (t) selectTake(t.id); }
  else if ((k === 'ArrowLeft' || k === 'ArrowRight') && st.mode === 'review' && e.target.type !== 'range') {
    st.playing = false;
    const step = (e.shiftKey ? 500 : 1000 / 30) * (k === 'ArrowLeft' ? -1 : 1);
    st.playhead = Math.max(0, Math.min(reviewDuration(), st.playhead + step));
    e.preventDefault(); ui();
  }
});
// stop a focused button from also "clicking" on Space
document.addEventListener('keyup', e => { if (e.key === ' ' && e.target.tagName === 'BUTTON') e.preventDefault(); });

// toast
let toastTimer = 0;
function toast(text, action, fn) {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.textContent = action || '';
  btn.onclick = () => { el.hidden = true; fn && fn(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; if (action) undo = null; }, action ? 6000 : 3800);
}

window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  project.compare = [...compareIds];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(project)); } catch { /* not available */ }
  hand.disable();
});

// ---------- start ----------

setSmoothing(S.smoothing);
setShape(S.shape);
$('shape-text').value = S.text;
$('limit').value = String(S.limit);
$('ft-limit').textContent = S.limit / 1000;
$('opt-cues').checked = S.cues;
$('opt-speedtone').checked = S.speedTone;
setInput('cursor');
refresh();
requestAnimationFrame(frame);
