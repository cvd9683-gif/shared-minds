// ------------------------------------------------
// Takes: the recorded data, the smoothing filter,
// and the analysis that the stage and timeline draw.
//
// A take stores the RAW input it was performed with,
// sampled once per animation frame with elapsed time:
//   raw: [[tMs, x, y, tracked], ...]   x, y in frame units (0–1)
// The object's path is derived from raw by the same
// smoothing filter used live, so adjustments re-run the
// filter and never modify what was performed.
// ------------------------------------------------

export const SMOOTH_MAX_TAU = 450; // ms of lag at 100% smoothing
const RECOVER_MS = 380;            // after tracking returns, ease in for this long
const RECOVER_TAU = 140;           // ... with at least this much lag, so nothing jumps

export function tauFor(smoothing) {
  // smoothing 0..1 → time constant in ms. Curved so the low end is fine-grained.
  return SMOOTH_MAX_TAU * Math.pow(smoothing, 1.6);
}

// Exponential smoothing that depends on elapsed time, not frame count,
// so a take replays identically at any frame rate.
export function createFilter(x, y, lost = false, recoverLeft = 0) {
  return { x, y, lost, recoverUntil: recoverLeft > 0 ? recoverLeft : -Infinity, t: 0 };
}

export function stepFilter(f, rx, ry, tracked, t, smoothing) {
  const dt = Math.max(0, t - f.t);
  f.t = t;
  if (!tracked) { f.lost = true; return f; } // hold position while the hand is missing
  if (f.lost) { f.lost = false; f.recoverUntil = t + RECOVER_MS; }
  let tau = tauFor(smoothing);
  if (t < f.recoverUntil) tau = Math.max(tau, RECOVER_TAU);
  const a = tau <= 0.5 ? 1 : 1 - Math.exp(-dt / tau);
  f.x += (rx - f.x) * a;
  f.y += (ry - f.y) * a;
  return f;
}

// ---------- derived paths (cached per smoothing value) ----------

const cache = new WeakMap();

export function effectiveSmoothing(take) {
  return take.adjust && typeof take.adjust.smoothing === 'number' ? take.adjust.smoothing : take.smoothing;
}
export function effectiveSpeed(take) {
  return take.adjust && take.adjust.speed ? take.adjust.speed : 1;
}
// Duration as it plays, after the speed adjustment.
export function playDuration(take) {
  return take.duration / effectiveSpeed(take);
}

export function derived(take) {
  const s = effectiveSmoothing(take);
  const hit = cache.get(take);
  if (hit && hit.s === s) return hit;
  const raw = take.raw;
  const st = take.start || { x: raw[0][1], y: raw[0][2], lost: false, recoverLeft: 0 };
  const f = createFilter(st.x, st.y, st.lost, st.recoverLeft);
  const n = raw.length;
  const t = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n);
  const tracked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    stepFilter(f, r[1], r[2], r[3] !== 0, r[0], s);
    t[i] = r[0]; x[i] = f.x; y[i] = f.y; tracked[i] = r[3] !== 0 ? 1 : 0;
  }
  const d = analyze({ s, t, x, y, tracked, n });
  cache.set(take, d);
  return d;
}

// Adds speed, holds and tracking-lost spans to a path {t, x, y, tracked, n}.
export function analyze(d) {
  d.speed = speedProfile(d);
  d.holds = findHolds(d);
  d.lostSpans = findLost(d);
  d.maxSpeed = d.speed.reduce((m, v) => Math.max(m, v), 0);
  return d;
}

// Speed at a time in take time, in frame-widths per second.
export function speedAt(d, ms) {
  if (d.n < 2) return 0;
  const a = sampleAt(d, ms - 40), b = sampleAt(d, ms);
  return Math.hypot(b.x - a.x, b.y - a.y) / 0.04;
}

// Position at a time in TAKE time (ms), interpolated between samples.
export function sampleAt(d, ms) {
  const { t, x, y, n } = d;
  if (n === 0) return { x: 0.5, y: 0.5, tracked: true };
  if (ms <= t[0]) return { x: x[0], y: y[0], tracked: !!d.tracked[0] };
  if (ms >= t[n - 1]) return { x: x[n - 1], y: y[n - 1], tracked: !!d.tracked[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= ms) lo = mid; else hi = mid;
  }
  const span = t[hi] - t[lo] || 1;
  const k = (ms - t[lo]) / span;
  return { x: x[lo] + (x[hi] - x[lo]) * k, y: y[lo] + (y[hi] - y[lo]) * k, tracked: !!d.tracked[lo] };
}

