import { useProject } from '@/store/project';
import { useViewStore } from '@/store/view';

import { CanvasSlot } from '@/features/units/canvas-slot';

import { useOverlayPrefs } from './overlay-prefs';
import { northArrowAngle, scaleBarLayout } from './scalebar';

/** On-canvas scale bar and north arrow (row 36), toggled from the View menu (remembered per browser). */

const MAX_PX = 160;

function ScaleBar() {
  const scale = useViewStore((s) => s.view.scale);
  const units = useProject((p) => p.display.units) ?? 'm';
  const layout = scaleBarLayout(scale, MAX_PX, units);
  if (!layout) return null;
  const seg = layout.px / layout.divisions;
  const w = Math.ceil(layout.px) + 2;
  return (
    <div
      className="bg-background/85 text-foreground rounded-md border px-2.5 pt-1 pb-1.5 shadow-sm backdrop-blur-sm"
      data-testid="scale-bar"
      data-metres={layout.metres}
      data-px={layout.px}
      aria-label={`Scale bar ${layout.label}`}
      role="img"
    >
      <div className="relative h-4 text-[10px] leading-4 tabular-nums" style={{ width: w + 24 }}>
        {layout.ticks.map((t, i) => (
          <span
            key={i}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
            style={{ left: t.px + 1 }}
          >
            {t.label}
          </span>
        ))}
      </div>
      <svg width={w} height={8} className="block" data-testid="scale-bar-graphic">
        <rect x={1} y={1} width={layout.px} height={6} fill="none" stroke="currentColor" strokeWidth={1} />
        {Array.from({ length: layout.divisions }, (_, i) =>
          i % 2 === 0 ? (
            <rect key={i} x={1 + i * seg} y={1} width={seg} height={6} fill="currentColor" />
          ) : null,
        )}
      </svg>
    </div>
  );
}

function NorthArrow() {
  const rotation = useViewStore((s) => s.view.rotation);
  const arrow = useProject((p) => p.north.arrow) ?? 'plant';
  const trueNorthAngle = useProject((p) => p.north.trueNorthAngle) ?? 0;
  const angle = northArrowAngle(rotation, { arrow, trueNorthAngle });
  const deg = (angle * 180) / Math.PI;
  return (
    <div
      className="bg-background/85 text-foreground flex flex-col items-center rounded-md border px-1.5 pt-1 pb-0.5 shadow-sm backdrop-blur-sm"
      data-testid="north-arrow"
      data-angle={deg}
      data-north={arrow}
      role="img"
      aria-label={`${arrow === 'true' ? 'True' : 'Plant'} north arrow`}
    >
      <svg width={44} height={44} viewBox="-22 -22 44 44" style={{ transform: `rotate(${-deg}deg)` }}>
        <circle r={11} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
        <path d="M0 -12 L5.5 10 L0 6 Z" fill="currentColor" />
        <path
          d="M0 -12 L-5.5 10 L0 6 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinejoin="round"
        />
        <text y={-14} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="currentColor">
          N
        </text>
      </svg>
      <span className="text-muted-foreground text-[9px] leading-3">
        {arrow === 'true' ? 'True N' : 'Plant N'}
      </span>
    </div>
  );
}

export function MapOverlays() {
  const scaleBar = useOverlayPrefs((s) => s.scaleBar);
  const northArrow = useOverlayPrefs((s) => s.northArrow);
  const hasContent = useProject((p) => p.drawings.length > 0 || p.objects.length > 0) ?? false;
  if (!hasContent) return null;
  return (
    <>
      {scaleBar && (
        <CanvasSlot name="bottom-left">
          <ScaleBar />
        </CanvasSlot>
      )}
      {northArrow && (
        <CanvasSlot name="top-right">
          <NorthArrow />
        </CanvasSlot>
      )}
    </>
  );
}
