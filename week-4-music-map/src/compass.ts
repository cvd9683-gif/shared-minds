// Music Map - Compass: place your albums on two axes you name yourself.
// Nothing is placed automatically: where an album sits is your judgement of how it
// feels ("lush ↔ minimal", "lover ↔ loner"), not a measurement. Albums wait in a tray
// you can filter by artist, album, genre or year; drag them on, drag them back.

import { escapeHtml as h } from './canvas';

export interface CompassItem {
  key: string;
  title: string;
  artist: string;
  cover: string;
  years: string[];
  genres: string[];
  /** A song from the album, opened when you click it on the compass. */
  trackId: string;
}

interface CompassState {
  title: string;
  axes: { top: string; bottom: string; left: string; right: string };
  placed: Record<string, { x: number; y: number }>;
}

const KEY = 'musicMap:compass';
const DEFAULT: CompassState = {
  title: 'My compass',
  axes: { top: 'lover', bottom: 'loner', left: 'lush', right: 'minimal' },
  placed: {},
};

export class CompassView {
  private root: HTMLElement;
  private onOpen: (trackId: string) => void;
  private items: CompassItem[] = [];
  private state: CompassState;
  private filter = '';
  private field!: HTMLElement;
  private tray!: HTMLElement;

  constructor(root: HTMLElement, onOpen: (trackId: string) => void) {
    this.root = root;
    this.onOpen = onOpen;
    this.state = load();
    this.build();
  }

  setItems(items: CompassItem[]): void {
    this.items = items;
    this.render();
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="mm-compass__field" aria-label="Compass. Drag albums onto it; arrow keys move a selected album.">
        <input class="mm-compass__title" value="" aria-label="Compass title" />
        <div class="mm-compass__axis is-x"></div>
        <div class="mm-compass__axis is-y"></div>
        ${(['top', 'bottom', 'left', 'right'] as const)
          .map((s) => `<input class="mm-compass__label is-${s}" data-axis="${s}" aria-label="${s} axis label" />`)
          .join('')}
        <div class="mm-compass__covers"></div>
        <p class="mm-compass__hint">Drag albums from the tray onto the compass. Where they go is up to you.</p>
      </div>
      <div class="mm-compass__tray">
        <div class="mm-compass__trayhead">
          <label class="sr-only" for="compass-filter">Filter albums</label>
          <input id="compass-filter" class="mm-compass__filter" type="search" placeholder="Filter by artist, album, genre or year" autocomplete="off" />
          <span class="mm-compass__count"></span>
          <button type="button" class="mm-btn mm-btn--small" data-c="export">Save as image</button>
          <button type="button" class="mm-link mm-small" data-c="clear">Clear</button>
        </div>
        <div class="mm-compass__list" role="list"></div>
      </div>`;
    this.field = this.root.querySelector('.mm-compass__field')!;
    this.tray = this.root.querySelector('.mm-compass__tray')!;
    const title = this.root.querySelector<HTMLInputElement>('.mm-compass__title')!;
    title.value = this.state.title;
    title.addEventListener('change', () => {
      this.state.title = title.value.trim() || DEFAULT.title;
      save(this.state);
    });
    this.root.querySelectorAll<HTMLInputElement>('.mm-compass__label').forEach((inp) => {
      const side = inp.dataset.axis as keyof CompassState['axes'];
      inp.value = this.state.axes[side];
      inp.addEventListener('change', () => {
        this.state.axes[side] = inp.value.trim() || DEFAULT.axes[side];
        save(this.state);
      });
    });
    this.root.querySelector<HTMLInputElement>('#compass-filter')!.addEventListener('input', (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTray();
    });
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-c]')?.dataset.c;
      if (act === 'export') void this.exportImage();
      if (act === 'clear' && Object.keys(this.state.placed).length && confirm('Move every album back to the tray?')) {
        this.state.placed = {};
        save(this.state);
        this.render();
      }
    });
  }

  private render(): void {
    this.renderCovers();
    this.renderTray();
  }

  private cover(it: CompassItem, placed: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mm-compass__cov${placed ? ' is-placed' : ''}`;
    b.dataset.key = it.key;
    b.title = `${it.title} · ${it.artist}`;
    b.setAttribute('aria-label', `${it.title} by ${it.artist}${placed ? '. Placed. Arrow keys move it, Delete returns it to the tray, Enter opens its history.' : '. In the tray. Press Enter to place it in the middle.'}`);
    b.innerHTML = `<img src="${h(it.cover)}" alt="" draggable="false" crossorigin="anonymous" />${placed ? `<span class="mm-compass__name">${h(it.title)}</span>` : ''}`;
    this.bindDrag(b, it);
    b.addEventListener('keydown', (e) => this.onKey(e, it));
    return b;
  }

  private renderCovers(): void {
    const box = this.root.querySelector('.mm-compass__covers')!;
    box.innerHTML = '';
    const byKey = new Map(this.items.map((i) => [i.key, i]));
    for (const [key, p] of Object.entries(this.state.placed)) {
      const it = byKey.get(key);
      if (!it) continue;
      const b = this.cover(it, true);
      this.position(b, p);
      box.appendChild(b);
    }
    this.root.querySelector<HTMLElement>('.mm-compass__hint')!.hidden = Object.keys(this.state.placed).length > 0;
  }

  private renderTray(): void {
    const list = this.root.querySelector('.mm-compass__list')!;
    const q = this.filter;
    const waiting = this.items.filter((i) => !this.state.placed[i.key]);
    const shown = q
      ? waiting.filter((i) => [i.title, i.artist, ...i.genres, ...i.years].some((v) => v.toLowerCase().includes(q)))
      : waiting;
    list.innerHTML = '';
    shown.slice(0, 400).forEach((it) => {
      const b = this.cover(it, false);
      b.setAttribute('role', 'listitem');
      list.appendChild(b);
    });
    this.root.querySelector('.mm-compass__count')!.textContent = `${shown.length} album${shown.length === 1 ? '' : 's'}${q ? ' match' : ' to place'}`;
  }

