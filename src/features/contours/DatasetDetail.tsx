import { CircleAlert, Crosshair, Filter, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ContourDataset, SizeColumnStyle } from '@/core/types';
import { formatArea } from '@/core/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ColorInput, CommitInput, NumberInput } from '@/components/inspector/fields';
import { useProject, useProjectStore } from '@/store/project';
import { compileDatasetFilter, sizeStyleFor } from '@/tables/access';
import { toNumber } from '@/tables/values';

import { datasetContours, datasetEnvelopes, DEFAULT_LABEL_STYLE } from './compute';
import { ColumnSelect, DashSelect, Row, Swatch, UnitSelect } from './controls';
import { DataGrid } from './DataGrid';
import { LABEL_PLACEMENTS } from './constants';
import { reconcileSizeStyles, updateDataset } from './ops';
import { useContoursUi } from './store';
import { StyleRuleEditor } from './StyleRuleEditor';
import { placeAnchorNamed } from '@/features/anchors/tools';

/**
 * Active dataset: live filter (row 71) and tabs for display re-binding (rows 65, 66, 70, 74), style
 * rules (row 67), the live data grid (row 68) and validation issues (row 69). Every control commits
 * one undoable change; contours re-derive from the dataset instantly.
 */

type DetailTab = 'display' | 'style' | 'rows' | 'issues';

