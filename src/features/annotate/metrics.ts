import type { Pt, Style } from '@/core/types';
import { fontFamily, labelHeightPx } from '@/features/objects/style';

/** Text measurement for annotation layout and hit-testing (screen pixels). */

let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function measureCtx() {
  if (!ctx) {
    const c =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  }
  return ctx;
}

export interface TextBox {
  /** Width and height of the text block in px. */
  w: number;
  h: number;
  /** Font size and line height in px. */
  size: number;
  lineH: number;
}

export function textBoxPx(text: string, s: Style, scale: number): TextBox {
  const size = labelHeightPx(s, scale);
  const lines = text.split('\n');
  const lineH = size * 1.25;
  const c = measureCtx();
  let w = 0;
  if (c) {
    c.font = `${s.labelBold ? 700 : 400} ${size}px ${fontFamily(s.labelFont)}`;
    for (const l of lines) w = Math.max(w, c.measureText(l).width);
  } else {
    w = Math.max(...lines.map((l) => l.length)) * size * 0.55;
  }
  return { w, h: lineH * lines.length, size, lineH };
}

/** Offset of world point `p` from `anchor` in screen-aligned pixels (x right, y down). */
export function screenDelta(p: Pt, anchor: Pt, scale: number, rotation: number): Pt {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  return { x: scale * (c * dx - s * dy), y: -scale * (s * dx + c * dy) };
}

/** Distance in px from a point to an axis-aligned box (0 inside). */
export function distToBox(p: Pt, x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.max(x0 - p.x, 0, p.x - x1);
  const dy = Math.max(y0 - p.y, 0, p.y - y1);
  return Math.hypot(dx, dy);
}
