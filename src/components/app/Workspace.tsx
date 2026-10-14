import { useEffect, useRef } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';

import { CanvasView } from '@/components/canvas/CanvasView';
import { Inspector } from '@/components/inspector/Inspector';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useUiStore } from '@/store/ui';

import { AppMenubar } from './AppMenubar';
import { Banners } from './Banners';
import { StatusBar } from './StatusBar';
import { ToolRail } from './ToolRail';

/** Application shell (row 3): menubar, tool rail, resizable canvas + inspector, status bar. */
export function Workspace() {
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const toolRailOpen = useUiStore((s) => s.toolRailOpen);
  const panelRef = useRef<ImperativePanelHandle>(null);

  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (inspectorOpen && p.isCollapsed()) p.expand();
    if (!inspectorOpen && !p.isCollapsed()) p.collapse();
  }, [inspectorOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace">
      <AppMenubar />
      <Banners />
      <div className="flex min-h-0 flex-1">
        {toolRailOpen && <ToolRail />}
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="pat-workspace-layout"
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="canvas" order={1} minSize={30} className="relative min-w-0">
            <CanvasView />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="inspector"
            order={2}
            ref={panelRef}
            defaultSize={24}
            minSize={16}
            maxSize={50}
            collapsible
            collapsedSize={0}
            onCollapse={() => useUiStore.getState().toggleInspector(false)}
            onExpand={() => useUiStore.getState().toggleInspector(true)}
          >
            <Inspector />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
    </div>
  );
}
