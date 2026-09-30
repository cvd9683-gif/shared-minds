// Music Map - Timeline canvas (after the paper timeline in Figma)
// A horizontal axis with a tick per year. Under each year, its covers are packed
// into a dense collage column, divided from the next year by a thin line. Above
// the axis, a magnifier box shows the year you're hovering at a readable size,
// joined to its stretch of the axis by two lines. Picking a cover pins the box:
// the cover grows, and its details sit beside it.
// The same canvas shows the Personal Timeline (by year saved) and the Historical
// Timeline (by release year, older years grouped by decade, gaps marked).

import { coverUrl, seeded } from './covers';
import type { Track } from './types';

export interface CanvasItem {
  id: string;
  track: Track;
  /** Shown in the cover's accessible name, e.g. "Saved 12 Apr 2019". */
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
  /** Label for an empty stretch of time before this section, e.g. "3 yrs not shown". */
  gapBefore?: string;
}

export interface CanvasCallbacks {
  onSelect(id: string, sectionKey: string, rect: DOMRect): void;
  onHover(id: string | null, el: HTMLElement | null): void;
  /** The year label or its caption was clicked. */
  onCaption?(sectionKey: string): void;
  /** A click on empty canvas while a cover is pinned. */
  onBackground?(): void;
}

interface Section {
  data: CanvasSection;
  x: number;
  w: number;
  covers: Map<string, HTMLButtonElement>;
}

const LEFT = 56;
const GAP_W = 64;

export class TimelineCanvas {
  private root: HTMLElement;
  private cb: CanvasCallbacks;
  private world: HTMLDivElement;
  private zoom: HTMLDivElement;
  private lines: SVGSVGElement;
  private info: HTMLDivElement;
  private sections: Section[] = [];
  private width = 800;
  private height = 600;
  private zoomKey: string | null = null;
  private pinned: { id: string; key: string } | null = null;
  private reducedMotion = false;
  private dragging = false;
  private accent: 'saved' | 'release' = 'saved';
  private lastData: CanvasSection[] = [];

  constructor(root: HTMLElement, nav: HTMLElement, cb: CanvasCallbacks) {
    this.root = root;
    this.cb = cb;
    nav.hidden = true; // the axis itself is the navigation now
    this.world = document.createElement('div');
    this.world.className = 'mm-canvas__world';
    this.zoom = document.createElement('div');
    this.zoom.className = 'mm-zoom';
    this.info = document.createElement('div');
    this.info.className = 'mm-zoom__info';
    this.lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lines.setAttribute('class', 'mm-zoom__lines');
    this.lines.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.world);
    this.bind();
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  resize(w: number, h: number): void {
    const changed = Math.abs(h - this.height) > 1 || Math.abs(w - this.width) > 1;
    this.width = w;
    this.height = h;
    if (changed && this.lastData.length) this.setSections(this.lastData, this.accent, true);
  }

  private get axisY(): number {
    return Math.round(Math.max(250, Math.min(this.height - 170, this.height * 0.58)));
  }

  private get cell(): number {
    return this.width < 600 ? 24 : 30;
  }

  // ---- Build ------------------------------------------------------------------

