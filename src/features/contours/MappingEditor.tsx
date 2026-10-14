import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useMemo } from 'react';

import type { CellValue, ContourDataset, Units } from '@/core/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useProject } from '@/store/project';
import { mappingErrors, type Mapping } from '@/tables/suggest';
import { validateDataset } from '@/tables/validate';
import { toNumber } from '@/tables/values';

import { anchorMap, projectExtent } from './compute';
import { LABEL_PLACEMENTS } from './constants';
import { ColumnSelect, Row, UnitSelect } from './controls';
import { hasPlantCalibration } from './import-flow';
import { reconcileSizeStyles } from './ops';

/**
 * Column mapping (row 63): position (X/Y, plant E/N or anchor ID), one or more size columns,
 * radius/diameter, size unit, label (column and template), group/category, colour, shape (circle,
 * square or W×H rectangle), width/height and rotation. Required roles are marked; the caller must
 * not save while `mappingErrors` returns anything.
 */

export interface MappingDraft {
  mapping: Mapping;
  labelTemplate: string;
  labelPlacement: ContourDataset['labelPlacement'];
}

function numericShare(rows: CellValue[][], c: number): number {
  let n = 0;
  let num = 0;
  for (let i = 0; i < Math.min(rows.length, 500); i++) {
    const v = rows[i][c];
    if (v === null || v === undefined || v === '') continue;
    n++;
    if (toNumber(v) !== null) num++;
  }
  return n ? num / n : 0;
}

