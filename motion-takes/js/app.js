// ------------------------------------------------
// Motion Takes — perform a movement, see it replay,
// try another interpretation, decide what to develop.
//
// Modes:
//   live       input → smoothing → object, nothing kept
//   countdown  three beats, then recording begins
//   recording  raw input is sampled with elapsed time
//   armed      (pinch to grab) waiting for the pinch that starts a take
//   review     a take replays (or is scrubbed); ghosts compare
// ------------------------------------------------

import {
  analyze, compactRaw, createFilter, effectiveSmoothing, effectiveSpeed,
  exampleTakes, fmtTime, makeTake, newId, sampleAt, speedAt, stepFilter, tauFor, validTake,
} from './takes.js';
import { editOf, isEdited, pieceLabel, pieceName, playDuration, rendered, resetEdits, setEdit, timingOf } from './edit.js';
import { HELP, interpret } from './commands.js';
import { Stage } from './stage.js';
import { Timeline } from './timeline.js';
import { HandInput } from './hand.js';
import { Sound } from './sound.js';
import { Voice } from './voice.js';
import { Demo } from './demo.js';

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
  settings: { smoothing: 0.35, limit: 5000, shape: 'circle', text: 'hello', cues: true, speedTone: false, loop: true, grab: false },
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
let sandbox = null; // while a guided example runs, the user's project is set aside here
function save() {
  if (sandbox) return;
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
  piece: null,          // selected piece of the selected take
  releasedAt: 0,
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
  { body: $('tl-body'), tracks: $('tracks'), ruler: $('ruler'), playhead: $('playhead'), piecesRow: $('pieces-row'), pieceLane: $('piece-lane') },
  {
    onSelect: id => selectTake(id),
    onCompare: id => { compareIds.has(id) ? compareIds.delete(id) : compareIds.add(id); save(); timeline.select(project.selectedId, compareIds); ui(); },
    onRename: (id, name) => { const t = byId(id); if (t) { pushHistory(); t.name = name; save(); refresh(); } },
    onPieceSelect: i => selectPiece(i, true),
    onPieceDrag: (i, scale, phase) => {
      const t = selected(); if (!t) return;
      if (phase === 'start') { pushHistory(); selectPiece(i, false); return; }
      if (phase === 'move') { setEdit(t, i, { scale }); timeline.pieces(t, st.piece); timeline.redraw(); pieceGutter(); return; }
      save(); refresh();
    },
    onDelete: id => deleteTake(id),
    onScrub: (ms, id, first) => scrub(ms, id, first),
  },
);
timeline.setLimit(S.limit);

new ResizeObserver(() => stage.resize()).observe($('stage'));

// ---------- recording ----------

function toggleRecord() {
  if (st.mode === 'recording') return stopRecording();
  if (st.mode === 'countdown' || st.mode === 'armed') return toLive();
  if (st.input === 'hand' && hand.state !== 'ready') {
    toast('Turn the camera on in the Mapping panel first, or switch input to Cursor.');
    return;
  }
  sound.ensure();
  st.playing = false;
  if (st.input === 'hand' && S.grab) { st.mode = 'armed'; ui(); return; }
  st.mode = 'countdown';
  st.countStart = performance.now();
  st.lastBeat = -1;
  ui();
}

function beginRecording(now, grab = false) {
  st.mode = 'recording';
  const f = createFilter(live.x, live.y, live.lost, Math.max(0, live.recoverUntil - now));
  st.rec = {
    start: now,
    startState: { x: live.x, y: live.y, lost: live.lost, recoverLeft: Math.max(0, live.recoverUntil - now) },
    filter: f,
    smoothing: S.smoothing,
    input: st.input,
    raw: [],
    grab,
    path: { t: [], x: [], y: [], tracked: [], n: 0, holds: [], lostSpans: [], speed: [] },
  };
  sound.recStart();
  ui();
}

