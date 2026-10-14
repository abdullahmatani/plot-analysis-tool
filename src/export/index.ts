/**
 * Export backends (FDR §8.10, rows 75–81; row 48 for Unicode/Arabic text).
 *
 * Build a backend-neutral {@link Scene} (paper mm, y-down) once, then render it with any backend:
 * vector PDF ({@link renderScenePdf}), SVG ({@link renderSceneSvg}), canvas/PNG and the WYSIWYG
 * preview ({@link renderSceneCanvas}). DXF export of analysis geometry in drawing/world coordinates
 * uses {@link DxfWriter}. Fonts are supplied as bytes ({@link createFontSet}); nothing is fetched.
 */

export type {
  FillStyle,
  FontFamily,
  GroupItem,
  HatchPatternName,
  HatchStyle,
  ImageItem,
  PathCmd,
  PathItem,
  PdfPageItem,
  Scene,
  SceneItem,
  SceneMeta,
  StrokeStyle,
  TextAnchor,
  TextBaseline,
  TextItem,
  TextOptions,
  FlatSubpath,
} from './scene';
export {
  DEFAULT_ARC_SEGMENT,
  MITER_LIMIT,
  MM_PER_PT,
  PT_PER_MM,
  SceneBuilder,
  arcPath,
  arcSweepToCubics,
  arcToCubics,
  bulgePolylineToPath,
  circlePath,
  ellipsePath,
  ellipseToCubics,
  flattenPath,
  paperRotation,
  pathBounds,
  polylinePath,
  rectPath,
  transformPath,
  walkScene,
} from './scene';

export type {
  EmMetrics,
  FontBytes,
  FontData,
  FontSet,
  LoadedFont,
  ShapedGlyph,
  ShapedRun,
  TextLayout,
  TextLayoutOptions,
  TextLine,
} from './fonts';
export {
  DEFAULT_METRICS,
  LINE_HEIGHT,
  anchorFraction,
  baselineOffset,
  createFontSet,
  cssFontFamily,
  emMetrics,
  layoutText,
  layoutToPath,
  lineDirection,
  placeOutline,
  shapeWithFontkit,
  splitLines,
} from './fonts';

export type { BidiClass } from './bidi';
export {
  bidiClass,
  isArabicScript,
  mirrorCodePoint,
  paragraphLevel,
  reorderRuns,
  resolveLevels,
  visualString,
} from './bidi';

export type { HatchGeometry } from './hatch';
export { hatchFamilies, hatchGeometry } from './hatch';

export type { PdfRenderOptions } from './pdf-backend';
export { pdfPathOps, renderScenePdf, renderScenesPdf } from './pdf-backend';

export type { SvgRenderOptions } from './svg-backend';
export { renderSceneSvg, svgPathData } from './svg-backend';

export type { Canvas2D, CanvasRenderOptions, PlacedImage } from './canvas-backend';
export { canvasSizeForDpi, decodeSceneImages, renderSceneCanvas } from './canvas-backend';

export type {
  DxfColor,
  DxfEntityStyle,
  DxfHAlign,
  DxfHatchOptions,
  DxfLayerOptions,
  DxfMTextOptions,
  DxfPolylineOptions,
  DxfTextOptions,
  DxfVAlign,
  DxfWriterOptions,
  MTextAttachment,
  TextOutlineOptions,
} from './dxf-writer';
export {
  ACI_RGB,
  DASH_TO_LINETYPE,
  DxfWriter,
  STANDARD_LINETYPES,
  dxfFloat,
  escapeMText,
  nearestAci,
  sanitizeName,
  textToOutlines,
} from './dxf-writer';

export type { Rgba } from './format';
export { base64Encode, fmt, hexColor, opacityOf, parseColor, xmlEscape } from './format';
