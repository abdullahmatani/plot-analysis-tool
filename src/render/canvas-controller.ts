import { apply, invert, transformBounds } from '@/core/affine';
import type { Bounds, Drawing, Project, Pt } from '@/core/types';
import { PdfTileManager } from '@/import/pdf/pdf-doc';
import { getProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useViewStore, type ViewTransform } from '@/store/view';
import { activeTool, bindToolContext, useToolUi } from '@/tools/registry';
import type { FrameInfo, SnapResult, ToolContext, ToolPointerEvent } from '@/tools/types';
import { substituteFont } from '@/underlay/cad-fonts';
import { useModelsStore, type DrawingModel } from '@/underlay/models';
import { drawingPlacement, visibleLayerFlags } from '@/underlay/pick';

import { UnderlayRenderer, type DrawingRenderState } from './underlay-renderer';
import { fitBounds, panBy, screenToWorld, visibleWorldBounds, worldToScreen, zoomAt } from './view';

/**
 * Imperative canvas controller: owns the WebGL underlay renderer and the 2D overlay, runs the
 * render loop (only when something changed), handles navigation (row 17: wheel/pinch zoom at the
 * cursor, middle-button / Space+drag / touch pan) and dispatches pointer events to the active tool.
 */

export type OverlayDrawer = (g: CanvasRenderingContext2D, f: FrameInfo) => void;

const overlays: { z: number; draw: OverlayDrawer }[] = [];

/** Registers an overlay layer (analysis objects, contours, labels, snap glyphs…). Lower z draws first. */
export function registerOverlay(z: number, draw: OverlayDrawer): () => void {
  const entry = { z, draw };
  overlays.push(entry);
  overlays.sort((a, b) => a.z - b.z);
  current?.requestRender();
  return () => {
    const i = overlays.indexOf(entry);
    if (i >= 0) overlays.splice(i, 1);
    current?.requestRender();
  };
}

export type Snapper = (
  screen: Pt,
  world: Pt,
  frame: FrameInfo,
  base: Pt | null,
  e: PointerEvent | null,
) => { pt: Pt; snap: SnapResult | null };

let snapper: Snapper | null = null;

export function setSnapper(s: Snapper | null) {
  snapper = s;
}

let current: CanvasController | null = null;

export function canvasController(): CanvasController | null {
  return current;
}

export function requestCanvasRender() {
  current?.requestRender();
}

export class CanvasController {
  renderer: UnderlayRenderer | null = null;
  webglError: string | null = null;
  private overlay: CanvasRenderingContext2D;
  private dirty = true;
  private raf = 0;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private uploaded = new Map<string, number>();
  private layerSig = new Map<string, string>();
  private tileManagers = new Map<string, PdfTileManager>();
  private pdfHidden = new Map<string, string>();
  private unsubs: (() => void)[] = [];
  private ro: ResizeObserver;
  private pointers = new Map<number, Pt>();
  private panning: { last: Pt } | null = null;
  private pinch: { dist: number; mid: Pt } | null = null;
  private spaceDown = false;
  private snapBase: Pt | null = null;
  private lastMove: PointerEvent | null = null;
  private moveScheduled = false;
  lastPointer: { screen: Pt; world: Pt; pt: Pt; snap: SnapResult | null } | null = null;
  readonly ctx: ToolContext;

