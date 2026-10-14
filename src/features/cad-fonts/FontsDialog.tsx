import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DEFAULT_FONT_RULE, FONT_RULES } from '@/underlay/cad-fonts';

/** Help → CAD font substitutions (row 24): which bundled font replaces each SHX/TTF font. */
export function FontsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="cad-fonts-dialog">
        <DialogHeader>
          <DialogTitle>CAD font substitutions</DialogTitle>
          <DialogDescription>
            Drawings name SHX and TrueType fonts that are not part of this offline app. Their text is drawn
            with the bundled open-licence fonts (Noto Sans, Noto Sans Arabic; SIL Open Font License) — fonts
            are never downloaded. The width factor keeps substituted text close to its original length and
            alignment.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Drawing font</TableHead>
                <TableHead>Drawn with</TableHead>
                <TableHead className="text-right">Width</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...FONT_RULES, DEFAULT_FONT_RULE].map((r) => (
                <TableRow key={r.examples}>
                  <TableCell className="text-xs">{r.examples}</TableCell>
                  <TableCell className="text-xs">
                    {r.kind === 'mono' ? 'Monospace (system), else Noto Sans' : 'Noto Sans'}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">×{r.widthScale}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{r.note ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
