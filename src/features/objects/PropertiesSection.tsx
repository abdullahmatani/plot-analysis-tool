import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { promptText } from '@/app/prompt';
import { newId } from '@/core/ids';
import type { AnalysisObject, DashStyle, Geometry, HatchPattern, LabelPlacement, Style } from '@/core/types';
import { degToRad, formatArea, formatLength, radToDeg } from '@/core/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ColorInput, CommitInput, Field, LengthInput, NumberInput } from '@/components/inspector/fields';
import { commit, useProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';

import { measures } from './labels';
import { resolveStyle } from './style';

/** Selected-object properties: name, layer, exact geometry (row 44), label (row 40), style and presets (row 42), attributes (row 45). */

const DASHES: { v: DashStyle; l: string }[] = [
  { v: 'solid', l: 'Solid' },
  { v: 'dash', l: 'Dashed' },
  { v: 'dot', l: 'Dotted' },
  { v: 'dash-dot', l: 'Dash-dot' },
  { v: 'long-dash', l: 'Long dash' },
];
const HATCHES: { v: HatchPattern; l: string }[] = [
  { v: 'none', l: 'No fill' },
  { v: 'solid', l: 'Solid' },
  { v: 'diagonal', l: 'Diagonal' },
  { v: 'back-diagonal', l: 'Back diagonal' },
  { v: 'cross', l: 'Cross' },
  { v: 'diagonal-cross', l: 'Diagonal cross' },
  { v: 'horizontal', l: 'Horizontal' },
  { v: 'vertical', l: 'Vertical' },
  { v: 'dots', l: 'Dots' },
];
const PLACEMENTS: { v: LabelPlacement; l: string }[] = [
  { v: 'centroid', l: 'Centre' },
  { v: 'top', l: 'Top' },
  { v: 'boundary', l: 'On boundary' },
  { v: 'leader', l: 'Leader' },
];
const FIELDS = [
  'name',
  'area',
  'perimeter',
  'length',
  'radius',
  'diameter',
  'layer',
  'category',
  'notes',
  'area_unit',
  'unit',
];

function updateSelected(label: string, ids: string[], fn: (o: AnalysisObject) => void, coalesceKey?: string) {
  const set = new Set(ids);
  commit(
    label,
    (d) => {
      for (const o of d.objects) if (set.has(o.id)) fn(o as AnalysisObject);
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

function setGeom(id: string, g: Geometry) {
  updateSelected('Edit dimensions', [id], (o) => void (o.geometry = g));
}

function GeometryFields({ o, readOnly }: { o: AnalysisObject; readOnly: boolean }) {
  const display = useProject((p) => p.display)!;
  const g = o.geometry;
  const L = (label: string, metres: number, fn: (m: number) => void, allowNegative = true) => (
    <Field label={label}>
      <LengthInput
        ariaLabel={label}
        metres={metres}
        units={display.units}
        precision={display.precision}
        allowNegative={allowNegative}
        disabled={readOnly}
        onCommit={fn}
      />
    </Field>
  );
  const A = (label: string, rad: number, fn: (r: number) => void) => (
    <Field label={label}>
      <NumberInput
        ariaLabel={label}
        value={radToDeg(rad)}
        suffix="°"
        disabled={readOnly}
        onCommit={(v) => fn(degToRad(v))}
      />
    </Field>
  );
  switch (g.type) {
    case 'circle':
      return (
        <>
          {L('Centre X', g.c.x, (x) => setGeom(o.id, { ...g, c: { ...g.c, x } }))}
          {L('Centre Y', g.c.y, (y) => setGeom(o.id, { ...g, c: { ...g.c, y } }))}
          {L('Radius', g.r, (r) => r > 0 && setGeom(o.id, { ...g, r }), false)}
          {L('Diameter', g.r * 2, (d) => d > 0 && setGeom(o.id, { ...g, r: d / 2 }), false)}
        </>
      );
    case 'arc':
      return (
        <>
          {L('Centre X', g.c.x, (x) => setGeom(o.id, { ...g, c: { ...g.c, x } }))}
          {L('Centre Y', g.c.y, (y) => setGeom(o.id, { ...g, c: { ...g.c, y } }))}
          {L('Radius', g.r, (r) => r > 0 && setGeom(o.id, { ...g, r }), false)}
          {A('Start angle', g.a0, (a0) => setGeom(o.id, { ...g, a0 }))}
          {A('End angle', g.a1, (a1) => setGeom(o.id, { ...g, a1 }))}
        </>
      );
    case 'rect':
      return (
        <>
          {L('Centre X', g.c.x, (x) => setGeom(o.id, { ...g, c: { ...g.c, x } }))}
          {L('Centre Y', g.c.y, (y) => setGeom(o.id, { ...g, c: { ...g.c, y } }))}
          {L('Width', g.w, (w) => w > 0 && setGeom(o.id, { ...g, w }), false)}
          {L('Height', g.h, (h) => h > 0 && setGeom(o.id, { ...g, h }), false)}
          {A('Rotation', g.rot, (rot) => setGeom(o.id, { ...g, rot }))}
        </>
      );
    case 'ellipse':
      return (
        <>
          {L('Centre X', g.c.x, (x) => setGeom(o.id, { ...g, c: { ...g.c, x } }))}
          {L('Centre Y', g.c.y, (y) => setGeom(o.id, { ...g, c: { ...g.c, y } }))}
          {L('Semi-axis X', g.rx, (rx) => rx > 0 && setGeom(o.id, { ...g, rx }), false)}
          {L('Semi-axis Y', g.ry, (ry) => ry > 0 && setGeom(o.id, { ...g, ry }), false)}
          {A('Rotation', g.rot, (rot) => setGeom(o.id, { ...g, rot }))}
        </>
      );
    case 'point':
      return (
        <>
          {L('X', g.p.x, (x) => setGeom(o.id, { ...g, p: { ...g.p, x } }))}
          {L('Y', g.p.y, (y) => setGeom(o.id, { ...g, p: { ...g.p, y } }))}
        </>
      );
    case 'polyline':
      return (
        <>
          <Field label="Closed">
            <Switch
              checked={g.closed}
              disabled={readOnly}
              onCheckedChange={(closed) => setGeom(o.id, { ...g, closed })}
              aria-label="Closed"
            />
          </Field>
          <div className="max-h-56 overflow-auto rounded border">
            <table className="w-full text-xs" data-testid="vertex-table">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="px-1 text-left">#</th>
                  <th className="px-1 text-left">X ({display.units})</th>
                  <th className="px-1 text-left">Y ({display.units})</th>
                </tr>
              </thead>
              <tbody>
                {g.pts.slice(0, 500).map((p, i) => (
                  <tr key={i}>
                    <td className="text-muted-foreground px-1">{i + 1}</td>
                    {(['x', 'y'] as const).map((axis) => (
                      <td key={axis} className="px-0.5 py-0.5">
                        <LengthInput
                          ariaLabel={`Vertex ${i + 1} ${axis.toUpperCase()}`}
                          metres={p[axis]}
                          units={display.units}
                          precision={display.precision}
                          allowNegative
                          disabled={readOnly}
                          onCommit={(v) =>
                            setGeom(o.id, {
                              ...g,
                              pts: g.pts.map((q, k) => (k === i ? { ...q, [axis]: v } : q)),
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      );
    case 'multipolygon':
      return (
        <p className="text-muted-foreground text-xs">
          {g.rings.length} rings, {g.rings.reduce((s, r) => s + r.length, 0)} vertices.
        </p>
      );
  }
}

function StyleRow({
  label,
  field,
  ids,
  style,
  overrides,
  children,
}: {
  label: string;
  field: keyof Style;
  ids: string[];
  style: Style;
  overrides: Partial<Style>;
  children: React.ReactNode;
}) {
  void style;
  const overridden = overrides[field] !== undefined;
  return (
    <Field label={label}>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">{children}</div>
        {overridden ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Reset ${label} to layer style`}
            title="Use layer style"
            onClick={() =>
              updateSelected(`Reset ${label.toLowerCase()}`, ids, (o) => {
                delete o.style[field];
              })
            }
          >
            <X />
          </Button>
        ) : (
          <span className="text-muted-foreground w-7 text-[10px]">layer</span>
        )}
      </div>
    </Field>
  );
}

function StyleSection({ objs, ids, readOnly }: { objs: AnalysisObject[]; ids: string[]; readOnly: boolean }) {
  const project = useProject((p) => p)!;
  const s = resolveStyle(project, objs[0]);
  const ov = objs[0].style;
  const set = <K extends keyof Style>(k: K, v: Style[K], coalesce = false) =>
    updateSelected(
      `Style: ${String(k)}`,
      ids,
      (o) => void (o.style[k] = v),
      coalesce ? `style-${String(k)}-${ids.join()}` : undefined,
    );
  const presets = project.stylePresets;
  return (
    <section className="space-y-1.5" data-testid="style-editor">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase">Style</h4>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="outline" disabled={readOnly}>
              Presets
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={async () => {
                const name = await promptText({
                  title: 'Save style preset',
                  label: 'Preset name',
                  defaultValue: `Style ${presets.length + 1}`,
                });
                if (!name) return;
                commit(
                  `Save style preset “${name}”`,
                  (d) => void d.stylePresets.push({ id: newId('sty'), name, style: { ...s } }),
                );
              }}
            >
              <Plus /> Save current style as preset…
            </DropdownMenuItem>
            {presets.length > 0 && <DropdownMenuLabel>Apply to {ids.length} selected</DropdownMenuLabel>}
            {presets.map((pr) => (
              <DropdownMenuItem
                key={pr.id}
                onSelect={() =>
                  updateSelected(`Apply preset “${pr.name}”`, ids, (o) => void (o.style = { ...pr.style }))
                }
              >
                <span
                  className="size-3 rounded-sm border"
                  style={{
                    background: pr.style.fill,
                    outline: `2px solid ${pr.style.stroke}`,
                    outlineOffset: -2,
                  }}
                />
                {pr.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <StyleRow label="Outline" field="stroke" ids={ids} style={s} overrides={ov}>
        <ColorInput
          value={s.stroke}
          disabled={readOnly}
          onCommit={(c) => set('stroke', c)}
          ariaLabel="Outline colour"
        />
      </StyleRow>
      <StyleRow label="Line width" field="strokeWidth" ids={ids} style={s} overrides={ov}>
        <NumberInput
          value={s.strokeWidth}
          min={0}
          max={10}
          suffix="mm"
          disabled={readOnly}
          onCommit={(v) => set('strokeWidth', v)}
          ariaLabel="Line width"
        />
      </StyleRow>
      <StyleRow label="Line style" field="dash" ids={ids} style={s} overrides={ov}>
        <Select value={s.dash} disabled={readOnly} onValueChange={(v) => set('dash', v as DashStyle)}>
          <SelectTrigger size="sm" className="w-full" aria-label="Line style">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DASHES.map((d) => (
              <SelectItem key={d.v} value={d.v}>
                {d.l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </StyleRow>
      <StyleRow label="Fill" field="hatch" ids={ids} style={s} overrides={ov}>
        <Select value={s.hatch} disabled={readOnly} onValueChange={(v) => set('hatch', v as HatchPattern)}>
          <SelectTrigger size="sm" className="w-full" aria-label="Fill pattern">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HATCHES.map((d) => (
              <SelectItem key={d.v} value={d.v}>
                {d.l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </StyleRow>
      <StyleRow label="Fill colour" field="fill" ids={ids} style={s} overrides={ov}>
        <ColorInput
          value={s.fill}
          disabled={readOnly}
          onCommit={(c) => set('fill', c)}
          ariaLabel="Fill colour"
        />
      </StyleRow>
      <StyleRow label="Fill opacity" field="fillOpacity" ids={ids} style={s} overrides={ov}>
        <Slider
          value={[Math.round(s.fillOpacity * 100)]}
          min={0}
          max={100}
          step={5}
          disabled={readOnly}
          onValueChange={([v]) => set('fillOpacity', v / 100, true)}
          aria-label="Fill opacity"
        />
      </StyleRow>
      <StyleRow label="Label size" field="labelSize" ids={ids} style={s} overrides={ov}>
        <div className="flex items-center gap-1">
          <NumberInput
            value={s.labelSize}
            min={0.5}
            max={1000}
            disabled={readOnly}
            onCommit={(v) => set('labelSize', v)}
            ariaLabel="Label size"
          />
          <Select
            value={s.labelSizeUnit}
            disabled={readOnly}
            onValueChange={(v) => set('labelSizeUnit', v as Style['labelSizeUnit'])}
          >
            <SelectTrigger size="sm" aria-label="Label size unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paper">mm on paper</SelectItem>
              <SelectItem value="world">m in world</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </StyleRow>
      <StyleRow label="Label colour" field="labelColor" ids={ids} style={s} overrides={ov}>
        <ColorInput
          value={s.labelColor}
          disabled={readOnly}
          onCommit={(c) => set('labelColor', c)}
          ariaLabel="Label colour"
        />
      </StyleRow>
      <StyleRow label="Label halo" field="labelHalo" ids={ids} style={s} overrides={ov}>
        <Switch
          checked={s.labelHalo}
          disabled={readOnly}
          onCheckedChange={(v) => set('labelHalo', v)}
          aria-label="Label halo"
        />
      </StyleRow>
      <StyleRow label="Bold label" field="labelBold" ids={ids} style={s} overrides={ov}>
        <Switch
          checked={s.labelBold}
          disabled={readOnly}
          onCheckedChange={(v) => set('labelBold', v)}
          aria-label="Bold label"
        />
      </StyleRow>
    </section>
  );
}

function LabelSection({ objs, ids, readOnly }: { objs: AnalysisObject[]; ids: string[]; readOnly: boolean }) {
  const label = objs[0].label ?? { template: '{name}', placement: 'centroid' as const, visible: false };
  return (
    <section className="space-y-1.5" data-testid="label-editor">
      <h4 className="text-xs font-semibold uppercase">Label</h4>
      <Field label="Show label">
        <Switch
          checked={label.visible}
          disabled={readOnly}
          aria-label="Show label"
          onCheckedChange={(visible) =>
            updateSelected(
              visible ? 'Show label' : 'Hide label',
              ids,
              (o) => void (o.label = { ...(o.label ?? label), visible }),
            )
          }
        />
      </Field>
      <Field label="Template">
        <div className="flex items-center gap-1">
          <CommitInput
            ariaLabel="Label template"
            disabled={readOnly}
            value={label.template}
            onCommit={(template) =>
              updateSelected(
                'Edit label',
                ids,
                (o) => void (o.label = { ...(o.label ?? label), template, visible: true }),
              )
            }
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="outline" aria-label="Insert field" disabled={readOnly}>
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {FIELDS.map((f) => (
                <DropdownMenuItem
                  key={f}
                  onSelect={() =>
                    updateSelected(
                      'Edit label',
                      ids,
                      (o) =>
                        void (o.label = {
                          ...(o.label ?? label),
                          template: `${o.label?.template ?? ''} {${f}}`.trim(),
                          visible: true,
                        }),
                    )
                  }
                >
                  {`{${f}}`}
                </DropdownMenuItem>
              ))}
              {Object.keys(objs[0].attributes).map((k) => (
                <DropdownMenuItem
                  key={k}
                  onSelect={() =>
                    updateSelected(
                      'Edit label',
                      ids,
                      (o) =>
                        void (o.label = {
                          ...(o.label ?? label),
                          template: `${o.label?.template ?? ''} {${k}}`.trim(),
                          visible: true,
                        }),
                    )
                  }
                >
                  {`{${k}}`}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Field>
      <Field label="Placement">
        <Select
          value={label.placement}
          disabled={readOnly}
          onValueChange={(v) =>
            updateSelected('Label placement', ids, (o) => {
              const placement = v as LabelPlacement;
              o.label = {
                ...(o.label ?? label),
                placement,
                visible: true,
                offset: placement === 'leader' ? (o.label?.offset ?? { x: 0, y: 0 }) : o.label?.offset,
              };
            })
          }
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Label placement">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLACEMENTS.map((p) => (
              <SelectItem key={p.v} value={p.v}>
                {p.l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {label.offset && (label.offset.x || label.offset.y) ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={readOnly}
          onClick={() =>
            updateSelected('Reset label position', ids, (o) => void (o.label && (o.label.offset = undefined)))
          }
        >
          Reset label position
        </Button>
      ) : null}
      <p className="text-muted-foreground text-[11px]">
        Drag the label with the Label tool (Shift+L) to move it; leader placement draws a line to the object.
      </p>
    </section>
  );
}

function AttributesSection({ o, readOnly }: { o: AnalysisObject; readOnly: boolean }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const set = (fn: (x: AnalysisObject) => void, label = 'Edit attributes') =>
    updateSelected(label, [o.id], fn);
  return (
    <section className="space-y-1.5" data-testid="attributes-editor">
      <h4 className="text-xs font-semibold uppercase">Attributes</h4>
      <Field label="Category">
        <CommitInput
          ariaLabel="Category"
          disabled={readOnly}
          value={o.category ?? ''}
          onCommit={(v) => set((x) => void (x.category = v || undefined), 'Edit category')}
        />
      </Field>
      <Field label="Notes">
        <Textarea
          aria-label="Notes"
          disabled={readOnly}
          className="min-h-12 text-xs"
          defaultValue={o.notes ?? ''}
          key={o.id + (o.notes ?? '')}
          onBlur={(e) =>
            e.target.value !== (o.notes ?? '') &&
            set((x) => void (x.notes = e.target.value || undefined), 'Edit notes')
          }
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Field>
      {Object.entries(o.attributes).map(([k, v]) => (
        <Field key={k} label={k}>
          <div className="flex items-center gap-1">
            <CommitInput
              ariaLabel={`Attribute ${k}`}
              disabled={readOnly}
              value={String(v)}
              onCommit={(nv) =>
                set(
                  (x) => void (x.attributes[k] = nv !== '' && Number.isFinite(Number(nv)) ? Number(nv) : nv),
                )
              }
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove attribute ${k}`}
              disabled={readOnly}
              onClick={() => set((x) => void delete x.attributes[k], 'Remove attribute')}
            >
              <Trash2 />
            </Button>
          </div>
        </Field>
      ))}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const k = key.trim();
          if (!k) return;
          set(
            (x) =>
              void (x.attributes[k] = value !== '' && Number.isFinite(Number(value)) ? Number(value) : value),
            'Add attribute',
          );
          setKey('');
          setValue('');
        }}
      >
        <Input
          className="h-7 text-xs"
          placeholder="Attribute"
          value={key}
          disabled={readOnly}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="New attribute name"
        />
        <Input
          className="h-7 text-xs"
          placeholder="Value"
          value={value}
          disabled={readOnly}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="New attribute value"
        />
        <Button
          size="icon-xs"
          type="submit"
          variant="outline"
          aria-label="Add attribute"
          disabled={readOnly || !key.trim()}
        >
          <Plus />
        </Button>
      </form>
    </section>
  );
}

export function SelectionProperties() {
  const selection = useViewStore((s) => s.selection);
  const project = useProject((p) => p);
  const readOnlyStore = useProjectStore((s) => s.readOnly);
  if (!project || !selection.length) return null;
  const sel = new Set(selection);
  const objs = project.objects.filter((o) => sel.has(o.id));
  if (!objs.length) return null;
  const ids = objs.map((o) => o.id);
  const locked = new Set(project.layers.filter((l) => l.locked).map((l) => l.id));
  const readOnly = readOnlyStore || objs.some((o) => locked.has(o.layerId));
  const o = objs[0];
  const m = objs.length === 1 ? measures(o.geometry) : null;
  const d = project.display;
  return (
    <div className="space-y-3 rounded-md border p-2" data-testid="selection-properties">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {objs.length === 1 ? o.name : `${objs.length} objects selected`}
        </h3>
        <Badge variant="outline" className="font-normal">
          {objs.length === 1 ? `${o.kind} · ${o.geometry.type}` : 'multiple'}
        </Badge>
      </div>
      {readOnly && (
        <p className="text-warning text-xs">
          {readOnlyStore ? 'Read-only.' : 'On a locked layer — unlock it to edit.'}
        </p>
      )}
      {objs.length === 1 && (
        <Field label="Name">
          <CommitInput
            ariaLabel="Name"
            disabled={readOnly}
            value={o.name}
            onCommit={(name) => updateSelected('Rename object', ids, (x) => void (x.name = name || x.name))}
          />
        </Field>
      )}
      <Field label="Layer">
        <Select
          value={objs.every((x) => x.layerId === o.layerId) ? o.layerId : undefined}
          disabled={readOnly}
          onValueChange={(layerId) => updateSelected('Change layer', ids, (x) => void (x.layerId = layerId))}
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Layer">
            <SelectValue placeholder="(mixed)" />
          </SelectTrigger>
          <SelectContent>
            {project.layers.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {m && (
        <div className="space-y-0.5 text-xs" data-testid="object-measures">
          {m.area !== undefined && (
            <Field label="Area">
              <span data-testid="measure-area">{formatArea(m.area, d.areaUnits, d.precision)}</span>
            </Field>
          )}
          {m.perimeter !== undefined && (
            <Field label="Perimeter">{formatLength(m.perimeter, d.units, d.precision)}</Field>
          )}
          {m.length !== undefined && (
            <Field label="Length">{formatLength(m.length, d.units, d.precision)}</Field>
          )}
        </div>
      )}
      {objs.length === 1 && (
        <section className="space-y-1.5" data-testid="geometry-editor">
          <h4 className="text-xs font-semibold uppercase">Geometry</h4>
          <GeometryFields o={o} readOnly={readOnly} />
        </section>
      )}
      <Separator />
      <LabelSection objs={objs} ids={ids} readOnly={readOnly} />
      <Separator />
      <StyleSection objs={objs} ids={ids} readOnly={readOnly} />
      {objs.length === 1 && (
        <>
          <Separator />
          <AttributesSection o={o} readOnly={readOnly} />
        </>
      )}
    </div>
  );
}
