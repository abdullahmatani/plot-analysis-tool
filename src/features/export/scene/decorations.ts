import type { Affine2D, NorthSettings, Units } from '@/core/types';
import { niceScaleBar, scaleBarLabel } from '@/core/scale-bar';
import type { FontSet } from '@/export/fonts';
import {
  polylinePath,
  rectPath,
  type FillStyle,
  type SceneItem,
  type StrokeStyle,
  type TextItem,
} from '@/export/scene';
import { dashMm } from '@/features/objects/style';
import type { LegendModel, LegendSwatch } from '@/features/legend/legend-model';

import { HATCH_LINE_MM, HATCH_SPACING_MM } from './objects';
import type { Rect } from './sheet';
import { fitLine, textWidth, wrapText } from './text';

/**
 * Sheet decorations (rows 36, 75, 76): legend box, title block, scale bar, north arrow and the
 * calibration statement. Sizes are paper millimetres scaled by the sheet's decoration factor `ui`.
 */

const INK = '#111827';
const MUTED = '#4b5563';
const RULE = '#9ca3af';
const BORDER: StrokeStyle = { color: INK, width: 0.35, join: 'miter' };
const THIN: StrokeStyle = { color: RULE, width: 0.18, join: 'miter' };

function text(
  t: string,
  x: number,
  y: number,
  size: number,
  opts: Partial<Omit<TextItem, 'kind' | 'text' | 'x' | 'y' | 'size'>> = {},
): TextItem {
  return {
    kind: 'text',
    text: t,
    x,
    y,
    size,
    font: opts.font ?? 'sans',
    color: opts.color ?? INK,
    anchor: opts.anchor ?? 'start',
    baseline: opts.baseline ?? 'alphabetic',
    ...(opts.bold ? { bold: true } : {}),
    ...(opts.rotation ? { rotation: opts.rotation } : {}),
    ...(opts.halo ? { halo: opts.halo } : {}),
  };
}

function box(r: Rect, stroke: StrokeStyle | undefined, fill?: FillStyle): SceneItem {
  const item: SceneItem = { kind: 'path', d: rectPath(r.x, r.y, r.w, r.h) };
  if (stroke) item.stroke = stroke;
  if (fill) item.fill = fill;
  return item;
}

function hline(x1: number, x2: number, y: number, s: StrokeStyle): SceneItem {
  return {
    kind: 'path',
    d: [
      { op: 'M', x: x1, y },
      { op: 'L', x: x2, y },
    ],
    stroke: s,
  };
}

function vline(x: number, y1: number, y2: number, s: StrokeStyle): SceneItem {
  return {
    kind: 'path',
    d: [
      { op: 'M', x, y: y1 },
      { op: 'L', x, y: y2 },
    ],
    stroke: s,
  };
}

// ---------------------------------------------------------------------------------------------
// Legend swatches and box
// ---------------------------------------------------------------------------------------------

export function swatchItems(sw: LegendSwatch, r: Rect): SceneItem[] {
  const out: SceneItem[] = [];
  const stroke: StrokeStyle | undefined = sw.stroke
    ? {
        color: sw.stroke.color,
        width: Math.max(0.15, Math.min(sw.stroke.width, r.h / 3)),
        cap: 'round',
        join: 'round',
        ...(sw.stroke.opacity < 1 ? { opacity: sw.stroke.opacity } : {}),
      }
    : undefined;
  if (stroke && sw.stroke) {
    const dash = dashMm(sw.stroke.dash, stroke.width);
    if (dash.length) stroke.dash = dash;
  }
  let fill: FillStyle | undefined;
  if (sw.fill && sw.fill.hatch !== 'none' && sw.fill.opacity > 0) {
    fill =
      sw.fill.hatch === 'solid'
        ? { color: sw.fill.color, opacity: sw.fill.opacity }
        : {
            color: sw.fill.color,
            opacity: sw.fill.opacity * 0.35,
            hatch: {
              pattern: sw.fill.hatch,
              spacing: Math.min(HATCH_SPACING_MM, r.h / 2.5),
              lineWidth: HATCH_LINE_MM,
              color: sw.fill.color,
              opacity: Math.min(1, sw.fill.opacity * 3 + 0.25),
            },
          };
  }
  switch (sw.shape) {
    case 'area':
    case 'ring': {
      const radius = sw.shape === 'ring' ? r.h / 2 : 0;
      const item: SceneItem = { kind: 'path', d: rectPath(r.x, r.y, r.w, r.h, radius) };
      if (fill) item.fill = fill;
      if (stroke) item.stroke = stroke;
      if (fill || stroke) out.push(item);
      break;
    }
    case 'line':
      if (stroke) out.push(hline(r.x, r.x + r.w, r.y + r.h / 2, stroke));
      break;
    case 'point': {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const s = Math.min(r.h, r.w) / 2;
      out.push({
        kind: 'path',
        d: [
          { op: 'M', x: cx - s, y: cy },
          { op: 'L', x: cx + s, y: cy },
          { op: 'M', x: cx, y: cy - s },
          { op: 'L', x: cx, y: cy + s },
        ],
        stroke: { color: sw.stroke?.color ?? INK, width: Math.max(0.18, stroke?.width ?? 0.25) },
      });
      break;
    }
  }
  return out;
}

