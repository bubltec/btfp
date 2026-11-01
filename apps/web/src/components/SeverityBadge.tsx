import type { Severity } from '@btfp/shared-types';
import { Badge, type BadgeTone } from '@bubltec/uiux';

const TONE: Record<Severity, BadgeTone> = {
  severe: 'danger',
  moderate: 'warn',
  mild: 'ok',
  unknown: 'neutral',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge tone={TONE[severity]} className="capitalize">
      {severity}
    </Badge>
  );
}
