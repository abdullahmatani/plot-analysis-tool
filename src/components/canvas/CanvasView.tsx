import { useEffect, useRef, useState } from 'react';
import { FileUp, Loader2, X } from 'lucide-react';

import { formatArea, formatLength } from '@/core/units';
import { importFiles, syncModels, useImportStore } from '@/import/import-drawing';
import { CanvasController } from '@/render/canvas-controller';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useViewStore } from '@/store/view';
import { useToolUi } from '@/tools/registry';
import { entityInfo } from '@/underlay/entity-info';
import { useModelsStore } from '@/underlay/models';

/** Canvas area: WebGL underlay + 2D overlay, drag-and-drop import (row 13) and progress (row 21). */
export function CanvasView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const bg = useUiStore((s) => s.canvasBg);
  const project = useProjectStore((s) => s.history?.project ?? null);
  const drawingsCount = project?.drawings.length ?? 0;

  useEffect(() => {
    const c = new CanvasController(containerRef.current!, glRef.current!, overlayRef.current!);
    setWebglError(c.webglError);
    (window as unknown as { __patCanvas?: CanvasController }).__patCanvas = c;
    return () => c.dispose();
  }, []);

  // Parse/load drawings of the open project.
  useEffect(() => {
    void syncModels(project);
  }, [project?.drawings, project]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ background: bg === 'dark' ? '#0b0f14' : '#ffffff' }}
      data-testid="canvas-container"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void importFiles(files);
      }}
    >
      <canvas ref={glRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label="Drawing canvas. Use the Objects table in the Data panel for a non-visual list of analysis objects."
        data-testid="canvas"
      />
      {webglError && (
        <div className="bg-destructive/10 text-destructive absolute top-2 left-2 rounded-md p-2 text-sm">
          WebGL2 is unavailable ({webglError}). Drawings cannot be displayed in this browser.
        </div>
      )}
      {drawingsCount === 0 && !dragOver && <EmptyHint />}
      {dragOver && (
        <div className="border-primary/60 bg-primary/5 pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed text-lg">
          Drop DXF, DWG, PDF, project or table files to import
        </div>
      )}
      <ImportProgress />
      <ModelStatus />
      <HintBar />
      <HoverTooltip />
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="text-muted-foreground max-w-sm space-y-2 text-center text-sm">
        <FileUp className="mx-auto size-8 opacity-60" />
        <p>Drag a DXF, DWG or PDF drawing here, or use File → Import drawing (Ctrl+I).</p>
        <p className="text-xs">Files are read on this computer only — nothing is uploaded.</p>
      </div>
    </div>
  );
}

function ImportProgress() {
  const jobs = useImportStore((s) => s.jobs);
  if (!jobs.length) return null;
  return (
    <div
      className="absolute top-3 left-1/2 z-10 w-[min(28rem,90%)] -translate-x-1/2 space-y-2"
      data-testid="import-progress"
    >
      {jobs.map((j) => (
        <div key={j.id} className="bg-popover rounded-lg border p-3 text-sm shadow-md">
          <div className="mb-1.5 flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            <span className="flex-1 truncate font-medium">{j.name}</span>
            <Button variant="ghost" size="xs" onClick={j.cancel} aria-label={`Cancel import of ${j.name}`}>
              <X /> Cancel
            </Button>
          </div>
          <Progress value={Math.round(j.progress * 100)} />
          <div className="text-muted-foreground mt-1 text-xs">{j.message}</div>
        </div>
      ))}
    </div>
  );
}

function ModelStatus() {
  const models = useModelsStore((s) => s.models);
  const errors = Object.values(models).filter((m) => m.status === 'error');
  if (!errors.length) return null;
  return (
    <div className="bg-destructive/10 text-destructive absolute bottom-10 left-3 max-w-md rounded-md p-2 text-xs">
      {errors.map((e) => (
        <div key={e.drawingId}>Could not load a drawing: {e.error}</div>
      ))}
    </div>
  );
}

function HintBar() {
  const hint = useToolUi((s) => s.hint);
  const typed = useToolUi((s) => s.typed);
  if (!hint && !typed) return null;
  return (
    <div
      className="bg-popover/90 pointer-events-none absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 rounded-md border px-2.5 py-1 text-xs shadow-sm"
      data-testid="tool-hint"
    >
      {hint}
      {typed && (
        <span className="ml-2 font-mono">
          ▸ <span className="bg-muted rounded px-1">{typed}</span> (Enter)
        </span>
      )}
    </div>
  );
}

function HoverTooltip() {
  const hover = useViewStore((s) => s.hoverEntity);
  const cursor = useViewStore((s) => s.cursor);
  const view = useViewStore((s) => s.view);
  const size = useViewStore((s) => s.canvasSize);
  const tool = useViewStore((s) => s.activeTool);
  const drawings = useProject((p) => p.drawings);
  const display = useProject((p) => p.display);
  if (!hover || !cursor || tool !== 'select' || !drawings || !display) return null;
  const d = drawings.find((x) => x.id === hover.drawingId);
  if (!d) return null;
  const info = entityInfo(d, hover.index);
  if (!info) return null;
  const c = Math.cos(view.rotation);
  const s = Math.sin(view.rotation);
  const dx = cursor.x - view.cx;
  const dy = cursor.y - view.cy;
  const x = size.w / 2 + view.scale * (c * dx - s * dy) + 16;
  const y = size.h / 2 - view.scale * (s * dx + c * dy) + 16;
  return (
    <div
      className="bg-popover pointer-events-none absolute z-10 max-w-64 rounded-md border px-2 py-1 text-xs shadow-md"
      style={{ left: Math.min(x, size.w - 200), top: Math.min(y, size.h - 90) }}
      data-testid="entity-tooltip"
    >
      <div className="font-medium">
        {info.type} <span className="text-muted-foreground font-normal">· {info.layer}</span>
      </div>
      {info.text && <div className="truncate">“{info.text}”</div>}
      {info.radius !== undefined && (
        <div>Radius {formatLength(info.radius, display.units, display.precision)}</div>
      )}
      {info.length !== undefined && info.length > 0 && (
        <div>Length {formatLength(info.length, display.units, display.precision)}</div>
      )}
      {info.area !== undefined && (
        <div>Area {formatArea(info.area, display.areaUnits, display.precision)}</div>
      )}
      {!info.calibrated && <div className="text-warning">Drawing not calibrated</div>}
    </div>
  );
}
