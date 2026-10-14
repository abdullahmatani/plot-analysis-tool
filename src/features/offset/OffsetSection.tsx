import { Link2, Unlink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Field, LengthInput, NumberInput } from '@/components/inspector/fields';
import type { OffsetCap, OffsetJoin } from '@/geometry/offset';
import { isClosed } from '@/geometry/convert';
import { useProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';

import { detachOffsets, setOffsetParams } from './actions';
import { CAPS, JOINS } from './options';

/** Properties of a live offset (row 59): source, distance, corners, caps; Detach. */
export function OffsetSection() {
  const selection = useViewStore((s) => s.selection);
  const project = useProject((p) => p);
  const readOnlyStore = useProjectStore((s) => s.readOnly);
  if (!project || selection.length !== 1) return null;
  const o = project.objects.find((x) => x.id === selection[0]);
  if (!o || o.kind !== 'offset') return null;
  const der = o.derived;
  const locked = project.layers.find((l) => l.id === o.layerId)?.locked ?? false;
  const readOnly = readOnlyStore || locked;
  const src = der ? project.objects.find((x) => x.id === der.sourceId) : undefined;
  const ring = der?.ringGroup ? project.objects.filter((x) => x.derived?.ringGroup === der.ringGroup) : [];
  const { units, precision } = project.display;
  return (
    <section className="space-y-1.5 rounded-md border p-2" data-testid="offset-section">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase">Offset</h4>
        <Badge variant={der ? 'default' : 'outline'} className="font-normal">
          {der ? 'Live' : 'Static'}
        </Badge>
      </div>
      {!der && (
        <p className="text-muted-foreground text-xs">
          Detached from its source: the geometry no longer follows it.
        </p>
      )}
      {der && (
        <>
          <Field label="Source">
            <Button
              variant="link"
              size="xs"
              className="h-auto max-w-full justify-start truncate p-0"
              disabled={!src}
              onClick={() => src && useViewStore.getState().set({ selection: [src.id] })}
              title="Select the source object"
            >
              <Link2 /> {src?.name ?? '(missing)'}
            </Button>
          </Field>
          <Field label="Distance">
            <LengthInput
              ariaLabel="Offset distance"
              metres={der.distance}
              units={units}
              precision={precision}
              allowNegative
              disabled={readOnly}
              onCommit={(distance) => void setOffsetParams(o.id, { distance })}
            />
          </Field>
          <Field label="Corners">
            <Select
              value={der.join}
              disabled={readOnly}
              onValueChange={(v) => void setOffsetParams(o.id, { join: v as OffsetJoin })}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Offset corners">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOINS.map((j) => (
                  <SelectItem key={j.v} value={j.v}>
                    {j.short}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {der.join === 'miter' && (
            <Field label="Mitre limit">
              <NumberInput
                ariaLabel="Mitre limit"
                value={der.miterLimit ?? 2}
                min={1}
                max={100}
                suffix="×"
                disabled={readOnly}
                onCommit={(miterLimit) => void setOffsetParams(o.id, { miterLimit })}
              />
            </Field>
          )}
          {src && !isClosed(src.geometry) && src.geometry.type !== 'arc' && (
            <Field label="Line ends">
              <Select
                value={der.cap ?? 'round'}
                disabled={readOnly}
                onValueChange={(v) => void setOffsetParams(o.id, { cap: v as OffsetCap })}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="Offset end caps">
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
            </Field>
          )}
          {ring.length > 1 && (
            <Field label="Ring group">
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0"
                onClick={() => useViewStore.getState().set({ selection: ring.map((x) => x.id) })}
              >
                Select all {ring.length} rings
              </Button>
            </Field>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={readOnly}
            onClick={() => detachOffsets([o.id])}
            data-testid="offset-detach"
          >
            <Unlink /> Detach (make static)
          </Button>
        </>
      )}
    </section>
  );
}