export interface LegendLayout {
  w: number;
  h: number;
  /** Items positioned with the box's top-left at (x, y). */
  draw(x: number, y: number): SceneItem[];
}

/** Lays out the legend box for a width (mm). `calibration` lines are appended when given. */
export function layoutLegend(
  model: LegendModel,
  fonts: FontSet | undefined,
  width: number,
  ui: number,
  calibration?: string[],
): LegendLayout {
  const pad = 3 * ui;
  const titleSize = 4 * ui;
  const groupSize = 2.8 * ui;
  const itemSize = 2.5 * ui;
  const calSize = 1.8 * ui;
  const swW = 9 * ui;
  const swH = 4.5 * ui;
  const gap = 2 * ui;
  const textX = pad + swW + gap;
  const textW = Math.max(10, width - textX - pad);
  type Row =
    | { kind: 'title'; lines: string[]; y: number }
    | { kind: 'group'; lines: string[]; y: number }
    | { kind: 'entry'; lines: string[]; y: number; h: number; swatch: LegendSwatch }
    | { kind: 'rule'; y: number }
    | { kind: 'cal'; lines: { text: string; bold: boolean }[]; y: number };
  const rows: Row[] = [];
  let y = pad;
  if (model.title.trim()) {
    const lines = wrapText(fonts, model.title, { size: titleSize, bold: true }, width - 2 * pad);
    rows.push({ kind: 'title', lines, y });
    y += lines.length * titleSize * 1.2 + 1.5 * ui;
  }
  // Group headings only help when there is more than one group.
  const multipleGroups = model.groups.length > 1;
  model.groups.forEach((g, gi) => {
    if (multipleGroups && g.title.trim()) {
      if (gi > 0) y += 1.2 * ui;
      const lines = wrapText(fonts, g.title, { size: groupSize, bold: true }, width - 2 * pad);
      rows.push({ kind: 'group', lines, y });
      y += lines.length * groupSize * 1.2 + 0.8 * ui;
    }
    for (const it of g.items) {
      const lines = wrapText(fonts, it.title, { size: itemSize }, textW);
      const h = Math.max(swH, lines.length * itemSize * 1.2);
      rows.push({ kind: 'entry', lines, y, h, swatch: it.swatch });
      y += h + 1.4 * ui;
    }
  });
  if (calibration?.length) {
    y += 0.6 * ui;
    rows.push({ kind: 'rule', y });
    y += 1.6 * ui;
    const lines: { text: string; bold: boolean }[] = [];
    calibration.forEach((c, i) => {
      for (const l of wrapText(fonts, c, { size: calSize, bold: i === 0 }, width - 2 * pad))
        lines.push({ text: l, bold: i === 0 });
    });
    rows.push({ kind: 'cal', lines, y });
    y += lines.length * calSize * 1.2;
  }
  const h = y + pad - 1.4 * ui;
  return {
    w: width,
    h,
    draw(x0, y0) {
      const out: SceneItem[] = [
        box({ x: x0, y: y0, w: width, h }, BORDER, { color: '#ffffff', opacity: 0.94 }),
      ];
      for (const r of rows) {
        switch (r.kind) {
          case 'title':
            r.lines.forEach((l, i) =>
              out.push(
                text(l, x0 + pad, y0 + r.y + i * titleSize * 1.2, titleSize, { bold: true, baseline: 'top' }),
              ),
            );
            break;
          case 'group':
            r.lines.forEach((l, i) =>
              out.push(
                text(l, x0 + pad, y0 + r.y + i * groupSize * 1.2, groupSize, {
                  bold: true,
                  baseline: 'top',
                  color: MUTED,
                }),
              ),
            );
            break;
          case 'entry': {
            const sy = y0 + r.y + (Math.min(r.h, swH * 1.6) - swH) / 2;
            out.push(...swatchItems(r.swatch, { x: x0 + pad, y: sy, w: swW, h: swH }));
            const ty = y0 + r.y + (r.lines.length === 1 ? r.h / 2 : 0);
            r.lines.forEach((l, i) =>
              out.push(
                text(l, x0 + textX, ty + i * itemSize * 1.2, itemSize, {
                  baseline: r.lines.length === 1 ? 'middle' : 'top',
                }),
              ),
            );
            break;
          }
          case 'rule':
            out.push(hline(x0 + pad, x0 + width - pad, y0 + r.y, THIN));
            break;
          case 'cal':
            r.lines.forEach((l, i) =>
              out.push(
                text(l.text, x0 + pad, y0 + r.y + i * calSize * 1.2, calSize, {
                  baseline: 'top',
                  bold: l.bold,
                  color: l.bold ? INK : MUTED,
                }),
              ),
            );
            break;
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Scale bar and north arrow
// ---------------------------------------------------------------------------------------------

function unitScale(lengthM: number, imperial: boolean): { div: number; unit: string } {
  if (imperial) return { div: 0.3048, unit: 'ft' };
  if (lengthM >= 1000) return { div: 1000, unit: 'km' };
  if (lengthM >= 1) return { div: 1, unit: 'm' };
  if (lengthM >= 0.01) return { div: 0.01, unit: 'cm' };
  return { div: 0.001, unit: 'mm' };
}

const trim = (v: number) => String(Number(v.toPrecision(6)));

export interface ScaleBarResult {
  items: SceneItem[];
  /** Bar length on paper (mm) and in the world (m). */
  lengthMm: number;
  lengthM: number;
  height: number;
}

/**
 * Scale bar with "nice" divisions (row 36): at most `maxMm` long on paper at 1:`scale`. The bar is
 * exactly `lengthM · 1000 / scale` mm long, so it measures true on a true-scale print.
 */
export function scaleBar(
  x: number,
  y: number,
  maxMm: number,
  scale: number,
  ui: number,
  units: Units = 'm',
): ScaleBarResult {
  const imperial = units === 'ft' || units === 'in';
  const mPerMm = scale / 1000;
  let lengthM: number;
  let divisions: number;
  if (imperial) {
    const spec = niceScaleBar((maxMm * mPerMm) / 0.3048);
    lengthM = spec.length * 0.3048;
    divisions = spec.divisions;
  } else {
    const spec = niceScaleBar(maxMm * mPerMm);
    lengthM = spec.length;
    divisions = spec.divisions;
  }
  const lengthMm = lengthM / mPerMm;
  const barH = 1.6 * ui;
  const seg = lengthMm / divisions;
  const items: SceneItem[] = [];
  for (let i = 0; i < divisions; i++) {
    items.push(
      box({ x: x + i * seg, y, w: seg, h: barH }, undefined, { color: i % 2 === 0 ? INK : '#ffffff' }),
    );
  }
  items.push(box({ x, y, w: lengthMm, h: barH }, { color: INK, width: 0.2, join: 'miter' }));
  const size = 2 * ui;
  const { div, unit } = unitScale(lengthM, imperial);
  const ty = y + barH + 0.8 * ui;
  const segM = lengthM / divisions;
  const labelEvery = divisions > 5 ? 2 : 1;
  for (let i = 0; i <= divisions; i += labelEvery) {
    const v = (i * segM) / div;
    const label = i === divisions ? (imperial ? `${trim(v)} ft` : scaleBarLabel(lengthM)) : trim(v);
    items.push(text(label, x + i * seg, ty, size, { anchor: 'middle', baseline: 'top' }));
  }
  if (divisions % labelEvery) {
    items.push(
      text(imperial ? `${trim(lengthM / div)} ${unit}` : scaleBarLabel(lengthM), x + lengthMm, ty, size, {
        anchor: 'middle',
        baseline: 'top',
      }),
    );
  }
  return { items, lengthMm, lengthM, height: barH + 0.8 * ui + size * 1.2 };
}

/** Direction of north on paper as a CCW-on-paper angle from "up", given the world → paper matrix. */
export function northAngle(M: Affine2D, north: NorthSettings): number {
  const t = north.arrow === 'true' ? north.trueNorthAngle : 0;
  // World direction of north (plant north is +Y; true north is rotated CCW by trueNorthAngle).
  const wx = -Math.sin(t);
  const wy = Math.cos(t);
  const px = M[0] * wx + M[2] * wy;
  const py = M[1] * wx + M[3] * wy;
  return Math.atan2(-px, -py);
}

/** North arrow centred at (cx, cy), `size` mm tall, pointing `angle` (CCW on paper from up). */
export function northArrow(
  cx: number,
  cy: number,
  size: number,
  angle: number,
  caption?: string,
): SceneItem[] {
  const s = size / 2;
  // Rotation CCW as seen on paper (y-down): (x, y) → (c·x + sn·y, −sn·x + c·y).
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const at = (x: number, y: number): [number, number] => [cx + c * x + sn * y, cy - sn * x + c * y];
  const tip = at(0, -s);
  const notch = at(0, s * 0.45);
  const items: SceneItem[] = [
    {
      kind: 'path',
      d: polylinePath([tip, at(-s * 0.42, s), notch], true),
      fill: { color: INK },
      stroke: { color: INK, width: 0.2, join: 'miter' },
    },
    {
      kind: 'path',
      d: polylinePath([tip, at(s * 0.42, s), notch], true),
      fill: { color: '#ffffff' },
      stroke: { color: INK, width: 0.2, join: 'miter' },
    },
  ];
  const [nx, ny] = at(0, -s - size * 0.22);
  items.push(text('N', nx, ny, size * 0.32, { anchor: 'middle', baseline: 'middle', bold: true }));
  if (caption)
    items.push(
      text(caption, cx, cy + s + size * 0.08, size * 0.16, {
        anchor: 'middle',
        baseline: 'top',
        color: MUTED,
      }),
    );
  return items;
}

// ---------------------------------------------------------------------------------------------
// Title block
// ---------------------------------------------------------------------------------------------

export interface TitleBlockContent {
  title: string;
  project: string;
  drawingNo: string;
  revision: string;
  date: string;
  preparedBy: string;
  checkedBy: string;
  notes: string;
  scaleStatement: string;
  calibration: string[];
}

export interface TitleBlockLayout {
  w: number;
  h: number;
  draw(
    x: number,
    y: number,
    extra: { northAngle?: number; northCaption?: string; scale?: number; units?: Units },
  ): SceneItem[];
}

/** Title block (row 76) with an optional scale/north panel at the top. */
export function layoutTitleBlock(
  c: TitleBlockContent,
  fonts: FontSet | undefined,
  w: number,
  ui: number,
  panel: { scaleBar: boolean; north: boolean },
): TitleBlockLayout {
  const pad = 1.6 * ui;
  const lab = 1.6 * ui;
  const val = 2.6 * ui;
  const titleSize = 4.4 * ui;
  const calSize = 1.8 * ui;
  const panelH = panel.scaleBar || panel.north ? 20 * ui : 0;
  const titleLines = wrapText(fonts, c.title || ' ', { size: titleSize, bold: true }, w - 2 * pad).slice(
    0,
    2,
  );
  const titleH = pad + lab * 1.3 + titleLines.length * titleSize * 1.2 + pad;
  const cellH = pad + lab * 1.3 + val * 1.2 + pad;
  const calLines: { text: string; bold: boolean }[] = [];
  c.calibration.forEach((l, i) => {
    for (const t of wrapText(fonts, l, { size: calSize, bold: i === 0 }, w - 2 * pad))
      calLines.push({ text: t, bold: i === 0 });
  });
  const calH = pad + calLines.length * calSize * 1.2 + pad;
  const noteLines = c.notes.trim()
    ? wrapText(fonts, c.notes, { size: calSize }, w - 2 * pad).slice(0, 8)
    : [];
  const notesH = noteLines.length ? pad + lab * 1.3 + noteLines.length * calSize * 1.2 + pad : 0;
  const h = panelH + titleH + 2 * cellH + calH + notesH;
  const cell = (out: SceneItem[], x: number, y: number, cw: number, label: string, value: string) => {
    out.push(text(label, x + pad, y + pad, lab, { baseline: 'top', color: MUTED }));
    out.push(
      text(fitLine(fonts, value, { size: val }, cw - 2 * pad), x + pad, y + pad + lab * 1.3, val, {
        baseline: 'top',
      }),
    );
  };
  return {
    w,
    h,
    draw(x0, y0, extra) {
      const out: SceneItem[] = [box({ x: x0, y: y0, w, h }, undefined, { color: '#ffffff' })];
      let y = y0;
      if (panelH) {
        const northW = panel.north ? panelH : 0;
        if (panel.north && extra.northAngle !== undefined) {
          out.push(
            ...northArrow(
              x0 + northW / 2,
              y + panelH * 0.49,
              panelH * 0.5,
              extra.northAngle,
              extra.northCaption,
            ),
          );
        }
        if (panel.north) out.push(vline(x0 + northW, y, y + panelH, THIN));
        const sx = x0 + northW + 2 * pad;
        out.push(text(c.scaleStatement, sx, y + pad, val, { baseline: 'top', bold: true }));
        if (panel.scaleBar && extra.scale) {
          const sb = scaleBar(sx, y + pad + val * 1.6, w - northW - 6 * pad, extra.scale, ui, extra.units);
          out.push(...sb.items);
        }
        y += panelH;
        out.push(hline(x0, x0 + w, y, THIN));
      }
      out.push(text('Title', x0 + pad, y + pad, lab, { baseline: 'top', color: MUTED }));
      titleLines.forEach((l, i) =>
        out.push(
          text(l, x0 + pad, y + pad + lab * 1.3 + i * titleSize * 1.2, titleSize, {
            baseline: 'top',
            bold: true,
          }),
        ),
      );
      y += titleH;
      out.push(hline(x0, x0 + w, y, THIN));
      const c1 = w * 0.5;
      const c2 = w * 0.35;
      cell(out, x0, y, c1, 'Project', c.project);
      cell(out, x0 + c1, y, c2, 'Drawing no.', c.drawingNo);
      cell(out, x0 + c1 + c2, y, w - c1 - c2, 'Rev', c.revision);
      out.push(vline(x0 + c1, y, y + cellH, THIN), vline(x0 + c1 + c2, y, y + cellH, THIN));
      y += cellH;
      out.push(hline(x0, x0 + w, y, THIN));
      const d1 = w / 3;
      cell(out, x0, y, d1, 'Prepared by', c.preparedBy);
      cell(out, x0 + d1, y, d1, 'Checked by', c.checkedBy);
      cell(out, x0 + 2 * d1, y, w - 2 * d1, 'Date', c.date);
      out.push(vline(x0 + d1, y, y + cellH, THIN), vline(x0 + 2 * d1, y, y + cellH, THIN));
      y += cellH;
      out.push(hline(x0, x0 + w, y, THIN));
      calLines.forEach((l, i) =>
        out.push(
          text(l.text, x0 + pad, y + pad + i * calSize * 1.2, calSize, {
            baseline: 'top',
            bold: l.bold,
            color: l.bold ? INK : MUTED,
          }),
        ),
      );
      y += calH;
      if (noteLines.length) {
        out.push(hline(x0, x0 + w, y, THIN));
        out.push(text('Notes', x0 + pad, y + pad, lab, { baseline: 'top', color: MUTED }));
        noteLines.forEach((l, i) =>
          out.push(text(l, x0 + pad, y + pad + lab * 1.3 + i * calSize * 1.2, calSize, { baseline: 'top' })),
        );
      }
      out.push(box({ x: x0, y: y0, w, h }, { color: INK, width: 0.5, join: 'miter' }));
      return out;
    },
  };
}

/** Standalone calibration statement box (used when neither title block nor legend carries it). */
export function calibrationNote(
  lines: string[],
  fonts: FontSet | undefined,
  x: number,
  yBottom: number,
  maxW: number,
  ui: number,
): SceneItem[] {
  const size = 1.8 * ui;
  const pad = 1.2 * ui;
  const wrapped: { text: string; bold: boolean }[] = [];
  lines.forEach((l, i) => {
    for (const t of wrapText(fonts, l, { size, bold: i === 0 }, maxW - 2 * pad))
      wrapped.push({ text: t, bold: i === 0 });
  });
  const w = Math.min(
    maxW,
    Math.max(...wrapped.map((l) => textWidth(fonts, l.text, { size, bold: l.bold }))) + 2 * pad,
  );
  const h = wrapped.length * size * 1.2 + 2 * pad;
  const y = yBottom - h;
  const out: SceneItem[] = [
    box({ x, y, w, h }, { color: RULE, width: 0.18 }, { color: '#ffffff', opacity: 0.94 }),
  ];
  wrapped.forEach((l, i) =>
    out.push(
      text(l.text, x + pad, y + pad + i * size * 1.2, size, {
        baseline: 'top',
        bold: l.bold,
        color: l.bold ? INK : MUTED,
      }),
    ),
  );
  return out;
}

export { BORDER, INK };
