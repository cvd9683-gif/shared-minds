// ------------------------------------------------
// Motion Takes — perform a movement, see it replay,
// try another interpretation, decide what to develop.
//
// A scene holds objects (layers). Each object has its own
// takes; one take per object is in use, and the scene plays
// them together. You perform one object while the others
// play, so you move in time with them.
//
// Modes:
//   live       rehearse: drag on the stage, nothing is kept
//   countdown  three beats, then recording begins
//   armed      (pinch to grab) waiting for the pinch that starts a take
//   recording  input is sampled with elapsed time
//   review     the scene replays (or is scrubbed); ghosts compare
// ------------------------------------------------

import {
  analyze, compactRaw, createFilter, exampleTakes, fmtTime, makeTake, newId,
  effectiveSmoothing, effectiveSpeed, sampleAt, speedAt, stepFilter, tauFor, validTake,
} from './takes.js';
import { isEdited, offsetOf, pieceName, playDuration, rendered, resetEdits, setEdit, shiftOf, timingOf } from './edit.js';
import { HELP, interpret } from './commands.js';
import { KIND_LABEL, TEMPLATES, buildTemplate, decorFor, makeLayer } from './scene.js';
import { Stage } from './stage.js';
import { Timeline } from './timeline.js';
import { HandInput } from './hand.js';
import { Sound } from './sound.js';
import { Voice } from './voice.js';
import { Demo } from './demo.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'motion-takes:v2';
const OLD_KEY = 'motion-takes:v1';
const BEAT_MS = 600;
const BEATS = 3;
const MIN_TAKE_MS = 250;
const HOSTED = !!(window.claude && window.claude.use); // inside a claude.ai viewer: no camera or microphone

// ---------- project ----------

const defaultSettings = () => ({ smoothing: 0.2, limit: 5000, cues: true, speedTone: false, loop: true, grab: false });

function newProject(template) {
  const built = buildTemplate(template, exampleTakes());
  return { version: 2, template, decor: decorFor(template), ...built, compare: [], settings: defaultSettings() };
}

function load() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY));
    if (p && p.version === 2 && Array.isArray(p.layers)) {
      p.takes = (p.takes || []).filter(validTake);
      p.settings = { ...defaultSettings(), ...(p.settings || {}) };
      p.compare = Array.isArray(p.compare) ? p.compare : [];
      p.decor = p.decor || decorFor(p.template);
      return p;
    }
  } catch { /* fall through */ }
  // earlier versions had one object; keep its takes on a circle
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY));
    if (old && Array.isArray(old.takes) && old.takes.some(t => !t.example)) {
      const circle = makeLayer('circle', { name: 'Circle' });
      const takes = old.takes.filter(validTake).map(t => ({ ...t, layerId: circle.id }));
      circle.activeTakeId = (takes.find(t => t.id === old.selectedId) || takes[0] || {}).id || null;
      return { version: 2, template: 'single', decor: [], layers: [circle], takes, selectedLayerId: circle.id, compare: [], settings: { ...defaultSettings(), ...(old.settings || {}) } };
    }
  } catch { /* fall through */ }
  return null;
}

let project = load() || newProject('notification');
const S = project.settings;
const compareIds = new Set(project.compare);

let saveTimer = 0, storageOk = true;
let sandbox = null; // while a guided example runs, the user's project waits here
function save() {
  if (sandbox) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 250);
}
function writeNow() {
  project.compare = [...compareIds];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(project)); }
  catch {
    if (storageOk) toast('This browser isn’t saving the project. Use Project → Download to keep your takes.');
    storageOk = false;
  }
}

const takeById = id => project.takes.find(t => t.id === id) || null;
const layerById = id => project.layers.find(l => l.id === id) || null;
const selLayer = () => layerById(project.selectedLayerId) || project.layers[0] || null;
const takesOf = layer => (layer ? project.takes.filter(t => t.layerId === layer.id) : []);
const activeOf = layer => (layer ? takeById(layer.activeTakeId) : null);
const selTake = () => activeOf(selLayer());

// where a layer sits at scene time T
function posAt(layer, T) {
  const t = activeOf(layer);
  if (!t) return { x: layer.x, y: layer.y, tracked: true };
  return sampleAt(rendered(t), T - offsetOf(t));
}
const restPos = layer => posAt(layer, 0);

function sceneDuration() {
  let d = 0;
  for (const L of project.layers) { const t = activeOf(L); if (t) d = Math.max(d, offsetOf(t) + playDuration(t)); }
  for (const id of compareIds) { const t = takeById(id); if (t && t.layerId === project.selectedLayerId) d = Math.max(d, offsetOf(t) + playDuration(t)); }
  return d;
}

// ---------- runtime state ----------

const st = {
  mode: 'live',
  input: 'cursor',
  playing: false,
  playhead: 0,
  endHold: 0,
  countStart: 0,
  lastBeat: -1,
  pointer: { x: 0.5, y: 0.5 },
  grip: null,           // input and object position when the hold began
  rehearsing: false,
  wasTracked: false,
  arrange: null,
  rawLast: { x: 0.5, y: 0.5 },
  trail: [],
  respBuf: [],
  rec: null,
  piece: null,
  releasedAt: 0,
  lostAt: 0,
  drawn: [],            // layers as last drawn, for clicking on them
  last: performance.now(),
};
let live = createFilter(0.5, 0.5);

function resetLive() {
  const L = selLayer();
  const p = L ? restPos(L) : { x: 0.5, y: 0.5 };
  live = createFilter(p.x, p.y);
  live.t = performance.now();
  st.grip = null;
  st.trail.length = 0;
}

// ---------- modules ----------

const stage = new Stage($('stage-canvas'));
stage.setDecor(project.decor);
const sound = new Sound();
sound.cues = S.cues; sound.speedTone = S.speedTone;
const hand = new HandInput($('cam-video'));

const timeline = new Timeline(
  { body: $('tl-body'), tracks: $('tracks'), ruler: $('ruler'), playhead: $('playhead'), piecesRow: $('pieces-row'), pieceLane: $('piece-lane') },
  {
    onSelectLayer: layer => selectLayer(layer),
    onUseTake: (layer, take) => useTake(take),
    onCompare: take => { compareIds.has(take.id) ? compareIds.delete(take.id) : compareIds.add(take.id); save(); enterReview(); refresh(); },
    onRenameLayer: (layer, name) => { pushHistory(); layer.name = name; save(); refresh(); },
    onRenameTake: (take, name) => { pushHistory(); take.name = name; save(); refresh(); },
    onDeleteLayer: layer => deleteLayer(layer),
    onDeleteTake: take => deleteTake(take),
    onLaneClick: layer => { if (layer && layer.id !== project.selectedLayerId) selectLayer(layer, false); },
    onScrub: (ms, first) => scrub(ms, first),
    onOffset: (take, dms, phase) => {
      if (phase === 'start') { pushHistory(); st.offsetStart = offsetOf(take); return; }
      take.adjust = { ...take.adjust, offset: Math.max(0, Math.round(st.offsetStart + dms)) };
      if (phase === 'move') { timeline.redraw(); timeline.pieces(selTake(), st.piece); return; }
      save(); refresh();
      say(null, { kind: 'edit', reply: `${layerById(take.layerId).name} now starts at ${fmtTime(offsetOf(take))}.` });
    },
    onPieceSelect: i => selectPiece(i, true),
    onPieceDrag: (i, scale, phase) => {
      const t = selTake(); if (!t) return;
      if (phase === 'start') { pushHistory(); selectPiece(i, false); return; }
      if (phase === 'move') { setEdit(t, i, { scale }); timeline.pieces(t, st.piece); timeline.redraw(); pieceGutter(); return; }
      save(); refresh();
    },
  },
);
timeline.setLimit(S.limit);
new ResizeObserver(() => stage.resize()).observe($('stage'));
window.addEventListener('scroll', () => stage.updateOffset(), { passive: true });

