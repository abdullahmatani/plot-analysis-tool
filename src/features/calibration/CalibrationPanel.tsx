import { Crosshair, MapPin, Ruler, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import type { Drawing, ProjectDisplay, Pt } from '@/core/types';
import { formatNumber, METRES_PER_PT } from '@/core/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useProject, useProjectStore } from '@/store/project';
import { calibrationState, useModelsStore } from '@/underlay/models';

import {
  DEFAULT_DISPLAY,
  fmtAngle,
  fmtLength,
  LENGTH_UNIT_OPTIONS,
  nativeUnitsLabel,
} from '@/features/units/format';

import {
  applyCalibration,
  applyRatioTab,
  drawingUnitName,
  pickDistance,
  pickPoint,
  pickTwoPoint,
  previewDistances,
  previewPoints,
  previewRatio,
  previewTwoPoint,
  removeCalibration,
  stopPicking,
  type Preview,
} from './actions';
import {
  equivalentRatio,
  metresPerUnit,
  PAPER_SIZES,
  paperName,
  PT_TO_MM,
  type PointFitKind,
} from './compute';
import { Note, PanelShell, Row, StateBadge } from './panel-ui';
import { closeSession, useCalStore, type CalibrateSession, type CalTab, type PointRow } from './store';

/** Calibration panel (rows 26, 28–31): non-modal, values typed here while points are picked on the canvas. */

const update = (fn: (s: CalibrateSession) => void) => useCalStore.getState().update('calibrate', fn);

function drawingLength(d: Drawing, a: Pt, b: Pt): string {
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  const unit = drawingUnitName(d);
  const paper = d.source.kind === 'pdf' ? ` (${formatNumber(l * PT_TO_MM, 2)} mm on paper)` : '';
  return `${formatNumber(l, 3)} ${unit}${paper}`;
}

function scaleText(d: Drawing, k: number, display: ProjectDisplay): string {
  const per = fmtLength(k, { ...display, precision: Math.max(4, display.precision) });
  const ratio = d.source.kind === 'pdf' ? ` · ≈ 1:${Number(equivalentRatio(k).toPrecision(6))}` : '';
  return `1 ${drawingUnitName(d)} = ${per}${ratio}`;
}

function ApplyBar({
  preview,
  onApply,
  disabled,
  label = 'Apply calibration',
}: {
  preview: Preview;
  onApply: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <Button size="sm" data-testid="cal-apply" disabled={disabled || !preview.calibration} onClick={onApply}>
        {label}
      </Button>
    </div>
  );
}

function PickButton({
  active,
  onPick,
  label,
  testId,
}: {
  active: boolean;
  onPick: () => void;
  label: string;
  testId?: string;
}) {
  return active ? (
    <Button
      size="xs"
      variant="secondary"
      onClick={stopPicking}
      data-testid={testId ? `${testId}-cancel` : undefined}
    >
      <Crosshair className="animate-pulse" /> Picking… (Esc)
    </Button>
  ) : (
    <Button size="xs" variant="outline" onClick={onPick} data-testid={testId}>
      <Crosshair /> {label}
    </Button>
  );
}

function TwoPointTab({
  s,
  d,
  display,
  readOnly,
}: {
  s: CalibrateSession;
  d: Drawing;
  display: ProjectDisplay;
  readOnly: boolean;
}) {
  const preview = previewTwoPoint(s);
  const { a, b } = s.twoPoint;
  const picking = s.picking?.list === 'twoPoint';
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <Note>
        Pick both ends of a dimension whose real length you know (snaps to the drawing), then type that
        length.
      </Note>
      <div className="flex flex-wrap items-center gap-2">
        <PickButton
          active={picking}
          onPick={pickTwoPoint}
          label={a && b ? 'Pick again' : 'Pick 2 points'}
          testId="cal-pick"
        />
        <span className="text-muted-foreground text-xs" data-testid="cal-picked">
          {a && b ? `Picked: ${drawingLength(d, a, b)}` : a ? 'Point 1 picked' : 'No points picked'}
        </span>
      </div>
      <Row label="Real length" htmlFor="cal-real-length">
        <div className="flex items-center gap-1">
          <Input
            id="cal-real-length"
            data-testid="cal-real-length"
            className="h-7 text-xs"
            placeholder={`e.g. 100 (${display.units})`}
            value={s.twoPoint.value}
            disabled={readOnly}
            onChange={(e) => update((x) => void (x.twoPoint.value = e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && preview.calibration) void applyCalibration(d.id, preview.calibration);
            }}
          />
          <span className="text-muted-foreground w-6 text-xs">{display.units}</span>
        </div>
      </Row>
      {preview.error && <Note tone="error">{preview.error}</Note>}
      {preview.calibration && (
        <Note tone="success">
          <span data-testid="cal-preview">
            {scaleText(d, metresPerUnit(preview.calibration.transform), display)}
          </span>
        </Note>
      )}
      <ApplyBar
        preview={preview}
        disabled={readOnly}
        onApply={() => void applyCalibration(d.id, preview.calibration!)}
      />
    </div>
  );
}

