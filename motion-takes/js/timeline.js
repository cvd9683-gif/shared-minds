// ------------------------------------------------
// Timeline: recorded movement over time, one row per
// object (layer). A row draws the speed of the take that
// layer is using, starting where that take starts in the
// scene; drag it sideways to stagger objects, the way you
// would offset layers in After Effects.
//
// The selected layer opens up to list its takes, so you
// can switch which one is used or overlay others as ghosts.
// ------------------------------------------------

import { fmtTime } from './takes.js';
import { editOf, offsetOf, pieceLabel, pieceName, playDuration, rendered, timingOf } from './edit.js';
import { KIND_LABEL } from './scene.js';

const GHOST_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><circle class="c-a" cx="9" cy="9" r="5.5"/></svg>';
const KIND_SVG = {
  circle: '<circle cx="9" cy="9" r="5"/>',
  square: '<rect x="4" y="4" width="10" height="10" rx="2"/>',
  text: '<path d="M4 5h10M9 5v9"/>',
  card: '<rect x="2.5" y="5" width="13" height="8" rx="2"/>',
  button: '<rect x="2.5" y="6" width="13" height="6" rx="3"/>',
  badge: '<circle cx="9" cy="9" r="4"/>',
  list: '<path d="M3 5h12M3 9h12M3 13h12"/>',
};

export class Timeline {
  constructor(els, cb) {
    this.els = els;
    this.cb = cb;
    this.scale = 5000;
    this.limit = 5000;
    this.vmax = 1;
    this.lanes = [];
    this.recRow = null;
    this.box = null;
    this.css = getComputedStyle(document.documentElement);
    this.col = {
      accent: this.v('--accent'), ink: this.v('--ink'), graphite: this.v('--graphite'),
      faint: this.v('--faint'), line: this.v('--line'), rec: this.v('--rec'), warn: this.v('--warn'),
    };
    this.bindLane(els.ruler.parentElement, { scrubOnly: true });
    new ResizeObserver(() => { this.box = null; this.redraw(); }).observe(els.body);
  }

  v(n) { return this.css.getPropertyValue(n).trim(); }

  // lane geometry is read once per resize, not once per frame
  laneBox() {
    if (this.box) return this.box;
    const lane = this.els.ruler.parentElement;
    const lr = lane.getBoundingClientRect(), br = this.els.body.getBoundingClientRect();
    this.box = { left: lr.left - br.left, width: lr.width || 1, absLeft: lr.left };
    return this.box;
  }
  msAt(clientX) {
    const b = this.laneBox();
    return Math.max(0, Math.min(1, (clientX - b.absLeft) / b.width)) * this.scale;
  }
  msPerPx() { return this.scale / this.laneBox().width; }

