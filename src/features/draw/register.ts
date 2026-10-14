import { toast } from 'sonner';

import { registerCommands } from '@/app/commands';
import type { DraftRecord } from '@/persistence/db';
import { getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { getTool, registerTool, setTool } from '@/tools/registry';

import { shapeTools } from './shapes';

type Restorable = { restoreDraft?: (s: unknown) => void };

/** Offers to resume unfinished drawings found after recovery (row 93). */
function onDrafts(e: Event) {
  const drafts = (e as CustomEvent<DraftRecord[]>).detail ?? [];
  for (const d of drafts) {
    if (!d.key.startsWith('tool:')) continue;
    const tool = getTool(d.tool) as (ReturnType<typeof getTool> & Restorable) | undefined;
    const n = (d.state as { points?: unknown[] } | null)?.points?.length ?? 0;
    if (!tool?.restoreDraft || !n) continue;
    toast(`Unfinished ${d.label.toLowerCase()} recovered`, {
      description: `${n} point${n === 1 ? '' : 's'} placed before the app closed.`,
      duration: 30000,
      action: {
        label: 'Resume',
        onClick: () => {
          setTool(d.tool);
          tool.restoreDraft?.(d.state);
        },
      },
    });
  }
}

export function register() {
  for (const { tool } of shapeTools) registerTool(tool);
  window.addEventListener('pat:drafts', onDrafts);
  const canDraw = () => !!getProject() && !useProjectStore.getState().readOnly;
  const un = registerCommands(
    shapeTools.map(({ spec, tool }) => ({
      id: spec.id,
      title: spec.title,
      menu: 'Draw' as const,
      section:
        spec.id.includes('circle') || spec.id.includes('arc') || spec.id.includes('ellipse')
          ? 'curves'
          : 'lines',
      shortcut: spec.shortcut,
      icon: spec.icon,
      rail: ['draw.polyline', 'draw.polygon', 'draw.rect', 'draw.circle', 'draw.line'].includes(spec.id),
      needsProject: true,
      enabled: canDraw,
      active: () => useViewStore.getState().activeTool === tool.id,
      run: () => setTool(tool.id),
    })),
  );
  return () => {
    window.removeEventListener('pat:drafts', onDrafts);
    un();
  };
}
