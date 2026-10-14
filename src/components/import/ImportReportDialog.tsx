import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useUiStore } from '@/store/ui';
import type { ImportReport } from '@/underlay/entity-store';

/** Import report (row 12): imported and skipped entities with counts, warnings and errors. */
export function ImportReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const payload = useUiStore((s) => s.dialogPayload) as {
    name: string;
    report: ImportReport;
    version?: string;
  } | null;
  if (!payload?.report) return null;
  const { name, report, version } = payload;
  const counts = Object.entries(report.counts).sort((a, b) => b[1] - a[1]);
  const skipped = Object.entries(report.skipped).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  const failed = report.errors.length > 0 && total === 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="import-report">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {failed ? (
              <XCircle className="text-destructive" />
            ) : report.warnings.length || skipped.length ? (
              <AlertTriangle className="text-warning" />
            ) : (
              <CheckCircle2 className="text-success" />
            )}
            Import report — {name}
          </DialogTitle>
          <DialogDescription>
            {failed
              ? 'The file could not be imported.'
              : `${total.toLocaleString()} items imported${skipped.length ? `, ${skipped.reduce((s, [, n]) => s + n, 0).toLocaleString()} skipped` : ''}.`}
            {version && <> Format: {version}.</>}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-3">
          {report.errors.length > 0 && (
            <section className="mb-3">
              <h3 className="text-destructive mb-1 text-sm font-medium">Errors</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {report.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </section>
          )}
          {report.warnings.length > 0 && (
            <section className="mb-3">
              <h3 className="mb-1 text-sm font-medium">Notes</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {report.warnings.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </section>
          )}
          {skipped.length > 0 && (
            <section className="mb-3">
              <h3 className="mb-1 text-sm font-medium">Skipped (unsupported or invalid)</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skipped.map(([t, n]) => (
                    <TableRow key={t}>
                      <TableCell>{t}</TableCell>
                      <TableCell className="text-right tabular-nums">{n.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}
          {counts.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-medium">Imported</h3>
              <div className="flex flex-wrap gap-1">
                {counts.map(([t, n]) => (
                  <Badge key={t} variant="outline" className="font-normal">
                    {t} <span className="tabular-nums">{n.toLocaleString()}</span>
                  </Badge>
                ))}
              </div>
            </section>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
