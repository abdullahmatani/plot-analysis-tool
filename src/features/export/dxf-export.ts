import { apply, invert, isSimilarity, IDENTITY } from '@/core/affine';
import type { Affine2D, Drawing, Geometry, Pt, Style, Units, Vertex } from '@/core/types';
import type { FontSet } from '@/export/fonts';
import { DASH_TO_LINETYPE, DxfWriter, type DxfEntityStyle, type MTextAttachment } from '@/export/dxf-writer';
import { flattenPath, type SceneItem, type TextItem } from '@/export/scene';
import { isClosed, toPolyline, transformGeometry } from '@/geometry/convert';
import { bounds as geometryBounds } from '@/geometry/measure';
import { add } from '@/geometry/vec';
import { labelAnchor, labelText } from '@/features/objects/labels';
import { resolveStyle } from '@/features/objects/style';
import { buildLegend } from '@/features/legend/legend-model';
import { placementOf } from '@/underlay/models';

import { calibrationStatement } from './scene/calibration';
import { contourGeometry } from './scene/contours';
import { layoutLegend } from './scene/decorations';
import { computeLayout } from './scene/project-scene';
import type { ProjectSceneInput } from './scene/types';

/**
 * DXF export of the analysis (row 79): objects, fills, labels, contours and (optionally) the legend
 * on named layers, in the coordinates of a chosen drawing (the inverse of its placement, so the file
 * overlays the source exactly when XREF'd at 0,0) or in world/plant coordinates. Labels with complex
 * scripts (Arabic, Hebrew…) are written as shaped glyph outlines by default so they display correctly
 * in CAD applications without complex-script support; the UTF-8 MTEXT is kept on a "-TEXT" layer
 * that is switched off (row 48).
 */

export interface DxfExportResult {
  bytes: Uint8Array;
  /** World → DXF coordinates. */
  transform: Affine2D;
  units: Units | 'unitless';
  warnings: string[];
  entityCount: number;
}

/** Text that needs complex-script shaping (RTL scripts and Arabic presentation forms). */
export function needsShaping(text: string): boolean {
  return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(text);
}

const CAP_HEIGHT = 0.714;

function drawingUnits(d: Drawing): Units | 'unitless' {
  if (d.source.kind === 'pdf') return 'unitless';
  if (d.unitsOverride) return d.unitsOverride;
  if (d.nativeUnits && d.nativeUnits !== 'pt') return d.nativeUnits;
  return 'unitless';
}

/** Entity style for an object whose style differs from its layer's. */
function entityStyle(s: Style, layer: Style): DxfEntityStyle | undefined {
  const st: DxfEntityStyle = {};
  if (s.stroke.toLowerCase() !== layer.stroke.toLowerCase()) st.color = s.stroke;
  if (s.dash !== layer.dash) st.linetype = DASH_TO_LINETYPE[s.dash];
  if (s.strokeWidth !== layer.strokeWidth) st.lineweight = s.strokeWidth;
  if (s.strokeOpacity < 1) st.transparency = Math.min(0.9, 1 - s.strokeOpacity);
  return Object.keys(st).length ? st : undefined;
}

