import { canvasController, requestCanvasRender } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useViewStore } from '@/store/view';

import { hitContour } from './compute';
import { useContoursUi } from './store';

/**
 * Canvas → table cross-highlighting (row 68): with the Select tool, hovering a contour highlights its
 * row in the data grid and clicking selects the row (Shift/Ctrl adds). Analysis objects keep priority:
 * contours are picked only where no object is under the cursor. Listens on the window so no shared
 * canvas code changes; the canvas element is recognised through the live canvas controller.
 */
export function installContourPicking(): () => void {
  let down: { x: number; y: number } | null = null;

  const onCanvas = (e: Event) => {
    const c = canvasController();
    return !!c && e.target === c.overlayCanvas;
  };
  const worldOf = (e: PointerEvent) => {
    const c = canvasController()!;
    const rect = c.overlayCanvas.getBoundingClientRect();
    const f = c.frame();
    return { world: f.toWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }), scale: f.scale };
  };
  const enabled = () => useViewStore.getState().activeTool === 'select' && !!getProject()?.datasets.length;
  const setHover = (next: { ds: string; row: number } | null) => {
    const cur = useContoursUi.getState().hover;
    if (cur?.ds === next?.ds && cur?.row === next?.row) return;
    useContoursUi.getState().set({ hover: next });
  };

  const onMove = (e: PointerEvent) => {
    if (!onCanvas(e) || e.buttons !== 0) return;
    if (!enabled() || useViewStore.getState().hoverObject) return setHover(null);
    const { world, scale } = worldOf(e);
    const hit = hitContour(getProject()!, world, 6 / scale);
    setHover(hit ? { ds: hit.datasetId, row: hit.row } : null);
  };
  const onDown = (e: PointerEvent) => {
    down = onCanvas(e) && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onUp = (e: PointerEvent) => {
    const start = down;
    down = null;
    if (!start || !onCanvas(e) || !enabled()) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    const p = getProject()!;
    const { world, scale } = worldOf(e);
    const objectHit = useViewStore.getState().hoverObject;
    const hit = objectHit ? null : hitContour(p, world, 6 / scale);
    const ui = useContoursUi.getState();
    if (!hit) {
      if (!e.shiftKey && !e.ctrlKey && ui.selection) ui.set({ selection: null });
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const cur = ui.selection?.ds === hit.datasetId ? ui.selection.rows : [];
    const rows = additive
      ? cur.includes(hit.row)
        ? cur.filter((r) => r !== hit.row)
        : [...cur, hit.row]
      : [hit.row];
    ui.set({ activeDatasetId: hit.datasetId, selection: rows.length ? { ds: hit.datasetId, rows } : null });
    ui.revealRow({ ds: hit.datasetId, row: hit.row });
    if (useUiStore.getState().inspectorTab !== 'data' && useViewStore.getState().selection.length === 0)
      useUiStore.getState().setInspectorTab('data');
  };
  const onOut = (e: PointerEvent) => {
    if (onCanvas(e)) setHover(null);
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointerout', onOut, true);
  const unsub = useContoursUi.subscribe((s, prev) => {
    if (s.hover !== prev.hover || s.selection !== prev.selection) requestCanvasRender();
  });
  return () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointerout', onOut, true);
    unsub();
  };
}
