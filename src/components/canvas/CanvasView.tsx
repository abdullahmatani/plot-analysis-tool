import { useUiStore } from '@/store/ui';

export function CanvasView() {
  const bg = useUiStore((s) => s.canvasBg);
  return (
    <div
      className="absolute inset-0"
      style={{ background: bg === 'dark' ? '#0b0f14' : '#ffffff' }}
      data-testid="canvas"
      tabIndex={0}
      aria-label="Drawing canvas"
    />
  );
}
