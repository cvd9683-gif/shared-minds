// ------------------------------------------------
// Puppet: a visible stand-in for a person's mouse and
// keyboard, used by the guided examples. It sends ordinary
// pointer and key events, so everything it does goes
// through the real tool: recording, dragging, typing.
// Only the hand on the mouse is pretend.
// ------------------------------------------------

const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const frame = () => new Promise(r => requestAnimationFrame(r));

export class Puppet {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'puppet';
    this.el.hidden = true;
    this.el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8.5-6.2 1.3L10 19z"/></svg><span class="puppet-ring"></span>';
    this.key = document.createElement('div');
    this.key.className = 'puppet-key';
    this.key.hidden = true;
    document.body.append(this.el, this.key);
    this.x = innerWidth / 2; this.y = innerHeight / 2;
    this.cancelled = () => false;
  }

  check() { if (this.cancelled()) throw new Error('cancelled'); }
  show() { this.el.hidden = false; this.place(); }
  hide() { this.el.hidden = true; this.key.hidden = true; }
  place() { this.el.style.transform = `translate(${this.x}px, ${this.y}px)`; }

  send(type, x, y, target) {
    const t = target || document.elementFromPoint(x, y) || document.body;
    t.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    return t;
  }

  // glide to a point; hover events go out along the way
  async moveTo(x, y, ms = 650, target = null) {
    this.show();
    const x0 = this.x, y0 = this.y, t0 = performance.now();
    for (;;) {
      this.check();
      const k = Math.min(1, (performance.now() - t0) / ms);
      this.x = x0 + (x - x0) * ease(k); this.y = y0 + (y - y0) * ease(k);
      this.place();
      this.send('pointermove', this.x, this.y, target || document.body);
      if (k >= 1) return;
      await frame();
    }
  }

  center(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }

  async click(el) {
    const [x, y] = this.center(el);
    await this.moveTo(x, y);
    this.pulse();
    const t = this.send('pointerdown', x, y);
    this.send('pointerup', x, y, t);
    t.click();
    await this.pause(250);
  }

  async clickAt(x, y) {
    await this.moveTo(x, y);
    this.pulse();
    const t = this.send('pointerdown', x, y);
    this.send('pointerup', x, y, t);
    await this.pause(250);
  }

  // press, move, release on the element under the start point
  async drag(x0, y0, x1, y1, ms = 900) {
    await this.moveTo(x0, y0);
    this.pulse();
    const t = this.send('pointerdown', x0, y0);
    this.el.classList.add('is-down');
    const t0 = performance.now();
    for (;;) {
      this.check();
      const k = Math.min(1, (performance.now() - t0) / ms);
      this.x = x0 + (x1 - x0) * ease(k); this.y = y0 + (y1 - y0) * ease(k);
      this.place();
      this.send('pointermove', this.x, this.y, t);
      if (k >= 1) break;
      await frame();
    }
    this.send('pointerup', x1, y1, t);
    this.el.classList.remove('is-down');
    await this.pause(200);
  }

  // follow a path of {t, x, y} (ms from now, page coordinates) without pressing
  async perform(points) {
    this.show();
    const t0 = performance.now();
    const end = points[points.length - 1].t;
    for (;;) {
      this.check();
      const t = performance.now() - t0;
      let i = points.findIndex(p => p.t >= t);
      if (i < 0) i = points.length - 1;
      const a = points[Math.max(0, i - 1)], b = points[i];
      const k = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
      this.x = a.x + (b.x - a.x) * ease(k); this.y = a.y + (b.y - a.y) * ease(k);
      this.place();
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: this.x, clientY: this.y }));
      if (t >= end) return;
      await frame();
    }
  }

  async press(key, label) {
    this.key.hidden = false;
    this.key.innerHTML = '<kbd></kbd><span></span>';
    this.key.firstChild.textContent = key === ' ' ? 'Space' : key;
    this.key.lastChild.textContent = label || '';
    this.key.classList.remove('is-hit'); void this.key.offsetWidth; this.key.classList.add('is-hit');
    const target = document.body;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    await this.pause(700);
    this.key.hidden = true;
  }

  async type(input, text) {
    await this.click(input);
    input.focus();
    input.value = '';
    for (const ch of text) { this.check(); input.value += ch; await this.pause(42); }
    await this.pause(300);
    input.form.requestSubmit();
    await this.pause(200);
  }

  pulse() {
    const r = this.el.querySelector('.puppet-ring');
    r.classList.remove('is-on'); void r.offsetWidth; r.classList.add('is-on');
  }

  async pause(ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { this.check(); await frame(); }
  }
}
