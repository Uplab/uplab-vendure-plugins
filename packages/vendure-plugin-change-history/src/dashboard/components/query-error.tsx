import { Trans } from '@lingui/react/macro';
import { Button } from '@vendure/dashboard';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { isForbiddenError } from '../format';

/**
 * A request of the change history failed: a translated message (the technical one in the tooltip) and a
 * retry. Shown instead of the «nothing here» text, which would claim there were no changes.
 */
export function QueryError({
  error,
  onRetry,
  retrying = false,
  className,
  what = 'history',
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  /** What failed to load: the history (default) or the feed's filter options. */
  what?: 'history' | 'filters';
}) {
  const detail = error instanceof Error ? error.message : undefined;
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2 text-sm text-destructive dark:text-red-400 ${className ?? ''}`}
      title={detail}
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>
        {isForbiddenError(error) && (
          <Trans context="change-history">You do not have permission to view this history.</Trans>
        )}
        {!isForbiddenError(error) && what === 'history' && (
          <Trans context="change-history">The change history could not be loaded.</Trans>
        )}
        {!isForbiddenError(error) && what === 'filters' && (
          <Trans context="change-history">The filter options could not be loaded.</Trans>
        )}
      </span>
      {onRetry && (
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          <RefreshCw className={retrying ? 'animate-spin' : undefined} />
          <Trans context="change-history">Retry</Trans>
        </Button>
      )}
    </div>
  );
}
