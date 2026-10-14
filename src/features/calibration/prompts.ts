import { create } from 'zustand';

/**
 * Promise-based prompts of the calibration feature, rendered by `PromptsHost`: the calibration guard
 * (row 32) and the recalibration choice (row 33).
 */

export type GuardChoice = 'continue' | 'calibrate' | 'confirm-units' | 'cancel';

export interface GuardRequest {
  action: string;
  drawings: { id: string; name: string; kind: string; units?: string }[];
  /** CAD drawings whose header units can be confirmed in one click. */
  confirmable: boolean;
  resolve(choice: GuardChoice): void;
}

export type RecalibrationChoice = 'move' | 'keep' | null;

export interface RecalibrationRequest {
  label: string;
  drawingName: string;
  objects: number;
  anchors: number;
  /** The change is not a similarity (circles become ellipses when moved). */
  distorting: boolean;
  resolve(choice: RecalibrationChoice): void;
}

interface PromptStore {
  guard: GuardRequest | null;
  recal: RecalibrationRequest | null;
  set(p: Partial<Pick<PromptStore, 'guard' | 'recal'>>): void;
}

export const usePrompts = create<PromptStore>()((set) => ({
  guard: null,
  recal: null,
  set: (p) => set(p),
}));

export function askGuard(req: Omit<GuardRequest, 'resolve'>): Promise<GuardChoice> {
  return new Promise((resolve) => {
    usePrompts.getState().guard?.resolve('cancel');
    usePrompts.getState().set({
      guard: {
        ...req,
        resolve: (c) => {
          usePrompts.getState().set({ guard: null });
          resolve(c);
        },
      },
    });
  });
}

export function askRecalibration(req: Omit<RecalibrationRequest, 'resolve'>): Promise<RecalibrationChoice> {
  return new Promise((resolve) => {
    usePrompts.getState().recal?.resolve(null);
    usePrompts.getState().set({
      recal: {
        ...req,
        resolve: (c) => {
          usePrompts.getState().set({ recal: null });
          resolve(c);
        },
      },
    });
  });
}
