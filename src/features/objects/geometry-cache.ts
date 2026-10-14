import type { Bounds, Geometry } from '@/core/types';
import { bounds } from '@/geometry/measure';

const cache = new WeakMap<Geometry, Bounds>();

/** Bounds of a geometry, cached by identity (Immer keeps unchanged geometry objects identical). */
export function geomBounds(g: Geometry): Bounds {
  let b = cache.get(g);
  if (!b) {
    b = bounds(g);
    cache.set(g, b);
  }
  return b;
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function expand(b: Bounds, d: number): Bounds {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  return {
    minX: Math.min(...list.map((b) => b.minX)),
    minY: Math.min(...list.map((b) => b.minY)),
    maxX: Math.max(...list.map((b) => b.maxX)),
    maxY: Math.max(...list.map((b) => b.maxY)),
  };
}
