/**
 * Project data model (FDR §5.4). All analysis geometry is stored in world metres as float64.
 * Drawings are placed in the world by a placement transform (calibration ∘ alignment).
 */

export type Units = 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft';

export interface Pt {
  x: number;
  y: number;
}

/** DXF-style vertex: `bulge` = tan(θ/4) of the arc segment that starts at this vertex (0/undefined = straight). */
export interface Vertex extends Pt {
  bulge?: number;
}

/**
 * 2D affine transform [a, b, c, d, e, f] mapping (x, y) → (a·x + c·y + e, b·x + d·y + f)
 * (same convention as Canvas 2D / SVG matrices).
 */
export type Affine2D = [number, number, number, number, number, number];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type DrawingKind = 'dxf' | 'dwg' | 'pdf';

export interface Drawing {
  id: string;
  name: string;
  source: { kind: DrawingKind; fileName: string; sha256: string; blobKey: string; size: number };
  /** PDF page (1-based). */
  page?: number;
  /** CAD layout name (model space when undefined). */
  layout?: string;
  /** Native units of the drawing as read from the file (CAD), or 'pt' for PDF. */
  nativeUnits?: Units | 'pt' | 'unitless';
  /** User override of CAD drawing units (row 26). */
  unitsOverride?: Units;
  calibration?: Calibration;
  /** Sub-drawing → plot plan alignment, applied after calibration (row 34). */
  alignment?: Affine2D;
  opacity: number;
  /** Greyscale "ghost" rendering so analysis stands out (row 19). */
  ghost: boolean;
  visible: boolean;
  /** Source layers (DXF/DWG) or optional-content groups (PDF) hidden by the user. */
  hiddenSourceLayers: string[];
  /** Draw order: lower first. */
  order: number;
  /** Verified by a "Check distance" measurement (row 32). */
  verified?: { at: string; expected: number; measured: number };
}

export type CalibrationMethod = 'cad-units' | 'two-point' | 'multi-point' | 'ratio' | 'coordinates';

export interface CalibrationReference {
  drawing: Pt;
  world: Pt | null;
  /** For distance references: index of the paired reference and the real distance in metres. */
  pair?: number;
  distance?: number;
  residual?: number;
}

export interface Calibration {
  method: CalibrationMethod;
  /** Drawing units → world metres. */
  transform: Affine2D;
  references: CalibrationReference[];
  /** Metres, multi-point and coordinates methods only. */
  residualRms?: number;
  /** Stated ratio, e.g. 500 for 1:500 (ratio method). */
  ratio?: number;
  separateXY?: boolean;
  at: string;
}

export type HatchPattern =
  | 'none'
  | 'solid'
  | 'diagonal'
  | 'back-diagonal'
  | 'cross'
  | 'diagonal-cross'
  | 'horizontal'
  | 'vertical'
  | 'dots';
export type DashStyle = 'solid' | 'dash' | 'dot' | 'dash-dot' | 'long-dash';

export interface Style {
  stroke: string;
  /** Paper millimetres (screen: 1 mm ≈ 3.78 px at 100 % UI scale). */
  strokeWidth: number;
  strokeOpacity: number;
  dash: DashStyle;
  fill: string;
  fillOpacity: number;
  hatch: HatchPattern;
  labelColor: string;
  /** Label text height; unit given by `labelSizeUnit`. */
  labelSize: number;
  labelSizeUnit: 'paper' | 'world';
  labelHalo: boolean;
  labelFont: 'sans' | 'serif' | 'mono';
  labelBold: boolean;
}

export type StyleOverride = Partial<Style>;

export interface StylePreset {
  id: string;
  name: string;
  style: Style;
}

export interface AnalysisLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  style: Style;
  legend: { show: boolean; label?: string; group?: string };
  /** Auto-numbering prefix and next number for bubble tags on this layer (row 41). */
  tagPrefix?: string;
  nextTag?: number;
}

export type Geometry =
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'arc'; c: Pt; r: number; a0: number; a1: number }
  | { type: 'rect'; c: Pt; w: number; h: number; rot: number }
  | { type: 'ellipse'; c: Pt; rx: number; ry: number; rot: number }
  | { type: 'polyline'; pts: Vertex[]; closed: boolean }
  | { type: 'multipolygon'; rings: Vertex[][] }
  | { type: 'point'; p: Pt };

export type GeometryType = Geometry['type'];

export type LabelPlacement = 'centroid' | 'boundary' | 'leader' | 'top';

export interface LabelSpec {
  template: string;
  placement: LabelPlacement;
  /** World offset of the label anchor (leader end) relative to the placement point. */
  offset?: Pt;
  visible: boolean;
}

export type ObjectKind = 'shape' | 'trace' | 'offset' | 'measurement' | 'text' | 'callout' | 'tag' | 'cloud';

export interface MeasurementInfo {
  mode: 'distance' | 'chain' | 'length' | 'area' | 'radius' | 'angle' | 'check' | 'point';
  /** For angle measurements: vertex is pts[1]. */
  value?: number;
}

export interface AnalysisObject {
  id: string;
  layerId: string;
  name: string;
  kind: ObjectKind;
  geometry: Geometry;
  style: StyleOverride;
  label?: LabelSpec;
  /** Free text / callout / tag text. */
  text?: string;
  attributes: Record<string, string | number>;
  category?: string;
  notes?: string;
  derived?: OffsetDerivation;
  measurement?: MeasurementInfo;
  /** Sequence number for bubble tags. */
  tagNumber?: number;
  createdAt: string;
}