  /** x and y run from -1 to 1; the axes cross at 0, 0. */
  private position(el: HTMLElement, p: { x: number; y: number }): void {
    el.style.left = `${50 + p.x * 46}%`;
    el.style.top = `${50 + p.y * 44}%`;
  }

  private place(key: string, p: { x: number; y: number } | null): void {
    if (p) this.state.placed[key] = { x: clamp(p.x), y: clamp(p.y) };
    else delete this.state.placed[key];
    save(this.state);
    this.render();
  }

  private fieldPoint(cx: number, cy: number): { x: number; y: number } | null {
    const r = this.field.getBoundingClientRect();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
    return { x: ((cx - r.left) / r.width * 100 - 50) / 46, y: ((cy - r.top) / r.height * 100 - 50) / 44 };
  }

  /** Drag from the tray onto the compass, around the compass, or back to the tray. */
  private bindDrag(el: HTMLElement, it: CompassItem): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      let ghost: HTMLElement | null = null;
      const move = (ev: PointerEvent) => {
        if (!ghost && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        if (!ghost) {
          ghost = el.cloneNode(true) as HTMLElement;
          ghost.classList.add('is-ghost');
          document.body.appendChild(ghost);
          el.classList.add('is-lifting');
          this.root.classList.add('is-dragging');
        }
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%) rotate(-2deg)`;
        this.tray.classList.toggle('is-target', this.overTray(ev.clientX, ev.clientY));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.root.classList.remove('is-dragging');
        this.tray.classList.remove('is-target');
        el.classList.remove('is-lifting');
        if (!ghost) {
          // A click: placed albums open their history; tray albums jump to the middle.
          if (this.state.placed[it.key]) this.onOpen(it.trackId);
          else this.place(it.key, { x: (Math.random() - 0.5) * 0.9, y: (Math.random() - 0.5) * 0.9 });
          return;
        }
        ghost.remove();
        if (this.overTray(ev.clientX, ev.clientY)) return this.place(it.key, null);
        const p = this.fieldPoint(ev.clientX, ev.clientY);
        if (p) this.place(it.key, p);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  private overTray(x: number, y: number): boolean {
    const r = this.tray.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  private onKey(e: KeyboardEvent, it: CompassItem): void {
    const p = this.state.placed[it.key];
    if (!p) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.place(it.key, { x: 0, y: 0 });
        this.focusKey(it.key);
      }
      return;
    }
    const step = e.shiftKey ? 0.2 : 0.05;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      this.place(it.key, { x: p.x + moves[e.key][0], y: p.y + moves[e.key][1] });
      this.focusKey(it.key);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.place(it.key, null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.onOpen(it.trackId);
    }
  }

  private focusKey(key: string): void {
    this.root.querySelector<HTMLElement>(`.mm-compass__covers [data-key="${CSS.escape(key)}"]`)?.focus();
  }

  /** Draws the compass as a square image you can post or print. */
  private async exportImage(): Promise<void> {
    const S = 1600;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const css = getComputedStyle(this.root);
    const font = css.getPropertyValue('--font').trim() || 'sans-serif';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(124, 108, 214, 0.18)';
    for (let i = 0; i <= S; i += 40) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, S);
      g.moveTo(0, i);
      g.lineTo(S, i);
      g.stroke();
    }
    g.fillStyle = '#17151f';
    g.textAlign = 'center';
    g.font = `800 64px ${font}`;
    g.fillText(this.state.title, S / 2, 110);
    const top = 190;
    const bottom = S - 80;
    const cx = S / 2;
    const cy = (top + bottom) / 2;
    g.strokeStyle = '#17151f';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(80, cy);
    g.lineTo(S - 80, cy);
    g.moveTo(cx, top);
    g.lineTo(cx, bottom);
    g.stroke();
    g.font = `700 40px ${font}`;
    g.fillStyle = '#f2560f';
    g.fillText(this.state.axes.top, cx, top - 18);
    g.fillText(this.state.axes.bottom, cx, bottom + 52);
    g.save();
    g.translate(48, cy);
    g.rotate(-Math.PI / 2);
    g.fillText(this.state.axes.left, 0, 0);
    g.restore();
    g.save();
    g.translate(S - 48, cy);
    g.rotate(Math.PI / 2);
    g.fillText(this.state.axes.right, 0, 0);
    g.restore();
    const byKey = new Map(this.items.map((i) => [i.key, i]));
    const size = 150;
    const w = (S - 160) / 2;
    const hgt = (bottom - top) / 2;
    for (const [key, p] of Object.entries(this.state.placed)) {
      const it = byKey.get(key);
      if (!it) continue;
      const img = await loadImage(it.cover).catch(() => null);
      const x = cx + p.x * w * 0.92 - size / 2;
      const y = cy + p.y * hgt * 0.92 - size / 2;
      g.fillStyle = '#17151f';
      g.fillRect(x - 2, y - 2, size + 4, size + 4);
      if (img) g.drawImage(img, x, y, size, size);
    }
    try {
      const url = c.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.state.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'compass'}.png`;
      a.click();
    } catch {
      alert('This browser blocked saving the image because some covers come from another site. Try a screenshot instead.');
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function load(): CompassState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s?.axes && s.placed) return { ...DEFAULT, ...s, axes: { ...DEFAULT.axes, ...s.axes } };
  } catch {
    /* start fresh */
  }
  return structuredClone(DEFAULT);
}

function save(s: CompassState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked */
  }
}
