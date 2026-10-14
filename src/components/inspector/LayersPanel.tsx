import type { ComponentType } from 'react';

import { DrawingsSection } from './DrawingsSection';

/** Sections below the drawings (analysis layers, anchors) contributed by later modules. */
export const layerSections: ComponentType[] = [];

export function LayersPanel() {
  return (
    <div className="space-y-4 p-2" data-testid="layers-panel">
      {layerSections.map((S, i) => (
        <S key={i} />
      ))}
      <DrawingsSection />
    </div>
  );
}
