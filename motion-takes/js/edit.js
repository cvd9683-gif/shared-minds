// ------------------------------------------------
// Editing a take without re-performing it.
//
// A take is split into PIECES: moves, and the holds
// between them (found from the speed profile). Each
// piece can be retimed with two non-destructive values:
//   scale  how long the piece lasts (×, 0.1–4)
//   ease   where its time goes: < 0 starts slow (ease in),
//          > 0 starts fast and settles (ease out)
// The path itself never changes. The raw performance is
// never touched; edits live beside it in take.edits.
//
// rendered(take) resamples the edited take in DISPLAY time,
// and everything that draws or plays uses that.
// ------------------------------------------------

import { analyze, derived, effectiveSmoothing, effectiveSpeed, sampleAt } from './takes.js';

const STEP = 1000 / 60;
export const SCALE_MIN = 0.1, SCALE_MAX = 4;

// ---------- pieces ----------

export function piecesOf(take) {
  if (take.segments && take.segments.length) return take.segments;
  const d = derived(take);
  const dur = take.duration;
  // merge holds separated by a blip shorter than 120 ms
  const holds = [];
  for (const h of d.holds) {
    const last = holds[holds.length - 1];
    if (last && h.t0 - last.t1 < 120) last.t1 = h.t1;
    else holds.push({ t0: h.t0, t1: h.t1 });
  }
  const segs = [];
  let cur = 0;
  for (const h of holds) {
    if (h.t0 - cur > 1) segs.push({ kind: 'move', t0: cur, t1: h.t0 });
    segs.push({ kind: 'hold', t0: Math.max(cur, h.t0), t1: h.t1 });
    cur = h.t1;
  }
  if (dur - cur > 1) segs.push({ kind: 'move', t0: cur, t1: dur });
  // fold a sliver of movement at either end into its neighbour
  const out = segs.filter((s, i) => !(s.kind === 'move' && s.t1 - s.t0 < 70 && segs.length > 1 && (i === 0 || i === segs.length - 1)));
  if (out.length) { out[0].t0 = 0; out[out.length - 1].t1 = dur; }
  for (let i = 1; i < out.length; i++) out[i].t0 = out[i - 1].t1;
  if (!out.length) out.push({ kind: 'move', t0: 0, t1: dur });
  // facts about each piece, measured once from the performance
  for (const s of out) {
    const a = sampleAt(d, s.t0), b = sampleAt(d, s.t1);
    s.dist = +Math.hypot(b.x - a.x, b.y - a.y).toFixed(4);
    let peak = 0;
    for (let i = 0; i < d.n; i++) if (d.t[i] >= s.t0 && d.t[i] <= s.t1) peak = Math.max(peak, d.speed[i]);
    s.peak = +peak.toFixed(3);
    s.fromEdge = a.x < 0.04 || a.x > 0.96 || a.y < 0.04 || a.y > 0.96;
  }
  take.segments = out;
  return out;
}

export function editOf(take, i) {
  const e = take.edits && take.edits[i];
  return { scale: e && e.scale != null ? e.scale : 1, ease: e && e.ease != null ? e.ease : 0 };
}

export function setEdit(take, i, patch) {
  const segs = piecesOf(take);
  if (!take.edits || take.edits.length !== segs.length) take.edits = segs.map((_, j) => ({ ...editOf(take, j) }));
  const e = take.edits[i];
  if (patch.scale != null) e.scale = clamp(patch.scale, SCALE_MIN, SCALE_MAX);
  if (patch.ease != null) e.ease = clamp(patch.ease, -1, 1);
}

export function isEdited(take) {
  const piecesChanged = (take.edits || []).some(e => Math.abs(e.scale - 1) > 0.005 || Math.abs(e.ease) > 0.005);
  return piecesChanged || effectiveSpeed(take) !== 1 || Math.abs(effectiveSmoothing(take) - take.smoothing) > 0.001;
}

// Back to the performance. Where and when the take sits in the scene stays.
export function resetEdits(take) {
  const a = take.adjust || {};
  take.edits = null;
  take.adjust = { speed: 1, smoothing: take.smoothing, offset: a.offset || 0, dx: a.dx || 0, dy: a.dy || 0 };
}

// When the take starts in the scene (ms), and how far it is shifted in the frame.
export function offsetOf(take) { return (take.adjust && take.adjust.offset) || 0; }
export function shiftOf(take) { return { dx: (take.adjust && take.adjust.dx) || 0, dy: (take.adjust && take.adjust.dy) || 0 }; }

