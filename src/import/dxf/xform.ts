/**
 * 3D affine transforms for flattening block references and OCS entities to the XY plane.
 *
 *   x' = m0·x + m1·y + m2·z  + m3
 *   y' = m4·x + m5·y + m6·z  + m7
 *   z' = m8·x + m9·y + m10·z + m11
 *
 * Stored as plain number fields (cheap to allocate: nested block arrays create one per cell).
 * `null` is used throughout for the identity so the common case (top-level 2D entities with the
 * default extrusion) keeps coordinates bit-exact and avoids any arithmetic.
 */
export class Xform {
  private scaleCache = -1;
  private similarCache = -1;

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

  /** Determinant of the XY linear part (sign < 0 = mirrored). */
  get det2(): number {
    return this.m0 * this.m5 - this.m4 * this.m1;
  }

  /** True when the XY linear part is a similarity (uniform scale + rotation, possibly mirrored). */
  get similar(): boolean {
    if (this.similarCache < 0) {
      const a = this.m0;
      const b = this.m4;
      const c = this.m1;
      const d = this.m5;
      const l1 = a * a + b * b;
      const l2 = c * c + d * d;
      const tol = 1e-9 * Math.max(l1, l2);
      this.similarCache = Math.abs(l1 - l2) <= tol && Math.abs(a * c + b * d) <= tol && l1 > 0 ? 1 : 0;
    }
    return this.similarCache === 1;
  }

  /** Mean XY scale factor, sqrt(|det2|). */
  get scale(): number {
    if (this.scaleCache < 0) this.scaleCache = Math.sqrt(Math.abs(this.det2));
    return this.scaleCache;
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

  /** Linear part applied to a vector (x component). */
  vx(x: number, y: number, z: number): number {
    return this.m0 * x + this.m1 * y + this.m2 * z;
  }

  vy(x: number, y: number, z: number): number {
    return this.m4 * x + this.m5 * y + this.m6 * z;
  }

  vz(x: number, y: number, z: number): number {
    return this.m8 * x + this.m9 * y + this.m10 * z;
  }

  /** this ∘ b (b is applied first). */
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

  static identity(): Xform {
    return new Xform(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
  }

  static translate(x: number, y: number, z: number): Xform {
    return new Xform(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z);
  }

  static scale(sx: number, sy: number, sz: number): Xform {
    return new Xform(sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0);
  }

  /** Rotation about Z (cosine and sine given, so callers can pass exact values for multiples of 90°). */
  static rotateZ(c: number, s: number): Xform {
    return new Xform(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0);
  }
}

/** Composes two optional transforms (null = identity): returns a ∘ b. */
export function compose(a: Xform | null, b: Xform | null): Xform | null {
  if (!a) return b;
  if (!b) return a;
  return a.mul(b);
}

const ARBITRARY_AXIS_LIMIT = 1 / 64;
const ocsCache = new Map<string, Xform | null>();

/**
 * OCS → WCS transform for an extrusion (normal) vector using the AutoCAD arbitrary axis algorithm.
 * Returns null for the default extrusion (0, 0, 1) and for degenerate vectors.
 */
export function ocsXform(nx: number, ny: number, nz: number): Xform | null {
  if (nx === 0 && ny === 0 && nz > 0) return null;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-12) || !Number.isFinite(l)) return null;
  nx /= l;
  ny /= l;
  nz /= l;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null;
  const key = `${nx},${ny},${nz}`;
  const hit = ocsCache.get(key);
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
  if (ocsCache.size < 1024) ocsCache.set(key, x);
  return x;
}
