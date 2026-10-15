import { Badge } from '@vendure/dashboard';
import type { ReactNode } from 'react';

/**
 * The look of the dashboard's `secondary` badge, on `outline`: Vendure 3.8's Badge no longer has `secondary`
 * (it renders an unknown variant unstyled), while `outline` and these colours exist on 3.7 and 3.8 alike.
 */
const OFF_BADGE = 'border-transparent bg-secondary text-secondary-foreground';

/** A yes/no state: green while on, grey while off. */
export function StateBadge({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? (
    <Badge variant="success">{children}</Badge>
  ) : (
    <Badge variant="outline" className={OFF_BADGE}>
      {children}
    </Badge>
  );
}
