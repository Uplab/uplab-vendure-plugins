import { Trans } from '@lingui/react/macro';
import { Badge, Link } from '@vendure/dashboard';
import type { ReactNode } from 'react';
import { builtInRoute, splitTrailingCode } from '../format';
import type { ChangeHistoryEntryData } from '../registry';
import { useLabels } from './use-labels';

/** The page of an entry's entity: the host's route for its type, else the core detail page. */
export function useEntityRoute() {
  const labels = useLabels();
  return (entry: ChangeHistoryEntryData): string | undefined => {
    const hostRoute = labels.entityRoute(entry.entityType);
    if (hostRoute) {
      return hostRoute(entry);
    }
    return builtInRoute(entry.entityType, entry.entityId, entry.parentId);
  };
}

/** Red on light and dark backgrounds alike (core's destructive badge is too dark on the dark theme). */
const DELETED_BADGE =
  'border-red-200 bg-red-50 font-normal text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300';

export function DeletedBadge() {
  return (
    <Badge variant="outline" className={DELETED_BADGE}>
      <Trans context="change-history">Deleted</Trans>
    </Badge>
  );
}

/** A link reads as one: the primary colour, underlined on hover. */
const LINK_CLASS = 'text-primary underline-offset-2 hover:underline';

/**
 * A label that keeps a variant's trailing «(SKU)» whole when the cell cuts it: the name shrinks, the code
 * stays.
 */
function CuttableLabel({ text, keepCode }: { text: ReactNode; keepCode: boolean }) {
  if (!keepCode || typeof text !== 'string') {
    return <span className="min-w-0 truncate">{text}</span>;
  }
  const { name, code } = splitTrailingCode(text);
  if (!code) {
    return <span className="min-w-0 truncate">{text}</span>;
  }
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-[0.3em]">
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0">({code})</span>
    </span>
  );
}

/**
 * A link to the entity's page, or its label with a «Deleted» badge when it is gone. `deletedBadge={false}`
 * leaves the badge out where the line already says «deleted».
 */
export function EntityLink({
  entry,
  children,
  className,
  deletedBadge = true,
  cut = false,
}: {
  entry: ChangeHistoryEntryData;
  children?: ReactNode;
  className?: string;
  deletedBadge?: boolean;
  /** In a cell that cuts long names: the name shrinks, a variant's SKU and the badge stay. */
  cut?: boolean;
}) {
  const route = useEntityRoute()(entry);
  const text = children ?? entry.entityLabel ?? entry.entityId;
  const label = cut ? <CuttableLabel text={text} keepCode={entry.entityType === 'ProductVariant'} /> : text;
  if (entry.entityDeleted) {
    return (
      <span className={`inline-flex max-w-full items-center gap-1.5 ${className ?? ''}`}>
        <span className="flex min-w-0 text-muted-foreground">{label}</span>
        {deletedBadge && (
          <span className="shrink-0">
            <DeletedBadge />
          </span>
        )}
      </span>
    );
  }
  if (!route) {
    return <span className={`${cut ? 'flex min-w-0' : ''} ${className ?? ''}`}>{label}</span>;
  }
  return (
    <Link
      to={route as never}
      className={`${LINK_CLASS} ${cut ? 'flex min-w-0 max-w-full' : ''} ${className ?? ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </Link>
  );
}
