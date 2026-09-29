// Music Map - Side-scrolling timeline canvas
// Covers sit along a horizontal axis, grouped into year sections, as a thin strip
// of small tiles. A lens follows the pointer: covers near it swell and scatter
// into a collage, then settle back into the line as the lens moves on.
// The same canvas shows "My timeline" (sections by year saved) and the
// "Historical timeline" (sections by release year, with gaps marked).
// On touch screens the lens sits at the centre of the view, so scrolling blooms
// whatever passes through the middle.

import { coverUrl, seeded } from './covers';
import type { Track } from './types';

export interface CanvasItem {
  id: string;
  track: Track;
  /** Shown in the tile's accessible name, e.g. "Saved 12 Apr 2019". */
  dateText: string;
  outside?: boolean;
}

export interface CanvasSection {
  key: string;
  title: string;
  /** Explorer-written caption ("senior year"), or a factual note when not editable. */
  caption?: string;
  editable: boolean;
  items: CanvasItem[];
  /** Label for an empty stretch of time before this section, e.g. "≈ 11 years". */
  gapBefore?: string;
}

export interface CanvasCallbacks {
  onSelect(id: string, sectionKey: string, rect: DOMRect): void;
  onHover(id: string | null, el: HTMLElement | null): void;
  onCaption?(sectionKey: string): void;
}

interface Tile {
  item: CanvasItem;
  section: string;
  el: HTMLButtonElement;
  x: number;
  sx: number;
  sy: number;
  scale: number;
  active: boolean;
}

const REST = 30;
const STEP = 34;
const PAD = 70;
const GAP = 110;

export class TimelineCanvas {
  private root: HTMLElement;
  private cb: CanvasCallbacks;
  private world: HTMLDivElement;
  private axis: HTMLDivElement;
  private nav: HTMLElement;
  private tiles: Tile[] = [];
  private sectionPos = new Map<string, { x: number; w: number; el: HTMLElement }>();
  private width = 800;
  private height = 600;
  private lens = { x: 0, s: 0, tx: 0, ts: 0 };
  private raf: number | null = null;
  private reducedMotion = false;
  /** Touch-first screens have no hover, so the lens rides the middle of the view. */
  private touch = matchMedia('(hover: none)').matches;
  private dragging = false;

  constructor(root: HTMLElement, nav: HTMLElement, cb: CanvasCallbacks) {
    this.root = root;
    this.nav = nav;
    this.cb = cb;
    this.world = document.createElement('div');
    this.world.className = 'mm-canvas__world';
    this.axis = document.createElement('div');
    this.axis.className = 'mm-canvas__axis';
    this.root.appendChild(this.world);
    this.bind();
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.world.style.height = `${h}px`;
    this.axis.style.top = `${this.axisY}px`;
    this.sectionPos.forEach((s) => (s.el.style.height = `${h}px`));
    this.paint(true);
  }

  private get axisY(): number {
    return Math.round(this.height * 0.56);
  }

  // ---- Build ------------------------------------------------------------------

