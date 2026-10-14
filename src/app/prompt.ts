import { create } from 'zustand';

/** Promise-based text prompt / confirmation rendered with shadcn dialogs (no window.prompt). */

export interface PromptRequest {
  kind: 'prompt' | 'confirm';
  title: string;
  description?: string;
  label?: string;
  defaultValue?: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (value: string | boolean | null) => void;
}

interface PromptStore {
  request: PromptRequest | null;
  set(r: PromptRequest | null): void;
}

export const usePromptStore = create<PromptStore>()((set) => ({
  request: null,
  set: (request) => set({ request }),
}));

export function promptText(opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    usePromptStore
      .getState()
      .set({ ...opts, kind: 'prompt', resolve: (v) => resolve(typeof v === 'string' ? v : null) });
  });
}

export function confirmAction(
  opts: Omit<PromptRequest, 'kind' | 'resolve' | 'label' | 'defaultValue'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    usePromptStore.getState().set({ ...opts, kind: 'confirm', resolve: (v) => resolve(v === true) });
  });
}
