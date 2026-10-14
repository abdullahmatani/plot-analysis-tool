import { invert, transformBounds } from '@/core/affine';
import type { Affine2D, Bounds, Pt } from '@/core/types';
import { rectPath, SceneBuilder, type Scene, type SceneItem } from '@/export/scene';

import './annotations';
import { geomBounds, intersects } from '@/features/objects/geometry-cache';
import { bounds as geometryBounds } from '@/geometry/measure';
import { buildLegend, type LegendModel } from '@/features/legend/legend-model';

import { calibrationStatement } from './calibration';
import { contourDatasetItems, contourGeometry } from './contours';
import {
  BORDER,
  calibrationNote,
  layoutLegend,
  layoutTitleBlock,
  northAngle,
  northArrow,
  scaleBar,
} from './decorations';
import { analysisLayerItems } from './objects';
import {
  boundsCentre,
  decorationScale,
  fitScale,
  insetRect,
  mmPerMetre,
  niceScaleAtLeast,
  paperFromWorld,
  paperName,
  paperSizeMm,
  rectCentre,
  rectToBounds,
  scaleLabel,
  sheetFrame,
  titleBlockWidth,
  type Rect,
} from './sheet';
import type { ContourSceneInput, ProjectSceneInput } from './types';
import { cadDrawingGroup, drawingWorldBounds, pdfDrawingGroup, type PdfItemRef } from './underlay';

/**
 * Project → export scene (rows 36, 75–78): one backend-neutral Scene in paper millimetres that the
 * PDF, SVG and canvas/PNG backends render identically, and that the export preview draws. Pure and
 * deterministic for a given input, so a saved profile reproduces the same output.
 */

export const CSS_PX_MM = 25.4 / 96;

export interface SceneLayout {
  region: 'sheet' | 'view' | 'window';
  paper: { w: number; h: number };
  /** Map viewport on paper (mm). */
  viewport: Rect;
  paperFromWorld: Affine2D;
  /** Print scale denominator (1:scale). */
  scale: number;
  centre: Pt;
  rotation: number;
  /** World bounds covered by the viewport. */
  viewportWorld: Bounds;
  scaleStatement: string;
  titleBlock?: Rect;
  legend?: Rect;
}

export interface ProjectSceneResult {
  scene: Scene;
  layout: SceneLayout;
  legend: LegendModel;
  /** Embedded PDF pages (raster backends render them separately). */
  pdfItems: PdfItemRef[];
  /** Calibration statement lines shown on the output. */
  calibration: string[];
  warnings: string[];
}

function unionAll(list: (Bounds | null | undefined)[]): Bounds | null {
  let out: Bounds | null = null;
  for (const b of list) {
    if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX)) continue;
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : { ...b };
  }
  return out;
}

/** World bounds of everything that would be exported (visible drawings, objects, contours). */
export function contentBounds(
  input: Pick<ProjectSceneInput, 'project' | 'drawings' | 'contours' | 'settings'>,
): Bounds | null {
  const { project } = input;
  const list: (Bounds | null)[] = [];
  if (input.settings.includeUnderlay) {
    for (const d of project.drawings) {
      if (!d.visible) continue;
      const di = input.drawings[d.id];
      if (di) list.push(drawingWorldBounds(d, di));
    }
  }
  const visibleLayers = new Set(project.layers.filter((l) => l.visible).map((l) => l.id));
  for (const o of project.objects) if (visibleLayers.has(o.layerId)) list.push(geomBounds(o.geometry));
  const visibleDs = new Set(project.datasets.filter((d) => d.visible).map((d) => d.id));
  for (const c of input.contours) {
    if (!visibleDs.has(c.datasetId)) continue;
    for (const it of c.items) list.push(geometryBounds(contourGeometry(it, project.chordTolerance || 0.005)));
  }
  return unionAll(list);
}