// Speed in frame-widths per second, averaged over a short window.
function speedProfile(d) {
  const { t, x, y, n } = d;
  const out = new Float64Array(n);
  const W = 45; // ms half-window
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (t[a] < t[i] - W) a++;
    while (b < n - 1 && t[b + 1] <= t[i] + W) b++;
    const dt = t[b] - t[a];
    if (dt <= 0) { out[i] = 0; continue; }
    let len = 0;
    for (let j = a + 1; j <= b; j++) len += Math.hypot(x[j] - x[j - 1], y[j] - y[j - 1]);
    out[i] = len / (dt / 1000);
  }
  return out;
}

// Holds: stretches where the object is nearly still for ≥ 220 ms.
// These are the pauses and hesitations the tool is meant to preserve.
function findHolds(d) {
  const { t, x, y, n, speed, tracked } = d;
  const holds = [];
  const STILL = 0.045, MIN = 220;
  let i0 = -1;
  for (let i = 0; i <= n; i++) {
    const still = i < n && speed[i] < STILL && tracked[i];
    if (still && i0 < 0) i0 = i;
    if (!still && i0 >= 0) {
      const t0 = t[i0], t1 = t[i - 1];
      if (t1 - t0 >= MIN) holds.push({ t0, t1, x: x[i0], y: y[i0] });
      i0 = -1;
    }
  }
  return holds;
}

function findLost(d) {
  const spans = [];
  let i0 = -1;
  for (let i = 0; i <= d.n; i++) {
    const lost = i < d.n && !d.tracked[i];
    if (lost && i0 < 0) i0 = i;
    if (!lost && i0 >= 0) { spans.push({ t0: d.t[i0], t1: d.t[i - 1] }); i0 = -1; }
  }
  return spans;
}

// ---------- making takes ----------

export function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeTake({ name, raw, input, smoothing, start, example = false }) {
  const duration = raw.length ? raw[raw.length - 1][0] : 0;
  return {
    id: newId(),
    name,
    createdAt: new Date().toISOString(),
    input,
    example,
    smoothing,             // smoothing used while performing
    start,                 // filter state when recording began
    duration,
    raw,
    adjust: { speed: 1, smoothing },
  };
}

// Round for storage; keeps a 5 s take to a few kilobytes.
export function compactRaw(raw) {
  return raw.map(r => [Math.round(r[0]), +r[1].toFixed(4), +r[2].toFixed(4), r[3] ? 1 : 0]);
}

export function validTake(t) {
  return t && typeof t.id === 'string' && Array.isArray(t.raw) && t.raw.length > 1 &&
    t.raw.every(r => Array.isArray(r) && r.length >= 3 && r.every(v => typeof v === 'number' && isFinite(v)));
}

// ---------- example takes (clearly labelled as examples) ----------

function rng(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
}
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

function synth(duration, fn, seed) {
  const r = rng(seed);
  const raw = [];
  for (let t = 0; t <= duration; t += 1000 / 60) {
    const p = fn(t);
    raw.push([t, p.x + (r() - 0.5) * 0.002, p.y + (r() - 0.5) * 0.002, 1]);
  }
  return raw;
}

export function exampleTakes() {
  // A quick entrance, a hesitation, a small doubt, then commitment.
  const quick = synth(3600, t => {
    if (t < 520) { const k = easeOut(t / 520); return { x: -0.04 + 0.5 * k, y: 0.62 - 0.08 * k }; }
    if (t < 1500) return { x: 0.46, y: 0.54 };
    if (t < 1850) { const k = easeInOut((t - 1500) / 350); return { x: 0.46 + 0.035 * k, y: 0.54 - 0.01 * k }; }
    if (t < 2500) return { x: 0.495, y: 0.53 };
    if (t < 2900) { const k = easeOut((t - 2500) / 400); return { x: 0.495 + 0.255 * k, y: 0.53 - 0.06 * k }; }
    return { x: 0.75, y: 0.47 };
  }, 7);
  // The same idea, performed calmly: one continuous arc.
  const calm = synth(4200, t => {
    const k = easeInOut(Math.min(1, t / 3900));
    return { x: 0.08 + 0.67 * k, y: 0.62 - 0.15 * Math.sin(Math.PI * k) };
  }, 11);
  const a = makeTake({ name: 'Example · quick entrance, hesitation', raw: quick, input: 'example', smoothing: 0.25, start: { x: -0.04, y: 0.62, lost: false, recoverLeft: 0 }, example: true });
  const b = makeTake({ name: 'Example · calm arc', raw: calm, input: 'example', smoothing: 0.25, start: { x: 0.08, y: 0.62, lost: false, recoverLeft: 0 }, example: true });
  for (const t of [a, b]) { t.raw = compactRaw(t.raw); t.duration = t.raw[t.raw.length - 1][0]; }
  return [a, b];
}

export function fmtTime(ms) {
  ms = Math.max(0, ms);
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}