function Residual({
  value,
  worst,
  display,
}: {
  value: number | undefined;
  worst: boolean;
  display: ProjectDisplay;
}) {
  if (value === undefined) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('tabular-nums', worst && 'text-destructive font-semibold')}>
      {value >= 0 ? '+' : ''}
      {fmtLength(value, { ...display, precision: display.precision + 1 })}
    </span>
  );
}

function FitSummary({
  preview,
  display,
  testId,
}: {
  preview: Preview;
  display: ProjectDisplay;
  testId: string;
}) {
  if (preview.error) return <Note tone="error">{preview.error}</Note>;
  if (!preview.fit)
    return (
      <Note>
        {preview.have} of {preview.needed} references complete.
      </Note>
    );
  const f = preview.fit;
  return (
    <div className="bg-muted/50 grid grid-cols-1 gap-0.5 rounded px-2 py-1.5 text-xs" data-testid={testId}>
      <div>
        RMS residual{' '}
        <strong className="tabular-nums" data-testid="cal-rms" data-rms={f.rms}>
          {fmtLength(f.rms, { ...display, precision: display.precision + 1 })}
        </strong>
        {preview.worstRow !== null && f.rms > 1e-9 && (
          <>
            {' '}
            · worst <strong>#{preview.worstRow + 1}</strong>
          </>
        )}
      </div>
      <div className="text-muted-foreground">
        {f.kx !== undefined && f.ky !== undefined
          ? `Scale X ${formatNumber(f.kx, 6)} · Y ${formatNumber(f.ky, 6)} m/unit`
          : `Scale ${formatNumber(f.scale, 6)} m/unit`}
        {f.rotation !== undefined && ` · rotation ${fmtAngle(f.rotation, display)}`}
      </div>
    </div>
  );
}

