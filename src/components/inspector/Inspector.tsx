import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUiStore, type InspectorTab } from '@/store/ui';

import { inspectorPanels } from './panels';

/** Inspector (row 3): Properties, Layers, Data and Legend tabs. */
export function Inspector() {
  const tab = useUiStore((s) => s.inspectorTab);
  const setTab = useUiStore((s) => s.setInspectorTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as InspectorTab)}
      className="flex h-full min-h-0 flex-col gap-0"
      data-testid="inspector"
    >
      <div className="border-b p-1.5">
        <TabsList className="w-full">
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="layers">Layers</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="legend">Legend</TabsTrigger>
        </TabsList>
      </div>
      {(['properties', 'layers', 'data', 'legend'] as const).map((t) => {
        const Panel = inspectorPanels[t];
        return (
          <TabsContent key={t} value={t} className="min-h-0 overflow-auto">
            <Panel />
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
