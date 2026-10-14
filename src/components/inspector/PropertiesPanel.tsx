import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatArea, formatLength } from '@/core/units';
import { Button } from '@/components/ui/button';
import { useProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { entityInfo } from '@/underlay/entity-info';

import { propertySections } from './property-sections';

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/** Underlay entity inspector (row 20): values in world units once calibrated. */
function PickedEntity() {
  const picked = useViewStore((s) => s.pickedEntity);
  const drawings = useProject((p) => p.drawings);
  const display = useProject((p) => p.display);
  if (!picked || !drawings || !display) return null;
  const d = drawings.find((x) => x.id === picked.drawingId);
  const info = d ? entityInfo(d, picked.index) : null;
  if (!d || !info) return null;
  const len = (v: number) => formatLength(v, display.units, display.precision + 1);
  return (
    <section className="space-y-1 rounded-md border p-2" data-testid="entity-inspector">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Drawing entity</h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Clear"
          onClick={() => useViewStore.getState().set({ pickedEntity: null })}
        >
          <X />
        </Button>
      </div>
      <Row label="Type">{info.type}</Row>
      <Row label="Layer">{info.layer}</Row>
      <Row label="Drawing">{d.name}</Row>
      <Row label="Colour">
        <span className="inline-flex items-center gap-1">
          <span className="size-3 rounded-sm border" style={{ background: info.color }} />
          {info.color}
        </span>
      </Row>
      {info.handle && <Row label="Handle">{info.handle}</Row>}
      {info.block && <Row label="From block">{info.block}</Row>}
      {info.text && <Row label="Text">{info.text}</Row>}
      {info.radius !== undefined && (
        <>
          <Row label="Radius">{len(info.radius)}</Row>
          <Row label="Diameter">{len(info.radius * 2)}</Row>
        </>
      )}
      {info.length !== undefined && info.length > 0 && (
        <Row label={info.area !== undefined ? 'Perimeter' : 'Length'}>{len(info.length)}</Row>
      )}
      {info.area !== undefined && (
        <Row label="Area">{formatArea(info.area, display.areaUnits, display.precision)}</Row>
      )}
      {!info.calibrated && (
        <p className="text-warning text-xs">This drawing is not calibrated — values use the file’s units.</p>
      )}
    </section>
  );
}

export function PropertiesPanel() {
  return (
    <div className="space-y-3 p-2" data-testid="properties-panel">
      {propertySections.map((S, i) => (
        <S key={i} />
      ))}
      <PickedEntity />
    </div>
  );
}
