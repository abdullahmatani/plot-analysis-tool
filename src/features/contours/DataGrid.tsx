import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type FilterFn,
  type SortingFn,
  type SortingState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CopyPlus,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  ZoomIn,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { CellValue, ContourDataset } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useProject, useProjectStore } from '@/store/project';
import { cellText } from '@/tables/values';

import { datasetContours } from './compute';
import { addRow, deleteRows, setCell } from './ops';
import { useContoursUi } from './store';
import { useVirtualRows } from './use-virtual-rows';
import { zoomToRows } from './view-ops';

/**
 * Live data grid (row 68): the dataset table with inline cell editing (double-click, Enter/F2 or
 * start typing; each edit is one undo step and the contour updates immediately), add/duplicate/delete
 * rows, sorting by column, a quick search, rows hidden by the dataset filter dimmed (or hidden), and
 * row ↔ contour cross-highlighting on hover and selection. Rows are virtualised for large tables.
 */

interface GridRow {
  i: number;
  cells: CellValue[];
}

const ROW_H = 26;
const GRID_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Enter',
  'F2',
  'Delete',
]);

function compareCells(x: unknown, y: unknown): number {
  const bx = x === null || x === undefined || x === '';
  const by = y === null || y === undefined || y === '';
  if (bx || by) return bx === by ? 0 : bx ? 1 : -1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'number') return -1;
  if (typeof y === 'number') return 1;
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
}

const mixedSort: SortingFn<GridRow> = (a, b, id) => compareCells(a.getValue(id), b.getValue(id));

const containsText: FilterFn<GridRow> = (row, id, value: string) =>
  cellText(row.getValue(id) as CellValue)
    .toLowerCase()
    .includes(String(value).toLowerCase());