// trimMs drops the end of the take: the moment spent saying "stop" or opening the hand
function stopRecording(trimMs = 0) {
  const rec = st.rec;
  st.rec = null;
  if (trimMs > 0 && rec.raw.length) {
    const end = rec.raw[rec.raw.length - 1][0] - trimMs;
    while (rec.raw.length > 2 && rec.raw[rec.raw.length - 1][0] > end) rec.raw.pop();
  }
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
  pushHistory();
  project.takes.push(take);
  project.selectedId = take.id;
  st.piece = null;
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
  if (id && id !== project.selectedId) { project.selectedId = id; st.piece = null; compareIds.delete(id); save(); timeline.select(id, compareIds); }
  if (!selected()) return;
  st.mode = 'review';
  st.playing = false;
  sound.silence();
  st.playhead = Math.max(0, Math.min(ms, reviewDuration()));
  if (first) ui();
}

function selectTake(id) {
  if (st.mode === 'recording' || st.mode === 'countdown') return;
  if (id !== project.selectedId) st.piece = null;
  project.selectedId = id;
  compareIds.delete(id);
  save();
  if (st.mode !== 'review') { st.mode = 'review'; st.playhead = 0; st.playing = true; }
  st.playhead = Math.min(st.playhead, reviewDuration());
  timeline.select(id, compareIds);
  ui();
}

function deleteTake(id) {
  const i = project.takes.findIndex(t => t.id === id);
  if (i < 0) return;
  pushHistory();
  const [take] = project.takes.splice(i, 1);
  compareIds.delete(id);
  if (project.selectedId === id) {
    const next = project.takes[Math.min(i, project.takes.length - 1)];
    project.selectedId = next ? next.id : null;
    st.piece = null;
    if (next) compareIds.delete(next.id);
    if (!next) toLive();
  }
  save();
  refresh();
  toast(`Deleted “${take.name}”.`, 'Undo', () => undoEdit());
}

// ---------- pieces ----------

function selectPiece(i, seek) {
  const t = selected();
  if (!t) return;
  st.piece = i;
  if (seek) {
    const seg = timingOf(t)[i];
    if (seg) { st.mode = 'review'; st.playhead = seg.d0; st.playing = true; st.endHold = 0; }
  }
  ui();
}

// rings for a take's holds on the stage; only pauses in the middle get a label
function holdMarks(take, labels) {
  const d = rendered(take);
  const timing = timingOf(take);
  return timing.filter(p => p.kind === 'hold' && p.d1 - p.d0 > 40).map((p, j) => {
    const at = sampleAt(d, (p.d0 + p.d1) / 2);
    const inner = p.i > 0 && p.i < timing.length - 1;
    return { t0: p.d0, t1: p.d1, x: at.x, y: at.y, label: labels && inner ? `pause ${((p.d1 - p.d0) / 1000).toFixed(2)}s` : '' };
  });
}

function pieceGutter() {
  const t = selected();
  const seg = t && st.piece != null ? timingOf(t)[st.piece] : null;
  $('piece-name').textContent = seg ? pieceName(t, seg.i) : 'Pieces';
  $('piece-dur').textContent = seg ? `${((seg.d1 - seg.d0) / 1000).toFixed(2)} s${Math.abs(seg.scale - 1) > 0.005 ? ` · ${seg.scale.toFixed(2)}×` : ''}` : (t ? `${timingOf(t).length}, click one` : '');
  document.querySelectorAll('#piece-ease [data-ease]').forEach(b => {
    b.disabled = !seg;
    b.classList.toggle('is-on', !!seg && Math.abs(seg.ease - +b.dataset.ease) < 0.01);
  });
  $('piece-reset').disabled = !seg || (Math.abs(seg.scale - 1) < 0.005 && Math.abs(seg.ease) < 0.005);
}

// ---------- history: every edit can be undone ----------

