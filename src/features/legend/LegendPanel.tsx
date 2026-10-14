import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderInput, MoreHorizontal, RotateCcw } from 'lucide-react';

import { promptText } from '@/app/prompt';
import type { LegendConfig } from '@/core/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CommitInput, Field, NumberInput } from '@/components/inspector/fields';
import type { FontSet } from '@/export/fonts';
import type { SceneItem } from '@/export/scene';
import { renderSceneSvg } from '@/export/svg-backend';
import { cn } from '@/lib/utils';
import { useProject, useProjectStore } from '@/store/project';
import { collectContours } from '@/features/export/inputs';
import { calibrationStatement } from '@/features/export/scene/calibration';
import { layoutLegend, swatchItems } from '@/features/export/scene/decorations';
import { useExportFonts } from '@/features/export/use-fonts';

import {
  buildLegend,
  reorderOverrides,
  type LegendItem,
  type LegendModel,
  type LegendSwatch,
} from './legend-model';
import {
  resetLegend,
  resetLegendEntry,
  setLegendConfig,
  setLegendOrder,
  setLegendOverride,
} from './legend-ops';

/**
 * Legend tab (row 75): legend settings (title, position, width, calibration statement), a live
 * preview drawn by the export renderer, and every entry with editable title, group, order and
 * hide/show. Each edit is one undoable commit.
 */

function svgUrl(widthMm: number, heightMm: number, items: SceneItem[], fonts?: FontSet): string {
  const svg = renderSceneSvg({ widthMm, heightMm, items }, { fonts, textAsPaths: !!fonts });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function Swatch({ swatch }: { swatch: LegendSwatch }) {
  const url = useMemo(
    () => svgUrl(9, 4.5, swatchItems(swatch, { x: 0.2, y: 0.2, w: 8.6, h: 4.1 })),
    [swatch],
  );
  return <img src={url} alt="" className="h-4 w-8 shrink-0 rounded-sm bg-white" />;
}

const POSITIONS: { id: LegendConfig['position']; label: string }[] = [
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'custom', label: 'Custom (x, y)' },
];