export function DatasetDetail({ ds }: { ds: ContourDataset }) {
  const project = useProject((p) => p);
  const [tab, setTab] = useState<DetailTab>('display');
  const reveal = useContoursUi((s) => s.reveal);
  useEffect(() => {
    if (reveal?.ds === ds.id) setTab('rows');
  }, [reveal, ds.id]);
  if (!project) return null;
  const dc = datasetContours(project, ds);
  const issues = dc.validation.issues.length;
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="dataset-detail">
      <FilterInput ds={ds} error={dc.filterError} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="gap-2">
        <TabsList className="w-full">
          <TabsTrigger value="display" className="text-xs">
            Display
          </TabsTrigger>
          <TabsTrigger value="style" className="text-xs">
            Style
          </TabsTrigger>
          <TabsTrigger value="rows" className="text-xs" data-testid="tab-rows">
            Rows
          </TabsTrigger>
          <TabsTrigger value="issues" className="text-xs" data-testid="tab-issues">
            Issues
            {issues > 0 && (
              <Badge variant="warning" className="ml-1 h-4 px-1 text-[10px]">
                {issues}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="display">
          <DisplayTab ds={ds} />
        </TabsContent>
        <TabsContent value="style">
          <StyleRuleEditor ds={ds} />
        </TabsContent>
        <TabsContent value="rows">
          <DataGrid ds={ds} />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesTab ds={ds} onShowRow={() => setTab('rows')} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FilterInput({ ds, error }: { ds: ContourDataset; error: string | null }) {
  const readOnly = useProjectStore((s) => s.readOnly);
  const [text, setText] = useState(ds.filter ?? '');
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setText(ds.filter ?? ''), [ds.filter]);
  // Live filtering (row 71): every valid expression is applied as you type (coalesced into one undo step).
  const apply = (v: string) => {
    setText(v);
    const trimmed = v.trim();
    if (trimmed !== '') {
      const f = compileDatasetFilter({ ...ds, filter: trimmed });
      if (!f.ok) {
        setLocal(f.error);
        return;
      }
    }
    setLocal(null);
    if ((ds.filter ?? '') === trimmed) return;
    updateDataset(
      ds.id,
      trimmed ? `Filter “${ds.name}”: ${trimmed}` : `Clear filter of “${ds.name}”`,
      (d) => {
        if (trimmed) d.filter = trimmed;
        else delete d.filter;
      },
      { coalesceKey: `ds-filter:${ds.id}` },
    );
  };
  const err = local ?? error;
  return (
    <div className="space-y-1">
      <div className="relative">
        <Filter className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
        <Input
          aria-label="Row filter"
          data-testid="dataset-filter"
          disabled={readOnly}
          className="h-7 pr-7 pl-7 font-mono text-xs"
          placeholder='e.g. category = "Jet fire" AND radius > 20'
          value={text}
          aria-invalid={!!err || undefined}
          onChange={(e) => apply(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {text && (
          <button
            type="button"
            aria-label="Clear filter"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
            onClick={() => apply('')}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {err && (
        <p className="text-destructive text-xs" data-testid="filter-error">
          {err}
        </p>
      )}
    </div>
  );
}

function numericColumns(ds: ContourDataset): string[] {
  return ds.table.columns.filter((_, c) => {
    let n = 0;
    let num = 0;
    for (let i = 0; i < Math.min(ds.table.rows.length, 300); i++) {
      const v = ds.table.rows[i][c];
      if (v === null || v === '') continue;
      n++;
      if (toNumber(v) !== null) num++;
    }
    return n > 0 && num / n >= 0.5;
  });
}

function DisplayTab({ ds }: { ds: ContourDataset }) {
  const project = useProject((p) => p)!;
  const readOnly = useProjectStore((s) => s.readOnly);
  const m = ds.mapping;
  const ls = { ...DEFAULT_LABEL_STYLE, ...(ds.labelStyle ?? {}) };
  const upd = (label: string, fn: Parameters<typeof updateDataset>[2], coalesceKey?: string) =>
    updateDataset(ds.id, label, fn, coalesceKey ? { coalesceKey } : {});
  const numeric = numericColumns(ds);
  const unmappedNumeric = numeric.filter((c) => !m.sizeColumns.includes(c));
  const envelopes = ds.envelope ? datasetEnvelopes(project, ds) : [];
  const { display } = project;
  const pos = m.position;

  return (
    <div className="space-y-3 text-xs" data-testid="display-tab">
      <div className="text-muted-foreground">
        Position:{' '}
        <span className="text-foreground">
          {pos.mode === 'anchor'
            ? `anchors from “${pos.anchor}”`
            : `${pos.mode === 'plant' ? 'plant E/N' : 'X/Y'} from “${pos.x}”, “${pos.y}”`}
        </span>
      </div>
      <section className="space-y-1.5">
        <h4 className="font-semibold uppercase">Labels</h4>
        <Row label="Label column">
          <ColumnSelect
            label="Label column"
            testId="bind-label"
            columns={ds.table.columns}
            value={m.label}
            disabled={readOnly}
            onChange={(c) =>
              upd(c ? `Label column “${c}”` : 'No label column', (d) => {
                if (c) d.mapping.label = c;
                else delete d.mapping.label;
              })
            }
          />
        </Row>
        <Row label="Template">
          <CommitInput
            ariaLabel="Label template"
            disabled={readOnly}
            placeholder={m.label ? '{label}' : '{label} – {radius} m'}
            value={ds.labelTemplate}
            onCommit={(v) =>
              void upd(`Label template “${v}”`, (d) => {
                d.labelTemplate = v;
              })
            }
          />
        </Row>
        <p className="text-muted-foreground">
          Fields: {'{label}'}, {'{group}'}, {'{radius}'}, {'{diameter}'}, {'{size}'}, {'{sizeColumn}'},{' '}
          {'{row}'}, any column as {'{Column name}'}; decimals with {'{radius:0.0}'}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={ds.labelPlacement}
            disabled={readOnly}
            onValueChange={(v) =>
              upd('Label placement', (d) => {
                d.labelPlacement = v as ContourDataset['labelPlacement'];
              })
            }
          >
            <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Label placement">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LABEL_PLACEMENTS.map((p) => (
                <SelectItem key={p.v} value={p.v}>
                  {p.l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="w-24">
            <NumberInput
              ariaLabel="Label size (mm)"
              value={ls.size}
              min={0.5}
              max={20}
              suffix="mm"
              decimals={2}
              disabled={readOnly}
              onCommit={(v) =>
                upd('Label size', (d) => {
                  d.labelStyle = { ...ls, size: v };
                })
              }
            />
          </div>
          <label className="flex items-center gap-1.5">
            <Switch
              checked={ls.visible}
              disabled={readOnly}
              aria-label="Show labels"
              onCheckedChange={(on) =>
                upd(on ? 'Show contour labels' : 'Hide contour labels', (d) => {
                  d.labelStyle = { ...ls, visible: on };
                })
              }
            />
            Show
          </label>
        </div>
      </section>

      <section className="space-y-1.5">
        <h4 className="font-semibold uppercase">Size</h4>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={m.sizeMode}
            disabled={readOnly}
            aria-label="Size mode"
            onValueChange={(v) =>
              v &&
              upd(`Sizes are ${v}`, (d) => {
                d.mapping.sizeMode = v as ContourDataset['mapping']['sizeMode'];
              })
            }
          >
            <ToggleGroupItem value="radius" className="px-2.5 text-xs" data-testid="bind-radius">
              Radius
            </ToggleGroupItem>
            <ToggleGroupItem value="diameter" className="px-2.5 text-xs" data-testid="bind-diameter">
              Diameter
            </ToggleGroupItem>
          </ToggleGroup>
          <UnitSelect
            label="Size unit"
            testId="bind-unit"
            value={m.sizeUnit}
            disabled={readOnly}
            onChange={(u) =>
              upd(`Size unit ${u}`, (d) => {
                d.mapping.sizeUnit = u;
              })
            }
          />
        </div>
        <ul className="space-y-1" aria-label="Size columns" data-testid="size-columns">
          {m.sizeColumns.map((col, k) => (
            <SizeColumnRow key={col} ds={ds} column={col} index={k} readOnly={readOnly} />
          ))}
        </ul>
        {unmappedNumeric.length > 0 && (
          <Select
            value=""
            disabled={readOnly}
            onValueChange={(c) =>
              upd(`Add size column “${c}”`, (d) => {
                d.mapping.sizeColumns.push(c);
                d.sizeStyles = reconcileSizeStyles(d.mapping.sizeColumns, d.sizeStyles as SizeColumnStyle[]);
              })
            }
          >
            <SelectTrigger size="sm" className="h-7 w-fit text-xs" aria-label="Add size column">
              <Plus className="size-3.5" />
              <SelectValue placeholder="Add size column" />
            </SelectTrigger>
            <SelectContent>
              {unmappedNumeric.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </section>

      <section className="space-y-1.5">
        <h4 className="font-semibold uppercase">Envelope</h4>
        <label className="flex items-center gap-2">
          <Switch
            checked={ds.envelope}
            disabled={readOnly}
            aria-label="Envelope"
            data-testid="envelope-switch"
            onCheckedChange={(on) =>
              upd(on ? 'Show envelope' : 'Hide envelope', (d) => {
                d.envelope = on;
              })
            }
          />
          Union of all visible rings per size column
        </label>
        {ds.envelope && (
          <label className="flex items-center gap-2">
            <Switch
              checked={ds.envelopeStyle?.hideRings === true}
              disabled={readOnly}
              aria-label="Show only the envelope"
              onCheckedChange={(on) =>
                upd(on ? 'Show only the envelope' : 'Show rings with the envelope', (d) => {
                  d.envelopeStyle = { ...(d.envelopeStyle ?? {}), hideRings: on };
                })
              }
            />
            Hide individual rings
          </label>
        )}
        {envelopes.length > 0 && (
          <ul className="space-y-0.5" data-testid="envelope-areas">
            {envelopes.map((e) => (
              <li key={e.sizeColumn} className="flex items-center gap-1.5">
                <Swatch color={e.style.stroke} />
                <span className="min-w-0 flex-1 truncate">{e.legendLabel}</span>
                <span
                  className="tabular-nums"
                  data-testid={`envelope-area-${e.sizeColumn}`}
                  data-area={e.area}
                >
                  {formatArea(e.area, display.areaUnits, display.precision)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1.5">
        <h4 className="font-semibold uppercase">Legend</h4>
        <Row label="Legend group">
          <CommitInput
            ariaLabel="Legend group"
            disabled={readOnly}
            placeholder={ds.name}
            value={ds.legendGroup ?? ''}
            onCommit={(v) =>
              void upd('Legend group', (d) => {
                if (v.trim()) d.legendGroup = v.trim();
                else delete d.legendGroup;
              })
            }
          />
        </Row>
      </section>
    </div>
  );
}

function SizeColumnRow({
  ds,
  column,
  index,
  readOnly,
}: {
  ds: ContourDataset;
  column: string;
  index: number;
  readOnly: boolean;
}) {
  const st = sizeStyleFor(ds, column, index);
  const setStyle = (label: string, patch: Partial<SizeColumnStyle>, coalesceKey?: string) =>
    updateDataset(
      ds.id,
      label,
      (d) => {
        d.sizeStyles = reconcileSizeStyles(d.mapping.sizeColumns, d.sizeStyles as SizeColumnStyle[]);
        const s = d.sizeStyles.find((x) => x.column === column);
        if (s) Object.assign(s, patch);
      },
      coalesceKey ? { coalesceKey } : {},
    );
  const id = `size-vis-${ds.id}-${index}`;
  return (
    <li className="flex items-center gap-1.5" data-testid={`size-column-${column}`}>
      <Checkbox
        id={id}
        checked={st.visible}
        disabled={readOnly}
        aria-label={`Show rings for ${column}`}
        onCheckedChange={(on) =>
          setStyle(`${on ? 'Show' : 'Hide'} rings “${column}”`, { visible: on === true })
        }
      />
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`Style of ${column}`} disabled={readOnly} className="shrink-0">
            <Swatch color={st.color} dash={st.dash} fillOpacity={st.fillOpacity} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 space-y-2 text-xs">
          <div className="font-medium">{column}</div>
          <ColorInput value={st.color} onCommit={(c) => setStyle(`Colour of “${column}”`, { color: c })} />
          <div className="flex items-center gap-2">
            <span className="w-16">Line</span>
            <DashSelect
              label="Line style"
              value={st.dash}
              onChange={(d) => setStyle(`Line style of “${column}”`, { dash: d })}
            />
            <div className="w-20">
              <NumberInput
                ariaLabel="Line width (mm)"
                value={st.strokeWidth}
                min={0.05}
                max={5}
                suffix="mm"
                decimals={2}
                onCommit={(v) => setStyle(`Line width of “${column}”`, { strokeWidth: v })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16">Fill</span>
            <Slider
              aria-label="Fill opacity"
              className="flex-1"
              min={0}
              max={1}
              step={0.02}
              value={[st.fillOpacity]}
              onValueChange={([v]) =>
                setStyle(`Fill of “${column}”`, { fillOpacity: v }, `fill:${ds.id}:${column}`)
              }
            />
            <span className="w-8 text-right tabular-nums">{Math.round(st.fillOpacity * 100)}%</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16">Legend</span>
            <CommitInput
              ariaLabel="Legend label"
              value={st.legendLabel ?? ''}
              placeholder={column}
              onCommit={(v) =>
                void setStyle(`Legend label of “${column}”`, { legendLabel: v.trim() || undefined })
              }
            />
          </div>
        </PopoverContent>
      </Popover>
      <label htmlFor={id} className="min-w-0 flex-1 truncate" title={column}>
        {st.legendLabel || column}
      </label>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove size column ${column}`}
        disabled={readOnly || ds.mapping.sizeColumns.length <= 1}
        onClick={() =>
          updateDataset(ds.id, `Remove size column “${column}”`, (d) => {
            d.mapping.sizeColumns = d.mapping.sizeColumns.filter((c) => c !== column);
          })
        }
      >
        <X />
      </Button>
    </li>
  );
}

function IssuesTab({ ds, onShowRow }: { ds: ContourDataset; onShowRow: () => void }) {
  const project = useProject((p) => p)!;
  const dc = datasetContours(project, ds);
  const { counts, issues } = dc.validation;
  const filtered = dc.passesFilter.reduce((n, v) => n + (v ? 0 : 1), 0);
  const show = (row: number) => {
    if (row <= 0) return;
    useContoursUi.getState().set({ selection: { ds: ds.id, rows: [row - 1] } });
    useContoursUi.getState().revealRow({ ds: ds.id, row: row - 1 });
    onShowRow();
  };
  return (
    <div className="space-y-2 text-xs" data-testid="issues-tab">
      <div className="flex flex-wrap gap-1.5" data-testid="validation-summary">
        <Badge variant="success">{counts.valid} valid</Badge>
        <Badge variant={counts.invalid ? 'warning' : 'outline'}>{counts.invalid} skipped</Badge>
        <Badge variant="outline">{counts.errors} errors</Badge>
        <Badge variant="outline">{counts.warnings} warnings</Badge>
        {filtered > 0 && <Badge variant="outline">{filtered} filtered out</Badge>}
      </div>
      {dc.unmatchedAnchors.length > 0 && (
        <div className="space-y-1 rounded-md border p-2" data-testid="unmatched-anchors">
          <div className="flex items-center gap-1.5 font-medium">
            <CircleAlert className="text-warning size-3.5" /> Unmatched anchors ({dc.unmatchedAnchors.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {dc.unmatchedAnchors.map((a) => (
              <Button
                key={a}
                variant="outline"
                size="xs"
                onClick={() => placeAnchorNamed(a)}
                title={`Place anchor ${a}`}
              >
                <Crosshair /> {a}
              </Button>
            ))}
          </div>
        </div>
      )}
      {issues.length === 0 ? (
        <p className="text-muted-foreground">No problems found.</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border [&_[data-slot=table-container]]:overflow-visible">
          <Table data-testid="issues-table">
            <TableHeader className="bg-muted sticky top-0">
              <TableRow>
                <TableHead className="w-12">Row</TableHead>
                <TableHead>Problem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((i, k) => (
                <TableRow
                  key={k}
                  className="cursor-pointer"
                  data-row={i.row}
                  data-severity={i.severity}
                  onClick={() => show(i.row)}
                >
                  <TableCell className="tabular-nums">{i.row || '—'}</TableCell>
                  <TableCell className="whitespace-normal">
                    <span className={i.severity === 'error' ? 'text-destructive' : 'text-warning'}>
                      {i.severity === 'error' ? 'Error' : 'Warning'}:
                    </span>{' '}
                    {i.message}
                    {i.column && <span className="text-muted-foreground"> ({i.column})</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
