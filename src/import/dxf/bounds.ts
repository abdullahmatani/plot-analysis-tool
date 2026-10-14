import { TAU, ccwSweep, normAngle } from '@/geometry/vec';

/** Mutable axis-aligned bounds accumulator (avoids allocations in hot loops). */
export class BBox {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  reset(): this {
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
    return this;
  }

  add(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** Circular arc CCW from a0 to a1 (radians); includes the axis extremes crossed by the arc. */
  addArc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const sweep = ccwSweep(a0, a1);
    this.add(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    this.add(cx + r * Math.cos(a0 + sweep), cy + r * Math.sin(a0 + sweep));
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      if (normAngle(a - a0) <= sweep)
        this.add(cx + (k === 0 ? r : k === 2 ? -r : 0), cy + (k === 1 ? r : k === 3 ? -r : 0));
    }
  }

  /** Arc segment of a polyline from (x0, y0) to (x1, y1) with bulge b (end points must be added separately). */
  addBulge(x0: number, y0: number, x1: number, y1: number, b: number): void {
    if (!b) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const chord = Math.hypot(dx, dy);
    if (chord === 0) return;
    const theta = 4 * Math.atan(b);
    const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
    const h = (chord / 2) * ((1 - b * b) / (2 * b));
    const ux = dx / chord;
    const uy = dy / chord;
    const cx = (x0 + x1) / 2 - uy * h;
    const cy = (y0 + y1) / 2 + ux * h;
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    if (b > 0) this.addArc(cx, cy, r, a0, a1);
    else this.addArc(cx, cy, r, a1, a0);
  }

  /**
   * Ellipse arc: centre, major axis (mx, my), ratio, params t0→t1 CCW. Minor axis = ratio × major
   * rotated +90°.
   */
  addEllipse(cx: number, cy: number, mx: number, my: number, ratio: number, t0: number, t1: number): void {
    const nx = -my * ratio;
    const ny = mx * ratio;
    let sweep = t1 - t0;
    const full = Math.abs(sweep) >= TAU - 1e-12;
    if (!full) sweep = ccwSweep(t0, t1);
    const pt = (t: number) =>
      this.add(cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t));
    pt(t0);
    pt(t0 + sweep);
    const tx = Math.atan2(nx, mx);
    const ty = Math.atan2(ny, my);
    for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) {
      if (full || normAngle(t - t0) <= sweep) pt(t);
    }
  }

  get valid(): boolean {
    return this.minX <= this.maxX && this.minY <= this.maxY;
  }
}
