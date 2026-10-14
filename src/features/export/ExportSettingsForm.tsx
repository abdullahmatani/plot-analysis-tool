import type { ReactNode } from 'react';
import { Crosshair, Maximize, MousePointerSquareDashed, ScanLine } from 'lucide-react';

import type { Bounds, PaperSize, Project, SheetLayout, TitleBlock } from '@/core/types';
import { degToRad, formatNumber, radToDeg } from '@/core/units';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CommitInput, NumberInput } from '@/components/inspector/fields';
import { geomBounds, unionBounds } from '@/features/objects/geometry-cache';
import { visibleWorldBounds } from '@/render/view';
import { useViewStore } from '@/store/view';

import { PAPER_SIZES, STANDARD_SCALES } from './scene/sheet';
import { FORMATS, isGraphic, type ExportFormat } from './settings';
import type { ExportOptions } from './run';
import { applyCurrentViewToSheet, fitSheetToContent, setSheet, setTitleField } from './sheet-ops';

/** Settings column of the export dialog (rows 76–81). */

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0" data-testid={testId}>
      <h3 className="text-muted-foreground text-xs font-semibold uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-normal">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} data-testid={id} />
    </div>
  );
}

const DPI_CHOICES = [72, 96, 150, 200, 300, 400, 600];

const TITLE_FIELDS: { key: keyof TitleBlock; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'project', label: 'Project' },
  { key: 'drawingNo', label: 'Drawing no.' },
  { key: 'revision', label: 'Revision' },
  { key: 'date', label: 'Date' },
  { key: 'preparedBy', label: 'Prepared by' },
  { key: 'checkedBy', label: 'Checked by' },
];

function fmtBounds(b: Bounds, precision: number) {
  const f = (v: number) => formatNumber(v, precision);
  return `${f(b.minX)}, ${f(b.minY)} → ${f(b.maxX)}, ${f(b.maxY)}`;
}

