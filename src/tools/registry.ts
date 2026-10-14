import { create } from 'zustand';

import { useViewStore } from '@/store/view';

import type { Tool, ToolContext } from './types';

/** Tool registry: tools are activated by id (from the rail, menus, palette or shortcuts). */

const tools = new Map<string, Tool>();
let ctx: ToolContext | null = null;

interface ToolUi {
  hint: string;
  typed: string;
  set(p: Partial<Omit<ToolUi, 'set'>>): void;
}

export const useToolUi = create<ToolUi>()((set) => ({ hint: '', typed: '', set: (p) => set(p) }));

export function registerTool(t: Tool) {
  tools.set(t.id, t);
}

export function getTool(id: string): Tool | undefined {
  return tools.get(id);
}

export function activeTool(): Tool | undefined {
  return tools.get(useViewStore.getState().activeTool);
}

export function bindToolContext(c: ToolContext | null) {
  ctx = c;
  const t = activeTool();
  if (c && t) t.activate?.(c);
}

export function setTool(id: string) {
  const prev = activeTool();
  if (prev?.id === id) return;
  const next = tools.get(id);
  if (!next) return;
  if (ctx) prev?.deactivate?.(ctx);
  useViewStore.getState().set({ activeTool: id });
  useToolUi.getState().set({ typed: '', hint: next.hint?.() ?? '' });
  if (ctx) {
    next.activate?.(ctx);
    ctx.setCursor(next.cursor ?? 'default');
    ctx.requestRender();
  }
}

export function refreshHint() {
  useToolUi.getState().set({ hint: activeTool()?.hint?.() ?? '' });
}