function DistanceRows({
  s,
  d,
  display,
  readOnly,
  preview,
}: {
  s: CalibrateSession;
  d: Drawing;
  display: ProjectDisplay;
  readOnly: boolean;
  preview: Preview;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5" data-testid="cal-ref-table">
      {s.distances.map((r, i) => {
        const picking = s.picking?.list === 'distances' && s.picking.index === i;
        const worst = preview.worstRow === i && (preview.fit?.rms ?? 0) > 0;
        return (
          <div
            key={i}
            className={cn(
              'grid grid-cols-1 gap-1 rounded border px-2 py-1.5',
              worst && 'border-destructive/70 bg-destructive/5',
            )}
            data-testid={`cal-ref-row-${i}`}
            data-worst={worst ? 'true' : 'false'}
          >
            <div className="flex items-center gap-1.5 text-xs">
              <Badge variant={worst ? 'destructive' : 'secondary'} className="font-mono">
                #{i + 1}
              </Badge>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {r.a && r.b ? drawingLength(d, r.a, r.b) : picking ? 'Picking…' : 'Not picked'}
              </span>
              {worst && <span className="text-destructive text-[11px] font-medium">worst</span>}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Pick reference ${i + 1} again`}
                disabled={readOnly}
                onClick={() => (picking ? stopPicking() : pickDistance(i))}
              >
                <RotateCcw />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove reference ${i + 1}`}
                disabled={readOnly}
                onClick={() => update((x) => void x.distances.splice(i, 1))}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <div className="flex min-w-0 items-center gap-1">
                <Input
                  className="h-7 text-xs"
                  data-testid={`cal-ref-value-${i}`}
                  aria-label={`Real length of reference ${i + 1}`}
                  placeholder="Real length"
                  value={r.value}
                  disabled={readOnly}
                  onChange={(e) => update((x) => void (x.distances[i].value = e.target.value))}
                />
                <span className="text-muted-foreground text-xs">{display.units}</span>
              </div>
              <span className="text-xs" data-testid={`cal-ref-residual-${i}`}>
                <Residual value={preview.residuals[i]} worst={worst} display={display} />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PointRows({
  rows,
  list,
  display,
  readOnly,
  preview,
  axes,
  picking,
}: {
  rows: PointRow[];
  list: 'points' | 'coords';
  display: ProjectDisplay;
  readOnly: boolean;
  preview: Preview;
  axes: [string, string];
  picking: number | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5" data-testid={`cal-${list}-table`}>
      {rows.map((r, i) => {
        const worst = preview.worstRow === i && (preview.fit?.rms ?? 0) > 1e-9 && rows.length > 2;
        return (
          <div
            key={i}
            className={cn(
              'grid grid-cols-1 gap-1 rounded border px-2 py-1.5',
              worst && 'border-destructive/70 bg-destructive/5',
            )}
            data-testid={`cal-${list}-row-${i}`}
            data-worst={worst ? 'true' : 'false'}
          >
            <div className="flex items-center gap-1.5 text-xs">
              <Badge variant={worst ? 'destructive' : 'secondary'} className="font-mono">
                #{i + 1}
              </Badge>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {r.p ? 'Point picked' : picking === i ? 'Picking…' : 'Not picked'}
              </span>
              <span className="text-xs">
                <Residual value={preview.residuals[i]} worst={worst} display={display} />
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Pick point ${i + 1} again`}
                disabled={readOnly}
                onClick={() => (picking === i ? stopPicking() : pickPoint(list, i))}
              >
                <RotateCcw />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove point ${i + 1}`}
                disabled={readOnly}
                onClick={() => update((x) => void x[list].splice(i, 1))}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
              {(['x', 'y'] as const).map((k, ai) => (
                <div key={k} className="flex min-w-0 items-center gap-1">
                  <span className="text-muted-foreground w-3 text-xs">{axes[ai]}</span>
                  <Input
                    className="h-7 text-xs"
                    data-testid={`cal-${list}-${k}-${i}`}
                    aria-label={`${axes[ai]} of point ${i + 1}`}
                    placeholder={display.units}
                    value={r[k]}
                    disabled={readOnly}
                    onChange={(e) => update((x) => void (x[list][i][k] = e.target.value))}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FIT_OPTIONS: { value: PointFitKind; label: string }[] = [
  { value: 'similarity', label: 'Similarity (scale, rotation, shift)' },
  { value: 'scale-xy', label: 'Separate X/Y scale' },
  { value: 'affine', label: 'Affine (distorted scans)' },
];

function FitSelect({
  value,
  onChange,
  disabled,
}: {
  value: PointFitKind;
  onChange: (v: PointFitKind) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PointFitKind)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-full text-xs" aria-label="Fit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FIT_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ReferencesTab({
  s,
  d,
  display,
  readOnly,
}: {
  s: CalibrateSession;
  d: Drawing;
  display: ProjectDisplay;
  readOnly: boolean;
}) {
  const distPreview = useMemo(() => previewDistances(s), [s]);
  const ptPreview = useMemo(() => previewPoints(s, 'points'), [s]);
  const preview = s.refMode === 'distance' ? distPreview : ptPreview;
  const picking = s.picking?.list === (s.refMode === 'distance' ? 'distances' : 'points');
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <Note>
        Three or more known distances (or points with known coordinates); a least-squares fit reports each
        reference's residual and highlights the worst.
      </Note>
      <Tabs
        value={s.refMode}
        onValueChange={(v) => update((x) => void (x.refMode = v as 'distance' | 'point'))}
      >
        <TabsList className="h-7" aria-label="Reference type">
          <TabsTrigger value="distance" data-testid="cal-refs-distance">
            Distances
          </TabsTrigger>
          <TabsTrigger value="point" data-testid="cal-refs-point">
            Points
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {s.refMode === 'distance' ? (
        <>
          <DistanceRows s={s} d={d} display={display} readOnly={readOnly} preview={distPreview} />
          <div className="flex items-center justify-between gap-2">
            <PickButton
              active={picking}
              onPick={() => pickDistance()}
              label="Add distance"
              testId="cal-add-ref"
            />
            <Label className="flex items-center gap-1.5 text-xs font-normal">
              <Switch
                checked={s.separateXY}
                disabled={readOnly}
                onCheckedChange={(v) => update((x) => void (x.separateXY = v))}
                aria-label="Separate X/Y scale"
              />
              Separate X/Y scale
            </Label>
          </div>
        </>
      ) : (
        <>
          <PointRows
            rows={s.points}
            list="points"
            display={display}
            readOnly={readOnly}
            preview={ptPreview}
            axes={['X', 'Y']}
            picking={s.picking?.list === 'points' ? s.picking.index : null}
          />
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
            <PickButton
              active={picking}
              onPick={() => pickPoint('points')}
              label="Add point"
              testId="cal-add-point"
            />
            <FitSelect
              value={s.pointFit}
              disabled={readOnly}
              onChange={(v) => update((x) => void (x.pointFit = v))}
            />
          </div>
        </>
      )}
      <FitSummary preview={preview} display={display} testId="cal-fit" />
      <ApplyBar
        preview={preview}
        disabled={readOnly}
        onApply={() => void applyCalibration(d.id, preview.calibration!)}
      />
    </div>
  );
}

function CoordinatesTab({
  s,
  d,
  display,
  readOnly,
}: {
  s: CalibrateSession;
  d: Drawing;
  display: ProjectDisplay;
  readOnly: boolean;
}) {
  const preview = useMemo(() => previewPoints(s, 'coords'), [s]);
  const picking = s.picking?.list === 'coords';
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <Note>
        Pick two or more points with known plant coordinates (e.g. grid intersections) and type their E/N.
        World coordinates then are plant coordinates.
      </Note>
      <PointRows
        rows={s.coords}
        list="coords"
        display={display}
        readOnly={readOnly}
        preview={preview}
        axes={['E', 'N']}
        picking={picking ? s.picking!.index : null}
      />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
        <PickButton
          active={picking}
          onPick={() => pickPoint('coords')}
          label="Add point"
          testId="cal-add-coord"
        />
        <FitSelect
          value={s.coordFit}
          disabled={readOnly}
          onChange={(v) => update((x) => void (x.coordFit = v))}
        />
      </div>
      <FitSummary preview={preview} display={display} testId="cal-coord-fit" />
      <ApplyBar
        preview={preview}
        disabled={readOnly}
        onApply={() => void applyCalibration(d.id, preview.calibration!)}
      />
    </div>
  );
}

function RatioTab({
  s,
  d,
  display,
  readOnly,
}: {
  s: CalibrateSession;
  d: Drawing;
  display: ProjectDisplay;
  readOnly: boolean;
}) {
  const model = useModelsStore((st) => st.models[d.id]);
  const preview = previewRatio(s, d);
  const page = model?.result?.page;
  if (d.source.kind === 'pdf') {
    const name = page ? paperName(page.width, page.height) : null;
    const wMm = page ? page.width * PT_TO_MM : 0;
    const hMm = page ? page.height * PT_TO_MM : 0;
    const k = preview.factor && preview.calibration ? metresPerUnit(preview.calibration.transform) : null;
    return (
      <div className="grid grid-cols-1 gap-2.5">
        <Note>
          Enter the scale stated on the drawing. The PDF's true paper size is used: 1 pt ={' '}
          {formatNumber(METRES_PER_PT * 1000, 4)} mm on paper.
        </Note>
        <Row label="Page size">
          <span className="text-xs tabular-nums" data-testid="cal-page-size">
            {page ? `${formatNumber(wMm, 1)} × ${formatNumber(hMm, 1)} mm${name ? ` (${name})` : ''}` : '—'}
          </span>
        </Row>
        <Row label="Stated scale" htmlFor="cal-ratio">
          <div className="flex items-center gap-1">
            <span className="text-xs">1&nbsp;:</span>
            <Input
              id="cal-ratio"
              data-testid="cal-ratio"
              className="h-7 text-xs"
              placeholder="500"
              inputMode="decimal"
              value={s.ratio}
              disabled={readOnly}
              onChange={(e) => update((x) => void (x.ratio = e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && preview.calibration) void applyRatioTab(s);
              }}
            />
          </div>
        </Row>
        <Row label="Scale refers to">
          <Select
            value={s.sheet ?? 'page'}
            disabled={readOnly}
            onValueChange={(v) => update((x) => void (x.sheet = v === 'page' ? null : v))}
          >
            <SelectTrigger size="sm" className="w-full text-xs" aria-label="Sheet size of the stated scale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="page">This PDF page{name ? ` (${name})` : ''}</SelectItem>
              {PAPER_SIZES.filter((p) => p.name !== name).map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.name} sheet ({p.w} × {p.h} mm)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {preview.error && <Note tone="error">{preview.error}</Note>}
        {k !== null && page && (
          <Note tone="success">
            <span data-testid="cal-preview">
              1 pt = {fmtLength(k, { ...display, precision: Math.max(4, display.precision) })} · sheet covers{' '}
              {fmtLength(page.width * k, display)} × {fmtLength(page.height * k, display)}
            </span>
          </Note>
        )}
        <ApplyBar preview={preview} disabled={readOnly} onApply={() => void applyRatioTab(s)} />
      </div>
    );
  }
  const insunits = model?.result?.insunits;
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <Note>Confirm the drawing units read from the file header, or override them.</Note>
      <Row label="File units">
        <span className="text-xs" data-testid="cal-file-units">
          {nativeUnitsLabel(d, insunits)}
        </span>
      </Row>
      <Row label="Drawing units">
        <Select
          value={s.unit || 'file'}
          disabled={readOnly}
          onValueChange={(v) =>
            update((x) => void (x.unit = v === 'file' ? '' : (v as CalibrateSession['unit'])))
          }
        >
          <SelectTrigger
            size="sm"
            className="w-full text-xs"
            aria-label="Drawing units"
            data-testid="cal-units"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="file">As in the file</SelectItem>
            {LENGTH_UNIT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Drawn at scale" htmlFor="cal-cad-ratio">
        <div className="flex items-center gap-1">
          <span className="text-xs">1&nbsp;:</span>
          <Input
            id="cal-cad-ratio"
            data-testid="cal-ratio"
            className="h-7 text-xs"
            placeholder="1"
            value={s.ratio}
            disabled={readOnly}
            onChange={(e) => update((x) => void (x.ratio = e.target.value))}
          />
        </div>
      </Row>
      {preview.error && <Note tone="error">{preview.error}</Note>}
      {preview.factor !== null && (
        <Note tone="success">
          <span data-testid="cal-preview">
            1 drawing unit ={' '}
            {fmtLength(preview.factor, { ...display, precision: Math.max(4, display.precision) })}
          </span>
        </Note>
      )}
      <ApplyBar
        preview={preview}
        disabled={readOnly}
        label="Confirm units"
        onApply={() => void applyRatioTab(s)}
      />
    </div>
  );
}

export function CalibrationPanel({ s }: { s: CalibrateSession }) {
  const d = useProject((p) => p.drawings.find((x) => x.id === s.drawingId));
  const display = useProject((p) => p.display) ?? DEFAULT_DISPLAY;
  const readOnly = useProjectStore((st) => st.readOnly);
  if (!d) return null;
  const state = calibrationState(d);
  const k = d.calibration ? metresPerUnit(d.calibration.transform) : null;
  return (
    <PanelShell
      testId="calibration-panel"
      icon={<Ruler />}
      title={`Calibrate “${d.name}”`}
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={state} />
          <span data-testid="cal-current-scale">
            {k !== null ? scaleText(d, k, display) : nativeUnitsLabel(d)}
          </span>
        </span>
      }
      onClose={() => {
        stopPicking();
        closeSession();
      }}
      footer={
        <>
          {d.calibration && (
            <Button
              size="xs"
              variant="ghost"
              disabled={readOnly}
              onClick={() => void removeCalibration(d.id)}
            >
              Remove calibration
            </Button>
          )}
          <div className="flex-1" />
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              stopPicking();
              closeSession();
            }}
          >
            Close
          </Button>
        </>
      }
    >
      <Tabs value={s.tab} onValueChange={(v) => update((x) => void (x.tab = v as CalTab))} className="gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="two-point" data-testid="cal-tab-two-point">
            Two points
          </TabsTrigger>
          <TabsTrigger value="references" data-testid="cal-tab-references">
            References
          </TabsTrigger>
          <TabsTrigger value="ratio" data-testid="cal-tab-ratio">
            {d.source.kind === 'pdf' ? 'Ratio' : 'Units'}
          </TabsTrigger>
          <TabsTrigger value="coordinates" data-testid="cal-tab-coordinates">
            <MapPin className="size-3.5" /> Plant
          </TabsTrigger>
        </TabsList>
        <TabsContent value="two-point">
          <TwoPointTab s={s} d={d} display={display} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="references">
          <ReferencesTab s={s} d={d} display={display} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="ratio">
          <RatioTab s={s} d={d} display={display} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="coordinates">
          <CoordinatesTab s={s} d={d} display={display} readOnly={readOnly} />
        </TabsContent>
      </Tabs>
    </PanelShell>
  );
}