const past = [], future = [];
function snapshot() {
  return {
    takes: project.takes.map(t => ({ ...t, adjust: { ...t.adjust }, edits: t.edits ? t.edits.map(e => ({ ...e })) : null })),
    selectedId: project.selectedId,
    compare: [...compareIds],
    counter: project.counter,
  };
}
function restore(snap) {
  project.takes = snap.takes.map(t => ({ ...t, adjust: { ...t.adjust }, edits: t.edits ? t.edits.map(e => ({ ...e })) : null }));
  project.selectedId = snap.selectedId;
  project.counter = snap.counter;
  compareIds.clear();
  snap.compare.forEach(id => compareIds.add(id));
  if (!selected()) { project.selectedId = project.takes[0] ? project.takes[0].id : null; st.piece = null; }
  if (st.piece != null && (!selected() || st.piece >= timingOf(selected()).length)) st.piece = null;
}
function pushHistory() {
  past.push(snapshot());
  if (past.length > 80) past.shift();
  future.length = 0;
}
function undoEdit() {
  if (!past.length) return false;
  future.push(snapshot());
  restore(past.pop());
  save(); refresh();
  return true;
}
function redoEdit() {
  if (!future.length) return false;
  past.push(snapshot());
  restore(future.pop());
  save(); refresh();
  return true;
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
  if (e.target.closest('.assist, .demo')) return;
  stageEl.dispatchEvent(new PointerEvent('pointermove', e));
});

function readInput() {
  if (st.input === 'cursor') return { x: st.pointer.x, y: st.pointer.y, tracked: true };
  const ready = hand.state === 'ready' && hand.tracked && hand.pos;
  // with pinch to grab on, only a pinched hand drives the object
  if (ready && (!S.grab || hand.pinched)) {
    const p = S.grab ? hand.grabPos : hand.pos;
    st.rawLast = { ...p };
    return { ...p, tracked: true };
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
  else if (hand.state === 'ready' && hand.tracked && S.grab) { cls = 'is-tracking'; text = hand.pinched ? 'Pinched · grabbing the object' : 'Tracking · pinch to grab'; }
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

  if (st.mode === 'armed' && hand.state === 'ready' && hand.tracked && hand.pinched) {
    // the pinch is the start: snap the object to the hand so the take begins where the grab does
    live.x = hand.grabPos.x; live.y = hand.grabPos.y; live.lost = false; live.recoverUntil = -Infinity;
    beginRecording(now, true);
  }
  if (st.mode === 'recording' && st.rec.grab) {
    if (hand.pinched && hand.tracked) st.releasedAt = 0;
    else if (!st.releasedAt) st.releasedAt = now;
    else if (now - st.releasedAt > 220) { stopRecording(now - st.releasedAt); return requestAnimationFrame(frame); }
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
    if (st.input === 'cursor' || rec.grab) lost = false;
    if (t >= S.limit) { stopRecording(); return requestAnimationFrame(frame); }
  } else {
    stepFilter(live, raw.x, raw.y, raw.tracked, now, S.smoothing);
    objX = live.x; objY = live.y;
    lost = st.input === 'hand' && hand.state === 'ready' && live.lost && hand.everTracked;
    if (lost && S.grab && hand.tracked) lost = 'released';
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
      const ghosts = [...compareIds].map(byId).filter(Boolean).map(t => ({ d: rendered(t), t: st.playhead, label: `${project.takes.indexOf(t) + 1} · ${t.name.length > 26 ? t.name.slice(0, 25) + '…' : t.name}`, holds: holdMarks(t, false) }));
      const seg = st.piece != null ? timingOf(p)[st.piece] : null;
      review = { primary: { d: rendered(p), t: st.playhead, holds: holdMarks(p, true), piece: seg ? { d0: seg.d0, d1: seg.d1, label: `${pieceName(p, seg.i)} · ${((seg.d1 - seg.d0) / 1000).toFixed(2)} s` } : null }, ghosts };
      if (st.playing) sound.tone(speedAt(review.primary.d, review.primary.t));
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
    grab: st.input === 'hand' && S.grab && hand.pinched && hand.tracked && st.mode !== 'review',
    cross: showCross ? (S.grab ? hand.grabPos : hand.pos) : null,
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
  } else if (m === 'armed') {
    $('mode-text').textContent = 'Ready';
    sub.textContent = 'Pinch to grab and start recording. Let go to stop. Esc cancels.';
  } else if (m === 'countdown') {
    $('mode-text').textContent = 'Get ready';
    sub.textContent = 'Recording starts after the count-in. Esc cancels.';
  } else if (m === 'recording') {
    sub.textContent = `Up to ${S.limit / 1000} s. Press R or Esc to stop.`;
  } else if (m === 'review' && take) {
    if (st.playing) $('mode-text').textContent = 'Replay';
    sub.textContent = `${take.name}${ghostN ? ` · compared with ${ghostN} ghost${ghostN > 1 ? 's' : ''}` : ''}. Esc returns to live.`;
  }

  const recording = m === 'recording' || m === 'countdown' || m === 'armed';
  chip.classList.toggle('is-count', m === 'countdown' || m === 'armed');
  $('btn-record').classList.toggle('is-live', recording);
  $('btn-record').querySelector('.tool-text').textContent = m === 'recording' ? 'Recording' : m === 'countdown' || m === 'armed' ? 'Cancel' : 'Record';
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

  $('assist').classList.toggle('is-muted', m === 'recording');
  $('grab').checked = S.grab;
  timeline.pieces(m === 'recording' ? null : take, st.piece);
  pieceGutter();

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
  const changed = isEdited(take);
  $('insp-orig').textContent = changed ? 'edited · performance kept' : 'as performed';
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
  timeline.setLimit(S.limit);
  save(); refresh();
});

