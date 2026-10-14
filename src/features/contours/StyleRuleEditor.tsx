import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { newId } from '@/core/ids';
import type { ContourDataset, StyleRule } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { ColorInput, CommitInput, NumberInput } from '@/components/inspector/fields';
import { useProjectStore } from '@/store/project';
import { findColumn } from '@/tables/access';
import {
  assignCategoryColors,
  breakLabel,
  DEFAULT_RAMP,
  makeGraduatedBreaks,
  RAMPS,
  type BreakMethod,
} from '@/tables/style-rules';
import { toNumber } from '@/tables/values';

import { ColumnSelect, DashSelect, Row, Swatch } from './controls';
import { updateDataset } from './ops';

/**
 * Style rules (row 67): colour by size column (ring sets, default), by category (categorical palette;
 * new values get the next colour automatically) or by value (graduated ramp with class breaks: equal
 * interval, quantile or natural breaks). Line style and fill opacity per rule and per category/class.
 */

type Mode = 'none' | 'categorical' | 'graduated';

export function StyleRuleEditor({ ds }: { ds: ContourDataset }) {
  const readOnly = useProjectStore((s) => s.readOnly);
  const rule = ds.styleRules[0];
  const mode: Mode = rule ? rule.kind : 'none';
  const [method, setMethod] = useState<BreakMethod>('jenks');
  const [classes, setClasses] = useState(rule?.breaks?.length || 5);

  const setRule = (label: string, next: StyleRule | null) =>
    updateDataset(ds.id, label, (d) => {
      d.styleRules = next ? [next, ...(d.styleRules.slice(1) as StyleRule[])] : d.styleRules.slice(1);
    });
  const patchRule = (label: string, fn: (r: StyleRule) => void, coalesceKey?: string) =>
    updateDataset(
      ds.id,
      label,
      (d) => {
        if (d.styleRules[0]) fn(d.styleRules[0] as StyleRule);
      },
      coalesceKey ? { coalesceKey } : {},
    );

  const columnValues = (col: string) => {
    const i = findColumn(ds.table.columns, col);
    return i < 0 ? [] : ds.table.rows.map((r) => r[i]);
  };
  const numericCols = ds.table.columns.filter((c) => columnValues(c).some((v) => toNumber(v) !== null));

  const makeCategorical = (col: string): StyleRule => ({
    id: rule?.id ?? newId('rule'),
    kind: 'categorical',
    column: col,
    categories: assignCategoryColors(columnValues(col)),
  });
  const makeGraduated = (
    col: string,
    n = classes,
    m = method,
    ramp = rule?.ramp ?? DEFAULT_RAMP,
  ): StyleRule => ({
    id: rule?.id ?? newId('rule'),
    kind: 'graduated',
    column: col,
    ramp,
    breaks: makeGraduatedBreaks(columnValues(col), n, m, ramp),
  });

  return (
    <div className="space-y-2 text-xs" data-testid="style-rules">
      <Row label="Colour by">
        <Select
          value={mode}
          disabled={readOnly}
          onValueChange={(v) => {
            if (v === 'none') setRule('Colour by size column', null);
            else if (v === 'categorical') {
              const col = ds.mapping.group ?? ds.mapping.label ?? ds.table.columns[0];
              setRule(`Colour by category “${col}”`, makeCategorical(col));
            } else {
              const col = ds.mapping.sizeColumns[0] ?? numericCols[0];
              if (col) setRule(`Colour by value “${col}”`, makeGraduated(col));
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full text-xs" aria-label="Colour by" data-testid="colour-by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Size column (one colour per ring set)</SelectItem>
            <SelectItem value="categorical">Category (palette)</SelectItem>
            <SelectItem value="graduated">Value (graduated ramp)</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      {rule && (
        <>
          <Row label={rule.kind === 'categorical' ? 'Category column' : 'Value column'}>
            <ColumnSelect
              label="Rule column"
              testId="rule-column"
              allowNone={false}
              columns={rule.kind === 'categorical' ? ds.table.columns : numericCols}
              value={rule.column}
              disabled={readOnly}
              onChange={(c) =>
                c &&
                setRule(
                  `Colour by “${c}”`,
                  rule.kind === 'categorical' ? makeCategorical(c) : makeGraduated(c),
                )
              }
            />
          </Row>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-[7.5rem]">Line / fill</span>
            <DashSelect
              label="Rule line style"
              value={rule.dash ?? 'solid'}
              disabled={readOnly}
              onChange={(dash) => patchRule('Rule line style', (r) => void (r.dash = dash))}
            />
            <Slider
              aria-label="Rule fill opacity"
              className="flex-1"
              min={0}
              max={1}
              step={0.02}
              disabled={readOnly}
              value={[rule.fillOpacity ?? 0.08]}
              onValueChange={([v]) =>
                patchRule('Rule fill opacity', (r) => void (r.fillOpacity = v), `rule-fill:${ds.id}`)
              }
            />
          </div>
        </>
      )}

      {rule?.kind === 'graduated' && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={method} onValueChange={(v) => setMethod(v as BreakMethod)}>
            <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Class method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jenks">Natural breaks</SelectItem>
              <SelectItem value="quantile">Quantile</SelectItem>
              <SelectItem value="equal">Equal interval</SelectItem>
            </SelectContent>
          </Select>
          <Select value={String(classes)} onValueChange={(v) => setClasses(Number(v))}>
            <SelectTrigger size="sm" className="w-24 text-xs" aria-label="Classes">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} classes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={rule.ramp ?? DEFAULT_RAMP}
            onValueChange={(ramp) =>
              setRule(`Ramp ${RAMPS[ramp]?.label ?? ramp}`, makeGraduated(rule.column, classes, method, ramp))
            }
          >
            <SelectTrigger size="sm" className="w-36 text-xs" aria-label="Colour ramp">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RAMPS).map(([k, r]) => (
                <SelectItem key={k} value={k}>
                  <span
                    className="inline-block h-2.5 w-10 rounded-sm"
                    style={{ background: `linear-gradient(90deg, ${r.stops.join(',')})` }}
                  />
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="xs"
            variant="outline"
            disabled={readOnly}
            onClick={() => setRule('Recompute class breaks', makeGraduated(rule.column))}
          >
            <RefreshCw /> Classify
          </Button>
        </div>
      )}

      {rule?.kind === 'categorical' && (
        <ul className="max-h-64 space-y-0.5 overflow-auto" data-testid="rule-categories">
          {(rule.categories ?? []).map((c, i) => (
            <li
              key={`${c.value}-${i}`}
              className="flex items-center gap-1.5"
              data-testid={`category-${c.value}`}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={readOnly}
                aria-label={c.hidden ? `Show ${c.value}` : `Hide ${c.value}`}
                onClick={() =>
                  patchRule(`${c.hidden ? 'Show' : 'Hide'} “${c.value}”`, (r) => {
                    const cat = r.categories?.[i];
                    if (cat) cat.hidden = !cat.hidden;
                  })
                }
              >
                {c.hidden ? <EyeOff className="opacity-50" /> : <Eye />}
              </Button>
              <ClassStyle
                color={c.color}
                dash={c.dash ?? rule.dash ?? 'solid'}
                fillOpacity={c.fillOpacity ?? rule.fillOpacity ?? 0.08}
                label={c.value}
                disabled={readOnly}
                onChange={(label, patch, key) =>
                  patchRule(
                    label,
                    (r) => {
                      const cat = r.categories?.[i];
                      if (cat) Object.assign(cat, patch);
                    },
                    key,
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate" dir="auto" title={c.value}>
                {c.label || c.value || '(blank)'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {rule?.kind === 'graduated' && (
        <ul className="space-y-0.5" data-testid="rule-breaks">
          {(rule.breaks ?? []).map((b, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <ClassStyle
                color={b.color}
                dash={b.dash ?? rule.dash ?? 'solid'}
                fillOpacity={b.fillOpacity ?? rule.fillOpacity ?? 0.08}
                label={b.label ?? breakLabel(rule.breaks ?? [], i)}
                disabled={readOnly}
                onChange={(label, patch, key) =>
                  patchRule(
                    label,
                    (r) => {
                      const br = r.breaks?.[i];
                      if (br) Object.assign(br, patch);
                    },
                    key,
                  )
                }
              />
              <span className="text-muted-foreground w-6">≤</span>
              <div className="w-24">
                <NumberInput
                  ariaLabel={`Upper bound of class ${i + 1}`}
                  value={b.upTo}
                  disabled={readOnly}
                  onCommit={(v) =>
                    patchRule('Edit class break', (r) => {
                      const br = r.breaks?.[i];
                      if (br) {
                        br.upTo = v;
                        delete br.label;
                      }
                    })
                  }
                />
              </div>
              <span className="min-w-0 flex-1 truncate">{b.label ?? breakLabel(rule.breaks ?? [], i)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClassStyle({
  color,
  dash,
  fillOpacity,
  label,
  disabled,
  onChange,
}: {
  color: string;
  dash: NonNullable<StyleRule['dash']>;
  fillOpacity: number;
  label: string;
  disabled: boolean;
  onChange: (
    label: string,
    patch: { color?: string; dash?: StyleRule['dash']; fillOpacity?: number; label?: string },
    key?: string,
  ) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={`Style of ${label}`} className="shrink-0">
          <Swatch color={color} dash={dash} fillOpacity={fillOpacity} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 text-xs">
        <div className="truncate font-medium" dir="auto">
          {label}
        </div>
        <ColorInput value={color} onCommit={(c) => onChange(`Colour of “${label}”`, { color: c })} />
        <div className="flex items-center gap-2">
          <span className="w-12">Line</span>
          <DashSelect
            label="Line style"
            value={dash}
            onChange={(d) => onChange(`Line style of “${label}”`, { dash: d })}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12">Fill</span>
          <Slider
            aria-label="Fill opacity"
            className="flex-1"
            min={0}
            max={1}
            step={0.02}
            value={[fillOpacity]}
            onValueChange={([v]) => onChange(`Fill of “${label}”`, { fillOpacity: v }, `class-fill:${label}`)}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12">Legend</span>
          <CommitInput
            ariaLabel="Legend label"
            value=""
            placeholder={label}
            onCommit={(v) => void onChange(`Legend label of “${label}”`, { label: v.trim() || undefined })}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
