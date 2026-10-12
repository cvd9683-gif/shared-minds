// ------------------------------------------------
// Timeline: recorded movement over time.
// Every take shares one time scale, and each lane
// draws the take's speed, so a quick entrance reads
// as a tall early peak and a hesitation as a flat gap.
// ------------------------------------------------

import { effectiveSpeed, fmtTime } from './takes.js';
import { editOf, pieceLabel, pieceName, playDuration, rendered, timingOf } from './edit.js';

const COMPARE_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><circle class="c-a" cx="9" cy="9" r="5.5"/></svg>';

export class Timeline {
  constructor(els, cb) {
    this.els = els;
    this.cb = cb;
    this.scale = 5000;    // ms visible across a lane
    this.limit = 5000;
    this.vmax = 1;
    this.rows = new Map(); // id → {el, canvas}
    this.recRow = null;
    this.css = getComputedStyle(document.documentElement);
    this.col = {
      accent: this.v('--accent'), ink: this.v('--ink'), graphite: this.v('--graphite'),
      faint: this.v('--faint'), line: this.v('--line'), rec: this.v('--rec'), warn: this.v('--warn'),
    };
    this.bindScrub(els.ruler.parentElement, null);
    new ResizeObserver(() => this.redraw()).observe(els.body);
  }

  v(n) { return this.css.getPropertyValue(n).trim(); }

  laneBox() {
    const lane = this.els.ruler.parentElement;
    const lr = lane.getBoundingClientRect(), br = this.els.body.getBoundingClientRect();
    return { left: lr.left - br.left, width: lr.width, absLeft: lr.left };
  }
  msAt(clientX) {
    const b = this.laneBox();
    return Math.max(0, Math.min(1, (clientX - b.absLeft) / b.width)) * this.scale;
  }

