/**
 * 3D affine transforms used to flatten block references and OCS entities onto the WCS XY plane.
 *
 *   x' = m0·x + m1·y + m2·z  + m3
 *   y' = m4·x + m5·y + m6·z  + m7
 *   z' = m8·x + m9·y + m10·z + m11
 *
 * `null` stands for the identity throughout, so untransformed top-level 2D entities keep their
 * coordinates bit-exact.
 */
export class Xform {
  private scaleMemo = -1;
  private similarMemo = -1;

  constructor(
    readonly m0: number,
    readonly m1: number,
    readonly m2: number,
    readonly m3: number,
    readonly m4: number,
    readonly m5: number,
    readonly m6: number,
    readonly m7: number,
    readonly m8: number,
    readonly m9: number,
    readonly m10: number,
    readonly m11: number,
  ) {}

  /** Determinant of the XY linear part (negative = mirrored). */
  get det2(): number {
    return this.m0 * this.m5 - this.m4 * this.m1;
  }

  /** True when the XY linear part is a similarity (rotation + uniform scale, possibly mirrored). */
  get similar(): boolean {
    if (this.similarMemo < 0) {
      const l1 = this.m0 * this.m0 + this.m4 * this.m4;
      const l2 = this.m1 * this.m1 + this.m5 * this.m5;
      const tol = 1e-9 * Math.max(l1, l2);
      const dot = this.m0 * this.m1 + this.m4 * this.m5;
      this.similarMemo = l1 > 0 && Math.abs(l1 - l2) <= tol && Math.abs(dot) <= tol ? 1 : 0;
    }
    return this.similarMemo === 1;
  }

  /** Mean XY scale factor sqrt(|det2|). */
  get scale(): number {
    if (this.scaleMemo < 0) this.scaleMemo = Math.sqrt(Math.abs(this.det2));
    return this.scaleMemo;
  }

  x(x: number, y: number, z: number): number {
    return this.m0 * x + this.m1 * y + this.m2 * z + this.m3;
  }

  y(x: number, y: number, z: number): number {
    return this.m4 * x + this.m5 * y + this.m6 * z + this.m7;
  }

  z(x: number, y: number, z: number): number {
    return this.m8 * x + this.m9 * y + this.m10 * z + this.m11;
  }

  vx(x: number, y: number, z: number): number {
    return this.m0 * x + this.m1 * y + this.m2 * z;
  }

  vy(x: number, y: number, z: number): number {
    return this.m4 * x + this.m5 * y + this.m6 * z;
  }

  vz(x: number, y: number, z: number): number {
    return this.m8 * x + this.m9 * y + this.m10 * z;
  }

  /** this ∘ b (b applied first). */
  mul(b: Xform): Xform {
    return new Xform(
      this.m0 * b.m0 + this.m1 * b.m4 + this.m2 * b.m8,
      this.m0 * b.m1 + this.m1 * b.m5 + this.m2 * b.m9,
      this.m0 * b.m2 + this.m1 * b.m6 + this.m2 * b.m10,
      this.m0 * b.m3 + this.m1 * b.m7 + this.m2 * b.m11 + this.m3,
      this.m4 * b.m0 + this.m5 * b.m4 + this.m6 * b.m8,
      this.m4 * b.m1 + this.m5 * b.m5 + this.m6 * b.m9,
      this.m4 * b.m2 + this.m5 * b.m6 + this.m6 * b.m10,
      this.m4 * b.m3 + this.m5 * b.m7 + this.m6 * b.m11 + this.m7,
      this.m8 * b.m0 + this.m9 * b.m4 + this.m10 * b.m8,
      this.m8 * b.m1 + this.m9 * b.m5 + this.m10 * b.m9,
      this.m8 * b.m2 + this.m9 * b.m6 + this.m10 * b.m10,
      this.m8 * b.m3 + this.m9 * b.m7 + this.m10 * b.m11 + this.m11,
    );
  }

  /** Same linear part, translation moved by (dx, dy, dz). */
  translated(dx: number, dy: number, dz: number): Xform {
    return new Xform(
      this.m0,
      this.m1,
      this.m2,
      this.m3 + dx,
      this.m4,
      this.m5,
      this.m6,
      this.m7 + dy,
      this.m8,
      this.m9,
      this.m10,
      this.m11 + dz,
    );
  }

  static identity(): Xform {
    return new Xform(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
  }

  static translate(x: number, y: number, z: number): Xform {
    return new Xform(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z);
  }

  static scale(sx: number, sy: number, sz: number): Xform {
    return new Xform(sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0);
  }

  /** Rotation about Z by `rad` radians; exact for multiples of 90°. */
  static rotateZ(rad: number): Xform | null {
    if (!rad) return null;
    const q = rad / (Math.PI / 2);
    const k = Math.round(q);
    if (Math.abs(q - k) < 1e-12) {
      const r = ((k % 4) + 4) % 4;
      if (r === 0) return null;
      const c = [1, 0, -1, 0][r];
      const s = [0, 1, 0, -1][r];
      return new Xform(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0);
    }
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Xform(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0);
  }
}

/** a ∘ b with null = identity. */
export function compose(a: Xform | null, b: Xform | null): Xform | null {
  if (!a) return b;
  if (!b) return a;
  return a.mul(b);
}

const ARBITRARY_AXIS_LIMIT = 1 / 64;
const ocsMemo = new Map<string, Xform | null>();

/**
 * OCS → WCS transform for an extrusion vector (AutoCAD arbitrary axis algorithm). Returns null for
 * the default extrusion (0, 0, 1), for missing and for degenerate (zero-length) vectors.
 */
export function ocsXform(n: { x?: number; y?: number; z?: number } | null | undefined): Xform | null {
  if (!n) return null;
  let nx = Number(n.x) || 0;
  let ny = Number(n.y) || 0;
  let nz = Number(n.z) || 0;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-12) || !Number.isFinite(l)) return null;
  nx /= l;
  ny /= l;
  nz /= l;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null;
  const key = `${nx},${ny},${nz}`;
  const hit = ocsMemo.get(key);
  if (hit !== undefined) return hit;
  let ax: number;
  let ay: number;
  let az: number;
  if (Math.abs(nx) < ARBITRARY_AXIS_LIMIT && Math.abs(ny) < ARBITRARY_AXIS_LIMIT) {
    // Ax = Wy × N
    ax = nz;
    ay = 0;
    az = -nx;
  } else {
    // Ax = Wz × N
    ax = -ny;
    ay = nx;
    az = 0;
  }
  const la = Math.hypot(ax, ay, az);
  ax /= la;
  ay /= la;
  az /= la;
  // Ay = N × Ax
  let bx = ny * az - nz * ay;
  let by = nz * ax - nx * az;
  let bz = nx * ay - ny * ax;
  const lb = Math.hypot(bx, by, bz);
  bx /= lb;
  by /= lb;
  bz /= lb;
  const x = new Xform(ax, bx, nx, 0, ay, by, ny, 0, az, bz, nz, 0);
  if (ocsMemo.size < 1024) ocsMemo.set(key, x);
  return x;
}

/** Unit normal of an extrusion vector, (0, 0, 1) when missing or degenerate. */
export function unitNormal(
  n: { x?: number; y?: number; z?: number } | null | undefined,
): [number, number, number] {
  const nx = Number(n?.x) || 0;
  const ny = Number(n?.y) || 0;
  const nz = Number(n?.z) || 0;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-12) || !Number.isFinite(l)) return [0, 0, 1];
  return [nx / l, ny / l, nz / l];
}
