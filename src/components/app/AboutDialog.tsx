import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface LicenceEntry {
  name: string;
  version: string;
  license: string;
  scope?: string;
  text?: string;
}

/** About dialog: privacy guarantee (row 7) and third-party licences (row 25). */
export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [licences, setLicences] = useState<LicenceEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!open || licences) return;
    import('@/generated/licences.json')
      .then((m) => setLicences((m.default as { packages: LicenceEntry[] }).packages))
      .catch(() => setLicences([]));
  }, [open, licences]);

  const current = licences?.find((l) => `${l.name}@${l.version}` === selected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plot Analysis Tool {__APP_VERSION__}</DialogTitle>
          <DialogDescription>Offline spatial analysis for plot plans and derived drawings.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="privacy">
          <TabsList>
            <TabsTrigger value="privacy">Privacy</TabsTrigger>
            <TabsTrigger value="licences">Licences</TabsTrigger>
          </TabsList>
          <TabsContent value="privacy" className="space-y-2 text-sm" data-testid="privacy-statement">
            <p className="flex items-center gap-2 font-medium">
              <ShieldCheck className="text-success size-5" /> Your data never leaves this device.
            </p>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5">
              <li>
                Drawings, tables and projects are read only through your browser’s file APIs and processed
                entirely on this computer (in the page, Web Workers and WebAssembly).
              </li>
              <li>
                Nothing is uploaded — ever. There are no accounts, no cloud storage, no telemetry, analytics
                or crash reporting.
              </li>
              <li>
                All fonts, icons, PDF and CAD components are bundled with the app. It makes no requests to any
                other website, and a Content Security Policy blocks connections to other hosts.
              </li>
              <li>
                After the first load the app works fully offline. Your work is saved automatically in this
                browser’s private storage; use “Save to file” to keep or share a copy.
              </li>
            </ul>
          </TabsContent>
          <TabsContent value="licences">
            <div className="grid h-[55vh] grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
              <ScrollArea className="rounded-md border">
                <ul className="text-xs" data-testid="licence-list">
                  {licences?.map((l) => (
                    <li key={`${l.name}@${l.version}`}>
                      <button
                        className="hover:bg-accent w-full px-2 py-1 text-left"
                        onClick={() => setSelected(`${l.name}@${l.version}`)}
                      >
                        <span className="font-medium">{l.name}</span> {l.version}
                        <span className="text-muted-foreground"> · {l.license}</span>
                        {l.scope && <span className="text-muted-foreground"> · {l.scope}</span>}
                      </button>
                    </li>
                  ))}
                  {licences && licences.length === 0 && (
                    <li className="p-2">Licence list unavailable in this build.</li>
                  )}
                </ul>
              </ScrollArea>
              <ScrollArea className="rounded-md border">
                <pre className="p-2 text-[11px] whitespace-pre-wrap">
                  {current?.text ?? 'Select a component to view its licence.'}
                </pre>
              </ScrollArea>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
