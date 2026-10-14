import type { Pt } from '@/core/types';
import type { ViewTransform } from '@/store/view';

/** Snap result (row 27): the snapped world point and why. */
export interface SnapResult {
  pt: Pt;
  mode: string;
  /** Source of the snap (underlay entity or analysis object), for tooltips. */
  source?:
    | { kind: 'underlay'; drawingId: string; index: number }
    | { kind: 'object'; id: string }
    | { kind: 'grid' }
    | { kind: 'anchor'; id: string };
}

export interface ToolPointerEvent {
  screen: Pt;
  /** Raw world position under the cursor. */
  world: Pt;
  /** Snapped/constrained world position (equals `world` when no snap applies). */
  pt: Pt;
  snap: SnapResult | null;
  button: number;
  buttons: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  pointerType: string;
  native: PointerEvent;
}

export interface FrameInfo {
  view: ViewTransform;
  width: number;
  height: number;
  dpr: number;
  toScreen(p: Pt): Pt;
  toWorld(p: Pt): Pt;
  /** Screen pixels per world metre. */
  scale: number;
  lightBg: boolean;
}

export interface ToolContext {
  frame(): FrameInfo;
  requestRender(): void;
  setCursor(c: string): void;
  /** Previous point for perpendicular/tangent snaps and ortho/polar constraints. */
  setSnapBase(p: Pt | null): void;
}

export interface Tool {
  id: string;
  title: string;
  cursor?: string;
  /** Wants snapping applied to pointer events. */
  snaps?: boolean;
  activate?(ctx: ToolContext): void;
  deactivate?(ctx: ToolContext): void;
  pointerDown?(e: ToolPointerEvent, ctx: ToolContext): void;
  pointerMove?(e: ToolPointerEvent, ctx: ToolContext): void;
  pointerUp?(e: ToolPointerEvent, ctx: ToolContext): void;
  doubleClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  /** Return true when the key was handled. */
  keyDown?(e: KeyboardEvent, ctx: ToolContext): boolean;
  /** Draws previews in screen space (ctx is in CSS pixels). */
  render?(g: CanvasRenderingContext2D, f: FrameInfo): void;
  /** Numeric input typed while the tool is active (e.g. "15" or "30,20"). */
  typedInput?(value: string, ctx: ToolContext): boolean;
  /** Extra characters that may start typed input (e.g. "d" for a diameter); default digits/@/-/+/Ø. */
  typedStart?(key: string): boolean;
  /** Short prompt shown in the canvas hint bar. */
  hint?(): string;
}
