// Music Map - "My timeline": saved tracks floating through depth
// The viewpoint sits at a date (the cursor). Covers saved after the cursor wait
// further away; moving forward in time brings them toward you and past you.
// Year frames and the rail below keep the selected period and direction legible.
// On narrow screens or when requested, the field falls back to a flat list.

import { coverUrl, seeded } from './covers';
import { formatMonth, formatSaved } from './graph';
import type { Track } from './types';

export const DAY = 86_400_000;
/** Days of saving history per unit of depth. */
const SPAN = 120 * DAY;
const Z_NEAR = -0.4;
const Z_FAR = 5;

export interface FieldItem {
  id: string;
  track: Track;
  savedMs: number;
}

interface Placed {
  item: FieldItem;
  el: HTMLButtonElement;
  sx: number;
  sy: number;
  visible: boolean;
}

export interface FieldCallbacks {
  onSelect(id: string, rect: DOMRect): void;
  onCursor(ms: number): void;
  onHover(id: string | null, anchor: HTMLElement | null): void;
}

export class TimelineField {
  private placed: Placed[] = [];
  private frames: { year: number; ms: number; el: HTMLDivElement }[] = [];
  private focusFrame: HTMLDivElement;
  private cursor = 0;
  private target = 0;
  private raf: number | null = null;
  private width = 800;
  private height = 600;
  private flat = false;
  private reducedMotion = false;
  private dragMoved = false;
  highlightId: string | null = null;

  private el: HTMLElement;
  private cb: FieldCallbacks;

  constructor(el: HTMLElement, cb: FieldCallbacks) {
    this.el = el;
    this.cb = cb;
    this.focusFrame = document.createElement('div');
    this.focusFrame.className = 'mm-frame mm-frame--focus';
    this.focusFrame.setAttribute('aria-hidden', 'true');
    this.bindDrag();
  }

  get range(): [number, number] {
    if (!this.placed.length) return [Date.now() - 365 * DAY, Date.now()];
    return [this.placed[0].item.savedMs - 30 * DAY, this.placed[this.placed.length - 1].item.savedMs + 10 * DAY];
  }

