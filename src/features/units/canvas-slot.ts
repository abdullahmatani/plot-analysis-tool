import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Non-modal panels and overlays placed over the canvas (calibration and measurement panels, scale
 * bar, north arrow). They are portalled into named slots created inside the canvas container, so
 * feature modules can add canvas chrome without editing the shared canvas component. Slots ignore
 * pointer events; only the panels inside them receive input.
 */

export type CanvasSlotName = 'top-left' | 'top-right' | 'bottom-left';

const SLOT_CLASS: Record<CanvasSlotName, string> = {
  'top-left':
    'absolute top-3 left-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(23rem,calc(100%-1.5rem))] flex-col gap-2',
  'top-right': 'absolute top-3 right-3 z-10 flex flex-col items-end gap-2',
  'bottom-left': 'absolute bottom-3 left-3 z-10 flex flex-col items-start gap-2',
};

const CONTAINER = '[data-testid="canvas-container"]';

let container: Element | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function refresh() {
  const next = document.querySelector(CONTAINER);
  if (next === container) return;
  container = next;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!observer) {
    observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    refresh();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

function ensureSlot(root: Element, name: CanvasSlotName): HTMLElement {
  const existing = root.querySelector<HTMLElement>(`:scope > [data-canvas-slot="${name}"]`);
  if (existing) return existing;
  const el = document.createElement('div');
  el.dataset.canvasSlot = name;
  el.className = `pointer-events-none ${SLOT_CLASS[name]}`;
  root.appendChild(el);
  return el;
}

/** The slot element inside the current canvas container (null while no project is open). */
export function useCanvasSlot(name: CanvasSlotName): HTMLElement | null {
  const root = useSyncExternalStore(
    subscribe,
    () => (container?.isConnected ? container : document.querySelector(CONTAINER)),
    () => null,
  );
  return root ? ensureSlot(root, name) : null;
}

/** Renders children into a canvas slot. */
export function CanvasSlot({ name, children }: { name: CanvasSlotName; children: ReactNode }) {
  const slot = useCanvasSlot(name);
  return slot ? createPortal(children, slot) : null;
}

/** Focuses the canvas so tool keys (Esc, Enter, typed values) reach the active tool. */
export function focusCanvas() {
  document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true });
}
