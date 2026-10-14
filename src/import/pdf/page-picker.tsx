import { useEffect, useState } from 'react';
import { create } from 'zustand';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

import { openPdfDocument } from './pdf-doc';

/** Page picker for multi-page PDF sets (row 15). Each chosen page becomes its own drawing. */

interface PickerState {
  req: { name: string; bytes: Uint8Array; count: number; resolve: (pages: number[] | null) => void } | null;
  set(r: PickerState['req']): void;
}

const usePicker = create<PickerState>()((set) => ({ req: null, set: (req) => set({ req }) }));

export function pickPdfPages(name: string, bytes: Uint8Array, count: number): Promise<number[] | null> {
  return new Promise((resolve) => usePicker.getState().set({ name, bytes, count, resolve }));
}

export function PdfPagePickerHost() {
  const req = usePicker((s) => s.req);
  const set = usePicker((s) => s.set);
  const [chosen, setChosen] = useState<Set<number>>(new Set([1]));
  const [thumbs, setThumbs] = useState<Record<number, { url: string; label: string }>>({});

  useEffect(() => {
    if (!req) return;
    setChosen(new Set([1]));
    setThumbs({});
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      const doc = await openPdfDocument(req.bytes);
      for (let p = 1; p <= Math.min(req.count, 60) && !cancelled; p++) {
        const page = await doc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = 140 / Math.max(vp1.width, vp1.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r));
        if (!blob || cancelled) break;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const mm = (pt: number) => Math.round((pt * 25.4) / 72);
        setThumbs((t) => ({ ...t, [p]: { url, label: `${mm(vp1.width)} × ${mm(vp1.height)} mm` } }));
      }
      await doc.loadingTask.destroy();
    })();
    return () => {
      cancelled = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [req]);

  const finish = (pages: number[] | null) => {
    req?.resolve(pages);
    set(null);
  };

  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent className="sm:max-w-3xl" data-testid="pdf-page-picker">
        <DialogHeader>
          <DialogTitle>Choose pages — {req?.name}</DialogTitle>
          <DialogDescription>
            This PDF has {req?.count} pages. Each selected page is imported as a separate drawing.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 text-sm">
          <Button
            size="xs"
            variant="outline"
            onClick={() => setChosen(new Set(Array.from({ length: req?.count ?? 0 }, (_, i) => i + 1)))}
          >
            Select all
          </Button>
          <Button size="xs" variant="outline" onClick={() => setChosen(new Set())}>
            Clear
          </Button>
        </div>
        <ScrollArea className="h-[55vh]">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-1">
            {Array.from({ length: req?.count ?? 0 }, (_, i) => i + 1).map((p) => (
              <label
                key={p}
                className="hover:bg-accent flex cursor-pointer flex-col items-center gap-1 rounded-md border p-2 text-xs"
              >
                <div className="bg-muted flex h-[140px] w-[140px] items-center justify-center overflow-hidden">
                  {thumbs[p] ? (
                    <img src={thumbs[p].url} alt={`Page ${p}`} className="max-h-full max-w-full" />
                  ) : (
                    <span className="text-muted-foreground">…</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    checked={chosen.has(p)}
                    onCheckedChange={(v) => {
                      const next = new Set(chosen);
                      if (v) next.add(p);
                      else next.delete(p);
                      setChosen(next);
                    }}
                  />
                  Page {p}
                </div>
                <div className="text-muted-foreground">{thumbs[p]?.label}</div>
              </label>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button disabled={!chosen.size} onClick={() => finish([...chosen].sort((a, b) => a - b))}>
            Import {chosen.size} page{chosen.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
