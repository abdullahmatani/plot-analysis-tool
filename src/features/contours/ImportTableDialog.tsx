import { ClipboardPaste, FileSpreadsheet, FileUp, LayoutTemplate, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { promptText } from '@/app/prompt';
import { currentSession } from '@/app/session';
import type { CellValue } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { getProject } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { diffTables, type TableDiff } from '@/tables/diff';
import { mappingErrors } from '@/tables/suggest';
import { cellText } from '@/tables/values';

import {
  calibrationGuard,
  datasetNameFor,
  initialMapping,
  parseSource,
  readTableSource,
  type ParseOptions,
  type TableSource,
} from './import-flow';
import { MappingEditor, type MappingDraft } from './MappingEditor';
import { addDataset, buildDataset, nextDatasetName, replaceData } from './ops';
import { useContoursUi } from './store';
import {
  applyTemplate,
  deleteTemplate,
  listTemplates,
  makeTemplate,
  matchTemplates,
  saveTemplate,
  type MappingTemplate,
  type TemplateSource,
} from './templates';
import { zoomToDataset } from './view-ops';

/**
 * Table import dialog (rows 62, 63, 72, 73): CSV / TSV / XLSX file or a pasted Excel range → sheet
 * picker, header row (detected), delimiter, preview of the first 50 rows → column mapping → dataset
 * (one undo step). Re-import replaces a dataset's data keeping its mapping and styles, with a change
 * summary. Mapping templates are suggested when headers match and apply in one click. The open dialog
 * is saved as a draft so it can be resumed after a crash (row 93).
 */

export const IMPORT_DIALOG = 'import-table';

export interface ImportPayload {
  file?: File;
  paste?: boolean;
  reimportOf?: string;
  draft?: ImportDraftState;
}

export interface ImportDraftState {
  stage: Stage;
  src: TableSource;
  opts: ParseOptions;
  draft: MappingDraft | null;
  name: string;
  reimportOf?: string;
}

type Stage = 'source' | 'mapping' | 'reimport';

/** Stable close callback (the dialog is opened and closed through the UI store). */
const closeDialog = () => useUiStore.getState().closeDialog();

const DRAFT = { key: 'dialog:import-table', tool: IMPORT_DIALOG, label: 'Table import' };
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;

export function ImportTableDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const payload = useUiStore((s) =>
    s.dialog === IMPORT_DIALOG ? s.dialogPayload : null,
  ) as ImportPayload | null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl"
        data-testid="import-table-dialog"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {open && <ImportBody payload={payload ?? {}} close={closeDialog} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportBody({ payload, close }: { payload: ImportPayload; close: () => void }) {
  const restored = payload.draft;
  const reimportOf = payload.reimportOf ?? restored?.reimportOf;
  const target = reimportOf ? getProject()?.datasets.find((d) => d.id === reimportOf) : undefined;
  const [stage, setStage] = useState<Stage>(restored?.stage ?? 'source');
  const [src, setSrc] = useState<TableSource | null>(restored?.src ?? null);
  const [opts, setOpts] = useState<ParseOptions>(restored?.opts ?? {});
  const [draft, setDraft] = useState<MappingDraft | null>(restored?.draft ?? null);
  const [name, setName] = useState(restored?.name ?? '');
  const [loading, setLoading] = useState(!!payload.file);
  const [templates, setTemplates] = useState<MappingTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  /** Styles of a template applied in the mapping step (kept with the mapping). */
  const [tplStyles, setTplStyles] = useState<Pick<
    TemplateSource,
    'sizeStyles' | 'styleRules' | 'labelStyle'
  > | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void listTemplates().then(setTemplates);
  }, []);

  useEffect(() => {
    if (!payload.file) return;
    let cancelled = false;
    readTableSource(payload.file)
      .then((s) => !cancelled && setSrc(s))
      .catch((e: Error) => {
        toast.error(e.message);
        close();
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [payload.file, close]);

  useEffect(() => {
    if (payload.paste) setTimeout(() => pasteRef.current?.focus(), 50);
  }, [payload.paste]);

  const parsed = useMemo(() => {
    if (!src) return null;
    try {
      return { result: parseSource(src, opts), error: null };
    } catch (e) {
      return { result: null, error: (e as Error).message };
    }
  }, [src, opts]);
  const result = parsed?.result ?? null;
  const columns = useMemo(() => result?.table.columns ?? [], [result]);

  useEffect(() => {
    if (src && result && !name) setName(target?.name ?? datasetNameFor(src, result.sheet, result.sheets));
  }, [src, result, name, target]);

  // Draft of the open dialog (row 93).
  useEffect(() => {
    const s = currentSession();
    if (!s || !src) return;
    const bytes = src.bytes?.byteLength ?? 0;
    if (bytes > MAX_DRAFT_BYTES) return;
    const state: ImportDraftState = { stage, src, opts, draft, name, ...(reimportOf ? { reimportOf } : {}) };
    s.drafts.set(DRAFT, state);
  }, [stage, src, opts, draft, name, reimportOf]);

  const finish = () => {
    currentSession()?.drafts.clear(DRAFT.key);
    close();
  };

  const matches = useMemo(
    () => (result ? matchTemplates(templates, columns) : []),
    [templates, result, columns],
  );
  const best = matches[0];

  const startMapping = (from?: TemplateSource) => {
    if (!result) return;
    const base: MappingDraft = from
      ? { mapping: from.mapping, labelTemplate: from.labelTemplate, labelPlacement: from.labelPlacement }
      : target
        ? {
            mapping: target.mapping,
            labelTemplate: target.labelTemplate,
            labelPlacement: target.labelPlacement,
          }
        : {
            mapping: initialMapping(result.table.columns, result.table.rows),
            labelTemplate: '',
            labelPlacement: 'top',
          };
    setDraft(base);
    setTplStyles(null);
    setStage('mapping');
  };

  const doImport = async (tpl?: TemplateSource) => {
    if (!result || !src || busy) return;
    const p = getProject();
    if (!p) return;
    const settings: TemplateSource | null =
      tpl ?? (draft ? { ...draft, sizeStyles: [], styleRules: [], ...(tplStyles ?? {}) } : null);
    if (!settings) return;
    if (mappingErrors(settings.mapping, result.table.columns).length) return;
    setBusy(true);
    try {
      if (!(await calibrationGuard())) return;
      const ds = buildDataset(p, {
        name: nextDatasetName(p, name.trim() || datasetNameFor(src, result.sheet, result.sheets)),
        table: result.table,
        mapping: settings.mapping,
        sizeStyles: settings.sizeStyles,
        styleRules: settings.styleRules,
        labelTemplate: settings.labelTemplate,
        labelPlacement: settings.labelPlacement,
        ...(settings.labelStyle ? { labelStyle: settings.labelStyle } : {}),
        source: {
          fileName: src.name,
          importedAt: new Date().toISOString(),
          ...(result.sheet ? { sheet: result.sheet } : {}),
        },
      });
      if (!addDataset(ds)) {
        toast.error('The dataset could not be added (the project is read-only).');
        return;
      }
      useContoursUi.getState().set({ activeDatasetId: ds.id, selection: null, hover: null });
      useUiStore.getState().setInspectorTab('data');
      zoomToDataset(ds.id, true);
      toast.success(`Imported “${ds.name}”`, {
        description: `${result.table.rows.length} rows · ${settings.mapping.sizeColumns.length} size column(s)`,
      });
      finish();
    } finally {
      setBusy(false);
    }
  };

  const doReplace = async (withMapping: boolean) => {
    if (!result || !src || !target || busy) return;
    setBusy(true);
    try {
      if (!(await calibrationGuard())) return;
      await currentSession()?.beforeHighImpact(`re-importing “${target.name}”`);
      const d = diffTables(target.table, result.table);
      const ok = replaceData(target.id, result.table, {
        ...(withMapping && draft ? { mapping: draft.mapping } : {}),
        source: {
          fileName: src.name,
          importedAt: new Date().toISOString(),
          ...(result.sheet ? { sheet: result.sheet } : {}),
        },
      });
      if (!ok) return;
      toast.success(`Re-imported “${target.name}”`, { description: diffSummary(d) });
      useContoursUi.getState().set({ activeDatasetId: target.id, selection: null, hover: null });
      finish();
    } finally {
      setBusy(false);
    }
  };

  const saveAsTemplate = async () => {
    if (!draft || !result) return;
    const n = await promptText({
      title: 'Save mapping template',
      label: 'Template name',
      defaultValue: name || 'Template',
    });
    if (!n) return;
    const t = makeTemplate(n, result.table.columns, {
      ...draft,
      sizeStyles: [],
      styleRules: [],
      ...(tplStyles ?? {}),
    });
    await saveTemplate(t);
    setTemplates(await listTemplates());
    toast.success(`Template “${n}” saved`);
  };

  const title = target ? `Re-import “${target.name}”` : 'Import table';
  const errors = draft && result ? mappingErrors(draft.mapping, result.table.columns) : [];
  const reimportDiff = useMemo(
    () => (target && result ? diffTables(target.table, result.table) : null),
    [target, result],
  );
  const headersOk =
    target && result ? mappingErrors(target.mapping, result.table.columns).length === 0 : false;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FileSpreadsheet className="size-5" /> {title}
        </DialogTitle>
        <DialogDescription>
          {stage === 'source'
            ? 'CSV, TSV, Excel (.xlsx) or a range copied from a spreadsheet. Files are read on this computer only.'
            : stage === 'mapping'
              ? 'Map the table columns to contour roles. Required roles are marked *.'
              : 'Review the changes before replacing the data. Mapping, styles and labels are kept.'}
        </DialogDescription>
      </DialogHeader>

      {stage === 'source' && (
        <SourceStage
          src={src}
          loading={loading}
          setSrc={(s) => {
            setSrc(s);
            setOpts({});
            setName('');
          }}
          pasteRef={pasteRef}
          parsed={parsed}
          opts={opts}
          setOpts={setOpts}
        />
      )}

      {stage === 'mapping' && draft && result && (
        <div className="grid max-h-[60vh] gap-3 overflow-auto pr-1">
          {!target && (
            <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
              <Label htmlFor="ds-name" className="text-muted-foreground text-xs font-normal">
                Dataset name
              </Label>
              <Input
                id="ds-name"
                className="h-8 text-xs"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <TemplateBar
            matches={matches.map((m) => m.template)}
            all={templates}
            onApply={(t) => {
              const a = applyTemplate(t, result.table.columns);
              setDraft({
                mapping: a.mapping,
                labelTemplate: a.labelTemplate,
                labelPlacement: a.labelPlacement,
              });
              setTplStyles({
                sizeStyles: a.sizeStyles,
                styleRules: a.styleRules,
                ...(a.labelStyle ? { labelStyle: a.labelStyle } : {}),
              });
              toast.info(`Template “${t.name}” applied`);
            }}
            onDelete={async (t) => {
              await deleteTemplate(t.id);
              setTemplates(await listTemplates());
            }}
          />
          <MappingEditor
            columns={result.table.columns}
            rows={result.table.rows}
            value={draft}
            onChange={setDraft}
          />
        </div>
      )}

      {stage === 'reimport' && reimportDiff && <ReimportSummary diff={reimportDiff} headersOk={headersOk} />}

      <DialogFooter className="items-center gap-2 sm:justify-between">
        <div className="text-muted-foreground text-xs">
          {result && (
            <span data-testid="import-shape">
              {result.table.rows.length} rows × {result.table.columns.length} columns
            </span>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {stage !== 'source' && (
            <Button variant="outline" onClick={() => setStage('source')}>
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={finish}>
            Cancel
          </Button>
          {stage === 'source' && result && !target && best && (
            <Button
              variant="secondary"
              data-testid="import-with-template"
              onClick={() => void doImport(applyTemplate(best.template, columns))}
              disabled={busy}
            >
              <LayoutTemplate /> Import with “{best.template.name}”
            </Button>
          )}
          {stage === 'source' && result && target && (
            <Button data-testid="reimport-next" onClick={() => setStage(headersOk ? 'reimport' : 'mapping')}>
              {headersOk ? 'Next: review changes' : 'Next: remap columns'}
            </Button>
          )}
          {stage === 'source' && result && !target && (
            <Button data-testid="mapping-next" onClick={() => startMapping()}>
              Next: map columns
            </Button>
          )}
          {stage === 'mapping' && (
            <>
              <Button variant="outline" onClick={() => void saveAsTemplate()} data-testid="save-template">
                <LayoutTemplate /> Save as template…
              </Button>
              {target ? (
                <Button
                  data-testid="reimport-apply-mapping"
                  disabled={errors.length > 0 || busy}
                  onClick={() => void doReplace(true)}
                >
                  Replace data
                </Button>
              ) : (
                <Button
                  data-testid="import-dataset"
                  disabled={errors.length > 0 || busy}
                  onClick={() => void doImport()}
                >
                  Import
                </Button>
              )}
            </>
          )}
          {stage === 'reimport' && (
            <Button data-testid="reimport-apply" disabled={busy} onClick={() => void doReplace(false)}>
              Replace data
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}

function diffSummary(d: TableDiff): string {
  return `${d.added.length} added · ${d.removed.length} removed · ${d.changed.length} changed · ${d.unchanged} unchanged`;
}

function ReimportSummary({ diff, headersOk }: { diff: TableDiff; headersOk: boolean }) {
  return (
    <div className="grid gap-3 text-sm" data-testid="reimport-summary">
      <div className="flex flex-wrap gap-2">
        <Badge variant="success" data-testid="diff-added">
          {diff.added.length} added
        </Badge>
        <Badge variant="destructive" data-testid="diff-removed">
          {diff.removed.length} removed
        </Badge>
        <Badge variant="warning" data-testid="diff-changed">
          {diff.changed.length} changed
        </Badge>
        <Badge variant="outline">{diff.unchanged} unchanged</Badge>
      </div>
      <p className="text-muted-foreground text-xs">
        {headersOk
          ? 'The headers match the current mapping — no remapping needed.'
          : 'Some mapped columns are missing; review the mapping.'}{' '}
        Rows matched by {diff.keyUsed.length ? diff.keyUsed.join(' + ') : 'position'}.
        {diff.addedColumns.length > 0 && ` New columns: ${diff.addedColumns.join(', ')}.`}
        {diff.removedColumns.length > 0 && ` Removed columns: ${diff.removedColumns.join(', ')}.`}
      </p>
      {diff.changed.length > 0 && (
        <ul className="text-muted-foreground max-h-40 list-disc overflow-auto pl-5 text-xs">
          {diff.changed.slice(0, 50).map((c) => (
            <li key={`${c.oldIndex}-${c.newIndex}`}>
              Row {c.newIndex + 1}: {c.columns.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateBar({
  matches,
  all,
  onApply,
  onDelete,
}: {
  matches: MappingTemplate[];
  all: MappingTemplate[];
  onApply: (t: MappingTemplate) => void;
  onDelete: (t: MappingTemplate) => void;
}) {
  if (!all.length) return null;
  const best = matches[0];
  return (
    <div className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
      <LayoutTemplate className="size-4" />
      {best ? (
        <>
          <span>
            Template <b>{best.name}</b> matches these headers.
          </span>
          <Button size="xs" onClick={() => onApply(best)} data-testid="apply-template">
            <Wand2 /> Apply
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground">No saved template matches these headers.</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="ghost" className="ml-auto">
            Templates ({all.length})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Apply a template</DropdownMenuLabel>
          {all.map((t) => (
            <DropdownMenuItem key={t.id} disabled={!matches.includes(t)} onSelect={() => onApply(t)}>
              {t.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Delete</DropdownMenuLabel>
          {all.map((t) => (
            <DropdownMenuItem key={`del-${t.id}`} variant="destructive" onSelect={() => onDelete(t)}>
              <Trash2 /> {t.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const DELIMS: { v: string; l: string }[] = [
  { v: 'auto', l: 'Detect' },
  { v: ',', l: 'Comma' },
  { v: ';', l: 'Semicolon' },
  { v: '\t', l: 'Tab' },
  { v: '|', l: 'Pipe' },
];

function SourceStage({
  src,
  loading,
  setSrc,
  pasteRef,
  parsed,
  opts,
  setOpts,
}: {
  src: TableSource | null;
  loading: boolean;
  setSrc: (s: TableSource) => void;
  pasteRef: React.RefObject<HTMLTextAreaElement | null>;
  parsed: { result: ReturnType<typeof parseSource> | null; error: string | null } | null;
  opts: ParseOptions;
  setOpts: (o: ParseOptions) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const result = parsed?.result ?? null;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setSrc(await readTableSource(f));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const readClipboard = async () => {
    try {
      let html: string | undefined;
      let plain = '';
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
          if (it.types.includes('text/plain')) plain = await (await it.getType('text/plain')).text();
        }
      } else {
        plain = await navigator.clipboard.readText();
      }
      if (!plain && !html) {
        toast.info('The clipboard holds no text. Copy a range in your spreadsheet first.');
        return;
      }
      setSrc({ kind: 'clipboard', name: 'Pasted table', text: plain, ...(html ? { html } : {}) });
    } catch {
      toast.error('The browser blocked clipboard access. Click the box and press Ctrl+V instead.');
    }
  };

  const raw = result?.raw ?? [];
  const headerOptions = Math.min(raw.length, 30);

  return (
    <div className="grid min-h-0 gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid content-start gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FileUp className="size-4" /> From a file
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.tab,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            data-testid="table-file-input"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} className="w-fit">
            Choose CSV, TSV or XLSX…
          </Button>
          <p className="text-muted-foreground text-xs">Or drop the file onto the drawing canvas.</p>
        </div>
        <div className="grid content-start gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClipboardPaste className="size-4" /> Paste a copied range
          </div>
          <Textarea
            ref={pasteRef}
            aria-label="Paste table here"
            data-testid="paste-target"
            className="h-16 resize-none font-mono text-xs"
            placeholder="Click here and press Ctrl+V"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onPaste={(e) => {
              const plain = e.clipboardData.getData('text/plain');
              const html = e.clipboardData.getData('text/html');
              if (!plain && !html) return;
              e.preventDefault();
              setText('');
              setSrc({ kind: 'clipboard', name: 'Pasted table', text: plain, ...(html ? { html } : {}) });
            }}
          />
          <div className="flex gap-2">
            <Button variant="outline" size="xs" onClick={() => void readClipboard()}>
              Read clipboard
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={!text.trim()}
              onClick={() => setSrc({ kind: 'clipboard', name: 'Pasted table', text })}
            >
              Use typed text
            </Button>
          </div>
        </div>
      </div>

      {loading && <p className="text-muted-foreground text-sm">Reading file…</p>}
      {parsed?.error && (
        <p className="text-destructive text-sm" role="alert">
          {parsed.error}
        </p>
      )}

      {src && result && (
        <div className="grid min-h-0 gap-2" data-testid="import-preview">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" data-testid="source-kind">
              {src.kind.toUpperCase()}
            </Badge>
            <span className="max-w-64 truncate font-medium" title={src.name}>
              {src.name}
            </span>
            {result.sheets && (
              <Select
                value={result.sheet}
                onValueChange={(sheet) => setOpts({ ...opts, sheet, headerRow: undefined })}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 text-xs"
                  aria-label="Sheet"
                  data-testid="sheet-picker"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {result.sheets.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={String(result.headerRow)}
              onValueChange={(v) => setOpts({ ...opts, headerRow: Number(v) })}
            >
              <SelectTrigger
                size="sm"
                className="h-7 max-w-64 text-xs"
                aria-label="Header row"
                data-testid="header-row"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="-1">No header row</SelectItem>
                {Array.from({ length: headerOptions }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>
                    Header: row {i + 1} —{' '}
                    {raw[i]
                      .filter((c) => cellText(c))
                      .slice(0, 3)
                      .map(cellText)
                      .join(', ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(src.kind === 'csv' || src.kind === 'tsv') && (
              <Select
                value={opts.delimiter ?? 'auto'}
                onValueChange={(v) => setOpts({ ...opts, delimiter: v === 'auto' ? undefined : v })}
              >
                <SelectTrigger size="sm" className="h-7 text-xs" aria-label="Delimiter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELIMS.map((d) => (
                    <SelectItem key={d.l} value={d.v}>
                      {d.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <PreviewTable columns={result.table.columns} rows={result.preview} />
          <p className="text-muted-foreground text-xs">
            Preview of the first {Math.min(result.preview.length, 50)} of {result.table.rows.length} rows.
          </p>
        </div>
      )}
    </div>
  );
}

export function PreviewTable({ columns, rows }: { columns: string[]; rows: CellValue[][] }) {
  return (
    <div className="max-h-64 overflow-auto rounded-md border [&_[data-slot=table-container]]:overflow-visible">
      <Table data-testid="preview-table">
        <TableHeader className="bg-muted sticky top-0 z-10">
          <TableRow>
            <TableHead className="text-muted-foreground w-8 text-right">#</TableHead>
            {columns.map((c) => (
              <TableHead key={c} className="max-w-48 truncate" title={c} dir="auto">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="text-muted-foreground text-right tabular-nums">{i + 1}</TableCell>
              {columns.map((_, c) => (
                <TableCell
                  key={c}
                  dir="auto"
                  className={`max-w-48 truncate ${typeof r[c] === 'number' ? 'text-right tabular-nums' : ''}`}
                  title={cellText(r[c])}
                >
                  {cellText(r[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
