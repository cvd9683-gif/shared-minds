// ------------------------------------------------
// Scenes: several objects (layers) in one frame, the way
// a UX motion file has a list, a toast and a badge.
//
// Each layer has its own takes. One take per layer is
// "in use"; the scene plays every layer's take together,
// each shifted by that take's start offset. You record a
// layer while the others play, so you perform in time
// with them.
//
// Positions are frame units: x 0–1 across, y 0–1 down.
// Sizes: w is a share of the frame's width, h of its height.
// ------------------------------------------------

import { compactRaw, makeTake, newId } from './takes.js';

export const KIND_LABEL = {
  circle: 'Circle', square: 'Square', text: 'Text', card: 'Card', button: 'Button', badge: 'Badge', list: 'List',
};

export function makeLayer(kind, props = {}) {
  const base = {
    circle: { w: 0.06, h: 0.1067 },
    square: { w: 0.06, h: 0.1067 },
    text: { w: 0.16, h: 0.09, label: 'hello' },
    card: { w: 0.3, h: 0.13, label: 'Card title', sub: 'Supporting text' },
    button: { w: 0.14, h: 0.08, label: 'Continue' },
    badge: { w: 0.032, h: 0.057, label: '1' },
    list: { w: 0.32, h: 0.42 },
  }[kind];
  return { id: newId(), kind, name: KIND_LABEL[kind], x: 0.5, y: 0.5, activeTakeId: null, ...base, ...props };
}

// ---------- templates ----------

export const TEMPLATES = {
  single: { name: 'One object', note: 'A single circle, for working out a feeling.' },
  notification: { name: 'Notification arrives', note: 'A list makes room, a toast drops in, a badge lands.' },
  cards: { name: 'Cards fan out', note: 'Three stacked cards spread apart, one after another.' },
};

export function decorFor(template) {
  if (template === 'notification') {
    // a simple app window behind the layers; it doesn't move
    return [
      { type: 'panel', x: 0.31, y: 0.06, w: 0.38, h: 0.9 },
      { type: 'bar', x: 0.31, y: 0.06, w: 0.38, h: 0.085, label: 'Messages' },
    ];
  }
  return [];
}

