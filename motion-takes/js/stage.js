// ------------------------------------------------
// Stage: a 16:9 frame on a pasteboard, holding a scene
// of layers. The interface stays still; the objects,
// their trails and their timing marks carry the personality.
//
// Timing is drawn on the selected layer's path as a motion
// designer's spacing chart: one bead every 50 ms. Beads bunch
// up where the motion is slow and spread where it is fast.
//
// Everything that doesn't move (pasteboard, frame, grid, the
// scene's backdrop) is drawn once into a cached canvas, so a
// frame only paints what changed.
// ------------------------------------------------

import { sampleAt } from './takes.js';
import { drawDecor, drawLayer, hitLayer } from './scene.js';

const BEAD_MS = 50;

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0; this.h = 0;
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.css = getComputedStyle(document.documentElement);
    this.col = {
      paper: this.v('--paper'), board: this.v('--pasteboard'), ink: this.v('--ink'),
      graphite: this.v('--graphite'), faint: this.v('--faint'), line: this.v('--line'),
      accent: this.v('--accent'), rec: this.v('--rec'), warn: this.v('--warn'),
    };
    this.fonts = { sans: this.v('--sans'), mono: this.v('--mono') };
    this.bg = document.createElement('canvas');
    this.decor = [];
    this.bgKey = '';
    this.resize();
  }

  v(name) { return this.css.getPropertyValue(name).trim(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.left = r.left; this.top = r.top;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    const padX = 56, padTop = 60, padBottom = 120;
    const aw = Math.max(10, this.w - padX * 2), ah = Math.max(10, this.h - padTop - padBottom);
    let w = aw, h = aw * 9 / 16;
    if (h > ah) { h = ah; w = ah * 16 / 9; }
    this.rect = { x: (this.w - w) / 2, y: padTop + (ah - h) / 2, w, h };
    this.bgKey = '';
  }

  // the stage can move when the page scrolls on narrow screens
  updateOffset() {
    const r = this.canvas.getBoundingClientRect();
    this.left = r.left; this.top = r.top;
  }

  // page coordinates → frame units (works outside the stage too)
  fromClient(cx, cy) {
    const r = this.rect;
    return { x: (cx - this.left - r.x) / r.w, y: (cy - this.top - r.y) / r.h };
  }
  P(x, y) { const r = this.rect; return [r.x + x * r.w, r.y + y * r.h]; }

  setDecor(decor) { this.decor = decor || []; this.bgKey = ''; }

  hit(layers, cx, cy) {
    const px = cx - this.left, py = cy - this.top;
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (hitLayer(L.layer, L.x, L.y, this.rect, px, py)) return L.layer;
    }
    return null;
  }

  background() {
    const key = `${this.w}x${this.h}@${this.dpr}:${JSON.stringify(this.decor)}`;
    if (key === this.bgKey) return;
    this.bgKey = key;
    const b = this.bg, c = b.getContext('2d'), col = this.col, r = this.rect;
    b.width = this.canvas.width; b.height = this.canvas.height;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = col.board;
    c.fillRect(0, 0, this.w, this.h);
    c.save();
    c.shadowColor = 'rgba(22,22,26,0.08)'; c.shadowBlur = 18; c.shadowOffsetY = 4;
    c.fillStyle = col.paper;
    c.fillRect(r.x, r.y, r.w, r.h);
    c.restore();
    c.fillStyle = 'rgba(22,22,26,0.11)';
    for (let i = 1; i < 16; i++) for (let j = 1; j < 9; j++) c.fillRect(r.x + (r.w * i) / 16 - 0.75, r.y + (r.h * j) / 9 - 0.75, 1.5, 1.5);
    c.save();
    c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    drawDecor(c, this.decor, r, col, this.fonts);
    c.restore();
    c.font = `500 10px ${this.fonts.mono}`;
    c.fillStyle = col.graphite;
    c.textBaseline = 'bottom'; c.textAlign = 'right';
    c.fillText('FRAME  16:9', r.x + r.w, r.y - 8);
    c.textAlign = 'left';
  }

  draw(view) {
    const c = this.ctx, col = this.col, r = this.rect;
    this.background();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.bg, 0, 0);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // objects may enter from just outside the frame; keep a margin visible
    c.save();
    c.beginPath(); c.rect(r.x - 48, r.y - 48, r.w + 96, r.h + 96); c.clip();

    for (const g of view.ghostPaths) this.path(g.d, g.t, col.ink, true, null, g.holds);
    if (view.sel) this.path(view.sel.d, view.sel.t, col.accent, false, view.sel.piece, view.sel.holds);
    if (view.recPath) this.path(view.recPath, Infinity, col.rec, false, null, [], true);
    if (view.trail) this.trail(view.trail, view.now, view.mode === 'recording' ? col.rec : col.accent);

    const opts = { col, fonts: this.fonts };
    // outside the frame, objects are drawn faintly: an offscreen start reads as offscreen,
    // and inside the frame they look the way the finished animation would
    c.save();
    c.globalAlpha = 0.16;
    for (const L of view.layers) drawLayer(c, L.layer, L.x, L.y, r, opts);
    c.restore();
    c.save();
    c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    for (const L of view.layers) drawLayer(c, L.layer, L.x, L.y, r, { ...opts, selected: L.selected && view.mode !== 'recording' && view.showSelection });
    c.restore();
    for (const L of view.layers) if (L.grab || L.lost) this.marker(L);
    for (const g of view.ghosts) {
      const b = drawLayer(c, g.layer, g.x, g.y, r, { ...opts, ghost: true });
      c.font = `500 10px ${this.fonts.mono}`;
      c.fillStyle = col.graphite; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(g.label, b.x + b.w / 2, b.y + b.h + 6);
      c.textAlign = 'left';
    }
    if (view.cross) this.crosshair(view.cross.x, view.cross.y);
    c.restore();

    if (view.mode === 'recording' || view.mode === 'countdown' || view.mode === 'armed') this.recFrame(view);
  }

  // A take's path with spacing beads; `upTo` is the playhead in the take's own time.
  path(d, upTo, color, ghost, piece, holds, live = false) {
    const c = this.ctx;
    const { t, x, y, n } = d;
    if (n < 2) return;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = color;
    c.globalAlpha = ghost ? 0.22 : 0.18;
    c.lineWidth = ghost ? 1.25 : 1.5;
    if (ghost) c.setLineDash([3, 4]);
    c.beginPath();
    for (let i = 0; i < n; i++) { const [px, py] = this.P(x[i], y[i]); i ? c.lineTo(px, py) : c.moveTo(px, py); }
    c.stroke();
    c.setLineDash([]);

    if (!ghost) {
      c.globalAlpha = live ? 0.55 : 0.7;
      c.lineWidth = 2;
      c.beginPath();
      for (let i = 0; i < n && t[i] <= upTo; i++) { const [px, py] = this.P(x[i], y[i]); i ? c.lineTo(px, py) : c.moveTo(px, py); }
      c.stroke();
    }

    if (piece) {
      c.globalAlpha = 0.9; c.lineWidth = 5;
      c.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (t[i] < piece.d0 || t[i] > piece.d1) continue;
        const [px, py] = this.P(x[i], y[i]);
        started ? c.lineTo(px, py) : (c.moveTo(px, py), started = true);
      }
      c.stroke();
      if (started) {
        c.fillStyle = color;
        for (const s of [sampleAt(d, piece.d0), sampleAt(d, piece.d1)]) { const [px, py] = this.P(s.x, s.y); c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill(); }
        const mid = sampleAt(d, (piece.d0 + piece.d1) / 2);
        const [mx, my] = this.P(mid.x, mid.y);
        c.font = `600 11px ${this.fonts.sans}`;
        c.textBaseline = 'bottom';
        c.fillText(piece.label, mx + 12, my - 14);
      }
    }

    // spacing beads, read straight from the evenly sampled arrays
    c.fillStyle = color;
    const avg = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 16.7;
    const step = Math.max(1, Math.round(BEAD_MS / (avg || 16.7)));
    for (let i = 0; i < n; i += step) {
      const [px, py] = this.P(x[i], y[i]);
      c.globalAlpha = ghost ? 0.35 : t[i] <= upTo ? 0.95 : 0.3;
      c.beginPath();
      c.arc(px, py, ghost ? 1.4 : 1.8, 0, Math.PI * 2);
      c.fill();
    }

    if (!live && holds) {
      c.font = `500 10px ${this.fonts.mono}`;
      c.textBaseline = 'middle';
      holds.forEach((h, k) => {
        const dur = h.t1 - h.t0;
        const [px, py] = this.P(h.x, h.y);
        const rad = 10 + Math.min(18, dur / 60);
        c.globalAlpha = ghost ? 0.35 : 0.8;
        c.strokeStyle = color; c.lineWidth = 1; c.setLineDash([2, 3]);
        c.beginPath(); c.arc(px, py, rad, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
        const isSel = piece && Math.abs(piece.d0 - h.t0) < 1;
        if (!ghost && h.label && !isSel) {
          c.fillStyle = color;
          c.fillText(h.label, px + rad + 6, k % 2 ? py + rad + 10 : py - rad - 4);
        }
      });
    }
    c.globalAlpha = 1;
  }

  trail(trail, now, color) {
    const c = this.ctx;
    const LIFE = 700;
    c.lineCap = 'round';
    c.strokeStyle = color;
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const age = now - b.t;
      if (age > LIFE) continue;
      const k = 1 - age / LIFE;
      c.globalAlpha = k * 0.5;
      c.lineWidth = 1 + k * this.rect.w * 0.014;
      const [x1, y1] = this.P(a.x, a.y), [x2, y2] = this.P(b.x, b.y);
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    c.globalAlpha = 1;
  }

  marker(L) {
    const c = this.ctx, col = this.col;
    const [px, py] = this.P(L.x, L.y);
    const R = Math.max(L.layer.w * this.rect.w, L.layer.h * this.rect.h) / 2;
    if (L.grab) {
      c.strokeStyle = col.ink; c.lineWidth = 2;
      c.beginPath(); c.arc(px, py, R + 6, 0, Math.PI * 2); c.stroke();
      return;
    }
    const released = L.lost === 'released';
    c.strokeStyle = released ? col.graphite : col.warn;
    c.lineWidth = released ? 1 : 1.5;
    c.setLineDash(released ? [2, 4] : [4, 4]);
    c.beginPath(); c.arc(px, py, R + 9, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    c.font = `500 10px ${this.fonts.mono}`;
    c.fillStyle = released ? col.graphite : col.warn;
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillText(released ? 'LET GO · PINCH TO GRAB' : 'HAND LOST · HOLDING', px, py + R + 14);
    c.textAlign = 'left';
  }

  crosshair(x, y) {
    const c = this.ctx;
    const [px, py] = this.P(x, y);
    c.strokeStyle = this.col.ink; c.globalAlpha = 0.6; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(px - 7, py); c.lineTo(px - 2, py); c.moveTo(px + 2, py); c.lineTo(px + 7, py);
    c.moveTo(px, py - 7); c.lineTo(px, py - 2); c.moveTo(px, py + 2); c.lineTo(px, py + 7);
    c.stroke();
    c.globalAlpha = 1;
  }

  recFrame(view) {
    const c = this.ctx, r = this.rect, col = this.col;
    c.strokeStyle = col.rec;
    c.lineWidth = view.mode === 'recording' ? 2 : 1;
    if (view.mode !== 'recording') c.setLineDash([6, 6]);
    c.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    c.setLineDash([]);
    if (view.mode === 'recording') {
      const k = Math.min(1, view.recProgress);
      c.fillStyle = col.rec;
      c.fillRect(r.x, r.y - 6, r.w * k, 3);
      c.fillStyle = 'rgba(236,59,42,0.15)';
      c.fillRect(r.x + r.w * k, r.y - 6, r.w * (1 - k), 3);
    }
  }
}