  bindScrub(laneEl, id) {
    laneEl.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      laneEl.setPointerCapture(e.pointerId);
      this.cb.onScrub(this.msAt(e.clientX), id, true);
      const move = ev => this.cb.onScrub(this.msAt(ev.clientX), null, false);
      const up = () => {
        laneEl.removeEventListener('pointermove', move);
        laneEl.removeEventListener('pointerup', up);
        laneEl.removeEventListener('pointercancel', up);
      };
      laneEl.addEventListener('pointermove', move);
      laneEl.addEventListener('pointerup', up);
      laneEl.addEventListener('pointercancel', up);
    });
  }

  // Rebuild the take rows.
  render(project, selectedId, compareIds) {
    const { tracks } = this.els;
    this.project = project;
    this.selectedId = selectedId;
    this.compareIds = compareIds;
    tracks.textContent = '';
    this.rows.clear();
    this.recRow = null;

    const takes = project.takes;
    const longest = takes.reduce((m, t) => Math.max(m, playDuration(t)), 0);
    this.scale = Math.ceil(Math.max(this.limit, longest) / 500) * 500;
    this.vmax = Math.max(0.8, ...takes.map(t => rendered(t).maxSpeed));

    if (!takes.length) {
      const p = document.createElement('p');
      p.className = 'tracks-empty';
      p.innerHTML = 'No takes yet. Press <kbd>R</kbd> to record one. Each take is kept, so you can try several interpretations and compare them here.';
      tracks.appendChild(p);
    }

    takes.forEach((take, i) => {
      const row = document.createElement('div');
      row.className = 'tl-row track' + (take.id === selectedId ? ' is-selected' : '');
      row.dataset.id = take.id;
      const isSel = take.id === selectedId;
      const isCmp = compareIds.has(take.id);
      const speed = effectiveSpeed(take);
      row.innerHTML = `
        <div class="tl-gutter">
          <button class="compare${isCmp ? ' is-on' : ''}" title="${isSel ? 'Selected take' : (isCmp ? 'Hide from comparison' : 'Show as a ghost to compare')}" aria-pressed="${isSel || isCmp}">${COMPARE_SVG}</button>
          <div class="track-meta">
            <span class="track-name"></span>
            <span class="track-sub">
              <span>${i < 9 ? i + 1 : '·'}</span>
              ${take.example ? '<span class="badge badge-example">Example</span>' : `<span class="badge">${take.input === 'hand' ? 'Hand' : 'Cursor'}</span>`}
              <span>${fmtTime(playDuration(take))}${speed !== 1 ? ` · ${speed}×` : ''}</span>
            </span>
          </div>
          <div class="track-actions">
            <button class="ren" title="Rename" aria-label="Rename take">✎</button>
            <button class="del" title="Delete" aria-label="Delete take">×</button>
          </div>
        </div>
        <div class="tl-lane"><canvas></canvas></div>`;
      row.querySelector('.track-name').textContent = take.name;
      const gutter = row.querySelector('.tl-gutter');
      gutter.addEventListener('click', e => {
        if (e.target.closest('.track-actions') || e.target.closest('input')) return;
        if (e.target.closest('.compare')) { if (take.id !== this.selectedId) this.cb.onCompare(take.id); return; }
        this.cb.onSelect(take.id);
      });
      row.querySelector('.track-name').addEventListener('dblclick', () => this.startRename(row, take));
      row.querySelector('.ren').addEventListener('click', () => this.startRename(row, take));
      row.querySelector('.del').addEventListener('click', () => this.cb.onDelete(take.id));
      this.bindScrub(row.querySelector('.tl-lane'), take.id);
      tracks.appendChild(row);
      this.rows.set(take.id, { el: row, canvas: row.querySelector('canvas'), take });
    });
    this.redraw();
  }

  startRename(row, take) {
    const span = row.querySelector('.track-name');
    const input = document.createElement('input');
    input.className = 'track-name-input';
    input.value = take.name;
    input.maxLength = 48;
    span.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = commit => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (commit && v && v !== take.name) this.cb.onRename(take.id, v);
      else input.replaceWith(span);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Selection and comparison change in place, so a double-click to rename survives the first click.
  select(selectedId, compareIds) {
    this.selectedId = selectedId;
    this.compareIds = compareIds;
    for (const [id, r] of this.rows) {
      const isSel = id === selectedId, isCmp = compareIds.has(id);
      r.el.classList.toggle('is-selected', isSel);
      const b = r.el.querySelector('.compare');
      b.classList.toggle('is-on', isCmp);
      b.title = isSel ? 'Selected take' : (isCmp ? 'Hide from comparison' : 'Show as a ghost to compare');
      b.setAttribute('aria-pressed', isSel || isCmp);
    }
    this.redraw();
  }

  setLimit(ms) { this.limit = ms; }

  // The selected take's pieces, as blocks on the same time scale.
  // Drag a block's right edge to stretch or squeeze that piece.
  pieces(take, selIndex) {
    const row = this.els.piecesRow, lane = this.els.pieceLane;
    row.hidden = !take;
    if (!take) return;
    const timing = timingOf(take);
    const key = JSON.stringify([take.id, selIndex, this.scale, timing.map(p => [p.d0, p.d1, p.ease])]);
    if (key === this.piecesKey) return;
    this.piecesKey = key;
    lane.textContent = '';
    for (const p of timing) {
      const b = document.createElement('div');
      const e = editOf(take, p.i);
      b.className = `piece ${p.kind}` + (p.i === selIndex ? ' is-sel' : '') + (Math.abs(e.scale - 1) > 0.005 || Math.abs(e.ease) > 0.005 ? ' is-edited' : '');
      b.style.left = `${(p.d0 / this.scale) * 100}%`;
      b.style.width = `${((p.d1 - p.d0) / this.scale) * 100}%`;
      const label = p.kind === 'hold' ? `${((p.d1 - p.d0) / 1000).toFixed(2)}s` : pieceLabel(take, p.i).toLowerCase();
      b.title = `${pieceName(take, p.i)} · ${((p.d1 - p.d0) / 1000).toFixed(2)} s${Math.abs(e.scale - 1) > 0.005 ? ` (${e.scale.toFixed(2)}× as performed)` : ''}. Drag the right edge to retime.`;
      b.innerHTML = `<span></span><span class="piece-grip" aria-hidden="true"></span>`;
      b.firstChild.textContent = label;
      b.addEventListener('pointerdown', ev => {
        if (ev.target.classList.contains('piece-grip')) return;
        this.cb.onPieceSelect(p.i);
      });
      const grip = b.querySelector('.piece-grip');
      grip.addEventListener('pointerdown', ev => {
        ev.preventDefault(); ev.stopPropagation();
        grip.setPointerCapture(ev.pointerId);
        this.cb.onPieceDrag(p.i, null, 'start');
        const speed = effectiveSpeed(take);
        const move = mv => {
          const r = lane.getBoundingClientRect();
          const ms = ((mv.clientX - r.left) / r.width) * this.scale - p.d0;
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

  redraw() {
    this.drawRuler();
    for (const r of this.rows.values()) this.drawLane(r.canvas, rendered(r.take), 1, r.take.id === this.selectedId);
  }

  fit(canvas) {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
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
    // the recording limit
    const lx = Math.round(px(this.limit)) - 0.5;
    c.strokeStyle = col.rec; c.globalAlpha = 0.6; c.setLineDash([2, 2]);
    c.beginPath(); c.moveTo(lx, 0); c.lineTo(lx, h); c.stroke();
    c.setLineDash([]); c.globalAlpha = 1;
  }

  // Speed over time. Display time = take time / speed adjustment.
  drawLane(canvas, d, speed, selected, color) {
    const { c, w, h } = this.fit(canvas);
    const col = this.col;
    const ink = color || (selected ? col.accent : col.ink);
    const px = ms => (ms / speed / this.scale) * w;
    const top = 6, base = h - 7;
    const vy = v => base - Math.min(1, v / this.vmax) * (base - top);

    // baseline
    c.strokeStyle = col.line;
    c.beginPath(); c.moveTo(0, base + 0.5); c.lineTo(px(d.t[d.n - 1] || 0), base + 0.5); c.stroke();

    // tracking-lost spans: hatched, so they are not read as stillness
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
    c.lineTo(px(d.t[d.n - 1]), base);
    c.closePath();
    c.fillStyle = ink;
    c.globalAlpha = selected ? 0.16 : 0.07;
    c.fill();
    c.globalAlpha = selected ? 1 : 0.55;
    c.strokeStyle = ink;
    c.lineWidth = 1.25;
    c.beginPath();
    for (let i = 0; i < d.n; i++) { const x = px(d.t[i]), y = vy(d.speed[i]); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    c.globalAlpha = 1;

    // holds, bracketed under the baseline
    if (d.holds) {
      c.font = `500 9px ${this.v('--mono')}`;
      c.textBaseline = 'bottom';
      for (const hd of d.holds) {
        const x0 = px(hd.t0), x1 = px(hd.t1);
        c.strokeStyle = ink; c.globalAlpha = selected ? 0.8 : 0.4;
        c.beginPath(); c.moveTo(x0, base + 3); c.lineTo(x0, base + 5); c.lineTo(x1, base + 5); c.lineTo(x1, base + 3); c.stroke();
        if (x1 - x0 > 34) { c.fillStyle = ink; c.fillText('hold', x0 + 3, base + 1); }
      }
      c.globalAlpha = 1;
    }

    // end marker
    const ex = px(d.t[d.n - 1]);
    c.strokeStyle = ink; c.globalAlpha = 0.35;
    c.beginPath(); c.moveTo(ex + 0.5, top); c.lineTo(ex + 0.5, base); c.stroke();
    c.globalAlpha = 1;
  }

  // A temporary lane at the top while a take is being recorded.
  showRecording(d) {
    if (!this.recRow) {
      const row = document.createElement('div');
      row.className = 'tl-row track is-selected';
      row.innerHTML = `<div class="tl-gutter"><span class="compare"></span><div class="track-meta"><span class="track-name">Recording…</span><span class="track-sub"><span class="badge badge-rec">Rec</span><span class="rec-time"></span></span></div></div><div class="tl-lane"><canvas></canvas></div>`;
      const empty = this.els.tracks.querySelector('.tracks-empty');
      if (empty) empty.remove();
      this.els.tracks.prepend(row);
      this.els.tracks.scrollTop = 0;
      this.recRow = row;
    }
    this.recRow.querySelector('.rec-time').textContent = fmtTime(d.t[d.n - 1] || 0);
    this.drawLane(this.recRow.querySelector('canvas'), d, 1, true, this.col.rec);
  }

  setPlayhead(ms, rec = false) {
    const b = this.laneBox();
    const x = b.left + Math.min(1, ms / this.scale) * b.width;
    const ph = this.els.playhead;
    ph.style.transform = `translateX(${x}px)`;
    ph.classList.toggle('is-rec', rec);
  }
}