/** Paper layout and world → paper transform for the export region. */
export function computeLayout(input: ProjectSceneInput): SceneLayout {
  const { settings } = input;
  const sheet = settings.sheet;
  const region = settings.region === 'view' && !input.view ? 'sheet' : settings.region;
  const content = contentBounds(input);
  const finish = (
    paper: { w: number; h: number },
    viewport: Rect,
    centre: Pt,
    scale: number,
    rotation: number,
    scaleStatement: string,
  ): SceneLayout => {
    const M = paperFromWorld(rectCentre(viewport), centre, scale, rotation);
    return {
      region,
      paper,
      viewport,
      paperFromWorld: M,
      scale,
      centre,
      rotation,
      viewportWorld: transformBounds(invert(M), rectToBounds(viewport)),
      scaleStatement,
    };
  };
  if (region === 'view' && input.view) {
    const v = input.view;
    const paper = { w: Math.max(1, v.width) * CSS_PX_MM, h: Math.max(1, v.height) * CSS_PX_MM };
    const scale = 1000 / (v.scale * CSS_PX_MM);
    return finish(
      paper,
      { x: 0, y: 0, w: paper.w, h: paper.h },
      { x: v.cx, y: v.cy },
      scale,
      v.rotation,
      `Scale ${scaleLabel(scale)} (view, ${paper.w.toFixed(0)} × ${paper.h.toFixed(0)} mm)`,
    );
  }
  if (region === 'window') {
    const win = settings.window ?? content ?? { minX: -50, minY: -50, maxX: 50, maxY: 50 };
    const border = 5;
    const p = paperSizeMm(sheet);
    const inner = { w: Math.max(10, p.w - 2 * border), h: Math.max(10, p.h - 2 * border) };
    const scale = sheet.scale && sheet.scale > 0 ? sheet.scale : niceScaleAtLeast(fitScale(win, 0, inner));
    const k = mmPerMetre(scale);
    const vw = Math.max(1e-3, (win.maxX - win.minX) * k);
    const vh = Math.max(1e-3, (win.maxY - win.minY) * k);
    const paper = { w: vw + 2 * border, h: vh + 2 * border };
    return finish(
      paper,
      { x: border, y: border, w: vw, h: vh },
      boundsCentre(win),
      scale,
      0,
      `Scale ${scaleLabel(scale)} (window ${paper.w.toFixed(0)} × ${paper.h.toFixed(0)} mm)`,
    );
  }
  const sf = sheetFrame(sheet);
  const rotation = sheet.viewRotation || 0;
  const inner = insetRect(sf.viewport, 5 * sf.ui);
  let scale: number;
  let centre: Pt;
  if (sheet.scale && sheet.scale > 0) {
    scale = sheet.scale;
    centre = sheet.viewCentre ?? (content ? boundsCentre(content) : { x: 0, y: 0 });
  } else {
    scale = content ? niceScaleAtLeast(fitScale(content, rotation, inner)) : 1000;
    centre = content ? boundsCentre(content) : { x: 0, y: 0 };
  }
  return finish(
    sf.paper,
    sf.viewport,
    centre,
    scale,
    rotation,
    `Scale ${scaleLabel(scale)} at ${paperName(sheet)}`,
  );
}

