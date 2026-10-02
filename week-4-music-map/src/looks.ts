// Music Map - Notebook looks, to compare on your own library before one is chosen.
// A look is a whole system: paper, ink, type and the way things move. Pick one with
// the switcher at the bottom of the Personal Timeline, or open the page with
// ?look=ruled | graph | sketch. The choice is remembered in this browser.

export type LookId = 'current' | 'ruled' | 'graph' | 'sketch';

export interface Look {
  id: LookId;
  name: string;
  line: string;
  /** Spring stiffness and damping for covers, and how far the lens pushes neighbours. */
  spring: { k: number; d: number };
  lens: number;
  /** Degrees of hand-placed tilt on each cover (straightens when you look closer). */
  tilt: number;
}

export const LOOKS: Look[] = [
  { id: 'current', name: 'Current', line: 'The look you have now.', spring: { k: 0.16, d: 0.74 }, lens: 0.95, tilt: 0 },
  {
    id: 'ruled',
    name: 'Composition book',
    line: 'Ruled school paper, a red margin, ballpoint ink and your own handwriting. Covers are taped in.',
    spring: { k: 0.14, d: 0.76 },
    lens: 0.9,
    tilt: 1.4,
  },
  {
    id: 'graph',
    name: 'Graph pad',
    line: 'A precise engineering pad: lilac grid, signal orange, measured type. Pages tear off at the perforation.',
    spring: { k: 0.24, d: 0.66 },
    lens: 0.85,
    tilt: 0,
  },
  {
    id: 'sketch',
    name: 'Black sketchbook',
    line: 'Black paper for listening at night: chalk lines, pastel marks, covers held in photo corners.',
    spring: { k: 0.1, d: 0.8 },
    lens: 1.05,
    tilt: 2.4,
  },
];

const KEY = 'musicMap:look';
let current: Look = LOOKS[0];
const listeners = new Set<(l: Look) => void>();

export function look(): Look {
  return current;
}

export function initLook(): void {
  const fromUrl = new URLSearchParams(location.search).get('look');
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  current = LOOKS.find((l) => l.id === fromUrl) ?? LOOKS.find((l) => l.id === saved) ?? LOOKS[0];
}

export function setLook(id: LookId): void {
  current = LOOKS.find((l) => l.id === id) ?? LOOKS[0];
  try {
    localStorage.setItem(KEY, current.id);
  } catch {
    /* storage blocked */
  }
  const url = new URL(location.href);
  if (current.id === 'current') url.searchParams.delete('look');
  else url.searchParams.set('look', current.id);
  history.replaceState(null, '', url);
  listeners.forEach((f) => f(current));
}

export function onLook(f: (l: Look) => void): void {
  listeners.add(f);
}

/** Looks dress the Personal Timeline only, for now; the Historical Timeline keeps its own style. */
export function applyLook(active: boolean): void {
  const root = document.documentElement;
  if (active && current.id !== 'current') root.dataset.look = current.id;
  else delete root.dataset.look;
}

/** The switcher: one row of named options, each with a one-line description on hover/focus. */
export function renderLookPicker(el: HTMLElement): void {
  el.innerHTML = `<span class="mm-looks__label">Notebook</span>${LOOKS.map(
    (l) =>
      `<button type="button" class="mm-looks__opt" data-look="${l.id}" aria-pressed="${l.id === current.id}" title="${l.line}">${l.name}</button>`,
  ).join('')}<p class="mm-looks__line" aria-live="polite">${current.line}</p>`;
}