// take adjustments: stored beside the take, original samples untouched
$('insp-speed').addEventListener('change', e => {
  const t = selected(); if (!t) return;
  pushHistory();
  const before = effectiveSpeed(t);
  t.adjust = { ...t.adjust, speed: +e.target.value };
  st.playhead = st.playhead * before / t.adjust.speed; // keep the same moment of the take
  save(); refresh();
});
$('insp-smooth').addEventListener('pointerdown', () => pushHistory());
$('insp-smooth').addEventListener('keydown', () => pushHistory());
$('insp-smooth').addEventListener('input', e => {
  const t = selected(); if (!t) return;
  t.adjust = { ...t.adjust, smoothing: e.target.value / 100 };
  save(); timeline.redraw(); inspector();
});
$('insp-smooth').addEventListener('change', () => refresh());
$('insp-reset').addEventListener('click', () => {
  const t = selected(); if (!t) return;
  pushHistory();
  resetEdits(t);
  st.playhead = Math.min(st.playhead, playDuration(t));
  save(); refresh();
});

document.querySelectorAll('#piece-ease [data-ease]').forEach(b => b.addEventListener('click', () => {
  const t = selected(); if (!t || st.piece == null) return;
  pushHistory(); setEdit(t, st.piece, { ease: +b.dataset.ease }); save(); refresh();
}));
$('piece-reset').addEventListener('click', () => {
  const t = selected(); if (!t || st.piece == null) return;
  pushHistory(); setEdit(t, st.piece, { scale: 1, ease: 0 }); save(); refresh();
});
$('grab').addEventListener('change', e => { S.grab = e.target.checked; save(); ui(); });

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
    pushHistory();
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
  pushHistory();
  project.takes.push(...exampleTakes());
  save(); refresh();
});
$('act-clear').addEventListener('click', () => {
  if (!project.takes.length) return;
  toast(`Delete all ${project.takes.length} takes?`, 'Delete all', () => {
    pushHistory();
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
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !typing(e.target)) {
    e.preventDefault();
    const ok = e.shiftKey ? redoEdit() : undoEdit();
    say(null, { reply: ok ? (e.shiftKey ? 'Redone.' : 'Undone.') : `Nothing to ${e.shiftKey ? 'redo' : 'undo'}.` });
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('cmd-input').focus(); return; }
  if (k === 'm' || k === 'M') { voice.toggle(); return; }
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
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3800);
}

window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  if (sandbox) { restore(sandbox.snap); sandbox = null; }
  project.compare = [...compareIds];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(project)); } catch { /* not available */ }
  hand.disable();
});

