// Music Map - Historical Timeline as a whole-library web
// Every album in the map, fanned around the artist it's credited to (a sunflower
// of covers per artist, like the network maps in the brief). Thin lines join
// artists to their albums; sampled and interpolated recordings arc between albums;
// people credited on other artists' work (producers, writers, features) reach
// across the web. Drawn on a 2D canvas so a large library stays smooth: scroll or
// pinch to zoom from the whole web down to single covers, drag to move.

export interface WebAlbum {
  id: string;
  trackIds: string[];
  title: string;
  artist: string;
  cover: string;
  outside: boolean;
  /** People credited as the artist (hub candidates), strongest first. */
  artistIds: string[];
  /** Other credited people (producers, writers…): drawn as links across the web. */
  creditIds: string[];
}
export interface WebPerson {
  id: string;
  name: string;
}
export interface WebLink {
  a: string;
  b: string;
  kind: 'samples' | 'interpolates' | 'other';
  /** A link that's not documented (disputed/unconfirmed) is drawn dashed. */
  uncertain: boolean;
}

export interface WebCallbacks {
  onSelect(kind: 'album' | 'person', id: string, rect: DOMRect): void;
  onHover(info: { title: string; sub: string; x: number; y: number } | null): void;
}

interface ANode {
  album: WebAlbum;
  x: number;
  y: number;
  s: number;
  hub: HNode;
}
interface HNode {
  person: WebPerson;
  x: number;
  y: number;
  r: number;
  albums: ANode[];
}

const EASE = (t: number) => 1 - Math.pow(1 - t, 3);

export class LibraryWeb {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: WebCallbacks;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private w = 800;
  private h = 600;
  private albums: ANode[] = [];
  private hubs: HNode[] = [];
  private byId = new Map<string, ANode>();
  private hubById = new Map<string, HNode>();
  private links: { a: ANode; b: ANode; kind: WebLink['kind']; uncertain: boolean }[] = [];
  private credits: { hub: HNode; album: ANode }[] = [];
  private images = new Map<string, HTMLImageElement>();
  private cam = { k: 1, tx: 0, ty: 0 };
  private goal = { k: 1, tx: 0, ty: 0 };
  private intro = 1;
  private introStart = 0;
  private hoverAlbum: ANode | null = null;
  private hoverHub: HNode | null = null;
  private raf: number | null = null;
  private reducedMotion = false;
  private visible = false;
  private fitted = false;

  constructor(canvas: HTMLCanvasElement, cb: WebCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.cb = cb;
    this.bind();
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.hidden = !v;
    if (v) {
      if (!this.fitted) this.fit(false);
      this.kick();
    }
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.kick();
  }

  // ---- Layout -----------------------------------------------------------------------

