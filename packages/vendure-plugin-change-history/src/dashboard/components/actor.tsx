import { Trans } from '@lingui/react/macro';
import { Badge } from '@vendure/dashboard';
import { Bot, Clock, KeyRound, User } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ChangeHistoryEntryData } from '../registry';
import type { Labels, ResolvedSource } from './use-labels';

/** How an entry's author is shown: a person, an API key, a scheduled action, or the system (grey robot). */
export type ActorTone = 'human' | 'api_key' | 'scheduled' | 'system';

export interface ActorView {
  tone: ActorTone;
  name: string;
  source: ResolvedSource;
  Icon: ComponentType<{ className?: string }>;
}

const TONE_ICONS: Record<ActorTone, ComponentType<{ className?: string }>> = {
  human: User,
  api_key: KeyRound,
  scheduled: Clock,
  system: Bot,
};

/** Classes of the round icon in the timeline. */
export const TONE_ICON_CLASSES: Record<ActorTone, string> = {
  human: 'bg-muted text-foreground',
  api_key: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  scheduled: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  system: 'bg-muted text-muted-foreground',
};

export function actorOf(entry: ChangeHistoryEntryData, labels: Labels): ActorView {
  const source = labels.source(entry.source, entry.actorType);
  let tone: ActorTone;
  if (source.tone === 'scheduled') {
    tone = 'scheduled';
  } else if (entry.actorType === 'system' || source.tone === 'system') {
    tone = 'system';
  } else {
    tone = entry.actorType === 'api_key' ? 'api_key' : 'human';
  }
  let name: string;
  if (entry.entityType === 'Run') {
    // A run is labelled when recorded («ERP: stock sync after order #1042»).
    name = entry.entityLabel ?? source.label;
  } else if (tone === 'system') {
    name = source.label;
  } else {
    name = entry.actorLabel ?? source.label;
  }
  return { tone, name, source, Icon: source.icon ?? TONE_ICONS[tone] };
}

/** The badge after the author: «System change», «API key», or the scheduled source's own label. */
export function ActorBadge({ actor }: { actor: ActorView }) {
  if (actor.tone === 'system') {
    return (
      <Badge variant="secondary" className="font-normal">
        <Trans context="change-history">System change</Trans>
      </Badge>
    );
  }
  if (actor.tone === 'api_key') {
    return (
      <Badge variant="outline" className="border-blue-200 text-blue-700 font-normal dark:text-blue-300">
        <Trans context="change-history">API key</Trans>
      </Badge>
    );
  }
  if (actor.tone === 'scheduled') {
    return (
      <Badge variant="outline" className="border-amber-200 text-amber-700 font-normal dark:text-amber-300">
        {actor.source.label}
      </Badge>
    );
  }
  return null;
}

/** Icon and name in one line, greyed for the system — the feed's and the widget's «who». */
export function ActorName({ actor, className }: { actor: ActorView; className?: string }) {
  const { Icon } = actor;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${actor.tone === 'system' ? 'text-muted-foreground' : ''} ${className ?? ''}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{actor.name}</span>
      {actor.tone === 'api_key' && (
        <Badge variant="outline" className="border-blue-200 px-1 py-0 text-[10px] text-blue-700 dark:text-blue-300">
          API
        </Badge>
      )}
    </span>
  );
}