  constructor(
    readonly container: HTMLElement,
    readonly glCanvas: HTMLCanvasElement,
    readonly overlayCanvas: HTMLCanvasElement,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level handle to the live controller
    current = this;
    try {
      this.renderer = new UnderlayRenderer(glCanvas);
    } catch (e) {
      this.webglError = (e as Error).message;
    }
    this.overlay = overlayCanvas.getContext('2d')!;
    this.ctx = {
      frame: () => this.frame(),
      requestRender: () => this.requestRender(),
      setCursor: (c) => (this.overlayCanvas.style.cursor = c),
      setSnapBase: (p) => (this.snapBase = p),
    };
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.unsubs.push(
      useViewStore.subscribe((s, p) => {
        if (
          s.view !== p.view ||
          s.hoverEntity !== p.hoverEntity ||
          s.pickedEntity !== p.pickedEntity ||
          s.selection !== p.selection
        )
          this.requestRender();
      }),
      useModelsStore.subscribe(() => this.requestRender()),
      useProjectStore.subscribe((s, p) => {
        if (s.history?.project !== p.history?.project) this.requestRender();
      }),
      useUiStore.subscribe((s, p) => {
        if (s.canvasBg !== p.canvasBg) this.requestRender();
      }),
    );
    this.attachEvents();
    bindToolContext(this.ctx);
    const onZoomExtents = (e: Event) => {
      const detail = (e as CustomEvent<{ onlyIfFirst?: boolean }>).detail;
      if (detail?.onlyIfFirst === false) return;
      // Wait for the model to be installed, then fit.
      setTimeout(() => this.zoomExtents(), 50);
    };
    window.addEventListener('pat:zoom-extents', onZoomExtents);
    this.unsubs.push(() => window.removeEventListener('pat:zoom-extents', onZoomExtents));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const u of this.unsubs) u();
    for (const t of this.tileManagers.values()) t.dispose();
    this.renderer?.dispose();
    bindToolContext(null);
    if (current === this) current = null;
  }

  // ---------------------------------------------------------------- frame & rendering

  frame(): FrameInfo {
    const view = useViewStore.getState().view;
    const w = this.cssW;
    const h = this.cssH;
    return {
      view,
      width: w,
      height: h,
      dpr: this.dpr,
      scale: view.scale,
      toScreen: (p) => worldToScreen(view, w, h, p),
      toWorld: (p) => screenToWorld(view, w, h, p),
      lightBg: useUiStore.getState().canvasBg === 'light',
    };
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    this.renderer?.resize(this.cssW, this.cssH, this.dpr);
    this.overlayCanvas.width = Math.round(this.cssW * this.dpr);
    this.overlayCanvas.height = Math.round(this.cssH * this.dpr);
    useViewStore.getState().setCanvasSize(this.cssW, this.cssH);
    this.requestRender();
  }

  requestRender() {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.renderNow());
  }

  private drawingStates(project: Project): DrawingRenderState[] {
    return [...project.drawings]
      .sort((a, b) => a.order - b.order)
      .map((d) => ({
        id: d.id,
        placement: drawingPlacement(d),
        opacity: d.opacity,
        ghost: d.ghost,
        visible: d.visible,
        invertOnDark: d.source.kind === 'pdf',
      }));
  }

  private syncGpu(project: Project) {
    const r = this.renderer;
    if (!r) return;
    const models = useModelsStore.getState().models;
    const ids = new Set(project.drawings.map((d) => d.id));
    for (const id of [...this.uploaded.keys()]) {
      if (!ids.has(id) || !models[id] || models[id].status !== 'ready') {
        r.removeDrawing(id);
        this.uploaded.delete(id);
        this.layerSig.delete(id);
        this.tileManagers.get(id)?.dispose();
        this.tileManagers.delete(id);
      }
    }
    for (const d of project.drawings) {
      const m = models[d.id];
      if (!m || m.status !== 'ready' || !m.render || !m.result) continue;
      if (this.uploaded.get(d.id) !== m.version) {
        if (d.source.kind === 'pdf') {
          r.removeDrawing(d.id);
          r.ensureDrawing(d.id);
          this.setupPdf(d, m);
        } else {
          r.setDrawing(d.id, m.render, m.result.store.layers.length);
        }
        this.uploaded.set(d.id, m.version);
        this.layerSig.delete(d.id);
      }
      const sig = d.hiddenSourceLayers.join('\u0000');
      if (this.layerSig.get(d.id) !== sig) {
        this.layerSig.set(d.id, sig);
        if (d.source.kind === 'pdf') {
          const tm = this.tileManagers.get(d.id);
          if (tm && m.pdf && this.pdfHidden.get(d.id) !== sig) {
            this.pdfHidden.set(d.id, sig);
            tm.setHiddenGroups(m.pdf.doc, d.hiddenSourceLayers);
          }
        } else {
          r.setLayerVisibility(d.id, visibleLayerFlags(d));
        }
      }
    }
  }

  private setupPdf(d: Drawing, m: DrawingModel) {
    this.tileManagers.get(d.id)?.dispose();
    if (!m.pdf || !m.result?.page) return;
    const tm = new PdfTileManager(m.pdf.page, m.result.page.width, m.result.page.height, (tiles) => {
      this.renderer?.setTiles(d.id, tiles);
      this.requestRender();
    });
    this.tileManagers.set(d.id, tm);
    this.pdfHidden.delete(d.id);
  }

  private renderNow() {
    this.raf = 0;
    if (!this.dirty) return;
    this.dirty = false;
    const project = getProject();
    const f = this.frame();
    const lightBg = f.lightBg;
    if (project) {
      this.syncGpu(project);
      const states = this.drawingStates(project);
      for (const s of states) {
        const tm = this.tileManagers.get(s.id);
        if (tm && s.visible) tm.update(f.view, f.width, f.height, f.dpr, s.placement);
      }
      if (this.renderer) {
        const t0 = performance.now();
        // Large drawings are uploaded over several frames (NFR-2: no long main-thread blocks).
        if (this.renderer.uploadPending()) this.requestRender();
        this.renderer.render(f.view, f.width, f.height, states, lightBg);
        this.lastGpuMs = performance.now() - t0;
      }
    }
    // 2D overlay.
    const g = this.overlay;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (project) {
      this.drawUnderlayText(g, f, project);
      for (const o of overlays) {
        g.save();
        try {
          o.draw(g, f);
        } catch (e) {
          console.error('overlay error', e);
        }
        g.restore();
      }
      const tool = activeTool();
      if (tool?.render) {
        g.save();
        tool.render(g, f);
        g.restore();
      }
    }
    this.frames++;
  }

  frames = 0;
  lastGpuMs = 0;

  /** CAD TEXT/MTEXT drawn with Canvas 2D (bundled fonts; row 24). */
  private drawUnderlayText(g: CanvasRenderingContext2D, f: FrameInfo, project: Project) {
    const models = useModelsStore.getState().models;
    const visWorld = visibleWorldBounds(f.view, f.width, f.height);
    let budget = 6000;
    const sorted = [...project.drawings].filter((d) => d.visible).sort((a, b) => a.order - b.order);
    for (const d of sorted) {
      const m = models[d.id];
      const store = m?.result?.store;
      if (!m?.textIndex || !store || !m.render || d.source.kind === 'pdf') continue;
      const place = drawingPlacement(d);
      let inv;
      try {
        inv = invert(place);
      } catch {
        continue;
      }
      const vis = transformBounds(inv, visWorld);
      const det = place[0] * place[3] - place[1] * place[2];
      const unitPx = f.scale * Math.sqrt(Math.abs(det));
      const placeRot = Math.atan2(place[1], place[0]);
      const flags = visibleLayerFlags(d);
      const ids = m.textIndex.search(vis.minX, vis.minY, vis.maxX, vis.maxY);
      g.globalAlpha = d.opacity * (d.ghost ? 0.45 : 1);
      for (const k of ids) {
        if (budget <= 0) break;
        const i = m.render.textIds[k];
        if (!flags[store.layer[i]]) continue;
        const o = store.geomStart[i];
        const gm = store.geom;
        const hPx = gm[o + 2] * unitPx;
        if (hPx < 2 || hPx > 4000) continue;
        const text = store.texts[store.textIndex[i]];
        if (!text) continue;
        budget--;
        const p = f.toScreen(apply(place, { x: gm[o], y: gm[o + 1] }));
        const rot = gm[o + 3] + placeRot + f.view.rotation;
        // Bundled substitute for the text style's SHX/TTF font, with width compensation (row 24).
        const sub = substituteFont(
          store.geomLen[i] > 10 && gm[o + 10] >= 0 ? store.fonts?.[gm[o + 10]] : undefined,
        );
        const wf = (gm[o + 4] || 1) * sub.widthScale;
        const hAlign = gm[o + 5];
        const vAlign = gm[o + 6];
        let rgb = store.color[i];
        if (f.lightBg && rgb === 0xffffff) rgb = 0;
        if (d.ghost) rgb = f.lightBg ? 0x9ca3af : 0x6b7280;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(-rot);
        // Negative width factor = mirrored (backward) text; oblique angle slants the glyphs.
        if (wf !== 1) g.scale(wf, 1);
        const oblique = gm[o + 7];
        if (oblique) g.transform(1, 0, -Math.tan(oblique), 1, 0, 0);
        g.fillStyle = `#${rgb.toString(16).padStart(6, '0')}`;
        g.font = `${hPx * 1.38}px ${sub.css}`;
        g.textAlign = hAlign === 1 ? 'center' : hAlign === 2 ? 'right' : 'left';
        g.textBaseline =
          vAlign === 3 ? 'top' : vAlign === 2 ? 'middle' : vAlign === 1 ? 'bottom' : 'alphabetic';
        const lines = text.split('\n');
        const lh = hPx * 1.667 * (gm[o + 9] || 1);
        const startY =
          vAlign === 3 ? 0 : vAlign === 2 ? (-(lines.length - 1) * lh) / 2 : -(lines.length - 1) * lh;
        for (let li = 0; li < lines.length; li++) g.fillText(lines[li], 0, startY + li * lh);
        g.restore();
      }
      g.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- view operations

  setView(v: ViewTransform) {
    useViewStore.getState().setView(v);
  }

  /** World bounds of all visible drawings (and any extra bounds, e.g. analysis objects). */
  contentBounds(extra: Bounds[] = []): Bounds | null {
    const project = getProject();
    if (!project) return null;
    const models = useModelsStore.getState().models;
    const all: Bounds[] = [...extra];
    for (const d of project.drawings) {
      const m = models[d.id];
      if (!d.visible || !m?.result) continue;
      all.push(transformBounds(drawingPlacement(d), m.result.extents));
    }
    if (!all.length) return null;
    return {
      minX: Math.min(...all.map((b) => b.minX)),
      minY: Math.min(...all.map((b) => b.minY)),
      maxX: Math.max(...all.map((b) => b.maxX)),
      maxY: Math.max(...all.map((b) => b.maxY)),
    };
  }

  zoomExtents(extra: Bounds[] = []) {
    const b = this.contentBounds([...extra, ...extentProviders.flatMap((p) => p())]);
    if (!b) return;
    this.setView(fitBounds(b, this.cssW, this.cssH, useViewStore.getState().view.rotation));
  }

  zoomToBounds(b: Bounds, margin = 48) {
    this.setView(fitBounds(b, this.cssW, this.cssH, useViewStore.getState().view.rotation, margin));
  }

  zoomBy(factor: number, at?: Pt) {
    const v = useViewStore.getState().view;
    this.setView(zoomAt(v, this.cssW, this.cssH, at ?? { x: this.cssW / 2, y: this.cssH / 2 }, factor));
  }

  rotateBy(delta: number) {
    const v = useViewStore.getState().view;
    this.setView({ ...v, rotation: normaliseRotation(v.rotation + delta) });
  }

  setRotation(r: number) {
    this.setView({ ...useViewStore.getState().view, rotation: normaliseRotation(r) });
  }

  // ---------------------------------------------------------------- input

  private toolEvent(e: PointerEvent): ToolPointerEvent {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const f = this.frame();
    const world = f.toWorld(screen);
    const tool = activeTool();
    let pt = world;
    let snap: SnapResult | null = null;
    if (tool?.snaps && snapper) {
      const r = snapper(screen, world, f, this.snapBase, e);
      pt = r.pt;
      snap = r.snap;
    }
    return {
      screen,
      world,
      pt,
      snap,
      button: e.button,
      buttons: e.buttons,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      pointerType: e.pointerType,
      native: e,
    };
  }

  private attachEvents() {
    const el = this.overlayCanvas;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this.zoomBy(Math.pow(1.0015, -delta), at);
    };
    const onDown = (e: PointerEvent) => {
      el.focus({ preventScroll: true });
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        this.panning = null;
        return;
      }
      const tool = activeTool();
      const panTool = tool?.id === 'pan';
      const touchPan = e.pointerType === 'touch' && (tool?.id === 'select' || panTool);
      if (e.button === 1 || (e.button === 0 && (this.spaceDown || panTool || touchPan))) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.panning = { last: { x: e.clientX, y: e.clientY } };
        el.style.cursor = 'grabbing';
        return;
      }
      if (e.button === 0 || e.button === 2) {
        el.setPointerCapture(e.pointerId);
        tool?.pointerDown?.(this.toolEvent(e), this.ctx);
        this.requestRender();
      }
    };
    const processMove = () => {
      this.moveScheduled = false;
      const e = this.lastMove;
      if (!e) return;
      const te = this.toolEvent(e);
      this.lastPointer = { screen: te.screen, world: te.world, pt: te.pt, snap: te.snap };
      useViewStore.getState().setCursor(te.pt);
      activeTool()?.pointerMove?.(te, this.ctx);
      this.requestRender();
    };
    const onMove = (e: PointerEvent) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const rect = el.getBoundingClientRect();
        let v = panBy(useViewStore.getState().view, mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
        v = zoomAt(
          v,
          this.cssW,
          this.cssH,
          { x: mid.x - rect.left, y: mid.y - rect.top },
          dist / Math.max(1, this.pinch.dist),
        );
        this.setView(v);
        this.pinch = { dist, mid };
        return;
      }
      if (this.panning) {
        const dx = e.clientX - this.panning.last.x;
        const dy = e.clientY - this.panning.last.y;
        this.panning.last = { x: e.clientX, y: e.clientY };
        this.setView(panBy(useViewStore.getState().view, dx, dy));
        return;
      }
      this.lastMove = e;
      if (!this.moveScheduled) {
        this.moveScheduled = true;
        requestAnimationFrame(processMove);
      }
    };
    const onUp = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.panning) {
        this.panning = null;
        el.style.cursor = this.spaceDown ? 'grab' : (activeTool()?.cursor ?? 'default');
        return;
      }
      if (e.button === 0 || e.button === 2) {
        activeTool()?.pointerUp?.(this.toolEvent(e), this.ctx);
        this.requestRender();
      }
    };
    const onDbl = (e: MouseEvent) => {
      activeTool()?.doubleClick?.(this.toolEvent(e as PointerEvent), this.ctx);
      this.requestRender();
    };
    const onLeave = () => {
      useViewStore.getState().setCursor(null);
      useViewStore.getState().set({ hoverEntity: null, hoverObject: null });
      this.lastPointer = null;
      this.requestRender();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' && !this.spaceDown && document.activeElement === el) {
        this.spaceDown = true;
        el.style.cursor = 'grab';
        e.preventDefault();
        return;
      }
      if (document.activeElement !== el) return;
      const tool = activeTool();
      if (tool?.keyDown?.(e, this.ctx)) {
        e.preventDefault();
        e.stopPropagation();
        this.requestRender();
        return;
      }
      // Typed dimensions (e.g. "15", "30,20", "@10<45"): collected while a tool accepts input.
      if (tool?.typedInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ui = useToolUi.getState();
        if (
          /^[0-9.,@<\-+ a-zA-ZøØ°]$/.test(e.key) &&
          (ui.typed || /[0-9.@\-+øØ]/.test(e.key) || tool.typedStart?.(e.key))
        ) {
          ui.set({ typed: ui.typed + e.key });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === 'Backspace' && ui.typed) {
          ui.set({ typed: ui.typed.slice(0, -1) });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === 'Enter' && ui.typed) {
          const ok = tool.typedInput(ui.typed, this.ctx);
          ui.set({ typed: ok ? '' : ui.typed });
          e.preventDefault();
          e.stopPropagation();
          this.requestRender();
          return;
        }
        if (e.key === 'Escape' && ui.typed) {
          ui.set({ typed: '' });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && this.spaceDown) {
        this.spaceDown = false;
        el.style.cursor = activeTool()?.cursor ?? 'default';
      }
    };
    const onContext = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp);
    this.unsubs.push(() => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('dblclick', onDbl);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp);
    });
  }
}

function normaliseRotation(r: number): number {
  const t = Math.PI * 2;
  let x = r % t;
  if (x > Math.PI) x -= t;
  if (x <= -Math.PI) x += t;
  return Math.abs(x) < 1e-12 ? 0 : x;
}

/** Extra content bounds (analysis objects, datasets) contributed by feature modules for zoom extents. */
const extentProviders: (() => Bounds[])[] = [];

export function registerExtentProvider(fn: () => Bounds[]): () => void {
  extentProviders.push(fn);
  return () => {
    const i = extentProviders.indexOf(fn);
    if (i >= 0) extentProviders.splice(i, 1);
  };
}