export function MappingEditor({
  columns,
  rows,
  value,
  onChange,
}: {
  columns: string[];
  rows: CellValue[][];
  value: MappingDraft;
  onChange: (v: MappingDraft) => void;
}) {
  const project = useProject((p) => p);
  const m = value.mapping;
  const pos = m.position;
  const errors = mappingErrors(m, columns);
  const set = (patch: Partial<Mapping>) => onChange({ ...value, mapping: { ...m, ...patch } });
  const setPos = (patch: Partial<Mapping['position']>) => set({ position: { ...pos, ...patch } });
  const numeric = useMemo(() => columns.map((_, c) => numericShare(rows, c) >= 0.5), [columns, rows]);

  // Live preview of what the mapping draws (row 69 validation on the full table).
  const preview = useMemo(() => {
    if (!project || errors.length) return null;
    const ds: ContourDataset = {
      id: 'preview',
      name: 'preview',
      visible: true,
      table: { columns, rows },
      mapping: m,
      sizeStyles: reconcileSizeStyles(m.sizeColumns, []),
      styleRules: [],
      labelTemplate: value.labelTemplate,
      labelPlacement: value.labelPlacement,
      envelope: false,
      order: 0,
    };
    const v = validateDataset(ds, { anchors: anchorMap(project.anchors), extent: projectExtent(project) });
    const unknown = new Set<string>();
    for (const i of v.issues)
      if (i.message.startsWith('Unknown anchor')) unknown.add(i.message.slice(16, -1));
    return { counts: v.counts, unknown: [...unknown] };
  }, [project, columns, rows, m, value.labelTemplate, value.labelPlacement, errors.length]);

  const has = (c: string | undefined) => !!c && columns.includes(c);
  const sizeSet = new Set(m.sizeColumns);
  const isPlant = pos.mode === 'plant';

  return (
    <div className="grid gap-3 text-sm" data-testid="mapping-editor">
      <section className="grid gap-2">
        <h4 className="text-xs font-semibold uppercase">Position</h4>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={pos.mode}
          onValueChange={(v) => v && setPos({ mode: v as Mapping['position']['mode'] })}
          aria-label="Position mode"
          className="w-fit"
        >
          <ToggleGroupItem value="xy" className="px-3 text-xs" data-testid="mode-xy">
            X / Y
          </ToggleGroupItem>
          <ToggleGroupItem value="plant" className="px-3 text-xs" data-testid="mode-plant">
            Plant E / N
          </ToggleGroupItem>
          <ToggleGroupItem value="anchor" className="px-3 text-xs" data-testid="mode-anchor">
            Anchor name
          </ToggleGroupItem>
        </ToggleGroup>
        {pos.mode === 'anchor' ? (
          <Row label="Anchor column" required>
            <ColumnSelect
              label="Anchor column"
              testId="map-anchor"
              columns={columns}
              allowNone={false}
              value={pos.anchor}
              invalid={!has(pos.anchor)}
              onChange={(c) => setPos({ anchor: c })}
            />
          </Row>
        ) : (
          <>
            <Row label={isPlant ? 'Easting (E)' : 'X'} required>
              <ColumnSelect
                label={isPlant ? 'Easting column' : 'X column'}
                testId="map-x"
                columns={columns}
                value={pos.x}
                invalid={!has(pos.x)}
                onChange={(c) => setPos({ x: c })}
              />
            </Row>
            <Row label={isPlant ? 'Northing (N)' : 'Y'} required>
              <ColumnSelect
                label={isPlant ? 'Northing column' : 'Y column'}
                testId="map-y"
                columns={columns}
                value={pos.y}
                invalid={!has(pos.y)}
                onChange={(c) => setPos({ y: c })}
              />
            </Row>
            <Row label="Coordinate unit">
              <UnitSelect
                label="Coordinate unit"
                value={pos.coordUnit ?? 'm'}
                onChange={(u) => setPos({ coordUnit: u })}
              />
            </Row>
            {isPlant && project && !hasPlantCalibration(project) && (
              <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" />
                No drawing is calibrated with plant coordinates yet; E/N values are used as world coordinates.
                Calibrate a drawing by coordinates to place them on the plot plan.
              </p>
            )}
          </>
        )}
      </section>
      <Separator />
      <section className="grid gap-2">
        <h4 className="text-xs font-semibold uppercase">
          Size columns <span className="text-destructive">*</span>
          <span className="text-muted-foreground ml-1 font-normal normal-case">one ring set per column</span>
        </h4>
        <div
          className="grid max-h-36 grid-cols-2 gap-x-3 gap-y-1 overflow-auto rounded-md border p-2"
          role="group"
          aria-label="Size columns"
          data-testid="map-sizes"
        >
          {columns.map((c, i) => {
            const id = `size-col-${i}`;
            return (
              <div key={c} className="flex min-w-0 items-center gap-1.5">
                <Checkbox
                  id={id}
                  checked={sizeSet.has(c)}
                  onCheckedChange={(on) =>
                    set({
                      sizeColumns: on
                        ? columns.filter((x) => x === c || sizeSet.has(x))
                        : m.sizeColumns.filter((x) => x !== c),
                    })
                  }
                />
                <Label
                  htmlFor={id}
                  className={`min-w-0 truncate text-xs font-normal ${numeric[i] ? '' : 'text-muted-foreground'}`}
                  title={c}
                >
                  {c}
                </Label>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={m.sizeMode}
            onValueChange={(v) => v && set({ sizeMode: v as Mapping['sizeMode'] })}
            aria-label="Size mode"
          >
            <ToggleGroupItem value="radius" className="px-3 text-xs">
              Radius
            </ToggleGroupItem>
            <ToggleGroupItem value="diameter" className="px-3 text-xs">
              Diameter
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">Unit</span>
            <UnitSelect label="Size unit" value={m.sizeUnit} onChange={(u: Units) => set({ sizeUnit: u })} />
          </div>
        </div>
      </section>
      <Separator />
      <section className="grid gap-2">
        <h4 className="text-xs font-semibold uppercase">Labels and styling</h4>
        <Row label="Label column">
          <ColumnSelect
            label="Label column"
            testId="map-label"
            columns={columns}
            value={m.label}
            onChange={(c) => set({ label: c })}
          />
        </Row>
        <Row label="Label template" htmlFor="map-template">
          <Input
            id="map-template"
            className="h-8 text-xs"
            placeholder={m.label ? '{label}' : 'e.g. {label} – {radius} m'}
            value={value.labelTemplate}
            onChange={(e) => onChange({ ...value, labelTemplate: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Row>
        <Row label="Label placement">
          <Select
            value={value.labelPlacement}
            onValueChange={(v) => onChange({ ...value, labelPlacement: v as MappingDraft['labelPlacement'] })}
          >
            <SelectTrigger size="sm" className="w-36 text-xs" aria-label="Label placement">
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
        </Row>
        <Row label="Group / category">
          <ColumnSelect
            label="Group column"
            testId="map-group"
            columns={columns}
            value={m.group}
            onChange={(c) => set({ group: c })}
          />
        </Row>
        <Row label="Colour column">
          <ColumnSelect
            label="Colour column"
            columns={columns}
            value={m.color}
            onChange={(c) => set({ color: c })}
          />
        </Row>
        <Row label="Shape column">
          <ColumnSelect
            label="Shape column"
            columns={columns}
            value={m.shape}
            onChange={(c) => set({ shape: c })}
          />
        </Row>
        {m.shape && (
          <>
            <Row label="Width (W×H)">
              <ColumnSelect
                label="Width column"
                columns={columns}
                value={m.width}
                onChange={(c) => set({ width: c })}
              />
            </Row>
            <Row label="Height (W×H)">
              <ColumnSelect
                label="Height column"
                columns={columns}
                value={m.height}
                onChange={(c) => set({ height: c })}
              />
            </Row>
            <Row label="Rotation (°)">
              <ColumnSelect
                label="Rotation column"
                columns={columns}
                value={m.rotation}
                onChange={(c) => set({ rotation: c })}
              />
            </Row>
            <p className="text-muted-foreground text-xs">
              Shape values: circle (default), square, or rect for a W×H rectangle grown by the size.
            </p>
          </>
        )}
      </section>
      {errors.length > 0 ? (
        <Alert variant="destructive" data-testid="mapping-errors">
          <CircleAlert />
          <AlertTitle>Required roles are not mapped</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        preview && (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="mapping-preview">
            <Badge variant={preview.counts.invalid ? 'warning' : 'success'}>
              {preview.counts.valid} of {preview.counts.total} rows draw
            </Badge>
            {preview.counts.invalid > 0 && (
              <span className="text-muted-foreground">
                {preview.counts.invalid} row(s) skipped — listed with reasons after import.
              </span>
            )}
            {preview.unknown.length > 0 && (
              <span className="text-muted-foreground" data-testid="mapping-unmatched">
                Unmatched anchors: {preview.unknown.slice(0, 8).join(', ')}
                {preview.unknown.length > 8 ? ` +${preview.unknown.length - 8}` : ''}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
