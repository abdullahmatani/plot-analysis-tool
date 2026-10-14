import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getProject } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { mappingErrors } from '@/tables/suggest';

import { MappingEditor, type MappingDraft } from './MappingEditor';
import { reconcileSizeStyles, updateDataset } from './ops';

/** Edits the full column mapping of an existing dataset (row 63); saving is one undo step. */

export const MAPPING_DIALOG = 'contour-mapping';

export function EditMappingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const payload = useUiStore((s) => (s.dialog === MAPPING_DIALOG ? s.dialogPayload : null)) as {
    datasetId: string;
  } | null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="edit-mapping-dialog"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {open && payload && <Body datasetId={payload.datasetId} close={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ datasetId, close }: { datasetId: string; close: () => void }) {
  const ds = getProject()?.datasets.find((d) => d.id === datasetId);
  const [draft, setDraft] = useState<MappingDraft | null>(
    ds ? { mapping: ds.mapping, labelTemplate: ds.labelTemplate, labelPlacement: ds.labelPlacement } : null,
  );
  if (!ds || !draft) return null;
  const errors = mappingErrors(draft.mapping, ds.table.columns);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Column mapping — {ds.name}</DialogTitle>
        <DialogDescription>Required roles are marked *. Styles and rules are kept.</DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] overflow-auto pr-1">
        <MappingEditor columns={ds.table.columns} rows={ds.table.rows} value={draft} onChange={setDraft} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          data-testid="save-mapping"
          disabled={errors.length > 0}
          onClick={() => {
            updateDataset(ds.id, `Edit mapping of “${ds.name}”`, (d) => {
              d.mapping = structuredClone(draft.mapping);
              d.labelTemplate = draft.labelTemplate;
              d.labelPlacement = draft.labelPlacement;
              d.sizeStyles = reconcileSizeStyles(draft.mapping.sizeColumns, d.sizeStyles as never);
            });
            close();
          }}
        >
          Save mapping
        </Button>
      </DialogFooter>
    </>
  );
}
