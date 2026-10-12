import { Trans } from '@lingui/react/macro';
import { Badge, Link } from '@vendure/dashboard';
import type { ReactNode } from 'react';
import { builtInRoute, splitTrailingCode, titleWhenCut } from '../format';
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
 * A name in a cell that cuts it: up to two lines broken between words (a word wider than the cell alone breaks
 * inside), an ellipsis only past the second line.
 */
const TWO_LINES = 'line-clamp-2 min-w-0 max-w-full whitespace-normal break-words';

/** A cut name: two lines at most, the whole name in the tooltip when it is cut. */
export function CutText({ children }: { children: ReactNode }) {
  return (
    <span className={TWO_LINES} onMouseEnter={(event) => titleWhenCut(event.currentTarget)}>
      {children}
    </span>
  );
}

/**
 * A variant's label in a cell that cuts it: «name (SKU)» on one line when both fit, else the SKU on a line of
 * its own under the name, so neither is crushed to a letter («C. (E2E-FOLD-40-424…»). Each line is cut with an
 * ellipsis only when it alone is wider than the cell (a long name; a code of 30 characters); the whole label
 * is the tooltip. Any other label takes up to two lines, broken between words (`CutText`).
 */
function CuttableLabel({ text, keepCode }: { text: ReactNode; keepCode: boolean }) {
  if (!keepCode || typeof text !== 'string') {
    return <CutText>{text}</CutText>;
  }
  const { name, code } = splitTrailingCode(text);
  if (!code) {
    return <CutText>{text}</CutText>;
  }
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-[0.3em]" title={text}>
      <span className="min-w-0 max-w-full truncate">{name}</span>
      <span className="min-w-0 max-w-full truncate">({code})</span>
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
  /** In a cell that cuts long names: a variant's SKU goes under its name when both do not fit; the badge stays. */
  cut?: boolean;
}) {
  const route = useEntityRoute()(entry);
  const text = children ?? entry.entityLabel ?? entry.entityId;
  const label = cut ? <CuttableLabel text={text} keepCode={entry.entityType === 'ProductVariant'} /> : text;
  if (entry.entityDeleted) {
    return (
      // The badge goes under the label when both do not fit on one line, as a variant's SKU does: it never
      // squeezes the name.
      <span className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 ${className ?? ''}`}>
        <span className="flex min-w-0 max-w-full text-muted-foreground">{label}</span>
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