// ---------- timing ----------

function warp(v, ease) {
  if (Math.abs(ease) < 0.005) return v;
  const k = 1 + Math.abs(ease) * 1.8;
  return ease > 0 ? 1 - Math.pow(1 - v, k) : Math.pow(v, k);
}

const timingCache = new WeakMap();
export function timingOf(take) {
  const key = JSON.stringify([effectiveSpeed(take), take.edits || null, take.segments ? take.segments.length : 0]);
  const hit = timingCache.get(take);
  if (hit && hit.key === key) return hit.timing;
  const timing = computeTiming(take);
  timingCache.set(take, { key, timing });
  return timing;
}

function computeTiming(take) {
  const segs = piecesOf(take);
  const sp = effectiveSpeed(take);
  let acc = 0;
  return segs.map((s, i) => {
    const { scale, ease } = editOf(take, i);
    const len = ((s.t1 - s.t0) * scale) / sp;
    const r = { ...s, i, scale, ease, d0: acc, d1: acc + len };
    acc += len;
    return r;
  });
}

function toTakeTime(timing, T) {
  if (!timing.length) return 0;
  let seg = timing[timing.length - 1];
  for (const s of timing) if (T < s.d1) { seg = s; break; }
  const span = seg.d1 - seg.d0;
  const v = span > 0 ? clamp((T - seg.d0) / span, 0, 1) : 1;
  return seg.t0 + warp(v, seg.ease) * (seg.t1 - seg.t0);
}

// ---------- the edited take, in display time ----------

const cache = new WeakMap();

export function rendered(take) {
  const { dx, dy } = shiftOf(take);
  const sig = JSON.stringify([effectiveSmoothing(take), effectiveSpeed(take), take.edits || null, take.segments ? take.segments.length : 0, dx, dy]);
  const hit = cache.get(take);
  if (hit && hit.sig === sig) return hit;
  const base = derived(take);
  const timing = timingOf(take);
  const D = timing.length ? timing[timing.length - 1].d1 : 0;
  const n = Math.max(2, Math.ceil(D / STEP) + 1);
  const t = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n), tracked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const T = Math.min(D, i * STEP);
    const p = sampleAt(base, toTakeTime(timing, T));
    t[i] = T; x[i] = p.x + dx; y[i] = p.y + dy; tracked[i] = p.tracked ? 1 : 0;
  }
  const d = analyze({ t, x, y, tracked, n });
  d.sig = sig; d.timing = timing; d.duration = D;
  cache.set(take, d);
  return d;
}

export function playDuration(take) { return rendered(take).duration; }

// ---------- words ----------

// Holds in the middle are pauses; a hold at the very start or end is a wait or a rest,
// and doesn't read as hesitation.
export function interiorHolds(timing) {
  return timing.filter((p, j) => p.kind === 'hold' && j > 0 && j < timing.length - 1);
}

export function pieceName(take, i) {
  const timing = timingOf(take);
  const seg = timing[i];
  if (!seg) return '';
  if (seg.kind === 'hold') {
    if (i === 0) return 'Opening wait';
    if (i === timing.length - 1) return 'Final rest';
    return `Pause ${interiorHolds(timing).findIndex(p => p.i === i) + 1}`;
  }
  return pieceLabel(take, i);
}

export function pieceLabel(take, i) {
  const seg = timingOf(take)[i];
  if (!seg) return '';
  if (seg.kind === 'hold') return pieceName(take, i);
  const rate = seg.scale / effectiveSpeed(take) || 1;
  const peak = seg.peak / rate;
  const moves = timingOf(take).filter(s => s.kind === 'move' && s.dist >= 0.06);
  if (seg.dist < 0.06) return 'Small drift';
  const tempo = peak > 1.6 ? 'Quick' : peak < 0.55 ? 'Slow' : 'Steady';
  let role = 'move';
  if (moves[0] && moves[0].i === i && seg.fromEdge) role = 'entrance';
  else if (moves.length > 1 && moves[moves.length - 1].i === i) role = 'final move';
  return `${tempo} ${role}`;
}

export function describe(take) {
  const timing = timingOf(take);
  return timing.map((s, j) => {
    const t = `${((s.d1 - s.d0) / 1000).toFixed(2)} s`;
    if (s.kind === 'hold') return `${j === 0 ? 'wait' : j === timing.length - 1 ? 'rest' : 'pause'} ${t}`;
    return `${pieceLabel(take, s.i).toLowerCase()} (${t})`;
  }).join(' → ');
}