export function buildAnalysisDxf(input: ProjectSceneInput & { fonts?: FontSet }): DxfExportResult {
  const { project, settings, fonts } = input;
  const warnings: string[] = [];
  // Coordinates: world (= plant) or the chosen drawing's own units.
  let T: Affine2D = IDENTITY;
  let units: Units | 'unitless' = 'm';
  let unitPerMetre = 1;
  if (settings.dxfCoordinates === 'drawing') {
    const d = project.drawings.find((x) => x.id === settings.dxfDrawingId) ?? project.drawings[0];
    if (d) {
      const placement = placementOf(d, input.drawings[d.id]?.insunits);
      try {
        T = invert(placement);
        units = drawingUnits(d);
        unitPerMetre = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));
        if (!isSimilarity(placement))
          warnings.push('The drawing has a non-uniform calibration: circles are written as ellipses.');
      } catch {
        warnings.push(`Drawing “${d.name}” has no invertible placement; world coordinates were used.`);
      }
    } else warnings.push('No drawing to take coordinates from; world coordinates were used.');
  }
  const layout = computeLayout({ ...input, settings: { ...settings, region: 'sheet' } });
  const scale = layout.scale;
  /** Paper mm → DXF units. */
  const mm = (v: number) => ((v * scale) / 1000) * unitPerMetre;
  const chordTol = Math.max(1e-9, (project.chordTolerance || 0.005) * unitPerMetre);
  const rot = Math.atan2(T[1], T[0]);
  // Dashes: the standard DASHED dash (0.5 units) prints about 3 mm long at the sheet scale.
  const w = new DxfWriter({ units, ltscale: Math.max(1e-9, mm(3) / 0.5), escapeUnicode: false });
  const toDxf = (p: Pt) => apply(T, p);
  const textMode = settings.dxfText ?? 'auto';

  const writeText = (
    layer: string,
    p: Pt,
    text: string,
    em: number,
    attachment: MTextAttachment,
    style: DxfEntityStyle | undefined,
    font: TextItem['font'] = 'sans',
    bold = false,
  ) => {
    if (!text.trim() || !(em > 0)) return;
    const complex = needsShaping(text);
    const outlines = fonts && (textMode === 'outlines' || (textMode === 'auto' && complex));
    if (outlines) {
      const [v, h] = attachment.split('-') as [string, string];
      w.textOutlines(layer, fonts, p, text, {
        height: em,
        rotation: rot,
        anchor: h === 'left' ? 'start' : h === 'right' ? 'end' : 'middle',
        baseline: v === 'top' ? 'top' : v === 'bottom' ? 'bottom' : 'middle',
        font,
        bold,
        ...(style?.color !== undefined ? { color: style.color } : {}),
      });
      if (textMode === 'auto') {
        const tl = w.addLayer({ name: `${layer}-TEXT`, off: true, color: 7 });
        w.mtext(tl, p, text, { height: em * CAP_HEIGHT, rotation: rot, attachment, ...style });
      }
      return;
    }
    if (textMode === 'outlines' && !fonts) warnings.push('Fonts unavailable: labels written as text.');
    w.mtext(layer, p, text, { height: em * CAP_HEIGHT, rotation: rot, attachment, ...style });
  };

  const geometryEntities = (layer: string, g: Geometry, style?: DxfEntityStyle) => {
    switch (g.type) {
      case 'circle':
        if (g.r > 0) w.circle(layer, g.c, g.r, style);
        break;
      case 'arc':
        if (g.r > 0) w.arc(layer, g.c, g.r, g.a0, g.a1, style);
        break;
      case 'ellipse': {
        const major = g.rx >= g.ry;
        const a = major ? g.rx : g.ry;
        const b = major ? g.ry : g.rx;
        if (!(a > 0)) break;
        const ang = major ? g.rot : g.rot + Math.PI / 2;
        w.ellipse(
          layer,
          g.c,
          { x: a * Math.cos(ang), y: a * Math.sin(ang) },
          Math.max(1e-6, b / a),
          0,
          Math.PI * 2,
          style,
        );
        break;
      }
      case 'point':
        w.point(layer, g.p, style);
        break;
      default:
        for (const ring of toPolyline(g, chordTol)) {
          if (ring.length < 2) continue;
          w.polyline(layer, ring, g.type === 'polyline' ? g.closed : true, style);
        }
    }
  };

  const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (g: Geometry) => {
    const b = geometryBounds(g);
    extent.minX = Math.min(extent.minX, b.minX);
    extent.minY = Math.min(extent.minY, b.minY);
    extent.maxX = Math.max(extent.maxX, b.maxX);
    extent.maxY = Math.max(extent.maxY, b.maxY);
  };

  // ---- analysis layers ----
  for (const layer of project.layers) {
    if (!layer.visible) continue;
    const objs = project.objects.filter((o) => o.layerId === layer.id);
    if (!objs.length) continue;
    const ls = { ...resolveStyle(project, { ...objs[0], style: {} }) };
    const name = w.addLayer({
      name: layer.name,
      color: ls.stroke,
      linetype: DASH_TO_LINETYPE[ls.dash],
      lineweight: ls.strokeWidth,
    });
    const fillLayer = `${name}-FILL`;
    const labelLayer = `${name}-LABELS`;
    for (const o of objs) {
      const s = resolveStyle(project, o);
      const g = transformGeometry(o.geometry, T, chordTol);
      grow(g);
      if (isClosed(o.geometry) && s.hatch !== 'none' && s.fillOpacity > 0) {
        w.addLayer({ name: fillLayer, color: ls.fill });
        const opacity = s.hatch === 'solid' ? s.fillOpacity : s.fillOpacity * 0.35;
        w.hatch(fillLayer, toPolyline(g, chordTol) as Vertex[][], {
          color: s.fill,
          transparency: Math.min(0.9, Math.max(0, 1 - opacity)),
        });
      }
      geometryEntities(name, g, entityStyle(s, ls));
      if (o.label?.visible) {
        const text = labelText(project, o);
        if (!text) continue;
        const anchor = labelAnchor(o);
        const at = o.label.offset ? add(anchor, o.label.offset) : anchor;
        w.addLayer({ name: labelLayer, color: s.labelColor });
        if (o.label.placement === 'leader' && o.label.offset)
          w.line(labelLayer, toDxf(anchor), toDxf(at), { color: s.stroke });
        const em = (s.labelSizeUnit === 'world' ? s.labelSize : (s.labelSize * scale) / 1000) * unitPerMetre;
        const top = o.label.placement === 'top';
        const p = toDxf(top ? { x: at.x, y: at.y + (0.8 * scale) / 1000 } : at);
        writeText(
          labelLayer,
          p,
          text,
          em,
          top ? 'bottom-center' : 'middle-center',
          { color: s.labelColor },
          s.labelFont,
          s.labelBold,
        );
      }
    }
  }

  // ---- contour datasets ----
  const byId = new Map(input.contours.map((c) => [c.datasetId, c]));
  for (const ds of [...project.datasets].filter((d) => d.visible).sort((a, b) => a.order - b.order)) {
    const ci = byId.get(ds.id);
    if (!ci || (!ci.items.length && !ci.envelopes.length)) continue;
    const layer = w.addLayer({ name: ds.name, color: 7 });
    const labels = `${layer}-LABELS`;
    for (const it of ci.items) {
      const g = transformGeometry(contourGeometry(it, project.chordTolerance || 0.005), T, chordTol);
      grow(g);
      geometryEntities(layer, g, {
        color: it.color,
        linetype: DASH_TO_LINETYPE[it.dash],
        lineweight: it.strokeWidth,
      });
      if (it.label) {
        w.addLayer({ name: labels, color: 7 });
        const wb = geometryBounds(contourGeometry(it));
        const top = ds.labelPlacement !== 'centre';
        const p = toDxf(top ? { x: it.centre.x, y: wb.maxY + (0.8 * scale) / 1000 } : it.centre);
        writeText(labels, p, it.label, mm(2.5), top ? 'bottom-center' : 'middle-center', undefined);
      }
    }
    for (const env of ci.envelopes) {
      const el = w.addLayer({ name: `${layer}-ENVELOPE`, color: env.color });
      const g = transformGeometry(env.geometry, T, chordTol);
      grow(g);
      geometryEntities(el, g, { linetype: DASH_TO_LINETYPE[env.dash], lineweight: env.strokeWidth });
    }
  }

  // ---- legend and calibration statement ----
  const calibration = calibrationStatement(project, settings.includeUnderlay);
  const hasExtent = Number.isFinite(extent.minX);
  const originWorld = hasExtent ? apply(invert(T), { x: extent.maxX, y: extent.maxY }) : { x: 0, y: 0 };
  // Legend to the right of the analysis, in paper mm at the sheet scale.
  const leftMm = 10;
  const paperToDxf = (x: number, y: number): Pt =>
    toDxf({ x: originWorld.x + ((leftMm + x) * scale) / 1000, y: originWorld.y - (y * scale) / 1000 });
  const writeSceneItems = (items: SceneItem[], layer: string): void => {
    for (const it of items) {
      if (it.kind === 'group') writeSceneItems(it.children, layer);
      else if (it.kind === 'path') {
        const subs = flattenPath(it.d, 0.05);
        if (it.fill && (it.fill.opacity ?? 1) > 0 && it.fill.color.toLowerCase() !== '#ffffff') {
          const rings = subs
            .filter((s) => s.closed && s.points.length >= 3)
            .map((s) => s.points.map((p) => paperToDxf(p.x, p.y)));
          if (rings.length)
            w.hatch(layer, rings, {
              color: it.fill.color,
              transparency: Math.min(0.9, Math.max(0, 1 - (it.fill.opacity ?? 1))),
            });
        }
        if (it.stroke && it.stroke.width > 0) {
          for (const s of subs) {
            if (s.points.length < 2) continue;
            w.polyline(
              layer,
              s.points.map((p) => paperToDxf(p.x, p.y)),
              s.closed,
              {
                color: it.stroke.color,
                lineweight: it.stroke.width,
              },
            );
          }
        }
      } else if (it.kind === 'text') {
        const v =
          it.baseline === 'top' || it.baseline === 'hanging'
            ? 'top'
            : it.baseline === 'middle'
              ? 'middle'
              : 'bottom';
        const h = it.anchor === 'start' ? 'left' : it.anchor === 'end' ? 'right' : 'center';
        writeText(
          layer,
          paperToDxf(it.x, it.y),
          it.text,
          mm(it.size),
          `${v}-${h}` as MTextAttachment,
          { color: it.color },
          it.font,
          !!it.bold,
        );
      }
    }
  };

  if (settings.includeLegend) {
    const model = buildLegend(project, { contours: input.contours });
    const lay = layoutLegend(model, fonts, project.legend.widthMm || 70, 1, calibration);
    const legendLayer = w.addLayer({ name: 'PAT-LEGEND', color: 7 });
    writeSceneItems(lay.draw(0, 0), legendLayer);
  } else {
    const calLayer = w.addLayer({ name: 'PAT-CALIBRATION', color: 7 });
    calibration.forEach((line, i) =>
      writeText(calLayer, paperToDxf(0, i * 3), line, mm(2), 'top-left', undefined),
    );
  }

  const bytes = w.toBytes();
  return { bytes, transform: T, units, warnings, entityCount: w.entityCount };
}