/** Builds the export scene for a project and settings (see module notes). */
export function buildProjectScene(input: ProjectSceneInput): ProjectSceneResult {
  const { project, settings, fonts } = input;
  const sheet = settings.sheet;
  const warnings: string[] = [];
  const layout = computeLayout(input);
  const M = layout.paperFromWorld;
  const k = mmPerMetre(layout.scale);
  const ui =
    layout.region === 'sheet'
      ? decorationScale(layout.paper)
      : Math.max(0.62, Math.min(1, Math.min(layout.paper.w, layout.paper.h) / 300));
  const cull = layout.viewportWorld;
  const tb = sheet.titleBlock;
  const meta = {
    title: tb.title.trim() || project.name,
    subject: layout.scaleStatement,
    creator: 'Plot Analysis Tool',
    ...(tb.preparedBy.trim() ? { author: tb.preparedBy.trim() } : {}),
  };
  const b = new SceneBuilder(layout.paper.w, layout.paper.h, { background: '#ffffff', meta });
  const pdfItems: PdfItemRef[] = [];
  const usedNames = new Set<string>();
  const unique = (name: string) => {
    let n = name.trim() || 'Layer';
    if (usedNames.has(n)) {
      let i = 2;
      while (usedNames.has(`${n} (${i})`)) i++;
      n = `${n} (${i})`;
    }
    usedNames.add(n);
    return n;
  };

  // ---- Map (clipped to the viewport) ----
  const mapItems: SceneItem[] = [];
  if (settings.includeUnderlay) {
    const drawings = [...project.drawings].filter((d) => d.visible).sort((a, c) => a.order - c.order);
    for (const d of drawings) {
      const di = input.drawings[d.id];
      if (!di) {
        warnings.push(`Drawing “${d.name}” is not loaded and was left out.`);
        continue;
      }
      if (di.pdf) {
        const r = pdfDrawingGroup(d, di, { paperFromWorld: M, viewportWorld: cull });
        if (r) {
          r.group.name = unique(r.group.name);
          mapItems.push(r.group);
          pdfItems.push({ drawingId: d.id, item: r.item });
        }
      } else {
        const g = cadDrawingGroup(d, di, { paperFromWorld: M, viewportWorld: cull });
        if (g) {
          g.name = unique(g.name);
          mapItems.push(g);
        }
      }
    }
  }
  const datasets = [...project.datasets].filter((d) => d.visible).sort((a, c) => a.order - c.order);
  const contourById = new Map(input.contours.map((c) => [c.datasetId, c]));
  const culledContours: ContourSceneInput[] = [];
  for (const ds of datasets) {
    const ci = contourById.get(ds.id);
    if (!ci) continue;
    const chordTol = project.chordTolerance || 0.005;
    const items = ci.items.filter((it) => {
      const wb = geometryBounds(contourGeometry(it, chordTol));
      return intersects(wb, cull);
    });
    culledContours.push({ ...ci, items });
    const r = contourDatasetItems(ds, { ...ci, items }, { paperFromWorld: M, fonts, chordTol, cull: null });
    if (r.rings.length || r.labels.length)
      mapItems.push({
        kind: 'group',
        name: unique(`Contours – ${ds.name}`),
        layer: true,
        children: [...r.rings, ...r.labels],
      });
  }
  const layers = analysisLayerItems({ project, paperFromWorld: M, mmPerMetre: k }, cull);
  const layerNames = new Map<string, string>();
  for (const li of layers) layerNames.set(li.layerId, unique(li.name));
  for (const li of layers)
    if (li.shapes.length)
      mapItems.push({ kind: 'group', name: layerNames.get(li.layerId)!, layer: true, children: li.shapes });
  // Labels above every shape (as on screen); same layer names, so they share the PDF layer.
  for (const li of layers)
    if (li.labels.length)
      mapItems.push({ kind: 'group', name: layerNames.get(li.layerId)!, layer: true, children: li.labels });
  const vp = layout.viewport;
  b.add({ kind: 'group', name: 'Map', clip: rectPath(vp.x, vp.y, vp.w, vp.h), children: mapItems });

  // ---- Decorations ----
  const calibration = calibrationStatement(project, settings.includeUnderlay);
  const showLegend = layout.region === 'sheet' ? sheet.showLegend : settings.includeLegend;
  const showTitle = layout.region === 'sheet' && sheet.showTitleBlock;
  const legend = buildLegend(project, {
    contours: culledContours,
    objectFilter: (o) => intersects(geomBounds(o.geometry), cull),
  });
  const inset = 4 * ui;
  const decoItems: SceneItem[] = [];
  const north = northAngle(M, project.north);
  const northCaption = project.north.arrow === 'true' ? 'True north' : 'Plant north';
  let calibrationShown = false;
  let titleRect: Rect | undefined;

  if (layout.region === 'sheet') {
    const sf = sheetFrame(sheet);
    decoItems.push({
      kind: 'path',
      d: rectPath(sf.frame.x, sf.frame.y, sf.frame.w, sf.frame.h),
      stroke: { ...BORDER, width: 0.5 },
    });
    if (showTitle) {
      const w = titleBlockWidth(sf.frame, ui);
      const tl = layoutTitleBlock(
        {
          title: tb.title || project.name,
          project: tb.project,
          drawingNo: tb.drawingNo,
          revision: tb.revision,
          date: tb.date,
          preparedBy: tb.preparedBy,
          checkedBy: tb.checkedBy,
          notes: tb.notes,
          scaleStatement: layout.scaleStatement,
          calibration,
        },
        fonts,
        w,
        ui,
        { scaleBar: sheet.showScaleBar, north: sheet.showNorthArrow },
      );
      titleRect = { x: sf.frame.x + sf.frame.w - tl.w, y: sf.frame.y + sf.frame.h - tl.h, w: tl.w, h: tl.h };
      b.add({
        kind: 'group',
        name: 'Title block',
        layer: true,
        children: tl.draw(titleRect.x, titleRect.y, {
          northAngle: north,
          northCaption,
          scale: layout.scale,
          units: project.display.units,
        }),
      });
      calibrationShown = true;
    }
  }

  // Standalone scale bar / north arrow (no title block).
  let bottomLeftUsed = 0;
  const wantScaleBar = sheet.showScaleBar && !titleRect;
  const wantNorth = sheet.showNorthArrow && !titleRect;
  if (wantScaleBar || wantNorth) {
    const h = 18 * ui;
    const x0 = vp.x + inset;
    const y0 = vp.y + vp.h - inset - h;
    const northW = wantNorth ? h : 0;
    const barMax = Math.min(80 * ui, vp.w * 0.35);
    const w = northW + (wantScaleBar ? barMax + 8 * ui : 0) + 2 * ui;
    const items: SceneItem[] = [
      {
        kind: 'path',
        d: rectPath(x0, y0, w, h),
        fill: { color: '#ffffff', opacity: 0.94 },
        stroke: { color: '#9ca3af', width: 0.18 },
      },
    ];
    if (wantNorth) items.push(...northArrow(x0 + northW / 2, y0 + h * 0.49, h * 0.5, north, northCaption));
    if (wantScaleBar) {
      const sx = x0 + northW + 3 * ui;
      items.push({
        kind: 'text',
        text: layout.scaleStatement,
        x: sx,
        y: y0 + 2 * ui,
        size: 2 * ui,
        font: 'sans',
        color: '#111827',
        anchor: 'start',
        baseline: 'top',
        bold: true,
      });
      items.push(...scaleBar(sx, y0 + 6 * ui, barMax, layout.scale, ui, project.display.units).items);
    }
    b.add({ kind: 'group', name: 'Scale and north', layer: true, children: items });
    bottomLeftUsed = h + inset;
  }

  // Legend.
  let legendRect: Rect | undefined;
  if (showLegend) {
    const width = Math.min(project.legend.widthMm > 0 ? project.legend.widthMm : 70, vp.w * 0.45);
    const lay = layoutLegend(
      legend,
      fonts,
      width,
      ui,
      project.legend.showCalibration ? calibration : undefined,
    );
    if (project.legend.showCalibration) calibrationShown = true;
    const pos = project.legend.position;
    let x = vp.x + vp.w - inset - lay.w;
    let y = vp.y + inset;
    if (pos === 'top-left' || pos === 'bottom-left') x = vp.x + inset;
    if (pos === 'bottom-right') y = (titleRect ? titleRect.y : vp.y + vp.h) - inset - lay.h;
    if (pos === 'bottom-left') y = vp.y + vp.h - inset - bottomLeftUsed - lay.h;
    if (pos === 'custom' && project.legend.custom) {
      x = project.legend.custom.x;
      y = project.legend.custom.y;
    }
    legendRect = { x, y, w: lay.w, h: lay.h };
    b.add({ kind: 'group', name: 'Legend', layer: true, children: lay.draw(x, y) });
  }

  // The calibration state must always be on the output (row 32).
  if (!calibrationShown) {
    const maxW = Math.min(vp.w - 2 * inset, 160 * ui);
    decoItems.push(
      ...calibrationNote(calibration, fonts, vp.x + inset, vp.y + vp.h - inset - bottomLeftUsed, maxW, ui),
    );
  }
  if (decoItems.length) b.add({ kind: 'group', name: 'Sheet', layer: true, children: decoItems });

  if (titleRect) layout.titleBlock = titleRect;
  if (legendRect) layout.legend = legendRect;
  return { scene: b.build(), layout, legend, pdfItems, calibration, warnings };
}
