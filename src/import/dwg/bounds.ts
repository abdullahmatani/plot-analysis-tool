import { TAU } from '@/geometry/vec';

/** Mutable bounding box with exact extents for arcs, ellipses and bulge segments. */
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

  add(x: number, y: number) {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** Arc running counter-clockwise from a0 to a1 (radians). */
  addArc(cx: number, cy: number, r: number, a0: number, a1: number) {
    this.add(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    this.add(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
    let sweep = a1 - a0;
    while (sweep < 0) sweep += TAU;
    if (sweep === 0) sweep = TAU;
    // Axis crossings (0, 90, 180, 270°) inside the sweep.
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      let d = a - a0;
      d -= Math.floor(d / TAU) * TAU;
      if (d <= sweep) this.add(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }

  /** Ellipse c + M·cos t + N·sin t (N = ratio · perp(M)) for t from t0 to t1 (t1 > t0). */
  addEllipse(cx: number, cy: number, mx: number, my: number, ratio: number, t0: number, t1: number) {
    const nx = -my * ratio;
    const ny = mx * ratio;
    const at = (t: number) =>
      this.add(cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t));
    at(t0);
    at(t1);
    // Extremes in x: dx/dt = -mx sin t + nx cos t = 0 → t = atan2(nx, mx) (+π); same for y.
    const tx = Math.atan2(nx, mx);
    const ty = Math.atan2(ny, my);
    for (const base of [tx, tx + Math.PI, ty, ty + Math.PI]) {
      let d = base - t0;
      d -= Math.floor(d / TAU) * TAU;
      if (t0 + d <= t1) at(t0 + d);
    }
  }

  /** Straight or bulged segment from (x0, y0) to (x1, y1); the start point is assumed added. */
  addBulge(x0: number, y0: number, x1: number, y1: number, b: number) {
    this.add(x1, y1);
    if (!b) return;
    const chord = Math.hypot(x1 - x0, y1 - y0);
    if (chord === 0) return;
    const theta = 4 * Math.atan(b);
    const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
    const h = (chord / 2) * ((1 - b * b) / (2 * b));
    const ux = (x1 - x0) / chord;
    const uy = (y1 - y0) / chord;
    const cx = (x0 + x1) / 2 - uy * h;
    const cy = (y0 + y1) / 2 + ux * h;
    const s = Math.atan2(y0 - cy, x0 - cx);
    const e = Math.atan2(y1 - cy, x1 - cx);
    if (b > 0) this.addArc(cx, cy, r, s, e);
    else this.addArc(cx, cy, r, e, s);
  }
}