  setSections(data: CanvasSection[], accent: 'saved' | 'release', keepState = false): void {
    const keepZoom = keepState ? this.zoomKey : null;
    const keepPin = keepState ? this.pinned : null;
    const keepInfo = this.info.innerHTML;
    this.lastData = data;
    this.accent = accent;
    this.root.dataset.accent = accent;
    this.world.innerHTML = '';
    this.sections = [];
    this.pinned = null;

    const y0 = this.axisY;
    const c = this.cell;
    const colTop = y0 + 78;
    const rows = Math.max(2, Math.floor((this.height - 16 - colTop) / (c + 2)));
    let x = LEFT;
    const axis = document.createElement('div');
    axis.className = 'mm-canvas__axis';
    this.world.appendChild(axis);

    for (const sec of data) {
      if (sec.gapBefore) {
        const gap = document.createElement('div');
        gap.className = 'mm-canvas__gap';
        Object.assign(gap.style, { left: `${x}px`, width: `${GAP_W}px`, top: `${y0 - 10}px` });
        gap.innerHTML = `<span>${escapeHtml(sec.gapBefore)}</span>`;
        this.world.appendChild(gap);
        x += GAP_W;
      }
      // Pack covers into a dense column; a few take a 2×2 spot, like a paper collage.
      const n = sec.items.length;
      const cols = Math.max(4, Math.ceil((n * 1.25) / rows));
      const grid: boolean[][] = [];
      const free = (r: number, q: number) => r < rows && !grid[r]?.[q];
      const take = (r: number, q: number) => ((grid[r] ??= [])[q] = true);
      const spots: { r: number; q: number; s: number }[] = [];
      for (let i = 0; i < n; i++) {
        const big = n > 6 && seeded(sec.items[i].id)() < 0.12;
        let spot: { r: number; q: number; s: number } | null = null;
        for (let q = 0; !spot; q++) {
          for (let r = 0; r < rows && !spot; r++) {
            if (big && q < cols - 1 && free(r, q) && free(r + 1, q) && free(r, q + 1) && free(r + 1, q + 1)) spot = { r, q, s: 2 };
            else if (!big && free(r, q)) spot = { r, q, s: 1 };
          }
          // No 2×2 room within the column's width: settle for a single spot.
          if (!spot && big && q >= cols) {
            for (let qq = 0; !spot; qq++) for (let r = 0; r < rows && !spot; r++) if (free(r, qq)) spot = { r, q: qq, s: 1 };
          }
        }
        for (let dr = 0; dr < spot.s; dr++) for (let dq = 0; dq < spot.s; dq++) take(spot.r + dr, spot.q + dq);
        spots.push(spot);
      }
      const usedCols = Math.max(cols, ...spots.map((s) => s.q + s.s));
      const width = Math.max(170, usedCols * (c + 2) + 28);

      const el = document.createElement('section');
      el.className = 'mm-sec';
      Object.assign(el.style, { left: `${x}px`, width: `${width}px` });
      el.setAttribute('aria-label', `${sec.title}, ${n} track${n === 1 ? '' : 's'}`);
      const caption = sec.editable
        ? `<button type="button" class="mm-sec__caption ${sec.caption ? '' : 'is-empty'}">${escapeHtml(sec.caption || '+ add a note')}</button>`
        : sec.caption
          ? `<span class="mm-sec__caption is-static">${escapeHtml(sec.caption)}</span>`
          : '';
      el.innerHTML = `
        <span class="mm-sec__tick" style="top:${y0}px"></span>
        <span class="mm-sec__divider" style="top:${y0 + 14}px"></span>
        <div class="mm-sec__head" style="top:${y0 + 16}px">
          <button type="button" class="mm-sec__year">${escapeHtml(sec.title)}</button>
          ${caption}
        </div>`;
      el.querySelector('.mm-sec__year')!.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      el.querySelector<HTMLButtonElement>('button.mm-sec__caption')?.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      this.world.appendChild(el);

      const covers = new Map<string, HTMLButtonElement>();
      sec.items.forEach((item, i) => {
        const spot = spots[i];
        const size = spot.s * c + (spot.s - 1) * 2;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `mm-cov${item.outside ? ' is-outside' : ''}`;
        b.dataset.id = item.id;
        Object.assign(b.style, {
          left: `${x + 14 + spot.q * (c + 2)}px`,
          top: `${colTop + spot.r * (c + 2)}px`,
          width: `${size}px`,
          height: `${size}px`,
        });
        b.setAttribute('aria-label', `${item.track.title} by ${item.track.artistCredit}. ${item.dateText}.`);
        b.innerHTML = `<img alt="" src="${coverUrl(item.track.cover, item.track.title)}" loading="lazy" draggable="false" />`;
        this.bindCover(b, item, sec.key);
        this.world.appendChild(b);
        covers.set(item.id, b);
      });

      this.sections.push({ data: sec, x, w: width, covers });
      x += width;
    }
    const worldW = x + LEFT;
    this.world.style.width = `${worldW}px`;
    this.world.style.height = `${this.height}px`;
    Object.assign(axis.style, { top: `${y0}px`, left: '16px', width: `${worldW - 32}px` });
    this.world.append(this.lines, this.zoom);

    const pin = keepPin && this.sections.some((s) => s.covers.has(keepPin.id)) ? keepPin : null;
    this.zoomKey = null;
    if (pin) this.pin(pin.id, keepInfo);
    else this.showZoom(keepZoom && this.find(keepZoom) ? keepZoom : this.centerKey());
  }