export interface OffsetDerivation {
  kind: 'offset';
  sourceId: string;
  distance: number;
  join: 'round' | 'miter' | 'square' | 'bevel';
  cap?: 'round' | 'butt' | 'square';
  miterLimit?: number;
  /** Multi-ring group id (row 58). */
  ringGroup?: string;
}

export interface Anchor {
  id: string;
  name: string;
  p: Pt;
}

export type CellValue = string | number | null;

export interface StyleRule {
  id: string;
  kind: 'categorical' | 'graduated';
  column: string;
  /**
   * Categorical: value → colour. Graduated: class breaks (ascending upper bounds) with colours.
   * `dash` / `fillOpacity` on a category or class override the rule-wide values (row 67).
   */
  categories?: {
    value: string;
    color: string;
    label?: string;
    hidden?: boolean;
    dash?: DashStyle;
    fillOpacity?: number;
  }[];
  breaks?: { upTo: number; color: string; label?: string; dash?: DashStyle; fillOpacity?: number }[];
  ramp?: string;
  dash?: DashStyle;
  fillOpacity?: number;
}

export interface SizeColumnStyle {
  column: string;
  visible: boolean;
  color: string;
  dash: DashStyle;
  fillOpacity: number;
  strokeWidth: number;
  legendLabel?: string;
}

export interface ContourDataset {
  id: string;
  name: string;
  visible: boolean;
  table: { columns: string[]; rows: CellValue[][] };
  mapping: {
    position: { mode: 'xy' | 'plant' | 'anchor'; x?: string; y?: string; anchor?: string; coordUnit?: Units };
    sizeColumns: string[];
    sizeMode: 'radius' | 'diameter';
    sizeUnit: Units;
    label?: string;
    group?: string;
    color?: string;
    shape?: string;
    width?: string;
    height?: string;
    rotation?: string;
  };
  sizeStyles: SizeColumnStyle[];
  styleRules: StyleRule[];
  labelTemplate: string;
  labelPlacement: 'top' | 'centre' | 'leader';
  filter?: string;
  envelope: boolean;
  order: number;
  legendGroup?: string;
  source?: { fileName: string; importedAt: string; sheet?: string };
  /** Contour label text style (row 70). Defaults: 2.5 mm paper, ring colour, halo, visible. */
  labelStyle?: ContourLabelStyle;
  /** Envelope outline style and legend label (row 74). Defaults: size-column colour, 2× width. */
  envelopeStyle?: {
    strokeWidth?: number;
    dash?: DashStyle;
    fillOpacity?: number;
    legendLabel?: string;
    /** Show only the envelope, not the individual rings. */
    hideRings?: boolean;
  };
}

export interface ContourLabelStyle {
  visible: boolean;
  /** Paper millimetres. */
  size: number;
  /** Fixed label colour; undefined = the ring's colour. */
  color?: string;
  halo: boolean;
}

export interface LegendEntryOverride {
  key: string;
  title?: string;
  hidden?: boolean;
  order?: number;
  group?: string;
}

export interface LegendConfig {
  title: string;
  overrides: LegendEntryOverride[];
  position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'custom';
  custom?: Pt;
  widthMm: number;
  showCalibration: boolean;
}

export type PaperSize =
  'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'ANSI A' | 'ANSI B' | 'ANSI C' | 'ANSI D' | 'ANSI E' | 'custom';

export interface TitleBlock {
  title: string;
  project: string;
  drawingNo: string;
  revision: string;
  date: string;
  preparedBy: string;
  checkedBy: string;
  notes: string;
}

export interface SheetLayout {
  paper: PaperSize;
  customMm?: { w: number; h: number };
  orientation: 'landscape' | 'portrait';
  marginsMm: number;
  /** Print scale denominator (e.g. 1000 for 1:1000); null = fit to viewport. */
  scale: number | null;
  /** World-space centre of the printed viewport and its rotation (radians). */
  viewCentre?: Pt;
  viewRotation: number;
  titleBlock: TitleBlock;
  showScaleBar: boolean;
  showNorthArrow: boolean;
  showLegend: boolean;
  showTitleBlock: boolean;
}

export interface ExportProfile {
  id: string;
  name: string;
  format: 'pdf' | 'png' | 'svg' | 'dxf' | 'csv' | 'xlsx';
  sheet: SheetLayout;
  dpi: number;
  region: 'sheet' | 'view' | 'window';
  window?: Bounds;
  includeUnderlay: boolean;
  includeLegend: boolean;
  dxfCoordinates: 'drawing' | 'world';
  dxfDrawingId?: string;
}

export interface SavedView {
  id: string;
  name: string;
  centre: Pt;
  scale: number;
  rotation: number;
}

export interface ProjectDisplay {
  units: Units;
  precision: number;
  areaUnits: 'm2' | 'ha' | 'km2' | 'ft2' | 'acre';
  angleUnits: 'deg' | 'rad';
  /** Show coordinates as plant E/N (only meaningful when a coordinates calibration exists). */
  plantCoords: boolean;
}

export interface NorthSettings {
  /** Angle of true north measured counter-clockwise from plant north (+Y), radians. */
  trueNorthAngle: number;
  /** Which north the north arrow shows. */
  arrow: 'plant' | 'true';
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  display: ProjectDisplay;
  drawings: Drawing[];
  layers: AnalysisLayer[];
  activeLayerId: string;
  objects: AnalysisObject[];
  anchors: Anchor[];
  datasets: ContourDataset[];
  legend: LegendConfig;
  exportProfiles: ExportProfile[];
  sheet: SheetLayout;
  views: SavedView[];
  stylePresets: StylePreset[];
  north: NorthSettings;
  /** Tessellation chord tolerance in metres for arc offsets (row 61). */
  chordTolerance: number;
}
