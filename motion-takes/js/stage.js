// ------------------------------------------------
// Stage: a 16:9 frame on a pasteboard. The interface
// stays still; the object, its trail and its timing
// marks carry the personality.
//
// Timing is drawn on the path itself, as a motion
// designer's spacing chart: one bead every 50 ms.
// Beads bunch up where the motion is slow and spread
// out where it is fast; holds get a ring and a duration.
// ------------------------------------------------

import { sampleAt } from './takes.js';

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
    this.resize();
  }

  v(name) { return this.css.getPropertyValue(name).trim(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    const padX = 56, padTop = 60, padBottom = 120;
    const aw = Math.max(10, this.w - padX * 2), ah = Math.max(10, this.h - padTop - padBottom);
    let w = aw, h = aw * 9 / 16;
    if (h > ah) { h = ah; w = ah * 16 / 9; }
    this.rect = { x: (this.w - w) / 2, y: padTop + (ah - h) / 2, w, h };
  }

  // stage pixels → frame units
  toFrame(px, py) {
    const r = this.rect;
    return { x: (px - r.x) / r.w, y: (py - r.y) / r.h };
  }
  P(x, y) { const r = this.rect; return [r.x + x * r.w, r.y + y * r.h]; }

  draw(view) {
    const c = this.ctx, col = this.col, r = this.rect;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = col.board;
    c.fillRect(0, 0, this.w, this.h);

    // frame
    c.save();
    c.shadowColor = 'rgba(22,22,26,0.08)';
    c.shadowBlur = 18; c.shadowOffsetY = 4;
    c.fillStyle = col.paper;
    c.fillRect(r.x, r.y, r.w, r.h);
    c.restore();
    this.grid();

    c.font = `500 10px ${this.v('--mono')}`;
    c.fillStyle = col.graphite;
    c.textBaseline = 'bottom';
    c.textAlign = 'right';
    c.fillText('FRAME  16:9', r.x + r.w, r.y - 8);
    c.textAlign = 'left';

    // clip drawing to a margin around the frame so off-frame entrances stay visible
    c.save();
    c.beginPath();
    c.rect(r.x - 40, r.y - 40, r.w + 80, r.h + 80);
    c.clip();

    if (view.mode === 'review' && view.review) {
      for (const g of view.review.ghosts) this.path(g.d, g.t, col.ink, true, false, null, g.holds);
      const p = view.review.primary;
      if (p) this.path(p.d, p.t, col.accent, false, false, p.piece, p.holds);
      for (const g of view.review.ghosts) {
        const s = sampleAt(g.d, g.t);
        this.object(s.x, s.y, view, { ghost: true, label: g.label });
      }
      if (p) {
        const s = sampleAt(p.d, p.t);
        this.object(s.x, s.y, view, { lost: !s.tracked });
      }
    } else {
      if (view.mode === 'recording' && view.rec) this.path(view.rec, Infinity, col.accent, false, true);
      this.trail(view.trail, view.now, view.mode === 'recording' ? col.rec : col.accent);
      this.object(view.live.x, view.live.y, view, { lost: view.lost, grab: view.grab });
    }

    if (view.cross) this.crosshair(view.cross.x, view.cross.y);
    c.restore();

    if (view.mode === 'recording' || view.mode === 'countdown') this.recFrame(view);
  }

  grid() {
    const c = this.ctx, r = this.rect;
    c.fillStyle = 'rgba(22,22,26,0.11)';
    const cols = 16, rows = 9;
    for (let i = 1; i < cols; i++) {
      for (let j = 1; j < rows; j++) {
        c.fillRect(r.x + (r.w * i) / cols - 0.75, r.y + (r.h * j) / rows - 0.75, 1.5, 1.5);
      }
    }
    // centre cross
    c.strokeStyle = 'rgba(22,22,26,0.10)';
    c.lineWidth = 1;
    const [cx, cy] = this.P(0.5, 0.5);
    c.beginPath();
    c.moveTo(cx - 6, cy); c.lineTo(cx + 6, cy);
    c.moveTo(cx, cy - 6); c.lineTo(cx, cy + 6);
    c.stroke();
  }

  // A take's path with spacing beads; `upTo` is the playhead in take time.
  path(d, upTo, color, ghost, live = false, piece = null, pieceHolds = null) {
    const c = this.ctx;
    const { t, x, y, n } = d;
    if (n < 2) return;
    c.lineCap = 'round'; c.lineJoin = 'round';

    // full path, faint
    c.strokeStyle = color;
    c.globalAlpha = ghost ? 0.22 : 0.18;
    c.lineWidth = ghost ? 1.25 : 1.5;
    if (ghost) c.setLineDash([3, 4]);
    c.beginPath();
    for (let i = 0; i < n; i++) { const [px, py] = this.P(x[i], y[i]); i ? c.lineTo(px, py) : c.moveTo(px, py); }
    c.stroke();
    c.setLineDash([]);

    // travelled path, stronger
    if (!ghost) {
      c.globalAlpha = live ? 0.55 : 0.7;
      c.lineWidth = 2;
      c.beginPath();
      for (let i = 0; i < n && t[i] <= upTo; i++) { const [px, py] = this.P(x[i], y[i]); i ? c.lineTo(px, py) : c.moveTo(px, py); }
      c.stroke();
    }

    // the selected piece, so a spoken or dragged edit has a place on the stage
    if (piece) {
      c.globalAlpha = 0.9;
      c.lineWidth = 5;
      c.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (t[i] < piece.d0 || t[i] > piece.d1) continue;
        const [px, py] = this.P(x[i], y[i]);
        started ? c.lineTo(px, py) : (c.moveTo(px, py), started = true);
      }
      c.stroke();
      if (started) {
        const s0 = sampleAt(d, piece.d0), s1 = sampleAt(d, piece.d1);
        for (const s of [s0, s1]) { const [px, py] = this.P(s.x, s.y); c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill(); }
        const mid = sampleAt(d, (piece.d0 + piece.d1) / 2);
        const [mx, my] = this.P(mid.x, mid.y);
        c.font = `600 11px ${this.v('--sans')}`;
        c.textBaseline = 'bottom';
        c.fillStyle = color;
        c.fillText(piece.label, mx + 10, my - 14);
      }
    }

    // spacing beads
    c.fillStyle = color;
    const end = t[n - 1];
    for (let ms = 0; ms <= end; ms += BEAD_MS) {
      const s = sampleAt(d, ms);
      const [px, py] = this.P(s.x, s.y);
      const passed = ms <= upTo;
      c.globalAlpha = ghost ? 0.35 : passed ? 0.95 : 0.3;
      const big = ms % 1000 === 0;
      c.beginPath();
      c.arc(px, py, big ? 3 : ghost ? 1.4 : 1.8, 0, Math.PI * 2);
      c.fill();
    }

    // holds
    if (!live) {
      c.font = `500 10px ${this.v('--mono')}`;
      c.textBaseline = 'middle';
      // holds come from the take's pieces when we have them, so the stage and timeline agree
      const holds = pieceHolds || d.holds.map(h => ({ ...h, label: `hold ${((h.t1 - h.t0) / 1000).toFixed(2)}s` }));
      holds.forEach((h, k) => {
        const dur = h.t1 - h.t0;
        const [px, py] = this.P(h.x, h.y);
        const rad = 10 + Math.min(18, dur / 60);
        c.globalAlpha = ghost ? 0.35 : 0.8;
        c.strokeStyle = color;
        c.lineWidth = 1;
        c.setLineDash([2, 3]);
        c.beginPath(); c.arc(px, py, rad, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
        const isSel = piece && Math.abs(piece.d0 - h.t0) < 1;
        if (!ghost && h.label && !isSel) {
          c.fillStyle = color;
          // alternate above and below, so neighbouring pauses don't print over each other
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
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const age = now - b.t;
      if (age > LIFE) continue;
      const k = 1 - age / LIFE;
      c.strokeStyle = color;
      c.globalAlpha = k * 0.55;
      c.lineWidth = 1 + k * this.rect.w * 0.018;
      const [x1, y1] = this.P(a.x, a.y), [x2, y2] = this.P(b.x, b.y);
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    c.globalAlpha = 1;
  }

  object(x, y, view, { ghost = false, lost = false, label = '', grab = false } = {}) {
    const c = this.ctx, col = this.col;
    const [px, py] = this.P(x, y);
    const R = this.rect.w * 0.03;
    c.save();
    if (ghost) {
      c.strokeStyle = col.ink; c.globalAlpha = 0.55; c.lineWidth = 1.5;
      c.fillStyle = 'rgba(253,252,249,0.6)';
    } else {
      c.fillStyle = col.accent;
    }
    if (view.shape === 'circle') {
      c.beginPath(); c.arc(px, py, R, 0, Math.PI * 2);
      ghost ? (c.fill(), c.stroke()) : c.fill();
    } else if (view.shape === 'square') {
      const s = R * 1.75;
      c.beginPath();
      roundRect(c, px - s / 2, py - s / 2, s, s, s * 0.14);
      ghost ? (c.fill(), c.stroke()) : c.fill();
    } else {
      c.font = `600 ${Math.round(R * 1.9)}px ${this.v('--sans')}`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const txt = view.text || ' ';
      if (ghost) { c.lineWidth = 1.2; c.strokeText(txt, px, py); }
      else c.fillText(txt, px, py);
    }
    c.restore();

    if (ghost && label) {
      c.font = `500 10px ${this.v('--mono')}`;
      c.fillStyle = col.graphite; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(label, px, py + R + 8);
      c.textAlign = 'left';
    }
    if (grab) {
      c.strokeStyle = col.ink; c.lineWidth = 2;
      c.beginPath(); c.arc(px, py, R + 6, 0, Math.PI * 2); c.stroke();
    }
    if (lost === 'released') {
      c.strokeStyle = col.graphite; c.lineWidth = 1; c.setLineDash([2, 4]);
      c.beginPath(); c.arc(px, py, R + 7, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      c.font = `500 10px ${this.v('--mono')}`;
      c.fillStyle = col.graphite; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText('LET GO · PINCH TO GRAB', px, py + R + 12);
      c.textAlign = 'left';
    } else if (lost) {
      c.strokeStyle = col.warn; c.lineWidth = 1.5; c.setLineDash([4, 4]);
      c.beginPath(); c.arc(px, py, R + 9, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      c.font = `500 10px ${this.v('--mono')}`;
      c.fillStyle = col.warn; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText('HAND LOST · HOLDING', px, py + R + 14);
      c.textAlign = 'left';
    }
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
    if (view.mode === 'countdown') c.setLineDash([6, 6]);
    c.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    c.setLineDash([]);
    if (view.mode === 'recording') {
      // remaining time, as a bar along the top edge of the frame
      const k = Math.min(1, view.recProgress);
      c.fillStyle = col.rec;
      c.fillRect(r.x, r.y - 6, r.w * k, 3);
      c.fillStyle = 'rgba(236,59,42,0.15)';
      c.fillRect(r.x + r.w * k, r.y - 6, r.w * (1 - k), 3);
    }
  }
}

function roundRect(c, x, y, w, h, r) {
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
