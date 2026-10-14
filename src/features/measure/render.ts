import type { AnalysisObject, Project, Style } from '@/core/types';
import type { FrameInfo } from '@/tools/types';

import { kindRenderers } from '@/features/objects/render';
import { hexToRgba, labelHeightPx } from '@/features/objects/style';

import { annotationLines, modeForGeometry } from './compute';
import { drawMeasurement } from './draw';

/**
 * Canvas renderer for measurement annotations (kind 'measurement'): dimension graphics with text in
 * the current display units, so switching units updates every annotation instantly (row 26).
 */
export function renderMeasurement(
  g: CanvasRenderingContext2D,
  o: AnalysisObject,
  s: Style,
  f: FrameInfo,
  p: Project,
) {
  const mode = o.measurement?.mode ?? modeForGeometry(o.geometry);
  drawMeasurement(g, f, mode, o.geometry, annotationLines(p, o), {
    color: hexToRgba(s.stroke, s.strokeOpacity),
    fill: s.hatch !== 'none' && s.fillOpacity > 0 ? hexToRgba(s.fill, s.fillOpacity) : undefined,
    textPx: Math.max(9, labelHeightPx(s, f.scale) * 1.2),
    lightBg: f.lightBg,
  });
}

export function registerMeasurementRenderer(): () => void {
  const prev = kindRenderers.measurement;
  kindRenderers.measurement = renderMeasurement;
  return () => {
    if (kindRenderers.measurement === renderMeasurement) kindRenderers.measurement = prev;
  };
}
