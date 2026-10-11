import { Trans } from '@lingui/react/macro';
import { Badge, Link } from '@vendure/dashboard';
import type { ReactNode } from 'react';
import { builtInRoute } from '../format';
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

export function DeletedBadge() {
  return (
    <Badge variant="destructive" className="font-normal">
      <Trans context="change-history">deleted</Trans>
    </Badge>
  );
}

/** A link to the entity's page, or its label with a «deleted» badge when it is gone. */
export function EntityLink({
  entry,
  children,
  className,
}: {
  entry: ChangeHistoryEntryData;
  children?: ReactNode;
  className?: string;
}) {
  const route = useEntityRoute()(entry);
  const text = children ?? entry.entityLabel ?? entry.entityId;
  if (entry.entityDeleted) {
    return (
      <span className={`inline-flex items-center gap-1.5 ${className ?? ''}`}>
        <span className="text-muted-foreground">{text}</span>
        <DeletedBadge />
      </span>
    );
  }
  if (!route) {
    return <span className={className}>{text}</span>;
  }
  return (
    <Link to={route as never} className={`hover:underline ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
      {text}
    </Link>
  );
}