  private bindCover(b: HTMLButtonElement, item: CanvasItem, key: string): void {
    b.addEventListener('click', (e) => {
      if (this.dragging) return e.preventDefault();
      this.cb.onSelect(item.id, key, b.getBoundingClientRect());
    });
    b.addEventListener('pointerenter', () => {
      if (!this.pinned) this.showZoom(key);
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
    });
    b.addEventListener('pointerleave', () => {
      this.hot(item.id, false);
      this.cb.onHover(null, null);
    });
    b.addEventListener('focus', () => {
      this.scrollIntoView(key, false);
      if (!this.pinned) this.showZoom(key);
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
    });
    b.addEventListener('blur', () => {
      this.hot(item.id, false);
      this.cb.onHover(null, null);
    });
    b.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const all = this.sections.flatMap((s) => [...s.covers.values()]);
      all[all.indexOf(b) + dir]?.focus({ preventScroll: true });
    });
  }

  private find(key: string): Section | undefined {
    return this.sections.find((s) => s.data.key === key);
  }

  private sectionOf(id: string): Section | undefined {
    return this.sections.find((s) => s.covers.has(id));
  }

  private centerKey(): string | null {
    const mid = this.root.scrollLeft + this.width / 2;
    let best: Section | undefined;
    let bestD = Infinity;
    for (const s of this.sections) {
      const d = Math.abs(s.x + s.w / 2 - mid);
      if (d < bestD) [best, bestD] = [s, d];
    }
    return best?.data.key ?? null;
  }

  /** Links a cover in the column and its copy in the magnifier. */
  private hot(id: string, on: boolean): void {
    this.sectionOf(id)?.covers.get(id)?.classList.toggle('is-hot', on);
    this.zoom.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-hot', on);
  }

  // ---- Magnifier ----------------------------------------------------------------

  private zoomBox(sec: Section) {
    const top = 14;
    const height = this.axisY - 58 - top;
    const width = this.pinned
      ? Math.min(this.width - 32, 1040)
      : Math.min(this.width - 32, 920, Math.max(420, sec.w * 2.6));
    const minL = this.root.scrollLeft + 16;
    const maxL = this.root.scrollLeft + this.width - 16 - width;
    const left = Math.max(minL, Math.min(maxL, sec.x + sec.w / 2 - width / 2));
    return { top, height, width, left };
  }

  private showZoom(key: string | null, force = false): void {
    const sec = key ? this.find(key) : undefined;
    if (!sec) {
      this.zoom.hidden = true;
      this.lines.innerHTML = '';
      return;
    }
    if (!force && key === this.zoomKey && !this.zoom.hidden) return this.placeZoom();
    this.zoomKey = key;
    this.zoom.hidden = false;
    this.zoom.classList.remove('is-pinned');
    const box = this.zoomBox(sec);
    const n = sec.data.items.length;
    // Size cells so the whole year fits inside the box.
    const pw = box.width - 28;
    const ph = box.height - 50;
    const c = Math.max(34, Math.min(150, Math.floor(Math.sqrt((pw * ph) / (n * 1.3)))));
    const items = sec.data.items
      .map((it, i) => {
        const big = n > 4 && seeded(it.id)() < 0.12 ? ' is-big' : '';
        const delay = this.reducedMotion ? 0 : Math.min(i * 14, 420);
        return `<button type="button" class="mm-zoom__item${big}${it.outside ? ' is-outside' : ''}" data-id="${escapeHtml(it.id)}" style="animation-delay:${delay}ms" title="${escapeHtml(it.track.title)} · ${escapeHtml(it.track.artistCredit)}"><img alt="${escapeHtml(it.track.title)} by ${escapeHtml(it.track.artistCredit)}" src="${coverUrl(it.track.cover, it.track.title)}" draggable="false" /></button>`;
      })
      .join('');
    this.zoom.innerHTML = `
      <p class="mm-zoom__head"><strong>${escapeHtml(sec.data.title)}</strong>${sec.data.caption ? ` <span>${escapeHtml(sec.data.caption)}</span>` : ''}<em>${n} track${n === 1 ? '' : 's'}</em></p>
      <div class="mm-zoom__grid" style="--c:${c}px">${items}</div>`;
    this.bindZoomItems(sec.data.key);
    this.placeZoom();
  }

  private bindZoomItems(key: string): void {
    this.zoom.querySelectorAll<HTMLButtonElement>('.mm-zoom__item').forEach((b) => {
      const id = b.dataset.id!;
      b.addEventListener('click', () => this.cb.onSelect(id, key, b.getBoundingClientRect()));
      b.addEventListener('pointerenter', () => {
        this.hot(id, true);
        this.cb.onHover(id, b);
      });
      b.addEventListener('pointerleave', () => {
        this.hot(id, false);
        this.cb.onHover(null, null);
      });
    });
  }

  private placeZoom(): void {
    const sec = this.zoomKey ? this.find(this.zoomKey) : undefined;
    if (!sec || this.zoom.hidden) return;
    const box = this.zoomBox(sec);
    Object.assign(this.zoom.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    // Two lines from the box's lower corners to the year's stretch of the axis.
    const y0 = this.axisY;
    const b = box.top + box.height;
    this.lines.setAttribute('width', this.world.style.width.replace('px', ''));
    this.lines.setAttribute('height', `${this.height}`);
    this.lines.innerHTML = `
      <line x1="${box.left}" y1="${b}" x2="${sec.x + 4}" y2="${y0}" />
      <line x1="${box.left + box.width}" y1="${b}" x2="${sec.x + sec.w - 4}" y2="${y0}" />`;
    this.sections.forEach((s) => s.covers.forEach((el) => el.classList.toggle('is-zoomed', s === sec)));
  }

  /** Pins the magnifier on one cover: it grows, with its details beside it. */
  private pin(id: string, html: string): void {
    const sec = this.sectionOf(id);
    if (!sec) return;
    const item = sec.data.items.find((i) => i.id === id)!;
    this.pinned = { id, key: sec.data.key };
    this.zoomKey = sec.data.key;
    this.zoom.hidden = false;
    this.zoom.classList.add('is-pinned');
    this.info.innerHTML = html;
    const others = sec.data.items
      .map(
        (it) =>
          `<button type="button" class="mm-zoom__item${it.id === id ? ' is-current' : ''}" data-id="${escapeHtml(it.id)}" title="${escapeHtml(it.track.title)}"><img alt="${escapeHtml(it.track.title)} by ${escapeHtml(it.track.artistCredit)}" src="${coverUrl(it.track.cover, it.track.title)}" draggable="false" /></button>`,
      )
      .join('');
    const pic = this.width < 600 ? 140 : Math.max(120, this.zoomBox(sec).height - 34);
    this.zoom.innerHTML = `
      <figure class="mm-zoom__picked" style="width:${pic}px;height:${pic}px"><img src="${coverUrl(item.track.cover, item.track.title)}" alt="Cover of ${escapeHtml(item.track.title)}" /></figure>
      <div class="mm-zoom__side"></div>
      <div class="mm-zoom__rest"><p class="mm-zoom__head"><strong>${escapeHtml(sec.data.title)}</strong><em>${sec.data.items.length} tracks</em></p><div class="mm-zoom__grid" style="--c:38px">${others}</div></div>`;
    this.zoom.querySelector('.mm-zoom__side')!.appendChild(this.info);
    this.bindZoomItems(sec.data.key);
    this.sections.forEach((s) => s.covers.forEach((el, k) => el.classList.toggle('is-selected', k === id)));
    this.placeZoom();
  }

  // ---- Public selection API (used by the app) ------------------------------------

  setSelected(id: string | null, html = '', label = ''): void {
    this.root.classList.toggle('has-picked', !!id);
    if (!id) {
      this.pinned = null;
      this.sections.forEach((s) => s.covers.forEach((el) => el.classList.remove('is-selected')));
      this.showZoom(this.zoomKey, true);
      return;
    }
    const sec = this.sectionOf(id);
    if (!sec) return;
    this.zoom.setAttribute('aria-label', label);
    this.scrollIntoView(sec.data.key, true);
    this.pin(id, html);
  }

  updateCallout(html: string): void {
    if (this.pinned) this.info.innerHTML = html;
  }

  get calloutEl(): HTMLElement {
    return this.info;
  }

  scrollToSection(key: string, smooth = true): void {
    const s = this.find(key);
    if (s) this.root.scrollTo({ left: Math.max(0, s.x - 40), behavior: smooth && !this.reducedMotion ? 'smooth' : 'auto' });
  }

  scrollToItem(id: string, highlight = false): void {
    const sec = this.sectionOf(id);
    if (!sec) return;
    this.scrollIntoView(sec.data.key, true);
    if (!this.pinned) this.showZoom(sec.data.key);
    if (highlight) {
      const el = sec.covers.get(id)!;
      el.classList.add('is-highlight');
      setTimeout(() => el.classList.remove('is-highlight'), 2400);
    }
  }

  focusItem(id: string): void {
    this.sectionOf(id)?.covers.get(id)?.focus({ preventScroll: true });
  }

  rectOf(id: string): DOMRect | null {
    return this.sectionOf(id)?.covers.get(id)?.getBoundingClientRect() ?? null;
  }

  private scrollIntoView(key: string, center: boolean): void {
    const s = this.find(key);
    if (!s) return;
    const left = this.root.scrollLeft;
    if (!center && s.x > left + 40 && s.x + s.w < left + this.width - 40) return;
    this.root.scrollTo({ left: Math.max(0, s.x + s.w / 2 - this.width / 2), behavior: this.reducedMotion ? 'auto' : 'smooth' });
  }

  // ---- Input --------------------------------------------------------------------

  private bind(): void {
    this.root.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement).closest('.mm-zoom')) return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        this.root.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
    // Hovering a year's column (or its label) brings it into the magnifier.
    this.root.addEventListener('pointermove', (e) => {
      if (this.pinned || e.pointerType === 'touch') return;
      if ((e.target as HTMLElement).closest('.mm-zoom')) return;
      const r = this.root.getBoundingClientRect();
      if (e.clientY - r.top < this.axisY - 24) return;
      const x = this.root.scrollLeft + e.clientX - r.left;
      const sec = this.sections.find((s) => x >= s.x && x < s.x + s.w);
      if (sec) this.showZoom(sec.data.key);
    });
    let scrollTimer = 0;
    this.root.addEventListener('scroll', () => {
      this.placeZoom();
      clearTimeout(scrollTimer);
      // After scrolling settles, the magnifier follows the year in the middle.
      scrollTimer = window.setTimeout(() => {
        if (!this.pinned) this.showZoom(this.centerKey());
      }, 160);
    });
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      // A click that re-drew the magnifier leaves its target detached; that isn't a background click.
      if (!t.isConnected || this.dragging || !this.pinned || t.closest('.mm-cov, .mm-zoom, .mm-sec__head')) return;
      this.cb.onBackground?.();
    });

    // Drag the background with a mouse to pan, like a canvas.
    let startX = 0;
    let startLeft = 0;
    let down = false;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('.mm-zoom, .mm-sec__head')) return;
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
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