export function DataGrid({ ds }: { ds: ContourDataset }) {
  const project = useProject((p) => p)!;
  const readOnly = useProjectStore((s) => s.readOnly);
  const dc = datasetContours(project, ds);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState('');
  const [hideFiltered, setHideFiltered] = useState(false);
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const selection = useContoursUi((s) => (s.selection?.ds === ds.id ? s.selection.rows : null));
  const hover = useContoursUi((s) => (s.hover?.ds === ds.id ? s.hover.row : -1));
  const reveal = useContoursUi((s) => s.reveal);
  const anchorRow = useRef<number | null>(null);

  const data = useMemo<GridRow[]>(() => ds.table.rows.map((cells, i) => ({ i, cells })), [ds.table.rows]);
  const columns = useMemo<ColumnDef<GridRow>[]>(
    () =>
      ds.table.columns.map((name, ci) => ({
        id: String(ci),
        header: name,
        accessorFn: (r: GridRow) => r.cells[ci],
        sortingFn: mixedSort,
        filterFn: containsText,
      })),
    [ds.table.columns],
  );
  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    sortDescFirst: false,
    globalFilterFn: containsText,
    getColumnCanGlobalFilter: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const allRows = table.getRowModel().rows;
  const rows = hideFiltered ? allRows.filter((r) => dc.passesFilter[r.original.i]) : allRows;
  const viewIndex = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((r, k) => m.set(r.original.i, k));
    return m;
  }, [rows]);

  const v = useVirtualRows(rows.length, ROW_H);
  const selected = useMemo(() => new Set(selection ?? []), [selection]);

  // Canvas → grid: scroll the revealed row into view.
  useEffect(() => {
    if (!reveal || reveal.ds !== ds.id) return;
    const k = viewIndex.get(reveal.row);
    if (k === undefined) return;
    setActive((a) => ({ row: k, col: a.col }));
    v.scrollToIndex(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to new reveal requests
  }, [reveal]);

  const selectRow = (i: number, e?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    const cur = selection ?? [];
    let next: number[];
    if (e?.shiftKey && anchorRow.current !== null) {
      const a = viewIndex.get(anchorRow.current) ?? 0;
      const b = viewIndex.get(i) ?? 0;
      next = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.original.i);
    } else if (e?.ctrlKey || e?.metaKey) {
      next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i];
      anchorRow.current = i;
    } else {
      next = [i];
      anchorRow.current = i;
    }
    useContoursUi.getState().set({ selection: next.length ? { ds: ds.id, rows: next } : null });
  };

  const commitEdit = (move?: 'down' | 'right') => {
    if (!editing) return;
    const row = rows[editing.row];
    if (row) setCell(ds.id, row.original.i, editing.col, editing.text);
    setEditing(null);
    if (move === 'down') setActive({ row: Math.min(rows.length - 1, editing.row + 1), col: editing.col });
    if (move === 'right')
      setActive({ row: editing.row, col: Math.min(ds.table.columns.length - 1, editing.col + 1) });
    requestAnimationFrame(() => v.el?.focus());
  };

  const startEdit = (row: number, col: number, initial?: string) => {
    if (readOnly || !rows[row]) return;
    setActive({ row, col });
    setEditing({ row, col, text: initial ?? cellText(rows[row].original.cells[col]) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Shortcuts with Ctrl/⌘/Alt (undo, redo, palette…) and keys the grid does not use pass through.
    if (editing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!GRID_KEYS.has(e.key) && e.key.length !== 1) return;
    e.stopPropagation();
    const nCols = ds.table.columns.length;
    const move = (dr: number, dc2: number) => {
      const row = Math.max(0, Math.min(rows.length - 1, active.row + dr));
      const col = Math.max(0, Math.min(nCols - 1, active.col + dc2));
      setActive({ row, col });
      v.scrollToIndex(row);
      const r = rows[row];
      if (r) {
        if (e.shiftKey) selectRow(r.original.i, { shiftKey: true });
        else if (dr !== 0) selectRow(r.original.i);
      }
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1, 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1, 0);
        return;
      case 'ArrowRight':
        e.preventDefault();
        move(0, 1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        move(0, -1);
        return;
      case 'Home':
        e.preventDefault();
        move(-rows.length, 0);
        return;
      case 'End':
        e.preventDefault();
        move(rows.length, 0);
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        startEdit(active.row, active.col);
        return;
      case 'Delete':
        if (!readOnly && rows[active.row]) {
          e.preventDefault();
          setCell(ds.id, rows[active.row].original.i, active.col, '');
        }
        return;
      case ' ':
        e.preventDefault();
        if (rows[active.row]) selectRow(rows[active.row].original.i, { ctrlKey: true });
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          startEdit(active.row, active.col, e.key);
        }
    }
  };

  const visibleRows = rows.slice(v.start, v.end);
  const selCount = selection?.length ?? 0;
  const activeId = (r: number, c: number) => `grid-${ds.id}-${r}-${c}`;

  return (
    <div className="space-y-1.5" data-testid="data-grid">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-28 flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            aria-label="Search rows"
            className="h-7 pl-7 text-xs"
            placeholder="Search rows"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={readOnly}
          onClick={() => {
            const i = addRow(ds.id);
            if (i >= 0) {
              useContoursUi.getState().set({ selection: { ds: ds.id, rows: [i] } });
              useContoursUi.getState().revealRow({ ds: ds.id, row: i });
            }
          }}
          data-testid="grid-add-row"
        >
          <Plus /> Row
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Duplicate selected row"
          disabled={readOnly || selCount !== 1}
          onClick={() => selection && addRow(ds.id, selection[0])}
        >
          <CopyPlus />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Zoom to selected rows"
          disabled={!selCount}
          onClick={() => selection && zoomToRows(ds.id, selection)}
        >
          <ZoomIn />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Delete selected rows"
          disabled={readOnly || !selCount}
          data-testid="grid-delete-rows"
          onClick={() => {
            if (!selection) return;
            deleteRows(ds.id, selection);
            useContoursUi.getState().set({ selection: null, hover: null });
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <span data-testid="grid-count">
          {rows.length} of {ds.table.rows.length} rows{selCount ? ` · ${selCount} selected` : ''}
        </span>
        {ds.filter && (
          <label className="ml-auto flex items-center gap-1">
            <Checkbox checked={hideFiltered} onCheckedChange={(c) => setHideFiltered(c === true)} />
            Hide filtered-out
          </label>
        )}
      </div>
      <div
        ref={v.ref}
        role="grid"
        aria-label={`Rows of ${ds.name}`}
        aria-rowcount={rows.length + 1}
        aria-activedescendant={rows[active.row] ? activeId(active.row, active.col) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseLeave={() => useContoursUi.getState().set({ hover: null })}
        className="group focus-visible:ring-ring/50 h-80 resize-y overflow-auto rounded-md border outline-none focus-visible:ring-[3px] [&_[data-slot=table-container]]:overflow-visible"
        data-testid="grid-scroll"
      >
        <Table className="table-fixed" style={{ width: 56 + ds.table.columns.length * 112 }}>
          <TableHeader className="bg-muted sticky top-0 z-10">
            <TableRow role="row">
              <TableHead className="w-14 px-1 text-right">#</TableHead>
              {table.getHeaderGroups()[0].headers.map((h) => {
                const sorted = h.column.getIsSorted();
                return (
                  <TableHead
                    key={h.id}
                    className="w-28 px-1"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                  >
                    <button
                      type="button"
                      className="hover:text-foreground flex w-full items-center gap-0.5 truncate text-left"
                      onClick={h.column.getToggleSortingHandler()}
                      title={`Sort by ${String(h.column.columnDef.header)}`}
                      dir="auto"
                    >
                      <span className="truncate">{String(h.column.columnDef.header)}</span>
                      {sorted === 'asc' ? (
                        <ArrowUp className="size-3 shrink-0" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="size-3 shrink-0" />
                      ) : (
                        <ArrowUpDown className="size-3 shrink-0 opacity-30" />
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
                <td colSpan={columns.length + 1} />
              </tr>
            )}
            {visibleRows.map((r, k) => {
              const viewRow = v.start + k;
              const i = r.original.i;
              const isSel = selected.has(i);
              const invalid = !dc.validation.validRows[i];
              const filteredOut = !dc.passesFilter[i];
              return (
                <TableRow
                  key={i}
                  role="row"
                  aria-selected={isSel}
                  data-row={i}
                  data-state={isSel ? 'selected' : undefined}
                  className={cn(
                    'h-[26px]',
                    isSel && 'bg-primary/15 data-[state=selected]:bg-primary/15',
                    hover === i && !isSel && 'bg-accent',
                    filteredOut && 'opacity-50',
                  )}
                  onMouseEnter={() => useContoursUi.getState().set({ hover: { ds: ds.id, row: i } })}
                >
                  <TableCell
                    className="text-muted-foreground cursor-pointer px-1 py-0 text-right tabular-nums"
                    onClick={(e) => selectRow(i, e)}
                    title={invalid ? 'Skipped — see Issues' : filteredOut ? 'Filtered out' : undefined}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {invalid && <TriangleAlert className="text-warning size-3" aria-label="invalid row" />}
                      {i + 1}
                    </span>
                  </TableCell>
                  {ds.table.columns.map((_, ci) => {
                    const value = r.original.cells[ci];
                    const isActive = active.row === viewRow && active.col === ci;
                    const isEditing = editing?.row === viewRow && editing.col === ci;
                    return (
                      <TableCell
                        key={ci}
                        id={activeId(viewRow, ci)}
                        role="gridcell"
                        dir="auto"
                        data-col={ci}
                        className={cn(
                          'truncate px-1 py-0',
                          typeof value === 'number' && 'text-right tabular-nums',
                          isActive &&
                            'group-focus-visible:ring-primary group-focus:ring-primary ring-inset group-focus:ring-2',
                        )}
                        title={cellText(value)}
                        onClick={(e) => {
                          setActive({ row: viewRow, col: ci });
                          selectRow(i, e);
                        }}
                        onDoubleClick={() => startEdit(viewRow, ci)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            aria-label={`Edit ${ds.table.columns[ci]} of row ${i + 1}`}
                            className="bg-background h-[22px] w-full rounded-sm border px-1 text-xs outline-none"
                            value={editing.text}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onBlur={() => commitEdit()}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitEdit('down');
                              } else if (e.key === 'Tab') {
                                e.preventDefault();
                                commitEdit('right');
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditing(null);
                                requestAnimationFrame(() => v.el?.focus());
                              }
                            }}
                          />
                        ) : (
                          cellText(value)
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
            {v.padBottom > 0 && (
              <tr aria-hidden style={{ height: v.padBottom }}>
                <td colSpan={columns.length + 1} />
              </tr>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
