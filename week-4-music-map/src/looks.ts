// Music Map - How the Graph pad brand moves.
// Quick and exact: firm springs with little overshoot, and neighbours that step
// aside only as far as the album under the pointer grows.

export interface Look {
  spring: { k: number; d: number };
  /** How strongly neighbours make room around the album under the pointer. */
  lens: number;
  /** Degrees of hand-placed tilt on covers (0: the pad is precise). */
  tilt: number;
}

const GRAPH: Look = { spring: { k: 0.24, d: 0.66 }, lens: 0.85, tilt: 0 };

export function look(): Look {
  return GRAPH;
}
