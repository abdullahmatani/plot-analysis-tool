import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Lock, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { AREA_FACTORS, AREA_LABEL, formatNumber, fromMetres, UNIT_LABEL } from '@/core/units';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useVirtualRows } from '@/features/contours/use-virtual-rows';
import { cn } from '@/lib/utils';
import { canvasController } from '@/render/canvas-controller';
import { getProject, useProject } from '@/store/project';
import { useViewStore } from '@/store/view';

import { objectRows, objectsBounds, type ObjectRow } from './rows';

/**
 * Objects table (row 46; row 84 non-visual alternative to the canvas): searchable, filterable and
 * sortable list of analysis objects with layer, type, area, perimeter, radius and attributes. Click a
 * row to select it and zoom to it (Ctrl/Shift for multiple); selection is synchronised both ways with
 * the canvas. Keyboard: ↑/↓ move and select, Space toggles, Enter zooms, Home/End.
 */

const ROW_H = 26;
const ALL = '__all__';

function cmp(a: unknown, b: unknown): number {
  const na = a === null || a === undefined || a === '';
  const nb = b === null || b === undefined || b === '';
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function ObjectsTable() {
  const project = useProject((p) => p);
  const selection = useViewStore((s) => s.selection);
  const [open, setOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [layerFilter, setLayerFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [active, setActive] = useState(0);
  const anchor = useRef<string | null>(null);

  const rows = useMemo(() => (project ? objectRows(project) : []), [project]);
  const display = project?.display;
  const len = (v: number | null) =>
    v === null || !display ? '' : formatNumber(fromMetres(v, display.units), display.precision);
  const area = (v: number | null) =>
    v === null || !display ? '' : formatNumber(v / AREA_FACTORS[display.areaUnits], display.precision);

  const columns = useMemo<ColumnDef<ObjectRow>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorKey: 'name',
        sortingFn: (a, b) => cmp(a.original.name, b.original.name),
      },
      { id: 'layer', header: 'Layer', accessorKey: 'layer', filterFn: 'equalsString' },
      { id: 'type', header: 'Type', accessorKey: 'type', filterFn: 'equalsString' },
      {
        id: 'area',
        header: 'Area',
        accessorKey: 'area',
        sortingFn: (a, b) => cmp(a.original.area, b.original.area),
      },
      {
        id: 'perimeter',
        header: 'Perimeter',
        accessorFn: (r) => r.perimeter ?? r.length,
        sortingFn: (a, b) =>
          cmp(a.original.perimeter ?? a.original.length, b.original.perimeter ?? b.original.length),
      },
      {
        id: 'radius',
        header: 'Radius',
        accessorKey: 'radius',
        sortingFn: (a, b) => cmp(a.original.radius, b.original.radius),
      },
      { id: 'attributes', header: 'Attributes', accessorKey: 'attributes' },
    ],
    [],
  );
  const columnFilters = useMemo<ColumnFiltersState>(
    () => [
      ...(layerFilter !== ALL ? [{ id: 'layer', value: layerFilter }] : []),
      ...(typeFilter !== ALL ? [{ id: 'type', value: typeFilter }] : []),
    ],
    [layerFilter, typeFilter],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: search, columnFilters },
    onSortingChange: setSorting,
    globalFilterFn: (row, _id, value: string) =>
      row.original.search.includes(String(value).toLowerCase().trim()),
    getColumnCanGlobalFilter: () => true,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const view = table.getRowModel().rows;
  const v = useVirtualRows(view.length, ROW_H);
  const selected = useMemo(() => new Set(selection), [selection]);

  // Canvas → table: bring the first selected object into view.
  const firstSel = selection[0];
  useEffect(() => {
    if (!firstSel) return;
    const k = view.findIndex((r) => r.id === firstSel);
    if (k >= 0) {
      setActive(k);
      v.scrollToIndex(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow selection changes only
  }, [firstSel]);

  if (!project) return null;
  const layers = project.layers.map((l) => l.name);
  const types = [...new Set(rows.map((r) => r.type))].sort();

  const zoom = (ids: string[]) => {
    const p = getProject();
    const b = p && objectsBounds(p, ids);
    if (b) canvasController()?.zoomToBounds(b);
  };

  const choose = (
    k: number,
    e?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    doZoom = true,
  ) => {
    const r = view[k]?.original;
    if (!r) return;
    setActive(k);
    if (!r.selectable) {
      if (doZoom) zoom([r.id]);
      return;
    }
    const cur = useViewStore.getState().selection;
    let next: string[];
    if (e?.shiftKey && anchor.current) {
      const a = view.findIndex((x) => x.id === anchor.current);
      next = view
        .slice(Math.min(a, k), Math.max(a, k) + 1)
        .map((x) => x.original)
        .filter((x) => x.selectable)
        .map((x) => x.id);
    } else if (e?.ctrlKey || e?.metaKey) {
      next = cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id];
      anchor.current = r.id;
    } else {
      next = [r.id];
      anchor.current = r.id;
    }
    useViewStore.getState().set({ selection: next, pickedEntity: null });
    if (doZoom && next.length) zoom(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const go = (k: number) => {
      const t = Math.max(0, Math.min(view.length - 1, k));
      v.scrollToIndex(t);
      choose(t, { shiftKey: e.shiftKey }, false);
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(active - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(view.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (view[active]) zoom(selection.length ? selection : [view[active].id]);
        break;
      case ' ':
        e.preventDefault();
        choose(active, { ctrlKey: true }, false);
        break;
      case 'Escape':
        useViewStore.getState().set({ selection: [] });
        break;
    }
  };

  const units = display ? UNIT_LABEL[display.units] : 'm';
  const areaUnit = display ? AREA_LABEL[display.areaUnits] : 'm²';
  const unitOf: Record<string, string> = { area: areaUnit, perimeter: units, radius: units };
  const rowId = (k: number) => `objrow-${k}`;

  return (
    <section className="space-y-1.5" data-testid="objects-table">
      <div className="flex items-center justify-between px-1">
        <button
          type="button"
          className="text-muted-foreground flex items-center gap-1 text-xs font-semibold uppercase"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Analysis objects <span className="font-normal">({rows.length})</span>
        </button>
        {selection.length > 0 && (
          <span className="text-muted-foreground text-xs" data-testid="objects-selected-count">
            {selection.length} selected
          </span>
        )}
      </div>
      {open && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative min-w-28 flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                aria-label="Search objects"
                data-testid="objects-search"
                className="h-7 pl-7 text-xs"
                placeholder="Search name, layer, type, attributes"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <Select value={layerFilter} onValueChange={setLayerFilter}>
              <SelectTrigger size="sm" className="h-7 w-28 text-xs" aria-label="Filter by layer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All layers</SelectItem>
                {layers.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger size="sm" className="h-7 w-28 text-xs" aria-label="Filter by type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All types</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-1 text-xs">
              No analysis objects yet. Draw, trace or offset shapes; they are listed here with their measures.
            </p>
          ) : (
            <div
              ref={v.ref}
              role="grid"
              aria-label="Analysis objects"
              aria-rowcount={view.length + 1}
              aria-multiselectable
              aria-activedescendant={view[active] ? rowId(active) : undefined}
              tabIndex={0}
              onKeyDown={onKeyDown}
              className="focus-visible:ring-ring/50 max-h-80 min-h-24 resize-y overflow-auto rounded-md border outline-none focus-visible:ring-[3px] [&_[data-slot=table-container]]:overflow-visible"
              data-testid="objects-grid"
            >
              <Table className="min-w-[36rem]">
                <TableHeader className="bg-muted sticky top-0 z-10">
                  <TableRow role="row">
                    {table.getHeaderGroups()[0].headers.map((h) => {
                      const s = h.column.getIsSorted();
                      const numeric = h.id in unitOf;
                      return (
                        <TableHead
                          key={h.id}
                          className={cn('px-1.5', numeric && 'text-right')}
                          aria-sort={s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : 'none'}
                        >
                          <button
                            type="button"
                            className={cn(
                              'hover:text-foreground inline-flex items-center gap-0.5',
                              numeric && 'flex-row-reverse',
                            )}
                            onClick={h.column.getToggleSortingHandler()}
                          >
                            {String(h.column.columnDef.header)}
                            {numeric && (
                              <span className="text-muted-foreground font-normal"> ({unitOf[h.id]})</span>
                            )}
                            {s === 'asc' ? (
                              <ArrowUp className="size-3" />
                            ) : s === 'desc' ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ArrowUpDown className="size-3 opacity-30" />
                            )}
                          </button>
                        </TableHead>
                      );
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {v.padTop > 0 && (
                    <tr aria-hidden style={{ height: v.padTop }}>
                      <td colSpan={columns.length} />
                    </tr>
                  )}
                  {view.slice(v.start, v.end).map((row, k) => {
                    const idx = v.start + k;
                    const r = row.original;
                    const isSel = selected.has(r.id);
                    return (
                      <TableRow
                        key={r.id}
                        id={rowId(idx)}
                        role="row"
                        aria-selected={isSel}
                        data-state={isSel ? 'selected' : undefined}
                        data-object-id={r.id}
                        className={cn(
                          'h-[26px] cursor-pointer',
                          isSel && 'bg-primary/15 data-[state=selected]:bg-primary/15',
                          idx === active && 'ring-primary/60 ring-1 ring-inset',
                          !r.selectable && 'text-muted-foreground',
                        )}
                        onClick={(e: MouseEvent) => choose(idx, e)}
                        onMouseEnter={() => useViewStore.getState().set({ hoverObject: r.id })}
                        onMouseLeave={() => useViewStore.getState().set({ hoverObject: null })}
                      >
                        <TableCell className="max-w-40 truncate px-1.5 py-0" dir="auto" title={r.name}>
                          {!r.selectable && (
                            <Lock className="mr-1 inline size-3" aria-label="locked or hidden layer" />
                          )}
                          {r.name}
                        </TableCell>
                        <TableCell className="max-w-28 truncate px-1.5 py-0" title={r.layer}>
                          {r.layer}
                        </TableCell>
                        <TableCell className="px-1.5 py-0">{r.type}</TableCell>
                        <TableCell className="px-1.5 py-0 text-right tabular-nums">{area(r.area)}</TableCell>
                        <TableCell className="px-1.5 py-0 text-right tabular-nums">
                          {len(r.perimeter ?? r.length)}
                        </TableCell>
                        <TableCell className="px-1.5 py-0 text-right tabular-nums">{len(r.radius)}</TableCell>
                        <TableCell className="max-w-40 truncate px-1.5 py-0" title={r.attributes}>
                          {r.attributes}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {v.padBottom > 0 && (
                    <tr aria-hidden style={{ height: v.padBottom }}>
                      <td colSpan={columns.length} />
                    </tr>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          {rows.length > 0 && view.length !== rows.length && (
            <p className="text-muted-foreground px-1 text-xs">
              Showing {view.length} of {rows.length} objects.
            </p>
          )}
        </>
      )}
    </section>
  );
}