// ---------- selection ----------

const busy = () => ['recording', 'countdown', 'armed'].includes(st.mode);

function selectLayer(layer, announce = true) {
  if (!layer || busy()) return;
  if (layer.id !== project.selectedLayerId) {
    project.selectedLayerId = layer.id;
    st.piece = null;
    compareIds.clear();
    save();
    if (st.mode === 'live') resetLive();
    refresh();
  }
  if (announce) say(null, { kind: 'info', reply: activeOf(layer) ? `${layer.name} selected. Press R to perform a new take of it while the others play.` : `${layer.name} has no take yet. Press R to perform it.` });
}

function useTake(take) {
  if (!take || busy()) return;
  const layer = layerById(take.layerId);
  if (!layer) return;
  if (layer.activeTakeId !== take.id) pushHistory();
  if (layer.id !== project.selectedLayerId) { project.selectedLayerId = layer.id; compareIds.clear(); }
  layer.activeTakeId = take.id;
  compareIds.delete(take.id);
  st.piece = null;
  save();
  enterReview(true);
  refresh();
}

function enterReview(restart = false) {
  if (st.mode !== 'review') { st.mode = 'review'; st.playhead = 0; st.playing = true; st.endHold = 0; }
  else if (restart) { st.playhead = 0; st.playing = true; st.endHold = 0; }
  st.playhead = Math.min(st.playhead, sceneDuration());
}

// ---------- recording ----------

function toggleRecord() {
  if (st.mode === 'recording') return stopRecording();
  if (st.mode === 'countdown' || st.mode === 'armed') return toLive();
  if (!selLayer()) { toast('Add an object first, from the Scene menu.'); return; }
  if (st.input === 'hand' && hand.state !== 'ready') {
    toast('Turn the camera on in the Mapping panel first, or switch input to Cursor.');
    return;
  }
  sound.ensure();
  st.playing = false;
  st.playhead = 0;
  st.rehearsing = false;
  resetLive();
  if (st.input === 'hand' && S.grab) { st.mode = 'armed'; ui(); return; }
  st.mode = 'countdown';
  st.countStart = performance.now();
  st.lastBeat = -1;
  ui();
}

function beginRecording(now, input, grab = false) {
  const L = selLayer();
  const o = restPos(L);   // the new take starts where this object starts
  st.mode = 'recording';
  st.grip = input && input.tracked ? { ix: input.x, iy: input.y, ox: o.x, oy: o.y } : null;
  st.wasTracked = !!(input && input.tracked);
  st.rec = {
    start: now,
    layerId: L.id,
    startState: { x: o.x, y: o.y, lost: false, recoverLeft: 0 },
    filter: createFilter(o.x, o.y),
    smoothing: S.smoothing,
    input: st.input,
    raw: [],
    grab,
    path: { t: [], x: [], y: [], tracked: [], n: 0, holds: [], lostSpans: [], speed: [] },
    lastAnalyze: 0,
  };
  sound.recStart();
  ui();
}

// trimMs drops the end: the moment spent saying "stop" or opening the hand
function stopRecording(trimMs = 0) {
  const rec = st.rec;
  st.rec = null;
  st.grip = null;
  sound.recStop();
  sound.silence();
  if (trimMs > 0 && rec.raw.length) {
    const end = rec.raw[rec.raw.length - 1][0] - trimMs;
    while (rec.raw.length > 2 && rec.raw[rec.raw.length - 1][0] > end) rec.raw.pop();
  }
  const dur = rec.raw.length ? rec.raw[rec.raw.length - 1][0] : 0;
  const layer = layerById(rec.layerId);
  if (dur < MIN_TAKE_MS || !layer) { toLive(); toast('That take was too short to keep.'); return; }
  pushHistory();
  layer.counter = (layer.counter || takesOf(layer).length) + 1;
  const take = makeTake({ name: `Take ${layer.counter}`, raw: compactRaw(rec.raw), input: rec.input, smoothing: rec.smoothing, start: rec.startState });
  take.layerId = layer.id;
  take.adjust.offset = 0;
  project.takes.push(take);
  const previous = layer.activeTakeId;
  layer.activeTakeId = take.id;
  // the take it replaces plays as a ghost, so the two interpretations sit side by side
  compareIds.clear();
  if (previous && takeById(previous)) compareIds.add(previous);
  st.piece = null;
  save();
  st.mode = 'review';
  st.playhead = 0; st.endHold = 0; st.playing = true;
  refresh();
  say(null, { kind: 'info', reply: previous && takeById(previous) ? `${layer.name}: ${take.name} is in use, with the previous take as a ghost. Say “use take ${takesOf(layer).indexOf(takeById(previous)) + 1}” to go back.` : `${layer.name}: ${take.name} recorded.` });
}

// ---------- playback ----------

function togglePlay() {
  if (busy()) return;
  if (!project.takes.length) { toast('Record a take first. Press R.'); return; }
  if (st.mode === 'review' && st.playing) { st.playing = false; sound.silence(); ui(); return; }
  sound.ensure();
  if (st.mode !== 'review' || st.playhead >= sceneDuration() - 1) st.playhead = 0;
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
  resetLive();
  ui();
}

function stop() {
  if (st.mode === 'recording') stopRecording();
  else if (st.mode !== 'live') toLive();
}

function scrub(ms, first) {
  if (busy()) return;
  st.mode = 'review';
  st.playing = false;
  sound.silence();
  st.playhead = Math.max(0, ms);
  if (first) ui();
}

// ---------- deleting ----------

function deleteTake(take) {
  const layer = layerById(take.layerId);
  pushHistory();
  project.takes = project.takes.filter(t => t !== take);
  compareIds.delete(take.id);
  if (layer && layer.activeTakeId === take.id) {
    const rest = takesOf(layer);
    layer.activeTakeId = rest.length ? rest[rest.length - 1].id : null;
    st.piece = null;
  }
  save(); refresh();
  toast(`Deleted “${take.name}”.`, 'Undo', () => undoEdit());
}