function EntryRow({ item, model, readOnly }: { item: LegendItem; model: LegendModel; readOnly: boolean }) {
  const idx = model.items.indexOf(item);
  return (
    <li
      className={cn('flex items-center gap-1 rounded-md border px-1 py-0.5', item.hidden && 'opacity-50')}
      data-testid="legend-entry"
      data-key={item.key}
      data-hidden={item.hidden ? 'true' : 'false'}
    >
      <Swatch swatch={item.swatch} />
      <CommitInput
        ariaLabel={`Legend title for ${item.defaultTitle}`}
        disabled={readOnly}
        value={item.title}
        onCommit={(v) =>
          void setLegendOverride(
            item.key,
            { title: v.trim() && v.trim() !== item.defaultTitle ? v.trim() : undefined },
            'Rename legend entry',
          )
        }
      />
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={readOnly}
        aria-label={item.hidden ? `Show ${item.title} in legend` : `Hide ${item.title} from legend`}
        onClick={() =>
          setLegendOverride(
            item.key,
            { hidden: item.hidden === item.defaultHidden ? !item.hidden : undefined },
            item.hidden ? 'Show legend entry' : 'Hide legend entry',
          )
        }
      >
        {item.hidden ? <EyeOff /> : <Eye />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={readOnly || idx <= 0}
        aria-label={`Move ${item.title} up`}
        onClick={() => setLegendOrder(reorderOverrides(model, item.key, -1))}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={readOnly || idx >= model.items.length - 1}
        aria-label={`Move ${item.title} down`}
        onClick={() => setLegendOrder(reorderOverrides(model, item.key, 1))}
      >
        <ArrowDown />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`More for ${item.title}`} disabled={readOnly}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={async () => {
              const g = await promptText({
                title: 'Legend group',
                label: 'Group heading (empty for the default)',
                defaultValue: item.group,
              });
              if (g === null) return;
              setLegendOverride(
                item.key,
                { group: g.trim() && g.trim() !== item.defaultGroup ? g.trim() : undefined },
                'Move legend entry to group',
              );
            }}
          >
            <FolderInput /> Move to group…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => resetLegendEntry(item.key)}>
            <RotateCcw /> Reset entry
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function LegendPanel() {
  const project = useProjectStore((s) => s.history?.project ?? null);
  const legend = useProject((p) => p.legend);
  const readOnly = useProjectStore((s) => s.readOnly);
  const fonts = useExportFonts();
  const datasets = project?.datasets;
  const anchors = project?.anchors;
  const display = project?.display;
  const contours = useMemo(
    () => (project ? collectContours(project) : []),
    // Contours depend on datasets, anchors and display precision only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datasets, anchors, display],
  );
  const model = useMemo(() => (project ? buildLegend(project, { contours }) : null), [project, contours]);
  const preview = useMemo(() => {
    if (!project || !model) return null;
    const cal = project.legend.showCalibration ? calibrationStatement(project) : undefined;
    const lay = layoutLegend(model, fonts, project.legend.widthMm || 70, 1, cal);
    return { url: svgUrl(lay.w + 1, lay.h + 1, lay.draw(0.5, 0.5), fonts), w: lay.w, h: lay.h };
  }, [project, model, fonts]);
  if (!project || !legend || !model) return null;
  const groups = new Map<string, LegendItem[]>();
  for (const it of model.items) {
    const list = groups.get(it.group) ?? [];
    list.push(it);
    groups.set(it.group, list);
  }
  return (
    <section className="space-y-3" data-testid="legend-panel">
      <div className="space-y-1.5">
        <h3 className="text-muted-foreground px-1 text-xs font-semibold uppercase">Legend</h3>
        <Field label="Title" htmlFor="legend-title">
          <CommitInput
            id="legend-title"
            ariaLabel="Legend title"
            disabled={readOnly}
            value={legend.title}
            onCommit={(v) => void setLegendConfig({ title: v }, 'Legend title', 'legend-title')}
          />
        </Field>
        <Field label="Position">
          <Select
            value={legend.position}
            disabled={readOnly}
            onValueChange={(v) =>
              setLegendConfig({ position: v as LegendConfig['position'] }, 'Legend position')
            }
          >
            <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label="Legend position">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSITIONS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {legend.position === 'custom' && (
          <Field label="Top-left (mm)">
            <div className="flex gap-1">
              <NumberInput
                ariaLabel="Legend x (mm)"
                value={legend.custom?.x ?? 20}
                min={0}
                disabled={readOnly}
                onCommit={(x) =>
                  setLegendConfig({ custom: { x, y: legend.custom?.y ?? 20 } }, 'Legend position')
                }
              />
              <NumberInput
                ariaLabel="Legend y (mm)"
                value={legend.custom?.y ?? 20}
                min={0}
                disabled={readOnly}
                onCommit={(y) =>
                  setLegendConfig({ custom: { x: legend.custom?.x ?? 20, y } }, 'Legend position')
                }
              />
            </div>
          </Field>
        )}
        <Field label="Width">
          <NumberInput
            ariaLabel="Legend width (mm)"
            value={legend.widthMm}
            min={30}
            max={300}
            suffix="mm"
            disabled={readOnly}
            onCommit={(w) => setLegendConfig({ widthMm: w }, 'Legend width')}
          />
        </Field>
        <div className="flex items-center justify-between gap-2 px-1">
          <label htmlFor="legend-cal" className="text-muted-foreground text-xs">
            Show calibration statement
          </label>
          <Switch
            id="legend-cal"
            checked={legend.showCalibration}
            disabled={readOnly}
            onCheckedChange={(v) => setLegendConfig({ showCalibration: v }, 'Legend calibration statement')}
          />
        </div>
      </div>
      {preview && (
        <div className="rounded-md border bg-white p-1" data-testid="legend-preview-box">
          <img
            src={preview.url}
            alt="Legend preview"
            data-testid="legend-preview"
            className="mx-auto block w-full"
            style={{ aspectRatio: `${preview.w} / ${preview.h}` }}
          />
        </div>
      )}
      <div className="space-y-1">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-muted-foreground text-xs font-semibold uppercase">Entries</h3>
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly || !legend.overrides.length}
            onClick={() => resetLegend()}
            data-testid="legend-reset"
          >
            <RotateCcw /> Reset edits
          </Button>
        </div>
        {!model.items.length && (
          <p className="text-muted-foreground px-1 text-xs">
            Entries appear for visible analysis layers and contour datasets once they contain items.
          </p>
        )}
        {[...groups].map(([title, items]) => (
          <div key={title} className="space-y-0.5" data-testid="legend-group">
            <div className="text-muted-foreground px-1 text-[11px] font-medium">{title}</div>
            <ul className="space-y-0.5">
              {items.map((it) => (
                <EntryRow key={it.key} item={it} model={model} readOnly={readOnly} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
