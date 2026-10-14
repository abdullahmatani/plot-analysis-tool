import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal fixed-height row virtualisation for tables in a scroll container: only the rows in view
 * (plus overscan) are rendered, with spacer rows above and below. Large datasets (thousands of rows)
 * stay responsive (row 68). `ref` is a callback ref, so the container may mount later.
 */
export function useVirtualRows(count: number, rowHeight: number, overscan = 10, headerHeight = 32) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(320);
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 320));
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [el]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.max(start, Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan));

  const scrollToIndex = useCallback(
    (i: number) => {
      if (!el || i < 0) return;
      const top = i * rowHeight;
      const view = el.clientHeight - headerHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + view) el.scrollTop = top + rowHeight - view;
    },
    [el, rowHeight, headerHeight],
  );

  return {
    ref,
    el,
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
    scrollToIndex,
  };
}
