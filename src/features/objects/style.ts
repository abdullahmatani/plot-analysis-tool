import { DEFAULT_STYLE } from '@/core/project';
import type { AnalysisLayer, AnalysisObject, DashStyle, HatchPattern, Project, Style } from '@/core/types';

/** Style resolution (row 42): layer style overridden per object. */

export const PX_PER_MM = 96 / 25.4;

export function layerOf(project: Project, o: AnalysisObject): AnalysisLayer | undefined {
  return project.layers.find((l) => l.id === o.layerId);
}

export function resolveStyle(project: Project, o: AnalysisObject): Style {
  const layer = layerOf(project, o);
  return { ...DEFAULT_STYLE, ...(layer?.style ?? {}), ...o.style };
}

/** Dash pattern in paper millimetres. */
export function dashMm(dash: DashStyle, widthMm: number): number[] {
  const w = Math.max(widthMm, 0.18);
  switch (dash) {
    case 'dash':
      return [12 * w, 6 * w];
    case 'dot':
      return [0.01, 4 * w];
    case 'dash-dot':
      return [12 * w, 4 * w, 0.01, 4 * w];
    case 'long-dash':
      return [24 * w, 6 * w];
    default:
      return [];
  }
}

const patternCache = new Map<string, CanvasPattern | null>();

/** Hatch fill patterns for the canvas (screen-space density). */
export function hatchPattern(
  g: CanvasRenderingContext2D,
  pattern: HatchPattern,
  color: string,
  alpha: number,
): CanvasPattern | string | null {
  if (pattern === 'none') return null;
  if (pattern === 'solid') return color;
  const key = `${pattern}|${color}|${alpha}`;
  if (patternCache.has(key)) return patternCache.get(key) ?? null;
  const size = 10;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const t = c.getContext('2d')!;
  t.strokeStyle = color;
  t.fillStyle = color;
  t.globalAlpha = Math.min(1, alpha * 3 + 0.25);
  t.lineWidth = 1;
  t.beginPath();
  const diag = () => {
    t.moveTo(0, size);
    t.lineTo(size, 0);
    t.moveTo(-size / 2, size / 2);
    t.lineTo(size / 2, -size / 2);
    t.moveTo(size / 2, size * 1.5);
    t.lineTo(size * 1.5, size / 2);
  };
  const back = () => {
    t.moveTo(0, 0);
    t.lineTo(size, size);
    t.moveTo(-size / 2, size / 2);
    t.lineTo(size / 2, size * 1.5);
    t.moveTo(size / 2, -size / 2);
    t.lineTo(size * 1.5, size / 2);
  };
  switch (pattern) {
    case 'diagonal':
      diag();
      break;
    case 'back-diagonal':
      back();
      break;
    case 'diagonal-cross':
      diag();
      back();
      break;
    case 'cross':
      t.moveTo(0, size / 2);
      t.lineTo(size, size / 2);
      t.moveTo(size / 2, 0);
      t.lineTo(size / 2, size);
      break;
    case 'horizontal':
      t.moveTo(0, size / 2);
      t.lineTo(size, size / 2);
      break;
    case 'vertical':
      t.moveTo(size / 2, 0);
      t.lineTo(size / 2, size);
      break;
    case 'dots':
      t.arc(size / 2, size / 2, 1.3, 0, Math.PI * 2);
      t.fill();
      break;
  }
  t.stroke();
  const p = g.createPattern(c, 'repeat');
  patternCache.set(key, p);
  return p;
}

export function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Label height in screen pixels: paper mm (constant on screen) or world metres (scales with zoom). */
export function labelHeightPx(style: Style, scale: number): number {
  return style.labelSizeUnit === 'world' ? style.labelSize * scale : style.labelSize * PX_PER_MM;
}

export function fontFamily(f: Style['labelFont']): string {
  return f === 'serif'
    ? 'Georgia, "Noto Sans", serif'
    : f === 'mono'
      ? 'ui-monospace, monospace'
      : '"Inter Variable", "PAT CAD Sans", "Noto Sans Arabic", sans-serif';
}