// ---------- commands: say it or type it ----------

let claudeFn, claudeOff = false;
async function getClaude() {
  if (claudeOff || !(window.claude && window.claude.use)) return null;
  if (claudeFn === undefined) claudeFn = await window.claude.use('sample').catch(() => null);
  return claudeFn;
}

const api = {
  takes: () => project.takes,
  selected,
  input: () => st.input,
  grabGate: () => S.grab,
  selectedPiece: () => st.piece,
  selectPiece: i => { st.piece = i; ui(); },
  record: () => { if (!['recording', 'countdown', 'armed'].includes(st.mode)) toggleRecord(); },
  stop,
  play: () => { if (!(st.mode === 'review' && st.playing)) togglePlay(); },
  pause: () => { if (st.mode === 'review' && st.playing) togglePlay(); },
  live: toLive,
  setLoop: v => { S.loop = v; save(); ui(); },
  select: t => selectTake(t.id),
  compare: list => {
    compareIds.clear();
    list.forEach(t => { if (t && t.id !== project.selectedId) compareIds.add(t.id); });
    save();
    if (st.mode !== 'review' && selected()) { st.mode = 'review'; st.playhead = 0; st.playing = true; }
    timeline.select(project.selectedId, compareIds);
    ui();
  },
  comparedWithSelected: () => [selected(), ...[...compareIds].map(byId)].filter(Boolean),
  undo: undoEdit,
  redo: redoEdit,
  edit: (label, fn) => { pushHistory(); const r = fn(); save(); refresh(); return r; },
  duplicate: (src, name) => {
    const c = { ...src, id: newId(), name, createdAt: new Date().toISOString(), adjust: { ...src.adjust }, edits: src.edits ? src.edits.map(e => ({ ...e })) : null };
    project.takes.push(c);
    return c;
  },
  rename: (t, name) => { t.name = name; },
  remove: t => deleteTake(t.id),
  duration: t => playDuration(t),
  claude: getClaude,
  disableClaude: () => { claudeOff = true; },
  thinking: on => {
    $('reply').classList.toggle('is-thinking', on);
    if (on) { $('reply-text').textContent = 'Thinking…'; $('reply-help').hidden = true; $('reply-undo').hidden = true; }
  },
};

let replyTimer = 0;
function say(you, res) {
  const r = $('reply');
  r.classList.remove('is-faded');
  clearTimeout(replyTimer);
  // replies step out of the way after a while, so the frame stays clear
  replyTimer = setTimeout(() => r.classList.add('is-faded'), res.help ? 25000 : 9000);
  $('reply-you').hidden = !you;
  if (you) $('reply-you').textContent = you;
  $('reply-text').textContent = res.reply;
  r.classList.toggle('is-claude', res.by === 'claude');
  r.classList.toggle('is-edit', res.kind === 'edit');
  const help = $('reply-help');
  help.hidden = !res.help;
  if (res.help) {
    help.textContent = '';
    for (const [a, b] of HELP) {
      const dt = document.createElement('dt'); dt.textContent = a;
      const dd = document.createElement('dd'); dd.textContent = b;
      help.append(dt, dd);
    }
  }
  $('reply-undo').hidden = res.kind !== 'edit';
}

async function run(text, source) {
  if (!text || !text.trim()) return;
  let res;
  try { res = await interpret(text, api); }
  catch (err) { console.error(err); res = { kind: 'unknown', reply: 'Something went wrong with that command.' }; }
  say(text, res || { kind: 'unknown', reply: `I don’t know “${text}” yet. Say “help” to see what I understand.` });
}

const cmdInput = $('cmd-input');
$('cmd').addEventListener('submit', e => {
  e.preventDefault();
  const v = cmdInput.value;
  cmdInput.value = '';
  run(v, 'typed');
});
cmdInput.addEventListener('keydown', e => { if (e.key === 'Escape') cmdInput.blur(); });
$('reply-undo').addEventListener('click', () => say(null, { reply: undoEdit() ? 'Undone.' : 'Nothing to undo.' }));
$('open-examples').addEventListener('click', e => {
  e.stopPropagation();
  const m = $('menu-examples');
  m.classList.add('is-open');
  m.querySelector('[data-menu-toggle]').setAttribute('aria-expanded', 'true');
});