export function ExportSettingsForm({
  project,
  options,
  setOptions,
  readOnly,
  contentBounds,
}: {
  project: Project;
  options: ExportOptions;
  setOptions: (patch: Partial<ExportOptions>) => void;
  readOnly: boolean;
  contentBounds: () => Bounds | null;
}) {
  const sheet = project.sheet;
  const fmt = options.format;
  const graphic = isGraphic(fmt);
  const region = fmt === 'pdf' ? 'sheet' : options.region;
  const showSheet = graphic ? region !== 'view' : fmt === 'dxf';
  const setS = (patch: Partial<SheetLayout>, label: string, key?: string) => void setSheet(patch, label, key);
  const scaleValue =
    sheet.scale === null ? 'fit' : STANDARD_SCALES.includes(sheet.scale) ? String(sheet.scale) : 'custom';

  return (
    <div className="space-y-4 text-sm" data-testid="export-settings">
      <Section title="Output">
        <Row label="Format">
          <Select value={fmt} onValueChange={(v) => setOptions({ format: v as ExportFormat })}>
            <SelectTrigger
              size="sm"
              className="w-full"
              aria-label="Export format"
              data-testid="export-format"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATS.map((f) => (
                <SelectItem key={f.id} value={f.id} data-testid={`export-format-${f.id}`}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {(fmt === 'png' || fmt === 'svg') && (
          <Row label="Region">
            <RadioGroup
              value={options.region}
              onValueChange={(v) => setOptions({ region: v as ExportOptions['region'] })}
              className="flex flex-wrap gap-3"
              aria-label="Export region"
            >
              {(['sheet', 'view', 'window'] as const).map((r) => (
                <div key={r} className="flex items-center gap-1.5">
                  <RadioGroupItem value={r} id={`export-region-${r}`} data-testid={`export-region-${r}`} />
                  <Label htmlFor={`export-region-${r}`} className="text-xs font-normal">
                    {r === 'sheet' ? 'Sheet' : r === 'view' ? 'Current view' : 'Window'}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </Row>
        )}
        {fmt === 'png' && (
          <Row label="Resolution" htmlFor="export-dpi">
            <div className="flex items-center gap-1">
              <Select
                value={DPI_CHOICES.includes(options.dpi) ? String(options.dpi) : 'custom'}
                onValueChange={(v) => v !== 'custom' && setOptions({ dpi: Number(v) })}
              >
                <SelectTrigger size="sm" className="w-24" aria-label="Resolution preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DPI_CHOICES.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d} dpi
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <Input
                id="export-dpi"
                data-testid="export-dpi"
                type="number"
                min={10}
                max={1200}
                step="any"
                className="h-7 w-24 text-xs"
                value={options.dpi}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 10 && v <= 1200) setOptions({ dpi: v });
                }}
              />
              <span className="text-muted-foreground text-xs">dpi</span>
            </div>
          </Row>
        )}
        {(fmt === 'png' || fmt === 'svg') && options.region === 'window' && (
          <Row label="Window">
            <div className="space-y-1">
              <div className="flex flex-wrap gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const b = contentBounds();
                    if (b) setOptions({ window: b });
                  }}
                >
                  <Maximize /> Content
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const s = useViewStore.getState();
                    setOptions({ window: visibleWorldBounds(s.view, s.canvasSize.w, s.canvasSize.h) });
                  }}
                >
                  <ScanLine /> View
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const ids = new Set(useViewStore.getState().selection);
                    const b = unionBounds(
                      project.objects.filter((o) => ids.has(o.id)).map((o) => geomBounds(o.geometry)),
                    );
                    if (b) setOptions({ window: b });
                  }}
                >
                  <MousePointerSquareDashed /> Selection
                </Button>
              </div>
              <p className="text-muted-foreground text-[11px]" data-testid="export-window">
                {options.window ? fmtBounds(options.window, project.display.precision) : 'Content extents'}
              </p>
            </div>
          </Row>
        )}
        {graphic && (
          <Toggle
            id="export-underlay"
            label="Include drawings (underlay)"
            checked={options.includeUnderlay}
            onChange={(v) => setOptions({ includeUnderlay: v })}
          />
        )}
        {(fmt === 'dxf' || (graphic && region !== 'sheet')) && (
          <Toggle
            id="export-legend"
            label="Include legend"
            checked={options.includeLegend}
            onChange={(v) => setOptions({ includeLegend: v })}
          />
        )}
        {fmt === 'svg' && (
          <Toggle
            id="export-svg-outlines"
            label="Text as outlines"
            checked={!!options.svgTextAsPaths}
            onChange={(v) => setOptions({ svgTextAsPaths: v })}
          />
        )}
        {fmt === 'dxf' && (
          <>
            <Row label="Coordinates">
              <RadioGroup
                value={options.dxfCoordinates}
                onValueChange={(v) => setOptions({ dxfCoordinates: v as 'drawing' | 'world' })}
                className="flex gap-3"
                aria-label="DXF coordinates"
              >
                {(['drawing', 'world'] as const).map((c) => (
                  <div key={c} className="flex items-center gap-1.5">
                    <RadioGroupItem
                      value={c}
                      id={`dxf-coords-${c}`}
                      disabled={c === 'drawing' && !project.drawings.length}
                    />
                    <Label htmlFor={`dxf-coords-${c}`} className="text-xs font-normal">
                      {c === 'drawing' ? 'Drawing (XREF at 0,0)' : 'World / plant'}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </Row>
            {options.dxfCoordinates === 'drawing' && project.drawings.length > 0 && (
              <Row label="Drawing">
                <Select
                  value={options.dxfDrawingId ?? project.drawings[0].id}
                  onValueChange={(v) => setOptions({ dxfDrawingId: v })}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="DXF coordinates drawing">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {project.drawings.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            )}
            <Row label="Label text">
              <Select
                value={options.dxfText ?? 'auto'}
                onValueChange={(v) => setOptions({ dxfText: v as ExportOptions['dxfText'] })}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="DXF label text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (Arabic as outlines)</SelectItem>
                  <SelectItem value="text">Text (MTEXT, UTF-8)</SelectItem>
                  <SelectItem value="outlines">Outlines (all labels)</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </>
        )}
        {fmt === 'csv' && (
          <Row label="Table">
            <Select value={options.csvTable ?? 'objects'} onValueChange={(v) => setOptions({ csvTable: v })}>
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label="CSV table"
                data-testid="export-csv-table"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="objects">Analysis objects</SelectItem>
                {project.datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    Contours – {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        )}
      </Section>

      {showSheet && (
        <Section title="Sheet" testId="export-sheet">
          <Row label="Paper">
            <div className="flex gap-1">
              <Select
                value={sheet.paper}
                disabled={readOnly}
                onValueChange={(v) => setS({ paper: v as PaperSize }, 'Sheet paper size')}
              >
                <SelectTrigger size="sm" className="w-28" aria-label="Paper size" data-testid="sheet-paper">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAPER_SIZES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p === 'custom' ? 'Custom' : p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sheet.paper !== 'custom' && (
                <Select
                  value={sheet.orientation}
                  disabled={readOnly}
                  onValueChange={(v) =>
                    setS({ orientation: v as SheetLayout['orientation'] }, 'Sheet orientation')
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-28"
                    aria-label="Orientation"
                    data-testid="sheet-orientation"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="landscape">Landscape</SelectItem>
                    <SelectItem value="portrait">Portrait</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </Row>
          {sheet.paper === 'custom' && (
            <Row label="Size (mm)">
              <div className="flex gap-1">
                <NumberInput
                  ariaLabel="Custom width (mm)"
                  value={sheet.customMm?.w ?? 297}
                  min={50}
                  max={5000}
                  disabled={readOnly}
                  onCommit={(w) => setS({ customMm: { w, h: sheet.customMm?.h ?? 210 } }, 'Sheet size')}
                />
                <NumberInput
                  ariaLabel="Custom height (mm)"
                  value={sheet.customMm?.h ?? 210}
                  min={50}
                  max={5000}
                  disabled={readOnly}
                  onCommit={(h) => setS({ customMm: { w: sheet.customMm?.w ?? 297, h } }, 'Sheet size')}
                />
              </div>
            </Row>
          )}
          <Row label="Margins">
            <NumberInput
              ariaLabel="Margins (mm)"
              value={sheet.marginsMm}
              min={0}
              max={100}
              suffix="mm"
              disabled={readOnly}
              onCommit={(v) => setS({ marginsMm: v }, 'Sheet margins')}
            />
          </Row>
          <Row label="Scale">
            <div className="flex items-center gap-1">
              <Select
                value={scaleValue}
                disabled={readOnly}
                onValueChange={(v) => {
                  if (v === 'fit') fitSheetToContent();
                  else if (v !== 'custom') setS({ scale: Number(v) }, 'Sheet scale');
                }}
              >
                <SelectTrigger size="sm" className="w-28" aria-label="Print scale" data-testid="sheet-scale">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fit">Fit</SelectItem>
                  {STANDARD_SCALES.filter((s) => s >= 10).map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      1:{s}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-muted-foreground text-xs">1:</span>
              <CommitInput
                ariaLabel="Scale denominator"
                className="w-20"
                disabled={readOnly}
                placeholder="fit"
                value={sheet.scale === null ? '' : String(sheet.scale)}
                onCommit={(v) => {
                  if (!v.trim()) return void fitSheetToContent();
                  const n = Number(v.replace(/\s/g, ''));
                  if (!(n > 0) || !Number.isFinite(n)) return false;
                  setS({ scale: n }, 'Sheet scale');
                }}
              />
            </div>
          </Row>
          {fmt !== 'dxf' && (
            <>
              <Row label="Rotation">
                <NumberInput
                  ariaLabel="View rotation (degrees)"
                  value={radToDeg(sheet.viewRotation || 0)}
                  min={-360}
                  max={360}
                  suffix="°"
                  disabled={readOnly}
                  onCommit={(d) => setS({ viewRotation: degToRad(d) }, 'Sheet rotation')}
                />
              </Row>
              <Row label="Viewport">
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={readOnly}
                    onClick={() => applyCurrentViewToSheet()}
                    data-testid="sheet-use-view"
                  >
                    <Crosshair /> Use current view
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={readOnly}
                    onClick={() => fitSheetToContent()}
                    data-testid="sheet-fit"
                  >
                    <Maximize /> Fit to content
                  </Button>
                </div>
              </Row>
              {sheet.viewCentre && sheet.scale !== null && (
                <p className="text-muted-foreground text-[11px]">
                  Centre {formatNumber(sheet.viewCentre.x, project.display.precision)},{' '}
                  {formatNumber(sheet.viewCentre.y, project.display.precision)}
                </p>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <Toggle
                  id="sheet-title-block"
                  label="Title block"
                  checked={sheet.showTitleBlock}
                  disabled={readOnly}
                  onChange={(v) => setS({ showTitleBlock: v }, 'Sheet title block')}
                />
                <Toggle
                  id="sheet-legend"
                  label="Legend"
                  checked={sheet.showLegend}
                  disabled={readOnly}
                  onChange={(v) => setS({ showLegend: v }, 'Sheet legend')}
                />
                <Toggle
                  id="sheet-scale-bar"
                  label="Scale bar"
                  checked={sheet.showScaleBar}
                  disabled={readOnly}
                  onChange={(v) => setS({ showScaleBar: v }, 'Sheet scale bar')}
                />
                <Toggle
                  id="sheet-north"
                  label="North arrow"
                  checked={sheet.showNorthArrow}
                  disabled={readOnly}
                  onChange={(v) => setS({ showNorthArrow: v }, 'Sheet north arrow')}
                />
              </div>
            </>
          )}
        </Section>
      )}

      {graphic && region === 'sheet' && sheet.showTitleBlock && (
        <Section title="Title block" testId="export-title-block">
          {TITLE_FIELDS.map((f) => (
            <Row key={f.key} label={f.label} htmlFor={`tb-${f.key}`}>
              <CommitInput
                id={`tb-${f.key}`}
                ariaLabel={`Title block ${f.label}`}
                disabled={readOnly}
                value={sheet.titleBlock[f.key]}
                onCommit={(v) => void setTitleField(f.key, v)}
              />
            </Row>
          ))}
          <Row label="Notes" htmlFor="tb-notes">
            <Textarea
              id="tb-notes"
              aria-label="Title block Notes"
              disabled={readOnly}
              className="min-h-14 text-xs"
              defaultValue={sheet.titleBlock.notes}
              key={sheet.titleBlock.notes}
              onBlur={(e) =>
                e.target.value !== sheet.titleBlock.notes && setTitleField('notes', e.target.value)
              }
              onKeyDown={(e) => e.stopPropagation()}
            />
          </Row>
        </Section>
      )}
    </div>
  );
}
