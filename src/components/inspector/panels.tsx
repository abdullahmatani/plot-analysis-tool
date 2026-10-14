import type { ComponentType } from 'react';

import type { InspectorTab } from '@/store/ui';

import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';

/** Data and Legend panels are provided by the contour and legend modules. */
export const dataPanels: ComponentType[] = [];
export const legendPanels: ComponentType[] = [];

function Stack({ items, empty }: { items: ComponentType[]; empty: string }) {
  if (!items.length) return <p className="text-muted-foreground p-3 text-sm">{empty}</p>;
  return (
    <div className="space-y-3 p-2">
      {items.map((S, i) => (
        <S key={i} />
      ))}
    </div>
  );
}

export const inspectorPanels: Record<InspectorTab, ComponentType> = {
  properties: PropertiesPanel,
  layers: LayersPanel,
  data: () => <Stack items={dataPanels} empty="Import a results table to create contours." />,
  legend: () => <Stack items={legendPanels} empty="The legend is built from your layers and datasets." />,
};
