import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';

import { formatLength, parseLength, UNIT_LABEL } from '@/core/units';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { OffsetCap, OffsetJoin } from '@/geometry/offset';
import { intervalDistances } from '@/geometry/offset';
import { isClosed } from '@/geometry/convert';
import { useProject } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useViewStore } from '@/store/view';
import { RAMPS, rampColors } from '@/tables/style-rules';

import { runOffset, runRings } from './actions';
import { CAPS, JOINS, type OffsetDialogMode } from './options';
import { DEFAULT_OFFSET_PARAMS, formatOffset, parseDistanceList, type OffsetParams } from './plan';

/** Offset dialog (rows 55–61): single/batch offset and multi-ring offsets of the selection. */

interface Remembered {
  distance: string;
  join: OffsetJoin;
  cap: OffsetCap;
  miterLimit: string;
  live: boolean;
  merge: boolean;
  ringMode: 'list' | 'interval';
  list: string;
  interval: string;
  count: string;
  start: string;
  ramp: string;
  set(p: Partial<Omit<Remembered, 'set'>>): void;
}

/** Last used values (per session) so repeated offsets need no retyping. */
const useRemembered = create<Remembered>()((set) => ({
  distance: String(DEFAULT_OFFSET_PARAMS.distance),
  join: DEFAULT_OFFSET_PARAMS.join,
  cap: DEFAULT_OFFSET_PARAMS.cap,
  miterLimit: String(DEFAULT_OFFSET_PARAMS.miterLimit),
  live: true,
  merge: false,
  ringMode: 'list',
  list: '10, 25, 50',
  interval: '10',
  count: '3',
  start: '',
  ramp: 'yellow-red',
  set: (p) => set(p),
}));

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-2">
      <Label htmlFor={htmlFor} className="font-normal">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function OffsetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const payload = useUiStore((s) => s.dialogPayload) as { mode?: OffsetDialogMode } | null;
  const display = useProject((p) => p.display);
  const chordTol = useProject((p) => p.chordTolerance) ?? 0.005;
  const objects = useProject((p) => p.objects);
  const selection = useViewStore((s) => s.selection);
  const r = useRemembered();
  const [tab, setTab] = useState<OffsetDialogMode>('single');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTab(payload?.mode ?? 'single');
  }, [open, payload]);

  const units = display?.units ?? 'm';
  const precision = display?.precision ?? 2;
  const sel = useMemo(() => {
    const set = new Set(selection);
    return (objects ?? []).filter((o) => set.has(o.id));
  }, [objects, selection]);
  const hasOpen = sel.some((o) => !isClosed(o.geometry) && o.geometry.type !== 'arc');
  const parse = (s: string) => parseLength(s.trim(), units);

  const distance = parse(r.distance);
  const miterLimit = Number(r.miterLimit.replace(',', '.'));
  const miterOk = r.join !== 'miter' || (Number.isFinite(miterLimit) && miterLimit >= 1);
  const ringDistances = useMemo(() => {
    if (r.ringMode === 'list') return parseDistanceList(r.list, (s) => parseLength(s, units));
    const iv = parseLength(r.interval.trim(), units);
    const n = Number(r.count);
    const st = r.start.trim() ? parseLength(r.start.trim(), units) : iv;
    if (iv === null || st === null || !(iv !== 0) || !Number.isInteger(n) || n < 1 || n > 50) return null;
    return intervalDistances(iv, n, st).filter((d) => d !== 0);
  }, [r.ringMode, r.list, r.interval, r.count, r.start, units]);

  const singleValid = distance !== null && distance !== 0 && miterOk && sel.length > 0;
  const ringsValid = !!ringDistances?.length && miterOk && sel.length === 1;

  const apply = async () => {
    setBusy(true);
    try {
      if (tab === 'single') {
        if (!singleValid) return;
        const params: OffsetParams = {
          distance: distance!,
          join: r.join,
          cap: r.cap,
          miterLimit: r.join === 'miter' ? miterLimit : 2,
          live: r.merge && sel.length > 1 ? false : r.live,
          merge: r.merge && sel.length > 1,
        };
        const ids = await runOffset(params);
        if (ids.length) onOpenChange(false);
      } else {
        if (!ringsValid) return;
        const ids = await runRings({
          distances: ringDistances!,
          join: r.join,
          cap: r.cap,
          miterLimit: r.join === 'miter' ? miterLimit : 2,
          ramp: r.ramp,
        });
        if (ids.length) onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const names = sel
    .slice(0, 3)
    .map((o) => o.name)
    .join(', ');
  const ringColors = ringDistances ? rampColors(r.ramp, ringDistances.length).reverse() : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="offset-dialog">
        <DialogHeader>
          <DialogTitle>{tab === 'single' ? 'Offset' : 'Multi-ring offset'}</DialogTitle>
          <DialogDescription>
            {sel.length
              ? `${sel.length} selected: ${names}${sel.length > 3 ? '…' : ''}. Positive distances expand, negative distances contract.`
              : 'Select the objects to offset first.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <Tabs value={tab} onValueChange={(v) => setTab(v as OffsetDialogMode)}>
            <TabsList className="w-full">
              <TabsTrigger value="single">Offset</TabsTrigger>
              <TabsTrigger value="rings">Multi-ring</TabsTrigger>
            </TabsList>
            <TabsContent value="single" className="grid gap-2 pt-1">
              <Row label={`Distance (${UNIT_LABEL[units]})`} htmlFor="off-distance">
                <Input
                  id="off-distance"
                  autoFocus
                  value={r.distance}
                  aria-invalid={distance === null || distance === 0 || undefined}
                  onChange={(e) => r.set({ distance: e.target.value })}
                  onFocus={(e) => e.target.select()}
                  data-testid="offset-distance"
                />
              </Row>
              {sel.length > 1 && (
                <Row label="Merge results">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={r.merge}
                      onCheckedChange={(v) => r.set({ merge: v === true })}
                      aria-label="Merge overlapping results into one envelope"
                    />
                    One envelope (union) of all results
                  </label>
                </Row>
              )}
              <Row label="Live offset">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={r.live && !(r.merge && sel.length > 1)}
                    disabled={r.merge && sel.length > 1}
                    onCheckedChange={(v) => r.set({ live: v === true })}
                    aria-label="Live offset"
                  />
                  Update when the source or distance changes
                </label>
              </Row>
            </TabsContent>
            <TabsContent value="rings" className="grid gap-2 pt-1">
              <RadioGroup
                value={r.ringMode}
                onValueChange={(v) => r.set({ ringMode: v as 'list' | 'interval' })}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="list" aria-label="List of distances" /> List of distances
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="interval" aria-label="Fixed interval" /> Fixed interval
                </label>
              </RadioGroup>
              {r.ringMode === 'list' ? (
                <Row label={`Distances (${UNIT_LABEL[units]})`} htmlFor="off-list">
                  <Input
                    id="off-list"
                    value={r.list}
                    placeholder="10, 25, 50"
                    aria-invalid={!ringDistances || undefined}
                    onChange={(e) => r.set({ list: e.target.value })}
                    data-testid="ring-distances"
                  />
                </Row>
              ) : (
                <>
                  <Row label={`Interval (${UNIT_LABEL[units]})`} htmlFor="off-interval">
                    <Input
                      id="off-interval"
                      value={r.interval}
                      onChange={(e) => r.set({ interval: e.target.value })}
                    />
                  </Row>
                  <Row label="Number of rings" htmlFor="off-count">
                    <Input
                      id="off-count"
                      inputMode="numeric"
                      value={r.count}
                      onChange={(e) => r.set({ count: e.target.value })}
                    />
                  </Row>
                  <Row label={`First ring at (${UNIT_LABEL[units]})`} htmlFor="off-start">
                    <Input
                      id="off-start"
                      value={r.start}
                      placeholder="= interval"
                      onChange={(e) => r.set({ start: e.target.value })}
                    />
                  </Row>
                </>
              )}
              <Row label="Colour ramp">
                <Select value={r.ramp} onValueChange={(v) => r.set({ ramp: v })}>
                  <SelectTrigger size="sm" className="w-full" aria-label="Colour ramp">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(RAMPS).map(([k, ramp]) => (
                      <SelectItem key={k} value={k}>
                        <span
                          className="h-3 w-10 rounded-sm"
                          style={{ background: `linear-gradient(90deg, ${ramp.stops.join(',')})` }}
                        />
                        {ramp.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-xs" data-testid="ring-preview">
                {ringDistances?.map((d, k) => (
                  <span key={d} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
                    <span className="size-2.5 rounded-full" style={{ background: ringColors[k] }} />
                    {formatOffset(d, units, precision)}
                  </span>
                ))}
                {!ringDistances && (
                  <span className="text-destructive">Enter distances like “10, 25, 50”.</span>
                )}
                {sel.length > 1 && <span className="text-destructive">Select a single source object.</span>}
              </div>
            </TabsContent>
          </Tabs>
          <Row label="Corners">
            <Select value={r.join} onValueChange={(v) => r.set({ join: v as OffsetJoin })}>
              <SelectTrigger size="sm" className="w-full" aria-label="Corner style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOINS.map((j) => (
                  <SelectItem key={j.v} value={j.v}>
                    {j.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {r.join === 'miter' && (
            <Row label="Mitre limit (× distance)" htmlFor="off-miter">
              <Input
                id="off-miter"
                value={r.miterLimit}
                aria-invalid={!miterOk || undefined}
                onChange={(e) => r.set({ miterLimit: e.target.value })}
              />
            </Row>
          )}
          {hasOpen && (
            <Row label="Open line ends">
              <Select value={r.cap} onValueChange={(v) => r.set({ cap: v as OffsetCap })}>
                <SelectTrigger size="sm" className="w-full" aria-label="End caps">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAPS.map((c) => (
                    <SelectItem key={c.v} value={c.v}>
                      {c.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}
          <p className="text-muted-foreground text-xs">
            Circles and arcs are offset exactly; curves elsewhere are tessellated within the chord tolerance
            of {formatLength(chordTol, 'mm', 1)} (Offset → Chord tolerance…).
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || (tab === 'single' ? !singleValid : !ringsValid)}
              data-testid="offset-apply"
            >
              {tab === 'single' ? 'Offset' : `Create ${ringDistances?.length ?? 0} rings`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
