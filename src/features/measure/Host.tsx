import { MapOverlays } from './MapOverlays';
import { MeasureHud } from './MeasureHud';

/** Always-mounted host of the measurement result panel and the scale bar / north arrow overlays. */
export function MeasureFeatureHost() {
  return (
    <>
      <MeasureHud />
      <MapOverlays />
    </>
  );
}
