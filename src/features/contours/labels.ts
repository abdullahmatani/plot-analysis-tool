import type { Pt } from '@/core/types';

/**
 * Contour label placement (row 70): label at the top of the ring, at its centre or via a leader,
 * with greedy screen-space collision avoidance — each label tries its preferred position, then
 * alternatives (other sides of the ring, other leader directions); a label that collides with every
 * candidate is not drawn. Pure: the canvas overlay and the export scene builder both use it with
 * their own world→screen/paper transform and text measurer.
 */

export type ContourLabelPlacement = 'top' | 'centre' | 'leader';

export interface LabelInput {
  /** Caller's id (e.g. ring index). */
  id: number;
  text: string;
  /** Ring centre and "radius" in screen units (for squares/rectangles: half the larger extent). */
  centre: Pt;
  r: number;
  placement: ContourLabelPlacement;
  /** Text height (screen units); default `LayoutOptions.height`. */
  height?: number;
}

export interface PlacedLabel {
  id: number;
  text: string;
  /** Text anchor point (screen) with alignment and baseline. */
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
  baseline: 'top' | 'middle' | 'bottom';
  /** Occupied box (screen). */
  box: Box;
  /** Leader from the ring (a) to the label (b). */
  leader?: { a: Pt; b: Pt };
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutOptions {
  /** Text height in screen units. */
  height: number;
  /** Gap between ring and label, and padding around boxes. */
  gap?: number;
  /** Leader length. */
  leaderLength?: number;
  /** Only labels intersecting this box are placed (and they must fit inside it). */
  viewport?: Box;
  /** Stop after this many placed labels. */
  maxLabels?: number;
}

interface Candidate {
  x: number;
  y: number;
  align: PlacedLabel['align'];
  baseline: PlacedLabel['baseline'];
  leader?: { a: Pt; b: Pt };
}

const LEADER_ANGLES = [45, 135, -45, -135, 90, -90, 0, 180].map((d) => (d * Math.PI) / 180);

function candidates(l: LabelInput, h: number, gap: number, leaderLen: number): Candidate[] {
  const { x, y } = l.centre;
  const r = l.r;
  switch (l.placement) {
    case 'centre':
      return [
        { x, y, align: 'center', baseline: 'middle' },
        { x, y: y - h * 1.1, align: 'center', baseline: 'middle' },
        { x, y: y + h * 1.1, align: 'center', baseline: 'middle' },
      ];
    case 'leader':
      return LEADER_ANGLES.map((a) => {
        const dx = Math.cos(a);
        const dy = -Math.sin(a); // screen y grows downwards
        const pa = { x: x + dx * r, y: y + dy * r };
        const pb = { x: pa.x + dx * leaderLen, y: pa.y + dy * leaderLen };
        const align: Candidate['align'] = Math.abs(dx) < 0.2 ? 'center' : dx > 0 ? 'left' : 'right';
        const baseline: Candidate['baseline'] = Math.abs(dy) < 0.2 ? 'middle' : dy < 0 ? 'bottom' : 'top';
        const off = align === 'left' ? 2 : align === 'right' ? -2 : 0;
        return { x: pb.x + off, y: pb.y, align, baseline, leader: { a: pa, b: pb } };
      });
    default:
      return [
        { x, y: y - r - gap, align: 'center', baseline: 'bottom' },
        { x, y: y + r + gap, align: 'center', baseline: 'top' },
        { x: x + r + gap, y, align: 'left', baseline: 'middle' },
        { x: x - r - gap, y, align: 'right', baseline: 'middle' },
      ];
  }
}

function boxOf(c: Candidate, w: number, h: number, pad: number): Box {
  const x0 = c.align === 'left' ? c.x : c.align === 'right' ? c.x - w : c.x - w / 2;
  const y0 = c.baseline === 'top' ? c.y : c.baseline === 'bottom' ? c.y - h : c.y - h / 2;
  return { x0: x0 - pad, y0: y0 - pad, x1: x0 + w + pad, y1: y0 + h + pad };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** Uniform-grid spatial hash of placed boxes. */
class BoxGrid {
  private cells = new Map<number, Box[]>();
  constructor(private size: number) {}
  private *keys(b: Box): Generator<number> {
    const s = this.size;
    const i0 = Math.floor(b.x0 / s);
    const i1 = Math.floor(b.x1 / s);
    const j0 = Math.floor(b.y0 / s);
    const j1 = Math.floor(b.y1 / s);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) yield i * 73856093 + j * 19349663;
  }
  hits(b: Box): boolean {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) for (const o of list) if (overlaps(o, b)) return true;
    }
    return false;
  }
  add(b: Box) {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) list.push(b);
      else this.cells.set(k, [b]);
    }
  }
}

/**
 * Greedy placement in input order (callers sort by priority). Labels with the same text at the
 * same centre are placed once.
 */
export function layoutLabels(
  inputs: LabelInput[],
  measure: (text: string, height: number) => number,
  opts: LayoutOptions,
): PlacedLabel[] {
  const vp = opts.viewport;
  const max = opts.maxLabels ?? Infinity;
  const grid = new BoxGrid(Math.max(16, opts.height * 4));
  const placed: PlacedLabel[] = [];
  const seen = new Set<string>();
  const widths = new Map<string, number>();
  for (const l of inputs) {
    if (placed.length >= max) break;
    if (!l.text) continue;
    const h = l.height ?? opts.height;
    const gap = opts.gap ?? Math.max(2, h * 0.25);
    const pad = Math.max(1, h * 0.12);
    const leaderLen = opts.leaderLength ?? h * 1.6;
    if (vp) {
      // Skip rings whose label area cannot be on screen.
      const reach = l.r + leaderLen + h * 20;
      if (l.centre.x + reach < vp.x0 || l.centre.x - reach > vp.x1) continue;
      if (l.centre.y + reach < vp.y0 || l.centre.y - reach > vp.y1) continue;
    }
    const dupKey = `${Math.round(l.centre.x)},${Math.round(l.centre.y)},${Math.round(l.r)}|${l.text}`;
    if (seen.has(dupKey)) continue;
    const wKey = `${h}|${l.text}`;
    let w = widths.get(wKey);
    if (w === undefined) {
      w = measure(l.text, h);
      widths.set(wKey, w);
    }
    for (const c of candidates(l, h, gap, leaderLen)) {
      const box = boxOf(c, w, h, pad);
      if (vp && (box.x0 < vp.x0 || box.x1 > vp.x1 || box.y0 < vp.y0 || box.y1 > vp.y1)) continue;
      if (grid.hits(box)) continue;
      grid.add(box);
      seen.add(dupKey);
      placed.push({
        id: l.id,
        text: l.text,
        x: c.x,
        y: c.y,
        align: c.align,
        baseline: c.baseline,
        box,
        ...(c.leader ? { leader: c.leader } : {}),
      });
      break;
    }
  }
  return placed;
}