  setData(albums: WebAlbum[], people: WebPerson[], links: WebLink[]): void {
    const personById = new Map(people.map((p) => [p.id, p]));
    // Count albums per person so collaborations sit with the better-known artist.
    const count = new Map<string, number>();
    albums.forEach((a) => a.artistIds.forEach((id) => count.set(id, (count.get(id) ?? 0) + 1)));
    const hubMap = new Map<string, HNode>();
    const unknown: WebPerson = { id: '_unknown', name: 'Unknown artist' };
    this.albums = [];
    for (const album of albums) {
      const primary = [...album.artistIds].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0))[0];
      const person = (primary && personById.get(primary)) || unknown;
      let hub = hubMap.get(person.id);
      if (!hub) hubMap.set(person.id, (hub = { person, x: 0, y: 0, r: 0, albums: [] }));
      const node: ANode = { album, x: 0, y: 0, s: 26 + Math.min(3, album.trackIds.length - 1) * 7, hub };
      hub.albums.push(node);
      this.albums.push(node);
    }
    // Credited people with no albums of their own still get a small hub to link from.
    for (const album of albums)
      for (const id of album.creditIds) {
        const p = personById.get(id);
        if (p && !hubMap.has(id)) hubMap.set(id, { person: p, x: 0, y: 0, r: 0, albums: [] });
      }
    this.hubs = [...hubMap.values()];
    // Each artist's albums form a sunflower around their hub, covers overlapping a little.
    for (const hub of this.hubs) {
      hub.albums.forEach((n, i) => {
        const r = hub.albums.length === 1 ? 30 : 26 + 15 * Math.sqrt(i + 0.5);
        const a = i * 2.39996;
        n.x = Math.cos(a) * r;
        n.y = Math.sin(a) * r;
      });
      hub.r = hub.albums.length ? 30 + 15 * Math.sqrt(hub.albums.length) + 14 : 10;
    }
    this.packHubs(albums, links);
    for (const hub of this.hubs) for (const n of hub.albums) [n.x, n.y] = [n.x + hub.x, n.y + hub.y];
    this.byId = new Map(this.albums.map((n) => [n.album.id, n]));
    this.hubById = new Map(this.hubs.map((h) => [h.person.id, h]));
    this.links = links
      .map((l) => ({ a: this.byId.get(l.a)!, b: this.byId.get(l.b)!, kind: l.kind, uncertain: l.uncertain }))
      .filter((l) => l.a && l.b && l.a !== l.b);
    this.credits = [];
    for (const n of this.albums)
      for (const id of n.album.creditIds.slice(0, 6)) {
        const hub = this.hubById.get(id);
        if (hub && hub !== n.hub) this.credits.push({ hub, album: n });
      }
    for (const n of this.albums) this.loadImage(n.album.cover);
    // Everything grows out from the centre.
    this.intro = this.reducedMotion ? 1 : 0;
    this.introStart = performance.now();
    this.fitted = false;
    if (this.visible) this.fit(false);
    this.kick();
  }

  /**
   * Packs artist hubs into one cloud: a spiral start, a pull toward the centre,
   * springs between artists who share credits or sampled songs, no overlaps.
   */
  private packHubs(albums: WebAlbum[], links: WebLink[]): void {
    const hubs = [...this.hubs].sort((a, b) => b.r - a.r);
    const meanR = hubs.reduce((t, h) => t + h.r, 0) / Math.max(1, hubs.length);
    hubs.forEach((h, i) => {
      const a = i * 2.39996;
      const rad = Math.sqrt(i) * meanR * 1.7;
      h.x = Math.cos(a) * rad;
      h.y = Math.sin(a) * rad * 0.8;
    });
    const hubOfAlbum = new Map<string, HNode>();
    for (const h of this.hubs) for (const n of h.albums) hubOfAlbum.set(n.album.id, h);
    const byPerson = new Map(this.hubs.map((h) => [h.person.id, h]));
    const springs: [HNode, HNode][] = [];
    for (const al of albums) {
      const home = hubOfAlbum.get(al.id);
      if (!home) continue;
      for (const id of [...al.artistIds, ...al.creditIds]) {
        const other = byPerson.get(id);
        if (other && other !== home) springs.push([home, other]);
      }
    }
    for (const l of links) {
      const a = hubOfAlbum.get(l.a);
      const b = hubOfAlbum.get(l.b);
      if (a && b && a !== b) springs.push([a, b]);
    }
    const iterations = hubs.length > 400 ? 70 : 140;
    for (let it = 0; it < iterations; it++) {
      const cool = 1 - it / iterations;
      for (const h of hubs) {
        h.x -= h.x * 0.02 * cool;
        h.y -= h.y * 0.025 * cool;
      }
      for (const [a, b] of springs) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - (a.r + b.r + 20)) / d) * 0.03 * cool;
        a.x += dx * f;
        a.y += dy * f;
        b.x -= dx * f;
        b.y -= dy * f;
      }
      for (let i = 0; i < hubs.length; i++)
        for (let j = i + 1; j < hubs.length; j++) {
          const a = hubs[i];
          const b = hubs[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r + 6;
          if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d >= min) continue;
          const o = ((min - d) / d) * 0.5;
          a.x -= dx * o;
          a.y -= dy * o;
          b.x += dx * o;
          b.y += dy * o;
        }
    }
  }

  private loadImage(src: string): void {
    if (!src || this.images.has(src)) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => this.kick();
    img.src = src;
    this.images.set(src, img);
  }

  // ---- Camera ---------------------------------------------------------------------

  private bounds() {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const h of this.hubs) {
      x0 = Math.min(x0, h.x - h.r);
      x1 = Math.max(x1, h.x + h.r);
      y0 = Math.min(y0, h.y - h.r);
      y1 = Math.max(y1, h.y + h.r);
    }
    return isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -100, y0: -100, x1: 100, y1: 100 };
  }

  fit(animate = true): void {
    const b = this.bounds();
    const top = 60;
    const k = Math.max(0.05, Math.min(2, (this.w - 60) / (b.x1 - b.x0), (this.h - top - 40) / (b.y1 - b.y0)));
    this.goal = { k, tx: this.w / 2 - ((b.x0 + b.x1) / 2) * k, ty: top + (this.h - top - 40) / 2 - ((b.y0 + b.y1) / 2) * k };
    if (!animate || this.reducedMotion) this.cam = { ...this.goal };
    this.fitted = true;
    this.kick();
  }

  zoomBy(f: number, cx = this.w / 2, cy = this.h / 2): void {
    const k = Math.max(0.05, Math.min(6, this.goal.k * f));
    const r = k / this.goal.k;
    this.goal = { k, tx: cx - (cx - this.goal.tx) * r, ty: cy - (cy - this.goal.ty) * r };
    this.kick();
  }

  private panBy(dx: number, dy: number): void {
    this.goal.tx += dx;
    this.goal.ty += dy;
    this.cam.tx += dx;
    this.cam.ty += dy;
    this.kick();
  }

  /** Eases the camera onto one album (used when opening its focused web). */
  focusOn(albumId: string): DOMRect | null {
    const n = this.byId.get(albumId);
    if (!n) return null;
    const k = Math.max(this.goal.k, 2.2);
    this.goal = { k, tx: this.w * 0.55 - n.x * k, ty: this.h * 0.5 - n.y * k };
    this.kick();
    return this.rectOf(n);
  }

  private rectOf(n: ANode): DOMRect {
    const r = this.canvas.getBoundingClientRect();
    const s = n.s * this.cam.k;
    return new DOMRect(r.left + n.x * this.cam.k + this.cam.tx - s / 2, r.top + n.y * this.cam.k + this.cam.ty - s / 2, s, s);
  }

  // ---- Drawing --------------------------------------------------------------------

  private kick(): void {
    if (this.raf === null && this.visible) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = null;
    const c = this.cam;
    const g = this.goal;
    const e = this.reducedMotion ? 1 : 0.16;
    c.k += (g.k - c.k) * e;
    c.tx += (g.tx - c.tx) * e;
    c.ty += (g.ty - c.ty) * e;
    if (this.intro < 1) this.intro = Math.min(1, (performance.now() - this.introStart) / 1300);
    this.draw();
    const moving = Math.abs(g.k - c.k) > 0.0005 || Math.abs(g.tx - c.tx) > 0.3 || Math.abs(g.ty - c.ty) > 0.3 || this.intro < 1;
    if (moving) this.kick();
  }

  private draw(): void {
    const { ctx, cam } = this;
    const accent = getComputedStyle(this.canvas).getPropertyValue('--release').trim() || '#b0148c';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const p = EASE(this.intro);
    const pos = (n: { x: number; y: number }, hub?: { x: number; y: number }) => {
      const hx = hub ? hub.x * p : 0;
      const hy = hub ? hub.y * p : 0;
      return { x: (hx + (n.x - (hub?.x ?? 0)) * p) * cam.k + cam.tx, y: (hy + (n.y - (hub?.y ?? 0)) * p) * cam.k + cam.ty };
    };
    const hubPos = (h: HNode) => ({ x: h.x * p * cam.k + cam.tx, y: h.y * p * cam.k + cam.ty });
    const focusHub = this.hoverHub ?? this.hoverAlbum?.hub ?? null;
    const related = new Set<ANode>();
    if (this.hoverAlbum) {
      related.add(this.hoverAlbum);
      this.links.forEach((l) => (l.a === this.hoverAlbum ? related.add(l.b) : l.b === this.hoverAlbum && related.add(l.a)));
    }
    if (this.hoverHub) {
      this.hoverHub.albums.forEach((n) => related.add(n));
      this.credits.forEach((c) => c.hub === this.hoverHub && related.add(c.album));
    }
    const dim = related.size > 0;
    const margin = 80;
    const onScreen = (x: number, y: number) => x > -margin && x < this.w + margin && y > -margin && y < this.h + margin;

    // Fans: hub → album
    ctx.lineWidth = 0.7;
    for (const h of this.hubs) {
      const hp = hubPos(h);
      const hot = focusHub === h;
      ctx.strokeStyle = hot ? accent : 'rgba(26, 29, 51, 0.13)';
      ctx.globalAlpha = dim && !hot ? 0.35 : 1;
      ctx.beginPath();
      for (const n of h.albums) {
        const np = pos(n, h);
        if (!onScreen(np.x, np.y) && !onScreen(hp.x, hp.y)) continue;
        ctx.moveTo(hp.x, hp.y);
        ctx.lineTo(np.x, np.y);
      }
      ctx.stroke();
    }
    // Credits across the web (producers, writers, features)
    ctx.globalAlpha = 1;
    for (const c of this.credits) {
      const hot = focusHub === c.hub || related.has(c.album);
      if (dim && !hot) continue;
      const a = hubPos(c.hub);
      const b = pos(c.album, c.album.hub);
      ctx.strokeStyle = hot ? accent : 'rgba(26, 29, 51, 0.06)';
      ctx.lineWidth = hot ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // Samples and interpolations arc between albums
    for (const l of this.links) {
      const a = pos(l.a, l.a.hub);
      const b = pos(l.b, l.b.hub);
      const hot = related.has(l.a) && related.has(l.b);
      ctx.globalAlpha = dim && !hot ? 0.25 : 1;
      ctx.strokeStyle = l.kind === 'other' ? 'rgba(26, 29, 51, 0.45)' : accent;
      ctx.lineWidth = hot ? 2.2 : l.kind === 'samples' ? 1.4 : 1.1;
      ctx.setLineDash(l.kind === 'interpolates' || l.uncertain ? [5, 4] : []);
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.18;
      const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.18;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Covers
    for (const n of this.albums) {
      const np = pos(n, n.hub);
      const s = n.s * cam.k * (n === this.hoverAlbum ? 1.8 : 1);
      if (!onScreen(np.x, np.y)) continue;
      ctx.globalAlpha = (dim && !related.has(n) ? 0.22 : 1) * (n.album.outside ? 0.8 : 1);
      if (n === this.hoverAlbum) {
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 18;
      }
      const img = this.images.get(n.album.cover);
      if (img?.complete && img.naturalWidth) ctx.drawImage(img, np.x - s / 2, np.y - s / 2, s, s);
      else {
        ctx.fillStyle = '#e6e6e6';
        ctx.fillRect(np.x - s / 2, np.y - s / 2, s, s);
      }
      ctx.shadowBlur = 0;
      if (n.album.outside && s > 14) {
        ctx.strokeStyle = 'rgba(26,29,51,0.5)';
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1;
        ctx.strokeRect(np.x - s / 2 - 2, np.y - s / 2 - 2, s + 4, s + 4);
        ctx.setLineDash([]);
      }
    }
    // Hub dots and names (names appear as you zoom in; the biggest always show)
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const biggest = new Set([...this.hubs].sort((a, b) => b.albums.length - a.albums.length).slice(0, 12));
    for (const h of this.hubs) {
      const hp = hubPos(h);
      if (!onScreen(hp.x, hp.y)) continue;
      const hot = focusHub === h;
      ctx.globalAlpha = dim && !hot ? 0.4 : 1;
      ctx.fillStyle = hot ? accent : '#1a1d33';
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, hot ? 4.5 : 2.6, 0, Math.PI * 2);
      ctx.fill();
      const screenR = h.r * cam.k;
      if (hot || screenR > 60 || (biggest.has(h) && screenR > 26)) {
        ctx.font = `${hot ? 600 : 500} ${hot ? 13 : 11.5}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        const label = h.person.name;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(hp.x - tw / 2 - 4, hp.y - 20 - 8, tw + 8, 16);
        ctx.fillStyle = hot ? accent : '#1a1d33';
        ctx.fillText(label, hp.x, hp.y - 20);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- Input --------------------------------------------------------------------

  private toWorld(x: number, y: number) {
    return { x: (x - this.cam.tx) / this.cam.k, y: (y - this.cam.ty) / this.cam.k };
  }

  private hit(clientX: number, clientY: number): { album?: ANode; hub?: HNode } {
    const r = this.canvas.getBoundingClientRect();
    const w = this.toWorld(clientX - r.left, clientY - r.top);
    for (let i = this.albums.length - 1; i >= 0; i--) {
      const n = this.albums[i];
      const half = (n.s / 2) * (n === this.hoverAlbum ? 1.8 : 1) + 2 / this.cam.k;
      if (Math.abs(w.x - n.x) <= half && Math.abs(w.y - n.y) <= half) return { album: n };
    }
    for (const h of this.hubs) if (Math.hypot(w.x - h.x, w.y - h.y) < 9 / this.cam.k) return { hub: h };
    return {};
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0014)), e.clientX - r.left, e.clientY - r.top);
        else this.panBy(-e.deltaX, -e.deltaY);
      },
      { passive: false },
    );
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let moved = 0;
    let velocity = { x: 0, y: 0 };
    c.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      moved = 0;
      velocity = { x: 0, y: 0 };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        // Hover
        const { album, hub } = this.hit(e.clientX, e.clientY);
        if (album !== (this.hoverAlbum ?? undefined) || hub !== (this.hoverHub ?? undefined)) {
          this.hoverAlbum = album ?? null;
          this.hoverHub = hub ?? null;
          c.style.cursor = album || hub ? 'pointer' : 'grab';
          this.kick();
        }
        const r = c.getBoundingClientRect();
        if (album)
          this.cb.onHover({ title: album.album.title, sub: `${album.album.artist}${album.album.trackIds.length > 1 ? ` · ${album.album.trackIds.length} songs` : ''}`, x: e.clientX - r.left, y: e.clientY - r.top });
        else if (hub) this.cb.onHover({ title: hub.person.name, sub: `${hub.albums.length} album${hub.albums.length === 1 ? '' : 's'} here`, x: e.clientX - r.left, y: e.clientY - r.top });
        else this.cb.onHover(null);
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = c.getBoundingClientRect();
        if (pinch) this.zoomBy(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinch = d;
        moved += 10;
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      velocity = { x: dx, y: dy };
      if (moved > 4) {
        c.style.cursor = 'grabbing';
        this.panBy(dx, dy);
      }
    });
    const end = (e: PointerEvent) => {
      const was = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!was) return;
      if (moved <= 4) {
        const { album, hub } = this.hit(e.clientX, e.clientY);
        if (album) this.cb.onSelect('album', album.album.id, this.rectOf(album));
        else if (hub && hub.person.id !== '_unknown') this.cb.onSelect('person', hub.person.id, c.getBoundingClientRect());
      } else if (!this.reducedMotion) {
        // A little glide after a drag.
        this.goal.tx += velocity.x * 8;
        this.goal.ty += velocity.y * 8;
        this.kick();
      }
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hoverAlbum || this.hoverHub) {
        this.hoverAlbum = this.hoverHub = null;
        this.kick();
      }
      this.cb.onHover(null);
    });
  }
}
