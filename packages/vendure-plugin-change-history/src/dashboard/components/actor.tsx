import { useLingui } from '@lingui/react/macro';
import { Badge } from '@vendure/dashboard';
import { Bot, Clock, KeyRound, User } from 'lucide-react';
import type { ComponentType } from 'react';
import { distinctBadges } from '../format';
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

/** One badge of an entry's title line; badges with the same visible text show once. */
export interface EntryBadge {
  key: string;
  text: string;
  variant?: 'outline' | 'secondary' | 'destructive';
  className?: string;
}

/**
 * The badges after the author: the actor's («System change», «API key», or the scheduled source's own label),
 * then the entry's own — each visible text once, and none repeating a text in `shown` (already on the line).
 */
export function EntryBadges({
  actor,
  badges = [],
  shown,
}: {
  actor: ActorView;
  badges?: Array<EntryBadge | false | null | undefined>;
  shown?: string[];
}) {
  const { t } = useLingui();
  const actorBadges: Record<ActorTone, EntryBadge | undefined> = {
    system: { key: 'actor', variant: 'secondary', text: t({ message: 'System change', context: 'change-history' }) },
    api_key: {
      key: 'actor',
      text: t({ message: 'API key', context: 'change-history' }),
      className: 'border-blue-200 text-blue-700 dark:text-blue-300',
    },
    scheduled: {
      key: 'actor',
      text: actor.source.label,
      className: 'border-amber-200 text-amber-700 dark:text-amber-300',
    },
    human: undefined,
  };
  return (
    <>
      {distinctBadges([actorBadges[actor.tone], ...badges], shown).map((badge) => (
        <Badge key={badge.key} variant={badge.variant ?? 'outline'} className={`font-normal ${badge.className ?? ''}`}>
          {badge.text}
        </Badge>
      ))}
    </>
  );
}

/** Icon and name in one line, greyed for the system — the feed's and the widget's «who». */
export function ActorName({ actor, className }: { actor: ActorView; className?: string }) {
  const { Icon } = actor;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${actor.tone === 'system' ? 'text-muted-foreground' : ''} ${className ?? ''}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{actor.name}</span>
      {actor.tone === 'api_key' && (
        <Badge variant="outline" className="border-blue-200 px-1 py-0 text-[10px] text-blue-700 dark:text-blue-300">
          API
        </Badge>
      )}
    </span>
  );
}