  setSections(sections: CanvasSection[], accent: 'saved' | 'release'): void {
    this.root.dataset.accent = accent;
    this.world.innerHTML = '';
    this.world.appendChild(this.axis);
    this.tiles = [];
    this.sectionPos.clear();
    let x = 40;
    const navItems: string[] = [];

    for (const sec of sections) {
      if (sec.gapBefore) {
        const gap = document.createElement('div');
        gap.className = 'mm-canvas__gap';
        gap.style.left = `${x}px`;
        gap.style.width = `${GAP}px`;
        gap.innerHTML = `<span>${escapeHtml(sec.gapBefore)}</span>`;
        this.world.appendChild(gap);
        x += GAP;
      }
      const w = Math.max(240, sec.items.length * STEP + PAD * 2);
      const el = document.createElement('section');
      el.className = 'mm-sec';
      el.style.left = `${x}px`;
      el.style.width = `${w}px`;
      el.style.height = `${this.height}px`;
      el.setAttribute('aria-label', `${sec.title}, ${sec.items.length} track${sec.items.length === 1 ? '' : 's'}`);
      const caption = sec.editable
        ? `<button type="button" class="mm-sec__caption ${sec.caption ? '' : 'is-empty'}" data-sec="${escapeHtml(sec.key)}">${escapeHtml(sec.caption || '+ what was going on?')}</button>`
        : sec.caption
          ? `<p class="mm-sec__caption is-static">${escapeHtml(sec.caption)}</p>`
          : '';
      el.innerHTML = `<header class="mm-sec__head"><h3 class="mm-sec__year">${escapeHtml(sec.title)}</h3>${caption}<p class="mm-sec__count">${sec.items.length} track${sec.items.length === 1 ? '' : 's'}</p></header>`;
      el.querySelector<HTMLButtonElement>('button.mm-sec__caption')?.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      this.world.appendChild(el);
      this.sectionPos.set(sec.key, { x, w, el });
      navItems.push(`<button type="button" class="mm-yearnav__btn" data-key="${escapeHtml(sec.key)}">${escapeHtml(sec.title)}</button>`);

      sec.items.forEach((item, i) => {
        const rand = seeded(item.id);
        const tile: Tile = {
          item,
          section: sec.key,
          el: document.createElement('button'),
          x: x + PAD + i * STEP + STEP / 2,
          // Alternate above/below so a bloom opens both ways around the axis.
          sy: (i % 2 ? 1 : -1) * (0.25 + rand() * 0.75),
          sx: rand() - 0.5,
          scale: 0.75 + rand() * 0.45,
          active: true,
        };
        const t = item.track;
        tile.el.type = 'button';
        tile.el.className = `mm-tile${item.outside ? ' is-outside' : ''}`;
        tile.el.dataset.id = item.id;
        tile.el.setAttribute('aria-label', `${t.title} by ${t.artistCredit}. ${item.dateText}.`);
        tile.el.innerHTML = `<img alt="" src="${coverUrl(t.cover, t.title)}" draggable="false" loading="lazy" />`;
        tile.el.addEventListener('click', (e) => {
          if (this.dragging) return e.preventDefault();
          this.cb.onSelect(item.id, sec.key, tile.el.getBoundingClientRect());
        });
        tile.el.addEventListener('pointerenter', () => this.cb.onHover(item.id, tile.el));
        tile.el.addEventListener('pointerleave', () => this.cb.onHover(null, null));
        tile.el.addEventListener('focus', () => {
          this.scrollToX(tile.x, false);
          this.setLens(tile.x, 1);
          this.cb.onHover(item.id, tile.el);
        });
        tile.el.addEventListener('blur', () => this.cb.onHover(null, null));
        tile.el.addEventListener('keydown', (e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          this.tiles[this.tiles.indexOf(tile) + dir]?.el.focus({ preventScroll: true });
        });
        this.world.appendChild(tile.el);
        this.tiles.push(tile);
      });
      x += w;
    }
    this.world.style.width = `${x + 40}px`;
    this.axis.style.width = `${x}px`;
    this.axis.style.top = `${this.axisY}px`;
    this.nav.innerHTML = `<span class="mm-yearnav__dir" aria-hidden="true">← earlier</span>${navItems.join('')}<span class="mm-yearnav__dir" aria-hidden="true">later →</span>`;
    this.nav.querySelectorAll<HTMLButtonElement>('.mm-yearnav__btn').forEach((b) =>
      b.addEventListener('click', () => this.scrollToSection(b.dataset.key!)),
    );
    // Start with the lens resting mid-view, at low strength, so the page opens with a hint of the bloom.
    this.lens.x = this.lens.tx = this.root.scrollLeft + this.width / 2;
    this.lens.s = this.lens.ts = this.touch ? 1 : 0.55;
    this.paint(true);
    this.updateNav();
  }

  // ---- Navigation ---------------------------------------------------------------

  scrollToSection(key: string, smooth = true): void {
    const s = this.sectionPos.get(key);
    if (!s) return;
    this.root.scrollTo({ left: Math.max(0, s.x - 40), behavior: smooth && !this.reducedMotion ? 'smooth' : 'auto' });
  }

  scrollToItem(id: string, highlight = false): void {
    const t = this.tiles.find((x) => x.item.id === id);
    if (!t) return;
    this.scrollToX(t.x, true);
    this.setLens(t.x, 1);
    if (highlight) {
      t.el.classList.add('is-highlight');
      setTimeout(() => t.el.classList.remove('is-highlight'), 2400);
    }
  }

  focusItem(id: string): void {
    this.tiles.find((x) => x.item.id === id)?.el.focus({ preventScroll: true });
  }

  rectOf(id: string): DOMRect | null {
    return this.tiles.find((x) => x.item.id === id)?.el.getBoundingClientRect() ?? null;
  }