function deleteLayer(layer) {
  pushHistory();
  project.layers = project.layers.filter(l => l !== layer);
  project.takes = project.takes.filter(t => t.layerId !== layer.id);
  if (project.selectedLayerId === layer.id) { project.selectedLayerId = project.layers[0] ? project.layers[0].id : null; compareIds.clear(); st.piece = null; }
  save(); toLive(); refresh();
  toast(`Deleted ${layer.name} and its takes.`, 'Undo', () => undoEdit());
}

// ---------- pieces ----------

function selectPiece(i, seek) {
  const t = selTake();
  if (!t) return;
  st.piece = i;
  if (seek) {
    const seg = timingOf(t)[i];
    if (seg) { st.mode = 'review'; st.playhead = offsetOf(t) + seg.d0; st.playing = true; st.endHold = 0; }
  }
  ui();
}

function pieceGutter() {
  const t = selTake();
  const seg = t && st.piece != null ? timingOf(t)[st.piece] : null;
  setText(E.pieceName, seg ? pieceName(t, seg.i) : 'Pieces');
  setText(E.pieceDur, seg ? `${((seg.d1 - seg.d0) / 1000).toFixed(2)} s${Math.abs(seg.scale - 1) > 0.005 ? ` · ${seg.scale.toFixed(2)}×` : ''}` : (t ? `${timingOf(t).length}, click one` : ''));
  E.easeBtns.forEach(b => {
    b.disabled = !seg;
    b.classList.toggle('is-on', !!seg && Math.abs(seg.ease - +b.dataset.ease) < 0.01);
  });
  $('piece-reset').disabled = !seg || (Math.abs(seg.scale - 1) < 0.005 && Math.abs(seg.ease) < 0.005);
}

// rings for a take's holds on the stage; only pauses in the middle get a label
function holdMarks(take, labels) {
  const d = rendered(take);
  const timing = timingOf(take);
  return timing.filter(p => p.kind === 'hold' && p.d1 - p.d0 > 40).map(p => {
    const at = sampleAt(d, (p.d0 + p.d1) / 2);
    const inner = p.i > 0 && p.i < timing.length - 1;
    return { t0: p.d0, t1: p.d1, x: at.x, y: at.y, label: labels && inner ? `pause ${((p.d1 - p.d0) / 1000).toFixed(2)}s` : '' };
  });
}

// ---------- history: every change can be undone ----------

const past = [], future = [];
const copyTake = t => ({ ...t, adjust: { ...t.adjust }, edits: t.edits ? t.edits.map(e => ({ ...e })) : null });
function snapshot() {
  return {
    template: project.template, decor: project.decor,
    layers: project.layers.map(l => ({ ...l })),
    takes: project.takes.map(copyTake),
    selectedLayerId: project.selectedLayerId,
    compare: [...compareIds],
  };
}
function restore(snap) {
  project.template = snap.template;
  project.decor = snap.decor;
  project.layers = snap.layers.map(l => ({ ...l }));
  project.takes = snap.takes.map(copyTake);
  project.selectedLayerId = snap.selectedLayerId;
  compareIds.clear();
  snap.compare.forEach(id => compareIds.add(id));
  stage.setDecor(project.decor);
  if (!selLayer()) project.selectedLayerId = project.layers[0] ? project.layers[0].id : null;
  if (st.piece != null && (!selTake() || st.piece >= timingOf(selTake()).length)) st.piece = null;
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
  save(); if (st.mode === 'live') resetLive(); refresh();
  return true;
}
function redoEdit() {
  if (!future.length) return false;
  past.push(snapshot());
  restore(future.pop());
  save(); if (st.mode === 'live') resetLive(); refresh();
  return true;
}

// ---------- scenes ----------

function loadTemplate(key) {
  pushHistory();
  const p = newProject(key);
  project.template = p.template; project.decor = p.decor; project.layers = p.layers; project.takes = p.takes;
  project.selectedLayerId = p.selectedLayerId;
  compareIds.clear();
  st.piece = null;
  stage.setDecor(project.decor);
  save(); toLive(); refresh();
  say(null, { kind: 'info', reply: `${TEMPLATES[key].name}. ${TEMPLATES[key].note} Press Space to play, or select an object and press R to perform it.` });
}

function addLayer(kind) {
  pushHistory();
  const n = project.layers.filter(l => l.kind === kind).length;
  const layer = makeLayer(kind, { name: n ? `${KIND_LABEL[kind]} ${n + 1}` : KIND_LABEL[kind], x: 0.5 + ((n % 3) - 1) * 0.08, y: 0.5 });
  project.layers.push(layer);
  project.selectedLayerId = layer.id;
  compareIds.clear(); st.piece = null;
  save(); toLive(); refresh();
  say(null, { kind: 'info', reply: `Added ${layer.name}. Drag it on the stage to place it, then press R to perform its motion.` });
}

// ---------- input ----------

const stageEl = $('stage');
window.addEventListener('pointermove', e => {
  const p = stage.fromClient(e.clientX, e.clientY);
  st.pointer.x = p.x; st.pointer.y = p.y;
  if (st.arrange) moveArrange(p);
  else if (e.target === stage.canvas && st.mode !== 'recording') stageEl.classList.toggle('is-arranging', !!stage.hit(st.drawn, e.clientX, e.clientY));
}, { passive: true });

stageEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target !== stage.canvas || busy()) return;
  const p = stage.fromClient(e.clientX, e.clientY);
  st.pointer.x = p.x; st.pointer.y = p.y;
  const hit = stage.hit(st.drawn, e.clientX, e.clientY);
  if (hit) {
    // place an object: with a take, shift the whole take; without one, move the object
    if (hit.id !== project.selectedLayerId) selectLayer(hit, false);
    const t = activeOf(hit);
    const sh = t ? shiftOf(t) : { dx: hit.x, dy: hit.y };
    st.arrange = { layer: hit, take: t, p0: p, s0: sh, moved: false };
    return;
  }
  // empty stage: rehearse the selected object
  if (st.input !== 'cursor' || !selLayer()) return;
  if (st.mode === 'review') toLive();
  st.rehearsing = true;
  st.grip = { ix: p.x, iy: p.y, ox: live.x, oy: live.y };
  stageEl.classList.add('is-rehearsing');
});

window.addEventListener('pointerup', () => {
  if (st.arrange) {
    const a = st.arrange;
    st.arrange = null;
    if (a.moved) { save(); if (st.mode === 'live') resetLive(); refresh(); }
    else ui();
  }
  if (st.rehearsing) { st.rehearsing = false; st.grip = null; stageEl.classList.remove('is-rehearsing'); }
});