// voice: final phrases become commands; "stop" is caught early while recording
let voiceStopAt = 0;
const voice = new Voice({
  onFinal: text => {
    cmdInput.classList.remove('is-interim');
    cmdInput.value = '';
    if (performance.now() - voiceStopAt < 3000 && /\b(stop|cut|done)\b/i.test(text)) return;
    run(text, 'voice');
  },
  onInterim: text => {
    if (st.mode === 'recording' && /\b(stop|cut|done)\b/i.test(text)) {
      voiceStopAt = performance.now();
      stopRecording(450);
      say(text, { kind: 'action', reply: 'Stopped. The moment you spent saying “stop” was trimmed off.' });
      return;
    }
    cmdInput.value = text;
    cmdInput.classList.add('is-interim');
  },
  onState: v => {
    $('mic').classList.toggle('is-on', v.on);
    $('mic').setAttribute('aria-pressed', v.on);
    if (v.error) say(null, { kind: 'info', reply: v.error });
    else if (v.on) say(null, { kind: 'info', reply: 'Listening. Say “record”, “replay”, “longer pause”, or “help”.' });
    else cmdInput.classList.remove('is-interim');
  },
});
$('mic').addEventListener('click', () => voice.toggle());

// ---------- guided examples ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const demo = new Demo(
  { card: $('demo'), title: $('demo-title'), step: $('demo-step'), text: $('demo-text'), say: $('demo-say'), guide: $('demo-guide'), pause: $('demo-pause'), next: $('demo-next'), tryIt: $('demo-try'), exit: $('demo-exit') },
  {
    enterSandbox: key => {
      if (sandbox) return;
      sandbox = { snap: snapshot(), past: past.splice(0), future: future.splice(0) };
      toLive();
      const ex = exampleTakes();
      project.takes = key === 'feelings' ? [ex[0]] : ex;
      project.selectedId = project.takes[0].id;
      compareIds.clear();
      st.piece = null;
      refresh();
    },
    leaveSandbox: () => {
      if (!sandbox) return;
      const sb = sandbox;
      sandbox = null;
      toLive();
      restore(sb.snap);
      past.length = 0; past.push(...sb.past);
      future.length = 0; future.push(...sb.future);
      st.piece = null;
      refresh();
      say(null, { kind: 'info', reply: 'Example closed. Your own takes are back.' });
    },
    selectIndex: i => { const t = project.takes[i]; if (t) selectTake(t.id); },
    compareIndexes: list => api.compare(list.map(i => project.takes[i])),
    play: () => { st.mode = 'review'; st.playhead = 0; st.playing = true; st.endHold = 0; ui(); },
    flashPieces: () => { const r = $('pieces-row'); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); },
    typeAndRun: async (text, cancelled) => {
      cmdInput.value = '';
      for (const ch of text) { if (cancelled()) return; cmdInput.value += ch; await sleep(32); }
      await sleep(300);
      if (cancelled()) return;
      cmdInput.value = '';
      await run(text, 'demo');
    },
    tryHands: () => {
      setInput('hand');
      S.grab = true; save(); ui();
      say(null, { kind: 'info', reply: 'Hand input is on, with Pinch to grab. Click Enable camera in the Mapping panel. The camera only works when Motion Takes runs on your own computer.' });
    },
  },
);
document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => demo.start(b.dataset.demo)));

// ---------- start ----------

setSmoothing(S.smoothing);
setShape(S.shape);
$('shape-text').value = S.text;
$('limit').value = String(S.limit);
$('opt-cues').checked = S.cues;
$('opt-speedtone').checked = S.speedTone;
setInput('cursor');
refresh();
requestAnimationFrame(frame);