  // Press and release in place: scrub there. Press and drag: move the take in time.
  bindLane(el, { scrubOnly = false, take = null, layer = null } = {}) {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.piece')) return;
      e.preventDefault();
      this.box = null;
      try { el.setPointerCapture(e.pointerId); } catch { /* not a real pointer (guided example) */ }
      const x0 = e.clientX;
      let dragging = false;
      if (scrubOnly) this.cb.onScrub(this.msAt(e.clientX), true);
      const move = ev => {
        if (scrubOnly) { this.cb.onScrub(this.msAt(ev.clientX), false); return; }
        if (!dragging && Math.abs(ev.clientX - x0) > 4) { dragging = true; this.cb.onOffset(take, 0, 'start'); }
        if (dragging) this.cb.onOffset(take, (ev.clientX - x0) * this.msPerPx(), 'move');
      };
      const up = ev => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (scrubOnly) return;
        if (dragging) this.cb.onOffset(take, (ev.clientX - x0) * this.msPerPx(), 'end');
        else { this.cb.onLaneClick(layer, take); this.cb.onScrub(this.msAt(ev.clientX), true); }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // m: { layers, takesOf, activeOf, selectedLayerId, compareIds, sceneDuration }
  render(m) {
    const { tracks } = this.els;
    this.m = m;
    tracks.textContent = '';
    this.lanes = [];
    this.recRow = null;
    this.piecesKey = '';
    const all = m.layers.flatMap(l => m.takesOf(l));
    const longest = all.reduce((x, t) => Math.max(x, offsetOf(t) + playDuration(t)), 0);
    this.scale = Math.ceil(Math.max(this.limit, longest, m.sceneDuration) / 500) * 500;
    this.vmax = Math.max(0.8, ...all.map(t => rendered(t).maxSpeed));

    if (!m.layers.length) {
      const p = document.createElement('p');
      p.className = 'tracks-empty';
      p.textContent = 'This scene has no objects. Add one from the Scene menu.';
      tracks.appendChild(p);
    }

    for (const layer of m.layers) {
      const sel = layer.id === m.selectedLayerId;
      const takes = m.takesOf(layer);
      const active = m.activeOf(layer);
      const row = document.createElement('div');
      row.className = 'tl-row track layer-row' + (sel ? ' is-selected' : '');
      row.innerHTML = `
        <div class="tl-gutter">
          <svg class="kind" viewBox="0 0 18 18" aria-hidden="true">${KIND_SVG[layer.kind] || KIND_SVG.circle}</svg>
          <div class="track-meta">
            <span class="track-name"></span>
            <span class="track-sub"></span>
          </div>
          <div class="track-actions">
            <button class="ren" title="Rename object" aria-label="Rename object">✎</button>
            <button class="del" title="Delete object" aria-label="Delete object">×</button>
          </div>
        </div>
        <div class="tl-lane"><canvas></canvas></div>`;
      row.querySelector('.track-name').textContent = layer.name;
      const idx = active ? takes.indexOf(active) + 1 : 0;
      row.querySelector('.track-sub').textContent = active
        ? `take ${idx} of ${takes.length}${offsetOf(active) ? ` · +${(offsetOf(active) / 1000).toFixed(2)}s` : ''}`
        : `${KIND_LABEL[layer.kind]} · no take yet`;
      row.querySelector('.tl-gutter').addEventListener('click', e => {
        if (e.target.closest('.track-actions') || e.target.closest('input')) return;
        this.cb.onSelectLayer(layer);
      });
      row.querySelector('.track-name').addEventListener('dblclick', () => this.startRename(row, layer.name, v => this.cb.onRenameLayer(layer, v)));
      row.querySelector('.ren').addEventListener('click', () => this.startRename(row, layer.name, v => this.cb.onRenameLayer(layer, v)));
      row.querySelector('.del').addEventListener('click', () => this.cb.onDeleteLayer(layer));
      const lane = row.querySelector('.tl-lane');
      if (active) this.bindLane(lane, { take: active, layer });
      else lane.addEventListener('click', () => this.cb.onSelectLayer(layer));
      tracks.appendChild(row);
      this.lanes.push({ canvas: lane.firstElementChild, take: active, selected: sel, layerRow: true, empty: active ? '' : `Select ${layer.name} and press R to perform it` });

      if (!sel) continue;
      takes.forEach((take, i) => {
        const isActive = take === active;
        const isCmp = m.compareIds.has(take.id);
        const tr = document.createElement('div');
        tr.className = 'tl-row track take-row' + (isActive ? ' is-active' : '');
        tr.innerHTML = `
          <div class="tl-gutter">
            <button class="use" title="${isActive ? 'This take is in use' : 'Use this take'}" aria-pressed="${isActive}"></button>
            <button class="compare${isCmp ? ' is-on' : ''}" title="${isActive ? 'In use' : (isCmp ? 'Hide ghost' : 'Show as a ghost to compare')}" aria-pressed="${isCmp}">${GHOST_SVG}</button>
            <div class="track-meta">
              <span class="track-name"></span>
              <span class="track-sub">
                <span>${i + 1}</span>
                <span>${(playDuration(take) / 1000).toFixed(2)}s</span>
                ${take.example ? '<span class="badge badge-example">Example</span>' : `<span class="badge">${take.input === 'hand' ? 'Hand' : 'Cursor'}</span>`}
              </span>
            </div>
            <div class="track-actions">
              <button class="ren" title="Rename take" aria-label="Rename take">✎</button>
              <button class="del" title="Delete take" aria-label="Delete take">×</button>
            </div>
          </div>
          <div class="tl-lane"><canvas></canvas></div>`;
        tr.querySelector('.track-name').textContent = take.name;
        tr.querySelector('.tl-gutter').addEventListener('click', e => {
          if (e.target.closest('.track-actions') || e.target.closest('input')) return;
          if (e.target.closest('.compare')) { if (!isActive) this.cb.onCompare(take); return; }
          this.cb.onUseTake(layer, take);
        });
        tr.querySelector('.track-name').addEventListener('dblclick', () => this.startRename(tr, take.name, v => this.cb.onRenameTake(take, v)));
        tr.querySelector('.ren').addEventListener('click', () => this.startRename(tr, take.name, v => this.cb.onRenameTake(take, v)));
        tr.querySelector('.del').addEventListener('click', () => this.cb.onDeleteTake(take));
        this.bindLane(tr.querySelector('.tl-lane'), { take, layer });
        tracks.appendChild(tr);
        this.lanes.push({ canvas: tr.querySelector('canvas'), take, selected: isActive });
      });
    }
    this.box = null;
    this.redraw();
  }

  startRename(row, current, commit) {
    const span = row.querySelector('.track-name');
    const input = document.createElement('input');
    input.className = 'track-name-input';
    input.value = current;
    input.maxLength = 48;
    span.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (ok && v && v !== current) commit(v);
      else input.replaceWith(span);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  setLimit(ms) { this.limit = ms; }

  redraw() {
    this.drawRuler();
    for (const L of this.lanes) {
      if (L.take) this.drawLane(L.canvas, rendered(L.take), offsetOf(L.take), L.selected, null, L.layerRow);
      else this.drawEmpty(L.canvas, L.empty);
    }
  }

  fit(canvas) {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    return { c, w: r.width, h: r.height };
  }

  drawRuler() {
    const { c, w, h } = this.fit(this.els.ruler);
    const col = this.col;
    const px = ms => (ms / this.scale) * w;
    c.font = `400 10px ${this.v('--mono')}`;
    c.textBaseline = 'top';
    for (let ms = 0; ms <= this.scale; ms += 100) {
      const x = Math.round(px(ms)) + 0.5;
      const sec = ms % 1000 === 0, half = ms % 500 === 0;
      c.strokeStyle = sec ? col.graphite : col.line;
      c.beginPath(); c.moveTo(x, h); c.lineTo(x, h - (sec ? 10 : half ? 7 : 4)); c.stroke();
      if (sec) { c.fillStyle = col.graphite; c.fillText(`${ms / 1000}s`, x + 4, 5); }
    }
    const lx = Math.round(px(this.limit)) - 0.5;
    c.strokeStyle = col.rec; c.globalAlpha = 0.6; c.setLineDash([2, 2]);
    c.beginPath(); c.moveTo(lx, 0); c.lineTo(lx, h); c.stroke();
    c.setLineDash([]); c.globalAlpha = 1;
  }

  drawEmpty(canvas, text) {
    const { c, h } = this.fit(canvas);
    c.font = `400 11px ${this.v('--sans')}`;
    c.fillStyle = this.col.faint;
    c.textBaseline = 'middle';
    c.fillText(text, 10, h / 2);
  }

  // Speed over time, drawn from where the take starts in the scene.
  drawLane(canvas, d, offset, selected, color, bar = false) {
    const { c, w, h } = this.fit(canvas);
    const col = this.col;
    const ink = color || (selected ? col.accent : col.ink);
    const px = ms => ((ms + offset) / this.scale) * w;
    const top = 6, base = h - 7;
    const vy = v => base - Math.min(1, v / this.vmax) * (base - top);
    const end = d.t[d.n - 1] || 0;

    // a layer row reads as a bar, like a layer's span in a motion editor
    if (bar) {
      c.fillStyle = selected ? 'rgba(59,44,255,0.06)' : 'rgba(22,22,26,0.035)';
      c.fillRect(px(0), 3, px(end) - px(0), h - 6);
      c.strokeStyle = selected ? 'rgba(59,44,255,0.35)' : col.line;
      c.strokeRect(px(0) + 0.5, 3.5, px(end) - px(0) - 1, h - 7);
    }
    c.strokeStyle = col.line;
    c.beginPath(); c.moveTo(px(0), base + 0.5); c.lineTo(px(end), base + 0.5); c.stroke();

    for (const s of d.lostSpans) {
      const x0 = px(s.t0), x1 = Math.max(x0 + 2, px(s.t1));
      c.save();
      c.beginPath(); c.rect(x0, top, x1 - x0, base - top); c.clip();
      c.strokeStyle = col.warn; c.globalAlpha = 0.5;
      for (let x = x0 - h; x < x1; x += 5) { c.beginPath(); c.moveTo(x, base); c.lineTo(x + h, top); c.stroke(); }
      c.restore();
    }
    if (d.n < 2) return;
    c.beginPath();
    c.moveTo(px(d.t[0]), base);
    for (let i = 0; i < d.n; i++) c.lineTo(px(d.t[i]), vy(d.speed[i]));
    c.lineTo(px(end), base);
    c.closePath();
    c.fillStyle = ink;
    c.globalAlpha = selected ? 0.16 : 0.07;
    c.fill();
    c.globalAlpha = selected ? 1 : 0.55;
    c.strokeStyle = ink; c.lineWidth = 1.25;
    c.beginPath();
    for (let i = 0; i < d.n; i++) { const x = px(d.t[i]), y = vy(d.speed[i]); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    c.globalAlpha = 1;
  }

  // The selected layer's take in use, in pieces, at its place in the scene.
  pieces(take, selIndex) {
    const row = this.els.piecesRow, lane = this.els.pieceLane;
    row.hidden = !take;
    if (!take) return;
    const timing = timingOf(take);
    const off = offsetOf(take);
    const key = JSON.stringify([take.id, selIndex, this.scale, off, timing.map(p => [p.d0, p.d1, p.ease])]);
    if (key === this.piecesKey) return;
    this.piecesKey = key;
    lane.textContent = '';
    for (const p of timing) {
      const b = document.createElement('div');
      const e = editOf(take, p.i);
      b.className = `piece ${p.kind}` + (p.i === selIndex ? ' is-sel' : '') + (Math.abs(e.scale - 1) > 0.005 || Math.abs(e.ease) > 0.005 ? ' is-edited' : '');
      b.style.left = `${((p.d0 + off) / this.scale) * 100}%`;
      b.style.width = `${((p.d1 - p.d0) / this.scale) * 100}%`;
      const label = p.kind === 'hold' ? `${((p.d1 - p.d0) / 1000).toFixed(2)}s` : pieceLabel(take, p.i).toLowerCase();
      b.title = `${pieceName(take, p.i)} · ${((p.d1 - p.d0) / 1000).toFixed(2)} s. Drag the right edge to retime.`;
      b.innerHTML = '<span></span><span class="piece-grip" aria-hidden="true"></span>';
      b.firstChild.textContent = label;
      b.addEventListener('pointerdown', ev => {
        if (ev.target.classList.contains('piece-grip')) return;
        this.cb.onPieceSelect(p.i);
      });
      const grip = b.querySelector('.piece-grip');
      grip.addEventListener('pointerdown', ev => {
        ev.preventDefault(); ev.stopPropagation();
        try { grip.setPointerCapture(ev.pointerId); } catch { /* not a real pointer */ }
        this.cb.onPieceDrag(p.i, null, 'start');
        const speed = (take.adjust && take.adjust.speed) || 1;
        const r = lane.getBoundingClientRect();
        const move = mv => {
          const ms = ((mv.clientX - r.left) / r.width) * this.scale - off - p.d0;
          this.cb.onPieceDrag(p.i, (Math.max(30, ms) * speed) / (p.t1 - p.t0), 'move');
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          this.cb.onPieceDrag(p.i, null, 'end');
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
      lane.appendChild(b);
    }
  }

  showRecording(d, label) {
    if (!this.recRow) {
      const row = document.createElement('div');
      row.className = 'tl-row track take-row is-active';
      row.innerHTML = '<div class="tl-gutter"><span class="use is-rec"></span><div class="track-meta"><span class="track-name"></span><span class="track-sub"><span class="badge badge-rec">Rec</span><span class="rec-time"></span></span></div></div><div class="tl-lane"><canvas></canvas></div>';
      row.querySelector('.track-name').textContent = label;
      this.els.tracks.prepend(row);
      this.els.tracks.scrollTop = 0;
      this.recRow = row;
      this.recCanvas = row.querySelector('canvas');
      this.recTime = row.querySelector('.rec-time');
    }
    this.recTime.textContent = fmtTime(d.t[d.n - 1] || 0);
    this.drawLane(this.recCanvas, d, 0, true, this.col.rec);
  }

  setPlayhead(ms, rec = false) {
    const b = this.laneBox();
    const x = b.left + Math.min(1, ms / this.scale) * b.width;
    if (x === this.phX && rec === this.phRec) return;
    this.phX = x; this.phRec = rec;
    const ph = this.els.playhead;
    ph.style.transform = `translate3d(${x}px,0,0)`;
    ph.classList.toggle('is-rec', rec);
  }
}
