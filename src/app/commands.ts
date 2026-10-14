import type { LucideIcon } from 'lucide-react';

import { useUiStore } from '@/store/ui';

/**
 * Command registry (row 4). Every user-facing action is a command with an id, title, menu group and
 * optional default shortcut. Menus, the Ctrl/⌘+K palette, keyboard shortcuts and the cheat-sheet are
 * all generated from this registry, so every tool is reachable from keyboard and palette.
 */

export type MenuGroup = 'File' | 'Edit' | 'View' | 'Draw' | 'Trace' | 'Offset' | 'Data' | 'Export' | 'Help';

export interface Command {
  id: string;
  title: string;
  menu: MenuGroup;
  /** Sub-section inside the menu (separators between sections). */
  section?: string;
  shortcut?: string;
  icon?: LucideIcon;
  keywords?: string[];
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Hidden from menus (palette and shortcuts only). */
  hidden?: boolean;
  /** Needs an open project. */
  needsProject?: boolean;
  /** Shown as a button in the tool rail (in registration order, grouped by `section`). */
  rail?: boolean;
  /** For tool commands: whether the tool is currently active. */
  active?: () => boolean;
}

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;

export function registerCommands(cmds: Command[]): () => void {
  for (const c of cmds) registry.set(c.id, c);
  version++;
  for (const l of listeners) l();
  return () => {
    for (const c of cmds) if (registry.get(c.id) === c) registry.delete(c.id);
    version++;
    for (const l of listeners) l();
  };
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function subscribeCommands(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function commandsVersion() {
  return version;
}

export function effectiveShortcut(cmd: Command): string | undefined {
  const custom = useUiStore.getState().shortcuts[cmd.id];
  if (custom === '') return undefined;
  return custom ?? cmd.shortcut;
}

export async function runCommand(id: string): Promise<boolean> {
  const cmd = registry.get(id);
  if (!cmd) return false;
  if (cmd.enabled && !cmd.enabled()) return false;
  await cmd.run();
  return true;
}

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Normalises a KeyboardEvent into a shortcut string like "Mod+Shift+Z", "Delete", "L". */
export function eventToShortcut(e: KeyboardEvent): string | null {
  const key = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = key.length === 1 ? key.toUpperCase() : key;
  if (k === ' ') k = 'Space';
  if (e.code?.startsWith('Digit') && e.shiftKey) k = e.code.slice(5);
  if (e.code?.startsWith('Key') && (e.altKey || e.shiftKey)) k = e.code.slice(3);
  parts.push(k);
  return parts.join('+');
}

export function formatShortcut(s: string | undefined): string {
  if (!s) return '';
  return s
    .split('+')
    .map((p) => {
      if (p === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'Shift') return isMac ? '⇧' : 'Shift';
      if (p === 'Alt') return isMac ? '⌥' : 'Alt';
      if (p === 'Ctrl') return isMac ? '⌃' : 'Ctrl';
      if (p === 'Delete') return 'Del';
      if (p === 'Escape') return 'Esc';
      return p;
    })
    .join(isMac ? '' : '+');
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Global keyboard handler: dispatches shortcuts to commands. */
export function handleShortcut(e: KeyboardEvent): boolean {
  const sc = eventToShortcut(e);
  if (!sc) return false;
  const typing = isTypingTarget(e.target);
  // While typing, only allow modifier shortcuts that are not text-editing keys.
  if (typing && (!sc.includes('Mod+') || /^Mod\+[ACVXZY]$/.test(sc) || sc === 'Mod+Shift+Z')) return false;
  for (const cmd of registry.values()) {
    if (effectiveShortcut(cmd) !== sc) continue;
    if (cmd.enabled && !cmd.enabled()) continue;
    e.preventDefault();
    void cmd.run();
    return true;
  }
  return false;
}
