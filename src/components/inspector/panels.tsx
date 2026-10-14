import type { ComponentType } from 'react';

import type { InspectorTab } from '@/store/ui';

function Placeholder({ text }: { text: string }) {
  return <p className="text-muted-foreground p-3 text-sm">{text}</p>;
}

/** Panel components per inspector tab; feature modules replace these as they are built. */
export const inspectorPanels: Record<InspectorTab, ComponentType> = {
  properties: () => <Placeholder text="Select an object to see its properties." />,
  layers: () => <Placeholder text="Drawings and analysis layers appear here." />,
  data: () => <Placeholder text="Import a results table to create contours." />,
  legend: () => <Placeholder text="The legend is built from your layers and datasets." />,
};
