import { Badge } from '@/components/ui/badge';
import { useProject } from '@/store/project';

/** Calibration status (row 32): Uncalibrated / Calibrated / Verified for the drawings in the project. */
export function CalibrationBadge() {
  const drawings = useProject((p) => p.drawings) ?? [];
  if (drawings.length === 0)
    return (
      <Badge variant="outline" className="h-6 font-normal text-muted-foreground">
        No drawing
      </Badge>
    );
  const states = drawings.map((d) =>
    d.verified ? 'verified' : d.calibration ? 'calibrated' : 'uncalibrated',
  );
  const worst = states.includes('uncalibrated')
    ? 'uncalibrated'
    : states.includes('calibrated')
      ? 'calibrated'
      : 'verified';
  const label =
    worst === 'uncalibrated' ? 'Uncalibrated' : worst === 'calibrated' ? 'Calibrated' : 'Verified';
  return (
    <Badge
      variant={worst === 'uncalibrated' ? 'warning' : worst === 'verified' ? 'success' : 'outline'}
      className="h-6 font-normal"
      data-testid="calibration-badge"
      data-state={worst}
    >
      {label} {worst === 'verified' ? '✓' : ''}
    </Badge>
  );
}