// Example takes are generated, not performed, and are labelled as examples.
function rng(seed) { return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const backOut = k => { const c = 1.4; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

// keys: [{t, x, y, ease}] — position reached at time t, eased from the previous key
function keyed(keys, seed) {
  const r = rng(seed), raw = [];
  const end = keys[keys.length - 1].t;
  for (let t = 0; t <= end + 0.1; t += 1000 / 60) {
    let i = keys.findIndex(k => k.t >= t);
    if (i < 0) i = keys.length - 1;
    if (i === 0) i = 1;
    const a = keys[i - 1], b = keys[i];
    const k = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    const e = (b.ease || easeOut)(k);
    raw.push([t, a.x + (b.x - a.x) * e + (r() - 0.5) * 0.0015, a.y + (b.y - a.y) * e + (r() - 0.5) * 0.0015, 1]);
  }
  return raw;
}

function example(layer, name, keys, seed, offset = 0) {
  const t = makeTake({ name: `Example · ${name}`, raw: keyed(keys, seed), input: 'example', smoothing: 0.15, start: { x: keys[0].x, y: keys[0].y, lost: false, recoverLeft: 0 }, example: true });
  t.raw = compactRaw(t.raw);
  t.duration = t.raw[t.raw.length - 1][0];
  t.layerId = layer.id;
  t.adjust.offset = offset;
  return t;
}

export function buildTemplate(template, singleExamples) {
  if (template === 'notification') {
    const list = makeLayer('list', { name: 'List', x: 0.5, y: 0.5, w: 0.34, h: 0.5 });
    const toast = makeLayer('card', { name: 'Toast', x: 0.5, y: 0.22, w: 0.34, h: 0.12, label: 'Ana sent you a photo', sub: 'now' });
    const badge = makeLayer('badge', { name: 'Badge', x: 0.655, y: 0.1, label: '1' });
    const takes = [
      example(list, 'list makes room', [{ t: 0, x: 0.5, y: 0.42 }, { t: 160, x: 0.5, y: 0.42 }, { t: 560, x: 0.5, y: 0.58 }, { t: 1300, x: 0.5, y: 0.58 }], 3),
      example(toast, 'drops in quickly', [{ t: 0, x: 0.5, y: -0.1 }, { t: 220, x: 0.5, y: -0.1 }, { t: 620, x: 0.5, y: 0.22, ease: backOut }, { t: 1400, x: 0.5, y: 0.22 }], 5),
      example(toast, 'drifts in gently', [{ t: 0, x: 0.5, y: -0.1 }, { t: 300, x: 0.5, y: -0.1 }, { t: 1150, x: 0.5, y: 0.22, ease: easeInOut }, { t: 1700, x: 0.5, y: 0.22 }], 9),
      example(badge, 'lands', [{ t: 0, x: 0.655, y: 0.02 }, { t: 520, x: 0.655, y: 0.02 }, { t: 760, x: 0.655, y: 0.1, ease: backOut }, { t: 1400, x: 0.655, y: 0.1 }], 4),
    ];
    list.activeTakeId = takes[0].id; toast.activeTakeId = takes[1].id; badge.activeTakeId = takes[3].id;
    return { layers: [list, toast, badge], takes, selectedLayerId: toast.id };
  }
  if (template === 'cards') {
    const names = ['Card A', 'Card B', 'Card C'];
    const targets = [0.22, 0.5, 0.78];
    const layers = names.map((n, i) => makeLayer('card', { name: n, x: 0.5, y: 0.52, w: 0.2, h: 0.36, label: n, sub: ['Plan', 'Build', 'Ship'][i] }));
    const takes = layers.map((l, i) => example(l, 'spreads out', [{ t: 0, x: 0.5, y: 0.52 + i * 0.012 }, { t: 600, x: targets[i], y: 0.52, ease: easeInOut }, { t: 1100, x: targets[i], y: 0.52 }], 20 + i, i * 90));
    layers.forEach((l, i) => { l.activeTakeId = takes[i].id; });
    return { layers, takes, selectedLayerId: layers[0].id };
  }
  const circle = makeLayer('circle', { name: 'Circle' });
  const takes = (singleExamples || []).map(t => ({ ...t, layerId: circle.id }));
  circle.activeTakeId = takes[0] ? takes[0].id : null;
  return { layers: [circle], takes, selectedLayerId: circle.id };
}

// ---------- drawing ----------

function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function layerBox(layer, x, y, rect) {
  const w = layer.w * rect.w, h = layer.h * rect.h;
  return { x: rect.x + x * rect.w - w / 2, y: rect.y + y * rect.h - h / 2, w, h };
}

export function drawDecor(c, decor, rect, col, fonts) {
  for (const d of decor) {
    const x = rect.x + d.x * rect.w, y = rect.y + d.y * rect.h, w = d.w * rect.w, h = d.h * rect.h;
    if (d.type === 'panel') {
      c.fillStyle = '#ffffff'; c.strokeStyle = col.line; c.lineWidth = 1;
      rr(c, x, y, w, h, 14); c.fill(); c.stroke();
    } else if (d.type === 'bar') {
      c.save(); rr(c, x, y, w, h, 14); c.clip();
      c.fillStyle = '#f3f1ec'; c.fillRect(x, y, w, h);
      c.restore();
      c.strokeStyle = col.line; c.beginPath(); c.moveTo(x, y + h); c.lineTo(x + w, y + h); c.stroke();
      c.fillStyle = col.ink; c.font = `600 ${Math.round(h * 0.34)}px ${fonts.sans}`; c.textBaseline = 'middle';
      c.fillText(d.label, x + w * 0.06, y + h / 2);
    }
  }
}

// opts: { ghost, selected, col, fonts }
export function drawLayer(c, layer, x, y, rect, opts) {
  const { col, fonts } = opts;
  const b = layerBox(layer, x, y, rect);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const ghost = !!opts.ghost;
  c.save();
  if (ghost) c.globalAlpha = 0.5;
  const fill = (color) => { if (ghost) { c.fillStyle = 'rgba(253,252,249,0.55)'; c.fill(); c.strokeStyle = col.ink; c.lineWidth = 1.25; c.stroke(); } else { c.fillStyle = color; c.fill(); } };

  switch (layer.kind) {
    case 'circle': c.beginPath(); c.arc(cx, cy, b.w / 2, 0, Math.PI * 2); fill(col.accent); break;
    case 'square': rr(c, b.x, b.y, b.w, b.h, b.w * 0.14); fill(col.accent); break;
    case 'text':
      c.font = `600 ${Math.round(b.h * 0.8)}px ${fonts.sans}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      if (ghost) { c.strokeStyle = col.ink; c.lineWidth = 1.1; c.strokeText(layer.label || ' ', cx, cy); }
      else { c.fillStyle = col.accent; c.fillText(layer.label || ' ', cx, cy); }
      break;
    case 'button':
      rr(c, b.x, b.y, b.w, b.h, b.h / 2); fill(col.ink);
      if (!ghost) { c.fillStyle = col.paper; c.font = `600 ${Math.round(b.h * 0.36)}px ${fonts.sans}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(layer.label, cx, cy); }
      break;
    case 'badge':
      c.beginPath(); c.arc(cx, cy, b.w / 2, 0, Math.PI * 2); fill(col.accent);
      if (!ghost) { c.fillStyle = '#fff'; c.font = `600 ${Math.round(b.w * 0.55)}px ${fonts.sans}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(layer.label, cx, cy + 0.5); }
      break;
    case 'card': {
      if (!ghost) { c.shadowColor = 'rgba(22,22,26,0.12)'; c.shadowBlur = 14; c.shadowOffsetY = 4; }
      rr(c, b.x, b.y, b.w, b.h, Math.min(12, b.h * 0.18));
      if (ghost) fill(); else { c.fillStyle = '#ffffff'; c.fill(); c.shadowColor = 'transparent'; c.strokeStyle = col.line; c.lineWidth = 1; c.stroke(); }
      if (!ghost) {
        const tall = b.h > b.w * 0.9;
        const pad = Math.min(b.w, b.h) * 0.16;
        const r = tall ? b.w * 0.14 : b.h * 0.22;
        const ax = b.x + pad + r, ay = tall ? b.y + pad + r : cy;
        c.beginPath(); c.arc(ax, ay, r, 0, Math.PI * 2); c.fillStyle = col.accent; c.fill();
        const tx = tall ? b.x + pad : ax + r + pad * 0.7;
        const ty = tall ? ay + r + pad : cy;
        c.fillStyle = col.ink; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        const fs = Math.max(9, Math.round(Math.min(b.h * 0.2, b.w * 0.075)));
        c.font = `600 ${fs}px ${fonts.sans}`;
        c.fillText(layer.label, tx, ty + (tall ? fs : -2));
        c.fillStyle = col.graphite; c.font = `400 ${Math.round(fs * 0.85)}px ${fonts.sans}`;
        c.fillText(layer.sub || '', tx, ty + (tall ? fs * 2.3 : fs + 2));
      }
      break;
    }
    case 'list': {
      const rows = 4, gap = b.h * 0.04, rh = (b.h - gap * (rows - 1)) / rows;
      for (let i = 0; i < rows; i++) {
        const ry = b.y + i * (rh + gap);
        rr(c, b.x, ry, b.w, rh, 8);
        if (ghost) fill(); else { c.fillStyle = '#ffffff'; c.fill(); c.strokeStyle = col.line; c.lineWidth = 1; c.stroke(); }
        if (!ghost) {
          const r = rh * 0.22;
          c.beginPath(); c.arc(b.x + rh * 0.5, ry + rh / 2, r, 0, Math.PI * 2); c.fillStyle = '#d9d5cc'; c.fill();
          c.fillStyle = '#e6e2da';
          rr(c, b.x + rh, ry + rh * 0.3, b.w * 0.45, rh * 0.14, 3); c.fill();
          rr(c, b.x + rh, ry + rh * 0.56, b.w * 0.3, rh * 0.12, 3); c.fill();
        }
      }
      break;
    }
  }
  c.restore();

  if (opts.selected && !ghost) {
    c.save();
    c.strokeStyle = col.accent; c.lineWidth = 1.5; c.setLineDash([4, 3]);
    const p = 5;
    if (layer.kind === 'circle' || layer.kind === 'badge') { c.beginPath(); c.arc(cx, cy, b.w / 2 + p, 0, Math.PI * 2); c.stroke(); }
    else c.strokeRect(b.x - p, b.y - p, b.w + p * 2, b.h + p * 2);
    c.restore();
  }
  return b;
}

export function hitLayer(layer, x, y, rect, px, py) {
  const b = layerBox(layer, x, y, rect);
  const pad = 6;
  return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad;
}