  private scrollToX(x: number, center: boolean): void {
    const left = this.root.scrollLeft;
    if (!center && x > left + 120 && x < left + this.width - 120) return;
    this.root.scrollTo({ left: Math.max(0, x - this.width / 2), behavior: this.reducedMotion ? 'auto' : 'smooth' });
  }

  private setLens(x: number, s: number): void {
    this.lens.tx = x;
    this.lens.ts = s;
    this.kick();
  }

  // ---- Input --------------------------------------------------------------------

  private bind(): void {
    this.root.addEventListener(
      'wheel',
      (e) => {
        // Vertical wheels scroll sideways; trackpads' own horizontal motion passes through.
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        this.root.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
    this.root.addEventListener('pointermove', (e) => {
      this.touch = e.pointerType === 'touch';
      if (this.touch) return;
      const r = this.root.getBoundingClientRect();
      this.setLens(this.root.scrollLeft + e.clientX - r.left, 1);
    });
    this.root.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') this.setLens(this.lens.tx, 0.35);
    });
    this.root.addEventListener('scroll', () => {
      if (this.touch) this.setLens(this.root.scrollLeft + this.width / 2, 1);
      else this.kick();
      this.updateNav();
    });

    // Drag the background with a mouse to pan, like a canvas.
    let startX = 0;
    let startLeft = 0;
    let down = false;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('.mm-sec__caption')) return;
      down = true;
      this.dragging = false;
      startX = e.clientX;
      startLeft = this.root.scrollLeft;
    });
    window.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 5) {
        this.dragging = true;
        this.root.classList.add('is-dragging');
      }
      if (this.dragging) this.root.scrollLeft = startLeft - dx;
    });
    window.addEventListener('pointerup', () => {
      down = false;
      this.root.classList.remove('is-dragging');
      setTimeout(() => (this.dragging = false), 0);
    });
  }

  private updateNav(): void {
    const mid = this.root.scrollLeft + this.width / 2;
    let current = '';
    this.sectionPos.forEach((s, key) => {
      if (mid >= s.x && mid < s.x + s.w) current = key;
    });
    this.nav.querySelectorAll<HTMLButtonElement>('.mm-yearnav__btn').forEach((b) => {
      const on = b.dataset.key === current;
      b.classList.toggle('is-current', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
  }

  // ---- Bloom ----------------------------------------------------------------------

  private kick(): void {
    if (this.reducedMotion) {
      this.lens.x = this.lens.tx;
      this.lens.s = this.lens.ts;
      this.paint();
      return;
    }
    if (this.raf === null) this.raf = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    const l = this.lens;
    l.x += (l.tx - l.x) * 0.16;
    l.s += (l.ts - l.s) * 0.12;
    const settled = Math.abs(l.tx - l.x) < 0.5 && Math.abs(l.ts - l.s) < 0.005;
    if (settled) {
      l.x = l.tx;
      l.s = l.ts;
    }
    this.paint();
    this.raf = settled ? null : requestAnimationFrame(() => this.tick());
  }

  private paint(all = false): void {
    const y0 = this.axisY;
    const radius = Math.max(150, Math.min(280, this.width * 0.17));
    const big = Math.max(70, Math.min(176, this.height * 0.27, this.width * 0.3));
    const spread = this.height * 0.3;
    const left = this.root.scrollLeft - radius * 2;
    const right = this.root.scrollLeft + this.width + radius * 2;

    for (const t of this.tiles) {
      const inView = t.x > left && t.x < right;
      if (!inView && !t.active && !all) continue;
      const d = t.x - this.lens.x;
      const f = inView ? Math.exp(-(d * d) / (2 * radius * radius)) * this.lens.s : 0;
      t.active = f > 0.01;
      const size = REST + f * (big * t.scale - REST);
      // Near the lens, tiles push outward along the axis and scatter above and below it.
      const cx = t.x + d * f * 0.85 + t.sx * f * 60;
      const cy = y0 + t.sy * f * spread;
      t.el.style.width = `${size}px`;
      t.el.style.height = `${size}px`;
      t.el.style.transform = `translate(${cx - size / 2}px, ${cy - size / 2}px)`;
      t.el.style.zIndex = `${10 + Math.round(f * 100)}`;
      t.el.classList.toggle('is-bloomed', f > 0.55);
    }
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