export function metrics(take) {
  const timing = timingOf(take);
  const d = rendered(take);
  const holds = interiorHolds(timing);
  const moves = timing.filter(s => s.kind === 'move');
  const holdTotal = holds.reduce((a, s) => a + (s.d1 - s.d0), 0);
  return {
    duration: d.duration,
    holdCount: holds.length,
    holdTotal,
    holdShare: d.duration ? holdTotal / d.duration : 0,
    longestHold: holds.reduce((m, s) => Math.max(m, s.d1 - s.d0), 0),
    peak: d.maxSpeed,
    smallMoves: moves.filter(s => s.dist < 0.06).length,
    moveCount: moves.filter(s => s.dist >= 0.06).length,
  };
}

// How strongly a take's timing reads as a feeling. A heuristic built from
// pauses and speed only; it says why, so a person can disagree.
export function feelingScore(take, feeling) {
  const m = metrics(take);
  const peak = Math.min(1, m.peak / 2.5);
  switch (feeling) {
    case 'confident': return peak * 1.2 - m.holdShare * 1.5 - m.smallMoves * 0.25 - Math.max(0, m.holdCount - 1) * 0.15;
    case 'nervous': return m.holdShare * 1.2 + m.smallMoves * 0.35 + m.holdCount * 0.2 + (peak > 0.5 ? 0.2 : 0);
    case 'calm': return (1 - peak) * 1.2 - m.smallMoves * 0.3 - Math.max(0, m.holdCount - 1) * 0.2;
    case 'urgent': return peak * 1.3 - m.holdShare * 1.2 - m.duration / 10000;
    default: return 0;
  }
}

export function feelingReasons(take) {
  const m = metrics(take);
  const bits = [];
  bits.push(m.holdCount ? `${m.holdCount} pause${m.holdCount > 1 ? 's' : ''} mid-motion (${(m.holdTotal / 1000).toFixed(2)} s still)` : 'no pauses mid-motion');
  bits.push(`peak speed ${m.peak.toFixed(1)} frames/s`);
  if (m.smallMoves) bits.push(`${m.smallMoves} small drift${m.smallMoves > 1 ? 's' : ''}`);
  return bits.join(', ');
}

// Feeling words → retiming. Multiplies onto whatever is there now.
export const FEELINGS = {
  calm: { move: 1.35, hold: 1.1, ease: -0.15, smooth: +0.2, note: 'moves 35% longer, softer smoothing' },
  nervous: { move: 0.75, hold: 1.45, ease: +0.5, smooth: -0.15, note: 'quicker darts, longer pauses, rawer motion' },
  hesitant: { move: 1.05, hold: 1.7, ease: -0.2, smooth: 0, note: 'pauses 70% longer, moves start slower' },
  confident: { move: 0.85, hold: 0.55, ease: +0.55, smooth: +0.05, note: 'pauses about half as long, moves start fast and settle' },
  urgent: { move: 0.6, hold: 0.3, ease: +0.35, smooth: -0.05, note: 'everything faster, pauses nearly gone' },
  heavy: { move: 1.5, hold: 1.15, ease: -0.55, smooth: +0.1, note: 'moves slower to start, as if pushing weight' },
};

export const FEELING_WORDS = {
  calm: ['calm', 'calmer', 'relaxed', 'gentle', 'gentler', 'soft', 'softer', 'peaceful', 'chill'],
  nervous: ['nervous', 'anxious', 'jittery', 'scared', 'worried', 'twitchy', 'unsure'],
  hesitant: ['hesitant', 'hesitating', 'shy', 'reluctant', 'doubtful', 'timid', 'careful'],
  confident: ['confident', 'sure', 'decisive', 'bold', 'assertive', 'certain', 'proud'],
  urgent: ['urgent', 'rushed', 'hurried', 'panicked', 'frantic', 'excited'],
  heavy: ['heavy', 'tired', 'sluggish', 'lazy', 'sleepy', 'weighty', 'sad'],
};

export function applyFeeling(take, feeling) {
  const f = FEELINGS[feeling];
  timingOf(take).forEach(s => {
    const e = editOf(take, s.i);
    if (s.kind === 'hold') setEdit(take, s.i, { scale: e.scale * f.hold });
    else setEdit(take, s.i, { scale: e.scale * f.move, ease: e.ease + f.ease });
  });
  const sm = clamp(effectiveSmoothing(take) + f.smooth, 0, 1);
  take.adjust = { ...take.adjust, smoothing: sm };
  return f.note;
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