  get cursorMs(): number {
    return this.target;
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  setFlat(flat: boolean): void {
    if (flat === this.flat && this.el.childElementCount) return;
    this.flat = flat;
    this.build();
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.render();
  }

  setItems(items: FieldItem[]): void {
    const sorted = [...items].sort((a, b) => a.savedMs - b.savedMs);
    this.placed = sorted.map((item, i) => {
      // Golden-angle scatter, kept away from the centre so the vanishing point stays open.
      const rand = seeded(item.id);
      const angle = i * 2.39996 + rand() * 0.4;
      const r = 0.42 + ((i * 0.618) % 1) * 0.5;
      return {
        item,
        el: document.createElement('button'),
        sx: Math.cos(angle) * r,
        sy: Math.sin(angle) * r * 0.85,
        visible: false,
      };
    });
    this.build();
    const [start] = this.range;
    if (!this.cursor) this.setCursor(start, true);
    else this.setCursor(this.clamp(this.target), true);
  }

  private build(): void {
    this.el.innerHTML = '';
    this.el.classList.toggle('is-flat', this.flat);
    this.frames = [];
    if (this.flat) return this.buildList();

    const [start, end] = this.range;
    for (let y = new Date(start).getFullYear() + 1; y <= new Date(end).getFullYear(); y++) {
      const el = document.createElement('div');
      el.className = 'mm-frame';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `<span>${y}</span>`;
      this.el.appendChild(el);
      this.frames.push({ year: y, ms: Date.UTC(y, 0, 1), el });
    }
    this.el.appendChild(this.focusFrame);

    for (const p of this.placed) {
      const { track } = p.item;
      p.el.className = 'mm-cover';
      p.el.type = 'button';
      p.el.dataset.id = p.item.id;
      p.el.setAttribute('aria-label', `${track.title} by ${track.artistCredit}. Saved ${formatSaved(new Date(p.item.savedMs).toISOString())}.`);
      p.el.innerHTML = `
        <span class="mm-cover__art"><img alt="" src="${coverUrl(track.cover, track.title)}" draggable="false" loading="lazy" /></span>
        <span class="mm-cover__label" aria-hidden="true">
          <span class="mm-cover__title">${escapeHtml(track.title)}</span>
          <span class="mm-cover__saved">Saved ${formatSaved(new Date(p.item.savedMs).toISOString())}</span>
        </span>`;
      this.bindItem(p);
      this.el.appendChild(p.el);
    }
    this.render();
  }

  private buildList(): void {
    let year = -1;
    let grid: HTMLElement | null = null;
    // Newest first reads naturally in a scrolling list.
    for (const p of [...this.placed].reverse()) {
      const y = new Date(p.item.savedMs).getFullYear();
      if (y !== year) {
        year = y;
        const section = document.createElement('section');
        section.className = 'mm-list__year';
        section.innerHTML = `<h3>Saved in ${y}</h3>`;
        grid = document.createElement('div');
        grid.className = 'mm-list__grid';
        section.appendChild(grid);
        this.el.appendChild(section);
      }
      const { track } = p.item;
      p.el.className = 'mm-list__item';
      p.el.type = 'button';
      p.el.dataset.id = p.item.id;
      p.el.style.cssText = '';
      p.el.innerHTML = `
        <img alt="" src="${coverUrl(track.cover, track.title)}" loading="lazy" />
        <span class="mm-list__text">
          <span class="mm-cover__title">${escapeHtml(track.title)}</span>
          <span class="mm-list__artist">${escapeHtml(track.artistCredit)}</span>
          <span class="mm-cover__saved">Saved ${formatSaved(new Date(p.item.savedMs).toISOString())}</span>
        </span>`;
      this.bindItem(p);
      grid!.appendChild(p.el);
    }
  }

  private bindItem(p: Placed): void {
    p.el.onclick = (e) => {
      if (this.dragMoved) {
        e.preventDefault();
        return;
      }
      this.cb.onSelect(p.item.id, (p.el.querySelector('img') ?? p.el).getBoundingClientRect());
    };
    p.el.onpointerenter = () => this.cb.onHover(p.item.id, p.el);
    p.el.onpointerleave = () => this.cb.onHover(null, null);
    p.el.onfocus = () => {
      // Keyboard focus brings the cover forward; a mouse press must not move it mid-click.
      if (!this.flat && p.el.matches(':focus-visible')) this.bringForward(p.item.id);
      this.cb.onHover(p.item.id, p.el);
    };
    p.el.onblur = () => this.cb.onHover(null, null);
    p.el.onkeydown = (e) => {
      if (this.flat) return;
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const i = this.placed.indexOf(p) + dir;
      this.placed[i]?.el.focus();
    };
  }

  /** Vertical drag on the field moves through time (touch and mouse). */
  private bindDrag(): void {
    let startY = 0;
    let startCursor = 0;
    let active = false;
    this.el.addEventListener('pointerdown', (e) => {
      if (this.flat || e.button !== 0) return;
      active = true;
      this.dragMoved = false;
      startY = e.clientY;
      startCursor = this.target;
    });
    window.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 6) this.dragMoved = true;
      if (this.dragMoved) this.setCursor(startCursor + dy * 1.2 * DAY);
    });
    window.addEventListener('pointerup', () => {
      active = false;
      setTimeout(() => (this.dragMoved = false), 0);
    });
  }

  private clamp(ms: number): number {
    const [start, end] = this.range;
    return Math.max(start, Math.min(end, ms));
  }

  setCursor(ms: number, immediate = false): void {
    this.target = this.clamp(ms);
    if (immediate || this.reducedMotion) {
      this.cursor = this.target;
      this.render();
    } else if (this.raf === null) {
      this.raf = requestAnimationFrame(() => this.tick());
    }
    this.cb.onCursor(this.target);
  }

  nudge(deltaMs: number): void {
    this.setCursor(this.target + deltaMs);
  }

  /** Moves the viewpoint so this cover sits just in front of the focus plane. */
  bringForward(id: string, immediate = false): void {
    const p = this.placed.find((x) => x.item.id === id);
    if (p) this.setCursor(p.item.savedMs - SPAN * 0.2, immediate);
  }

  /** Jumps to the previous or next saved track relative to the cursor. */
  step(dir: 1 | -1): FieldItem | null {
    const ref = this.target + SPAN * 0.2;
    const list = dir > 0 ? this.placed : [...this.placed].reverse();
    const next = list.find((p) => (dir > 0 ? p.item.savedMs > ref + DAY : p.item.savedMs < ref - DAY));
    if (next) this.bringForward(next.item.id);
    return next?.item ?? null;
  }

  rectOf(id: string): DOMRect | null {
    const p = this.placed.find((x) => x.item.id === id);
    if (!p || (!p.visible && !this.flat)) return null;
    return (p.el.querySelector('img') ?? p.el).getBoundingClientRect();
  }

  focusCover(id: string): void {
    this.placed.find((x) => x.item.id === id)?.el.focus({ preventScroll: this.flat ? false : true });
  }

  private tick(): void {
    const diff = this.target - this.cursor;
    this.cursor += diff * 0.14;
    if (Math.abs(diff) < DAY * 0.2) this.cursor = this.target;
    this.render();
    this.raf = this.cursor === this.target ? null : requestAnimationFrame(() => this.tick());
  }

  private project(ms: number) {
    const z = (ms - this.cursor) / SPAN;
    const scale = z >= 0 ? 1 / (1 + z * 0.75) : 1 + -z * 1.6;
    let opacity = 1;
    if (z < 0) opacity = Math.max(0, 1 + z / -Z_NEAR);
    else if (z > Z_FAR - 1) opacity = Math.max(0, Z_FAR - z);
    opacity *= 1 - Math.min(Math.max(z, 0), 4) * 0.09;
    return { z, scale, opacity };
  }

  render(): void {
    if (this.flat) return;
    const cx = this.width / 2;
    const cy = this.height * 0.46;
    const base = Math.max(84, Math.min(this.width * 0.14, 180));

    for (const f of this.frames) {
      const { z, scale, opacity } = this.project(f.ms);
      const show = z > Z_NEAR && z < Z_FAR;
      f.el.style.display = show ? '' : 'none';
      if (!show) continue;
      const w = this.width * 0.9 * scale;
      const h = this.height * 0.74 * scale;
      Object.assign(f.el.style, {
        width: `${w}px`,
        height: `${h}px`,
        transform: `translate(${cx - w / 2}px, ${cy - h / 2}px)`,
        opacity: `${opacity * 0.9}`,
        zIndex: `${Math.round(1000 - z * 100)}`,
      });
    }
    const fw = this.width * 0.9;
    const fh = this.height * 0.74;
    this.focusFrame.style.cssText = `width:${fw}px;height:${fh}px;transform:translate(${cx - fw / 2}px,${cy - fh / 2}px)`;
    this.focusFrame.innerHTML = `<span>Now viewing · saved around ${formatMonth(this.cursor)}</span>`;

    for (const p of this.placed) {
      const { z, scale, opacity } = this.project(p.item.savedMs);
      const visible = z > Z_NEAR && z < Z_FAR && opacity > 0.02;
      p.visible = visible;
      p.el.style.display = visible ? '' : 'none';
      p.el.tabIndex = visible && opacity > 0.25 ? 0 : -1;
      if (!visible) continue;
      const x = cx + p.sx * this.width * 0.4 * scale;
      const y = cy + p.sy * this.height * 0.36 * scale;
      const size = base * scale;
      const legible = scale > 0.5 && z < 1.4;
      p.el.classList.toggle('is-legible', legible);
      p.el.classList.toggle('is-highlight', p.item.id === this.highlightId);
      p.el.style.width = `${size}px`;
      p.el.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px)`;
      p.el.style.opacity = `${opacity}`;
      p.el.style.zIndex = `${Math.round(1000 - z * 100)}`;
      p.el.style.setProperty('--tilt', `${(-p.sx * 16).toFixed(1)}deg`);
    }
  }
}

// ---- Rail -------------------------------------------------------------------

/** Labelled slider under the field: the saved-date axis with a draggable handle. */
export class TimelineRail {
  private track: HTMLDivElement;
  private handle: HTMLDivElement;
  private window: HTMLDivElement;
  private readout: HTMLSpanElement;
  private range: [number, number] = [0, 1];

  private onSeek: (ms: number) => void;

  constructor(el: HTMLElement, onSeek: (ms: number) => void) {
    this.onSeek = onSeek;
    el.innerHTML = `
      <div class="mm-rail__head">
        <span class="mm-rail__dir">← Earlier saves</span>
        <span class="mm-rail__readout" aria-hidden="true"></span>
        <span class="mm-rail__dir">Later saves →</span>
      </div>
      <div class="mm-rail__track">
        <div class="mm-rail__window" aria-hidden="true"></div>
        <div class="mm-rail__handle" role="slider" tabindex="0" aria-label="Date saved (My timeline)"></div>
      </div>`;
    this.track = el.querySelector('.mm-rail__track')!;
    this.handle = el.querySelector('.mm-rail__handle')!;
    this.window = el.querySelector('.mm-rail__window')!;
    this.readout = el.querySelector('.mm-rail__readout')!;

    const seekFromEvent = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.onSeek(this.range[0] + f * (this.range[1] - this.range[0]));
    };
    this.track.addEventListener('pointerdown', (e) => {
      this.track.setPointerCapture(e.pointerId);
      seekFromEvent(e);
      const move = (ev: PointerEvent) => seekFromEvent(ev);
      const up = () => {
        this.track.removeEventListener('pointermove', move);
        this.track.removeEventListener('pointerup', up);
      };
      this.track.addEventListener('pointermove', move);
      this.track.addEventListener('pointerup', up);
    });
    this.handle.addEventListener('keydown', (e) => {
      const month = 30 * DAY;
      const cur = Number(this.handle.getAttribute('aria-valuenow'));
      const map: Record<string, number> = {
        ArrowRight: cur + month,
        ArrowUp: cur + month,
        ArrowLeft: cur - month,
        ArrowDown: cur - month,
        PageUp: cur + 365 * DAY,
        PageDown: cur - 365 * DAY,
        Home: this.range[0],
        End: this.range[1],
      };
      if (e.key in map) {
        e.preventDefault();
        this.onSeek(map[e.key]);
      }
    });
  }

  setData(range: [number, number], savedMs: number[]): void {
    this.range = range;
    this.track.querySelectorAll('.mm-rail__tick, .mm-rail__year').forEach((n) => n.remove());
    const pos = (ms: number) => ((ms - range[0]) / (range[1] - range[0])) * 100;
    for (let y = new Date(range[0]).getFullYear() + 1; y <= new Date(range[1]).getFullYear(); y++) {
      const t = document.createElement('span');
      t.className = 'mm-rail__year';
      t.style.left = `${pos(Date.UTC(y, 0, 1))}%`;
      t.textContent = `${y}`;
      this.track.appendChild(t);
    }
    for (const ms of savedMs) {
      const t = document.createElement('span');
      t.className = 'mm-rail__tick';
      t.style.left = `${pos(ms)}%`;
      this.track.appendChild(t);
    }
    this.handle.setAttribute('aria-valuemin', `${range[0]}`);
    this.handle.setAttribute('aria-valuemax', `${range[1]}`);
  }

  setCursor(ms: number): void {
    const [a, b] = this.range;
    const f = (ms - a) / (b - a);
    this.handle.style.left = `${f * 100}%`;
    this.window.style.left = `${f * 100}%`;
    this.window.style.width = `${(SPAN / (b - a)) * 100}%`;
    this.handle.setAttribute('aria-valuenow', `${Math.round(ms)}`);
    this.handle.setAttribute('aria-valuetext', `Saved around ${formatMonth(ms)}`);
    this.readout.textContent = `Viewing saves from ${formatMonth(ms)} onward`;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