function moveArrange(p) {
  const a = st.arrange;
  const dx = p.x - a.p0.x, dy = p.y - a.p0.y;
  if (!a.moved && Math.hypot(dx, dy) < 0.004) return;
  if (!a.moved) { pushHistory(); a.moved = true; }
  if (a.take) a.take.adjust = { ...a.take.adjust, dx: a.s0.dx + dx, dy: a.s0.dy + dy };
  else { a.layer.x = a.s0.dx + dx; a.layer.y = a.s0.dy + dy; }
  if (st.mode === 'live') resetLive();
}

// raw input in frame units, and whether it is driving right now
function readInput() {
  if (st.input === 'cursor') return { x: st.pointer.x, y: st.pointer.y, tracked: true };
  const ready = hand.state === 'ready' && hand.tracked && hand.pos;
  if (ready && (!S.grab || hand.pinched)) {
    const p = S.grab ? hand.grabPos : hand.pos;
    st.rawLast = { ...p };
    return { ...p, tracked: true };
  }
  return { ...st.rawLast, tracked: false };
}

function setInput(mode) {
  if (busy()) return;
  st.input = mode;
  document.querySelectorAll('[data-input]').forEach(b => {
    const on = b.dataset.input === mode;
    b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on);
  });
  $('cam').hidden = mode !== 'hand';
  $('cursor-note').hidden = mode !== 'cursor';
  $('input-title').textContent = mode === 'hand' ? 'Index fingertip' : 'Cursor';
  if (mode === 'cursor' && hand.state !== 'off' && hand.state !== 'error') hand.disable();
  toLive();
}

hand.onChange(() => {
  const s = hand.state;
  const on = s === 'ready' || s === 'starting' || s === 'loading';
  $('btn-cam-on').hidden = on;
  $('btn-cam-off').hidden = !on;
  $('cam-empty').hidden = s === 'ready' || s === 'loading';
  $('btn-cam-on').textContent = s === 'error' ? 'Try again' : 'Enable camera';
  // a failure stays on screen in Hand mode with a way out, instead of silently switching
  $('cam-error').hidden = s !== 'error';
  $('btn-use-cursor').hidden = s !== 'error';
  $('cam-empty').textContent = s === 'error' ? 'Camera unavailable' : 'Camera off';
  if (s === 'error') { $('cam-error').textContent = hand.error; say(null, { kind: 'info', reply: hand.error }); }
  camStatus(true);
  ui();
});

let lastCamStatus = '';
function camStatus(force) {
  let cls = '', text = 'Camera off';
  if (hand.state === 'error') { cls = 'is-lost'; text = 'Camera unavailable'; }
  else if (hand.state === 'starting') { cls = 'is-loading'; text = 'Waiting for camera permission…'; }
  else if (hand.state === 'loading') { cls = 'is-loading'; text = 'Loading hand model…'; }
  else if (hand.state === 'ready') {
    if (hand.tracked && S.grab) { cls = 'is-tracking'; text = hand.pinched ? 'Pinched · grabbing the object' : 'Tracking · pinch to grab'; }
    else if (hand.tracked) { cls = 'is-tracking'; text = 'Tracking index fingertip'; }
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
const E = {
  inX: $('ro-in-x'), inY: $('ro-in-y'), outX: $('ro-out-x'), outY: $('ro-out-y'),
  wire1: $('wire-1'), wire2: $('wire-2'), elapsed: $('tl-elapsed'), modeText: $('mode-text'),
  pieceName: $('piece-name'), pieceDur: $('piece-dur'), easeBtns: [...document.querySelectorAll('#piece-ease [data-ease]')],
};
const texts = new WeakMap();
function setText(el, v) { if (texts.get(el) !== v) { texts.set(el, v); el.textContent = v; } }

function frame(now) {
  const dt = Math.min(100, now - st.last);
  st.last = now;
  hand.update(now);
  if (st.input === 'hand') camStatus(false);
  const input = readInput();
  const L = selLayer();

  if (st.mode === 'countdown') {
    const beat = Math.floor((now - st.countStart) / BEAT_MS);
    if (beat !== st.lastBeat && beat < BEATS) {
      st.lastBeat = beat;
      sound.beat(beat === BEATS - 1);
      countdownEl.innerHTML = `<span>${BEATS - beat}</span>`;
      ui();
    }
    if (beat >= BEATS) { countdownEl.textContent = ''; beginRecording(now, input); }
  }
  if (st.mode === 'armed' && hand.state === 'ready' && hand.tracked && hand.pinched) beginRecording(now, input, true);
  if (st.mode === 'recording' && st.rec.grab) {
    if (hand.pinched && hand.tracked) st.releasedAt = 0;
    else if (!st.releasedAt) st.releasedAt = now;
    else if (now - st.releasedAt > 220) { const trim = now - st.releasedAt; st.releasedAt = 0; stopRecording(trim); return requestAnimationFrame(frame); }
  }

  // relative control: the object moves by however much the input has moved since the hold began.
  // When tracking comes back after a gap, hold again from there, so nothing jumps.
  const follow = st.mode === 'recording' || (st.mode === 'live' && (st.rehearsing || st.input === 'hand'));
  const f = st.mode === 'recording' ? st.rec.filter : live;
  if (follow && input.tracked && (!st.grip || !st.wasTracked)) st.grip = { ix: input.x, iy: input.y, ox: f.x, oy: f.y };
  st.wasTracked = input.tracked;
  let tx, ty, driving = true;
  if (follow && st.grip && input.tracked) { tx = st.grip.ox + input.x - st.grip.ix; ty = st.grip.oy + input.y - st.grip.iy; }
  else if (st.mode === 'recording') { tx = f.x; ty = f.y; driving = false; }
  else {
    const r = L ? restPos(L) : { x: 0.5, y: 0.5 };
    tx = r.x; ty = r.y;
    if (st.input === 'hand' && hand.state === 'ready' && hand.everTracked && !input.tracked) driving = false;
  }

  let objX, objY, lost = false;
  if (st.mode === 'recording') {
    const rec = st.rec;
    const t = now - rec.start;
    const tt = Math.min(t, S.limit);
    rec.raw.push([tt, tx, ty, driving ? 1 : 0]);
    stepFilter(rec.filter, tx, ty, driving, tt, rec.smoothing);
    const p = rec.path;
    p.t.push(tt); p.x.push(rec.filter.x); p.y.push(rec.filter.y); p.tracked.push(driving ? 1 : 0); p.n++;
    objX = rec.filter.x; objY = rec.filter.y;
    lost = !driving && !rec.grab && st.input === 'hand' && hand.everTracked;
    st.playhead = tt;
    if (t >= S.limit) { stopRecording(); return requestAnimationFrame(frame); }
  } else {
    // when the hand goes in live mode, hold for a moment, then settle home
    if (driving) st.lostAt = 0; else if (!st.lostAt) st.lostAt = now;
    const holding = !driving && now - st.lostAt < 700;
    stepFilter(live, tx, ty, !holding, now, S.smoothing);
    objX = live.x; objY = live.y;
    lost = holding ? (S.grab && hand.tracked ? 'released' : true) : false;
  }

  st.trail.push({ t: now, x: objX, y: objY });
  while (st.trail.length && now - st.trail[0].t > 800) st.trail.shift();
  st.respBuf.push({ t: now, r: input.x, o: objX });
  while (st.respBuf.length && now - st.respBuf[0].t > 2200) st.respBuf.shift();

  // playback advances by elapsed time, never by frame count
  if (st.mode === 'review' && st.playing) {
    const total = sceneDuration();
    if (st.playhead >= total) {
      st.endHold += dt;
      if (!S.loop) { st.playing = false; sound.silence(); ui(); }
      else if (st.endHold > 450) { st.playhead = 0; st.endHold = 0; }
    } else st.playhead = Math.min(total, st.playhead + dt);
  }

  const T = st.playhead;
  const view = { mode: st.mode, now, layers: [], ghosts: [], ghostPaths: [], sel: null, recPath: null, trail: null, cross: null, showSelection: true };
  const animate = st.mode === 'review' || st.mode === 'recording';
  for (const layer of project.layers) {
    const isSel = !!L && layer.id === L.id;
    const p = isSel && st.mode !== 'review' ? { x: objX, y: objY } : posAt(layer, animate ? T : 0);
    view.layers.push({ layer, x: p.x, y: p.y, selected: isSel, lost: isSel ? lost : false, grab: isSel && st.input === 'hand' && S.grab && hand.pinched && hand.tracked && st.mode !== 'review' });
  }
  st.drawn = view.layers;

  const take = selTake();
  if (st.mode === 'review' && L) {
    if (take) {
      const seg = st.piece != null ? timingOf(take)[st.piece] : null;
      view.sel = { d: rendered(take), t: T - offsetOf(take), holds: holdMarks(take, true), piece: seg ? { d0: seg.d0, d1: seg.d1, label: `${pieceName(take, seg.i)} · ${((seg.d1 - seg.d0) / 1000).toFixed(2)} s` } : null };
      if (st.playing) sound.tone(speedAt(view.sel.d, view.sel.t));
    }
    const ts = takesOf(L);
    for (const id of compareIds) {
      const g = takeById(id);
      if (!g || g.layerId !== L.id) continue;
      const d = rendered(g);
      const at = sampleAt(d, T - offsetOf(g));
      view.ghostPaths.push({ d, t: T - offsetOf(g), holds: holdMarks(g, false) });
      view.ghosts.push({ layer: L, x: at.x, y: at.y, label: `take ${ts.indexOf(g) + 1}` });
    }
  } else if (st.mode === 'recording') {
    view.recPath = st.rec.path;
    view.trail = st.trail;
    if (st.trail.length > 2) {
      const a = st.trail[st.trail.length - 3], b = st.trail[st.trail.length - 1];
      sound.tone(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.001, (b.t - a.t) / 1000));
    }
  } else if (st.mode === 'live') view.trail = st.trail;
  if (st.input === 'hand' && hand.state === 'ready' && hand.tracked && hand.pos && st.grip) {
    // show where the hand is, in the object's frame of reference
    const hp = S.grab ? hand.grabPos : hand.pos;
    view.cross = { x: st.grip.ox + hp.x - st.grip.ix, y: st.grip.oy + hp.y - st.grip.iy };
  }
  view.recProgress = st.rec ? (now - st.rec.start) / S.limit : 0;
  stage.draw(view);

  // panel readouts
  setText(E.inX, input.x.toFixed(3)); setText(E.inY, input.y.toFixed(3));
  const shown = view.layers.find(v => v.selected) || { x: 0, y: 0 };
  setText(E.outX, shown.x.toFixed(3)); setText(E.outY, shown.y.toFixed(3));
  const n = st.trail.length;
  const v = n > 3 ? Math.hypot(st.trail[n - 1].x - st.trail[n - 4].x, st.trail[n - 1].y - st.trail[n - 4].y) / Math.max(0.001, (st.trail[n - 1].t - st.trail[n - 4].t) / 1000) : 0;
  const act = st.mode === 'review' ? 0 : Math.min(1, v * 1.2);
  E.wire1.style.setProperty('--activity', driving ? Math.min(1, act + 0.15 * (act > 0.02)).toFixed(2) : 0);
  E.wire2.style.setProperty('--activity', act.toFixed(2));
  drawResponse();
  if (hand.state === 'ready' && st.input === 'hand') drawCamOverlay();

  if (st.mode === 'recording') {
    if (now - st.rec.lastAnalyze > 120) { analyze(st.rec.path); st.rec.lastAnalyze = now; }
    timeline.showRecording(st.rec.path, `${L ? L.name : ''} · recording`);
    timeline.setPlayhead(T, true);
    setText(E.elapsed, fmtTime(T));
    setText(E.modeText, `Rec ${fmtTime(T)}`);
  } else if (st.mode === 'review') {
    timeline.setPlayhead(T);
    setText(E.elapsed, fmtTime(T));
    if (!st.playing) setText(E.modeText, `Paused · ${fmtTime(T)}`);
  } else {
    timeline.setPlayhead(0);
    setText(E.elapsed, fmtTime(0));
  }
  requestAnimationFrame(frame);
}

// sizes are read when the layout changes, not every frame
const respCanvas = $('response');
let respSize = null;
new ResizeObserver(() => { respSize = null; }).observe(respCanvas);
function drawResponse() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (!respSize) {
    const r = respCanvas.getBoundingClientRect();
    respSize = { w: r.width, h: r.height };
    respCanvas.width = Math.max(1, Math.round(r.width * dpr)); respCanvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  const { w, h } = respSize;
  if (!w) return;
  const c = respCanvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const buf = st.respBuf;
  if (buf.length < 2) return;
  const now = buf[buf.length - 1].t;
  const X = t => w - ((now - t) / 2000) * w;
  let lo = Infinity, hi = -Infinity;
  for (const p of buf) { lo = Math.min(lo, p.r, p.o); hi = Math.max(hi, p.r, p.o); }
  const span = Math.max(0.15, hi - lo), mid = (hi + lo) / 2;
  const Y = val => h / 2 - ((val - mid) / span) * (h - 10);
  const line = (key, color, lw) => {
    c.strokeStyle = color; c.lineWidth = lw; c.beginPath();
    buf.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
  };
  line('r', stage.col.faint, 1);
  line('o', stage.col.accent, 1.75);
}

const camCanvas = $('cam-overlay');
let camSize = null;
new ResizeObserver(() => { camSize = null; }).observe(camCanvas);
function drawCamOverlay() {
  const v = $('cam-video');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (!camSize) {
    const r = camCanvas.getBoundingClientRect();
    camSize = { w: r.width, h: r.height };
    camCanvas.width = Math.max(1, Math.round(r.width * dpr)); camCanvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  const { w, h } = camSize;
  const c = camCanvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const vw = v.videoWidth || 4, vh = v.videoHeight || 3;
  const k = Math.max(w / vw, h / vh);
  const dw = vw * k, dh = vh * k, ox = (w - dw) / 2, oy = (h - dh) / 2;
  const P = (x, y) => [ox + x * dw, oy + y * dh];
  const reg = hand.region();
  const [rx, ry] = P(reg.x, reg.y);
  c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1; c.setLineDash([4, 3]);
  c.strokeRect(rx, ry, reg.w * dw, reg.h * dh);
  c.setLineDash([]);
  c.font = `500 9px ${stage.fonts.mono}`; c.fillStyle = 'rgba(255,255,255,0.75)';
  c.fillText('FRAME', rx + 4, ry + 11);
  if (hand.landmarks && hand.tracked) {
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (const p of hand.landmarks) { const [x, y] = P(p.x, p.y); c.beginPath(); c.arc(x, y, 1.6, 0, 7); c.fill(); }
    const [tx, ty] = P(hand.landmarks[8].x, hand.landmarks[8].y);
    c.fillStyle = hand.pinched ? '#ffffff' : stage.col.accent; c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(tx, ty, hand.pinched ? 7 : 5, 0, 7); c.fill(); c.stroke();
  }
}

// ---------- UI that changes on events (not every frame) ----------

function ui() {
  const m = st.mode, L = selLayer(), take = selTake();
  const chip = $('mode-chip');
  chip.className = 'stage-chip' + (m === 'recording' ? ' is-rec' : m === 'countdown' || m === 'armed' ? ' is-count' : m === 'review' ? ' is-replay' : '');
  const sub = $('mode-sub');
  const ghostN = [...compareIds].filter(id => { const t = takeById(id); return t && L && t.layerId === L.id; }).length;
  if (m === 'live') {
    $('mode-text').textContent = `Live · ${st.input === 'hand' ? 'Hand' : 'Cursor'}`;
    sub.textContent = !L ? 'Add an object from the Scene menu.'
      : st.input === 'hand' && HOSTED ? 'Hand input isn’t available on this link. Switch input to Cursor.'
      : st.input === 'hand' && hand.state !== 'ready' ? 'Turn the camera on in the Mapping panel, or switch input to Cursor.'
        : st.input === 'hand' ? `Your hand moves ${L.name}. Press R or say “record” to keep a take.`
          : `Drag on empty stage to rehearse ${L.name}; drag an object to place it. R records while the others play.`;
  } else if (m === 'armed') {
    $('mode-text').textContent = 'Ready';
    sub.textContent = `Pinch to grab ${L ? L.name : 'the object'} and start recording. Let go to stop. Esc cancels.`;
  } else if (m === 'countdown') {
    $('mode-text').textContent = 'Get ready';
    sub.textContent = `Recording ${L ? L.name : ''} after the count-in. Move your pointer to perform; no need to click. Esc cancels.`;
  } else if (m === 'recording') {
    sub.textContent = `${L ? L.name : ''}: up to ${S.limit / 1000} s. Press R or Esc to stop.`;
  } else if (m === 'review') {
    if (st.playing) $('mode-text').textContent = 'Replay';
    sub.textContent = `Scene${L ? ` · ${L.name}${take ? `, ${take.name}` : ''}` : ''}${ghostN ? ` with ${ghostN} ghost${ghostN > 1 ? 's' : ''}` : ''}. Esc returns to live.`;
  }

  const recording = busy();
  $('btn-record').classList.toggle('is-live', recording);
  $('btn-record').querySelector('.tool-text').textContent = m === 'recording' ? 'Recording' : recording ? 'Cancel' : 'Record';
  $('btn-stop').disabled = m === 'live';
  const playing = m === 'review' && st.playing;
  for (const id of ['btn-replay', 'tl-play']) {
    const b = $(id);
    b.disabled = recording || !project.takes.length;
    b.querySelector('span').className = playing ? 'ico-pause' : 'ico-play';
  }
  $('btn-replay').querySelector('.tool-text').textContent = playing ? 'Pause' : 'Replay';
  document.querySelectorAll('[data-input]').forEach(b => { b.disabled = recording; });
  $('smooth').disabled = m === 'recording';

  $('chain-wrap').classList.toggle('is-idle', m === 'review');
  const note = $('panel-note');
  note.textContent = m === 'review'
    ? 'The scene is replaying recorded takes, so the mapping is idle. Press Esc to perform live.'
    : `How live input moves ${L ? L.name : 'the selected object'}. The timeline below holds what you recorded.`;
  note.classList.toggle('is-note', m === 'review');

  if (L) {
    $('object-title').textContent = `${L.name} · position`;
    const simple = ['circle', 'square', 'text'].includes(L.kind);
    $('shape-seg').hidden = !simple;
    document.querySelectorAll('[data-shape]').forEach(b => {
      const on = b.dataset.shape === L.kind;
      b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on);
    });
    const labelled = typeof L.label === 'string' && L.kind !== 'list';
    $('shape-text').hidden = !labelled;
    if (labelled && document.activeElement !== $('shape-text')) $('shape-text').value = L.label;
  }

  $('assist').classList.toggle('is-muted', m === 'recording');
  $('grab').checked = S.grab;
  $('tl-total').textContent = fmtTime(Math.max(sceneDuration(), m === 'review' ? 0 : S.limit));
  $('tl-loop').classList.toggle('is-on', S.loop);
  $('tl-loop').setAttribute('aria-pressed', S.loop);
  timeline.pieces(m === 'recording' ? null : take, st.piece);
  pieceGutter();
  inspector();
}

function inspector() {
  const take = selTake();
  const el = $('inspector');
  el.hidden = !take;
  if (!take) return;
  const L = selLayer();
  $('insp-name').textContent = `${L.name} · ${take.name}`;
  $('insp-name').title = take.name;
  $('insp-speed').value = String(effectiveSpeed(take));
  const s = effectiveSmoothing(take);
  $('insp-smooth').value = Math.round(s * 100);
  $('insp-smooth-val').textContent = `${Math.round(s * 100)}%`;
  const changed = isEdited(take);
  $('insp-orig').textContent = changed ? 'edited · performance kept' : 'as performed';
  $('insp-orig').classList.toggle('is-changed', changed);
  $('insp-reset').disabled = !changed;
  for (const id of ['insp-speed', 'insp-smooth']) $(id).disabled = busy();
}

function refresh() {
  timeline.render({
    layers: project.layers, takesOf, activeOf,
    selectedLayerId: project.selectedLayerId, compareIds, sceneDuration: sceneDuration(),
  });
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
$('btn-use-cursor').addEventListener('click', () => setInput('cursor'));
// claude.ai links can't use the camera, so Hand mode says that once and offers the one useful action
if (HOSTED) {
  $('cam-empty').textContent = 'Not available on this link';
  for (const id of ['cam-status', 'grab-row', 'btn-cam-on', 'cam-note']) $(id).hidden = true;
  const info = $('cam-error');
  info.className = 'fine cam-info';
  info.hidden = false;
  info.innerHTML = 'Hand tracking needs your camera, and pages on claude.ai can’t use it. To try it, run Motion Takes on your computer: in the <code>motion-takes</code> folder run <code>python3 -m http.server</code>, then open <code>localhost:8000</code> in Chrome.';
  $('btn-use-cursor').hidden = false;
  $('btn-use-cursor').classList.add('btn-primary');
}

function setSmoothing(v) {
  S.smoothing = v;
  $('smooth').value = Math.round(v * 100);
  $('smooth-val').textContent = `${Math.round(v * 100)}%`;
  $('smooth-lag').textContent = `${Math.round(tauFor(v))} ms`;
}
$('smooth').addEventListener('input', e => { setSmoothing(e.target.value / 100); save(); });

document.querySelectorAll('[data-shape]').forEach(b => b.addEventListener('click', () => {
  const L = selLayer(); if (!L) return;
  pushHistory();
  L.kind = b.dataset.shape;
  if (L.kind === 'text' && !L.label) L.label = 'hello';
  save(); refresh();
}));
$('shape-text').addEventListener('focus', () => pushHistory());
$('shape-text').addEventListener('input', e => { const L = selLayer(); if (L) { L.label = e.target.value; save(); } });

$('limit').addEventListener('change', e => { S.limit = +e.target.value; timeline.setLimit(S.limit); save(); refresh(); });

$('insp-speed').addEventListener('change', e => {
  const t = selTake(); if (!t) return;
  pushHistory();
  t.adjust = { ...t.adjust, speed: +e.target.value };
  save(); refresh();
});
$('insp-smooth').addEventListener('pointerdown', () => pushHistory());
$('insp-smooth').addEventListener('keydown', () => pushHistory());
$('insp-smooth').addEventListener('input', e => {
  const t = selTake(); if (!t) return;
  t.adjust = { ...t.adjust, smoothing: e.target.value / 100 };
  save(); timeline.redraw(); inspector();
});
$('insp-smooth').addEventListener('change', () => refresh());
$('insp-reset').addEventListener('click', () => {
  const t = selTake(); if (!t) return;
  pushHistory(); resetEdits(t); save(); refresh();
});

E.easeBtns.forEach(b => b.addEventListener('click', () => {
  const t = selTake(); if (!t || st.piece == null) return;
  pushHistory(); setEdit(t, st.piece, { ease: +b.dataset.ease }); save(); refresh();
}));
$('piece-reset').addEventListener('click', () => {
  const t = selTake(); if (!t || st.piece == null) return;
  pushHistory(); setEdit(t, st.piece, { scale: 1, ease: 0 }); save(); refresh();
});
$('grab').addEventListener('change', e => { S.grab = e.target.checked; save(); ui(); });

$('opt-cues').addEventListener('change', e => { S.cues = sound.cues = e.target.checked; save(); });
$('opt-speedtone').addEventListener('change', e => { S.speedTone = sound.speedTone = e.target.checked; if (!e.target.checked) sound.silence(); else sound.ensure(); save(); });

document.querySelectorAll('[data-template]').forEach(b => b.addEventListener('click', () => loadTemplate(b.dataset.template)));
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => { addLayer(b.dataset.add); document.querySelectorAll('.menu.is-open').forEach(m => m.classList.remove('is-open')); }));

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
    note: 'Motion Takes project data: objects in a 16:9 frame and, for each, its takes as per-frame positions with elapsed time. Positions are in frame units (0–1). This is not a Lottie or After Effects file.',
    exportedAt: new Date().toISOString(),
    ...project,
    compare: [...compareIds],
  };
  const json = JSON.stringify(data, null, 1);
  const filename = `motion-takes-${new Date().toISOString().slice(0, 10)}.json`;
  const dl = HOSTED ? await window.claude.use('downloads').catch(() => null) : null;
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
    let layers = data.layers, takes = data.takes.filter(validTake);
    if (!Array.isArray(layers) || !layers.length) { // a one-object file from the first version
      const circle = makeLayer('circle', { name: 'Circle' });
      takes = takes.map(t => ({ ...t, layerId: circle.id }));
      circle.activeTakeId = takes[0] ? takes[0].id : null;
      layers = [circle];
    }
    const apply = () => {
      pushHistory(); toLive();
      project.template = data.template || 'single'; project.decor = data.decor || []; project.layers = layers; project.takes = takes;
      project.selectedLayerId = layers.some(l => l.id === data.selectedLayerId) ? data.selectedLayerId : layers[0].id;
      compareIds.clear(); stage.setDecor(project.decor);
      save(); refresh();
      toast(`Opened ${layers.length} object${layers.length > 1 ? 's' : ''} and ${takes.length} take${takes.length === 1 ? '' : 's'}.`);
    };
    if (project.takes.some(t => !t.example)) toast('Replace this scene with the one in the file?', 'Replace', apply);
    else apply();
  } catch {
    toast('That file is not Motion Takes project data.');
  }
});
$('act-examples').addEventListener('click', () => {
  const L = selLayer(); if (!L) return;
  pushHistory();
  const ex = exampleTakes().map(t => ({ ...t, layerId: L.id }));
  project.takes.push(...ex);
  if (!L.activeTakeId) L.activeTakeId = ex[0].id;
  save(); refresh();
});
$('act-clear').addEventListener('click', () => {
  if (!project.takes.length) return;
  toast(`Delete all ${project.takes.length} takes in this scene?`, 'Delete all', () => {
    pushHistory(); toLive();
    project.takes = [];
    project.layers.forEach(l => { l.activeTakeId = null; });
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
  if (k === '/') { e.preventDefault(); cmdInput.focus(); return; }
  if (k === 'm' || k === 'M') { voice.toggle(); return; }
  if (k === 'r' || k === 'R') { if (!e.repeat) toggleRecord(); e.preventDefault(); }
  else if (k === ' ') { if (!e.repeat) togglePlay(); e.preventDefault(); }
  else if (k === 'Escape') { stop(); }
  else if (/^[1-9]$/.test(k)) { const t = takesOf(selLayer())[+k - 1]; if (t) useTake(t); }
  else if (k === 'Tab' && project.layers.length > 1 && !busy() && e.target === document.body) {
    e.preventDefault();
    const i = project.layers.indexOf(selLayer());
    selectLayer(project.layers[(i + (e.shiftKey ? -1 : 1) + project.layers.length) % project.layers.length]);
  }
  else if ((k === 'ArrowLeft' || k === 'ArrowRight') && st.mode === 'review' && e.target.type !== 'range') {
    st.playing = false;
    const step = (e.shiftKey ? 500 : 1000 / 30) * (k === 'ArrowLeft' ? -1 : 1);
    st.playhead = Math.max(0, Math.min(sceneDuration(), st.playhead + step));
    e.preventDefault(); ui();
  }
});
document.addEventListener('keyup', e => { if (e.key === ' ' && e.target.tagName === 'BUTTON') e.preventDefault(); });

let toastTimer = 0;
function toast(text, action, fn) {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.textContent = action || '';
  btn.onclick = () => { el.hidden = true; fn && fn(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 4200);
}

window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  if (sandbox) { restore(sandbox.snap); sandbox = null; }
  writeNow();
  hand.disable();
});

// ---------- commands: say it or type it ----------

let claudeFn, claudeOff = false;
async function getClaude() {
  if (claudeOff || !HOSTED) return null;
  if (claudeFn === undefined) claudeFn = await window.claude.use('sample').catch(() => null);
  return claudeFn;
}

const api = {
  takes: () => takesOf(selLayer()),
  selected: selTake,
  layers: () => project.layers,
  selectedLayer: selLayer,
  selectLayer: layer => selectLayer(layer, false),
  activeOf,
  input: () => st.input,
  grabGate: () => S.grab,
  selectedPiece: () => st.piece,
  selectPiece: i => { st.piece = i; ui(); },
  record: () => { if (!busy()) toggleRecord(); },
  stop,
  play: () => { if (!(st.mode === 'review' && st.playing)) togglePlay(); },
  playFromStart: () => { if (!project.takes.length) return; st.mode = 'review'; st.playhead = 0; st.playing = true; st.endHold = 0; ui(); },
  pause: () => { if (st.mode === 'review' && st.playing) togglePlay(); },
  live: toLive,
  setLoop: v => { S.loop = v; save(); ui(); },
  select: t => useTake(t),
  compare: list => {
    const L = selLayer();
    compareIds.clear();
    list.forEach(t => { if (t && L && t.layerId === L.id && t.id !== L.activeTakeId) compareIds.add(t.id); });
    save(); enterReview(); refresh();
  },
  comparedWithSelected: () => [selTake(), ...[...compareIds].map(takeById).filter(t => t && t.layerId === project.selectedLayerId)].filter(Boolean),
  undo: undoEdit,
  redo: redoEdit,
  edit: (label, fn) => { pushHistory(); const r = fn(); save(); refresh(); return r; },
  duplicate: (src, name) => {
    const c = { ...copyTake(src), id: newId(), name, createdAt: new Date().toISOString() };
    project.takes.push(c);
    return c;
  },
  rename: (t, name) => { t.name = name; },
  remove: t => deleteTake(t),
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

async function run(text) {
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
  run(v);
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
  hosted: HOSTED,
  onFinal: text => {
    cmdInput.classList.remove('is-interim');
    cmdInput.value = '';
    if (performance.now() - voiceStopAt < 3000 && /\b(stop|cut|done)\b/i.test(text)) return;
    run(text);
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
    $('mic').classList.toggle('is-blocked', !!v.error);
    $('mic').setAttribute('aria-pressed', v.on);
    $('mic').title = v.error || 'Listen for voice commands (M)';
    if (v.error) { say(null, { kind: 'info', reply: v.error }); toast(v.error); }
    else if (v.on) say(null, { kind: 'info', reply: 'Listening. Say “record”, “replay”, “longer pause”, or “help”.' });
    else cmdInput.classList.remove('is-interim');
  },
});
voice.onSilent = () => say(null, { kind: 'info', reply: 'Not hearing anything yet. Check that the browser is allowed to use the microphone (the icon in the address bar) and that the right microphone is selected.' });
$('mic').addEventListener('click', () => voice.toggle());

// ---------- guided examples ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const demo = new Demo(
  { card: $('demo'), title: $('demo-title'), step: $('demo-step'), text: $('demo-text'), say: $('demo-say'), guide: $('demo-guide'), pause: $('demo-pause'), next: $('demo-next'), tryIt: $('demo-try'), exit: $('demo-exit') },
  {
    enterSandbox: key => {
      if (sandbox) return;
      sandbox = { snap: snapshot(), past: past.splice(0), future: future.splice(0) };
      const p = newProject(key === 'choreo' || key === 'walkthrough' ? 'notification' : 'single');
      if (key === 'feelings') p.takes = [p.takes[0]];
      project.template = p.template; project.decor = p.decor; project.layers = p.layers; project.takes = p.takes;
      project.selectedLayerId = p.selectedLayerId;
      compareIds.clear(); st.piece = null;
      stage.setDecor(project.decor);
      toLive(); refresh();
    },
    leaveSandbox: () => {
      if (!sandbox) return;
      const sb = sandbox;
      sandbox = null;
      restore(sb.snap);
      past.length = 0; past.push(...sb.past);
      future.length = 0; future.push(...sb.future);
      st.piece = null;
      toLive(); refresh();
      say(null, { kind: 'info', reply: 'Example closed. Your own scene is back.' });
    },
    selectIndex: i => { const t = takesOf(selLayer())[i]; if (t) useTake(t); },
    compareIndexes: list => api.compare(list.map(i => takesOf(selLayer())[i])),
    play: () => api.playFromStart(),
    flashPieces: () => flash($('pieces-row')),
    // where things are on screen, for the example's cursor
    layerPoint: name => {
      stage.updateOffset();
      const L = st.drawn.find(d => d.layer.name === name);
      const r = stage.rect;
      return L ? { x: stage.left + r.x + L.x * r.w, y: stage.top + r.y + L.y * r.h } : { x: stage.left + r.x + r.w / 2, y: stage.top + r.y + r.h / 2 };
    },
    stageCenter: () => { stage.updateOffset(); const r = stage.rect; return { x: stage.left + r.x + r.w * 0.78, y: stage.top + r.y + r.h / 2 }; },
    frameHeight: () => stage.rect.h,
    laneOf: name => {
      const row = [...document.querySelectorAll('.layer-row')].find(r => r.querySelector('.track-name').textContent === name);
      row.scrollIntoView({ block: 'nearest' });
      timeline.box = null;
      return row.querySelector('.tl-lane');
    },
    cmdInput: () => cmdInput,
    flashLayers: () => document.querySelectorAll('.layer-row .tl-lane').forEach(flash),
    typeAndRun: async (text, cancelled) => {
      cmdInput.value = '';
      for (const ch of text) { if (cancelled()) return; cmdInput.value += ch; await sleep(30); }
      await sleep(280);
      if (cancelled()) return;
      cmdInput.value = '';
      await run(text);
    },
    tryHands: () => {
      setInput('hand');
      S.grab = true; save(); ui();
      say(null, { kind: 'info', reply: HOSTED ? 'Hand input is on, with Pinch to grab. The camera only works when Motion Takes runs on your own computer, not on this link.' : 'Hand input is on, with Pinch to grab. Click Enable camera in the Mapping panel.' });
    },
  },
);
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => demo.start(b.dataset.demo)));

// ---------- start ----------

setSmoothing(S.smoothing);
$('limit').value = String(S.limit);
$('opt-cues').checked = S.cues;
$('opt-speedtone').checked = S.speedTone;
setInput('cursor');
refresh();
requestAnimationFrame(frame);
