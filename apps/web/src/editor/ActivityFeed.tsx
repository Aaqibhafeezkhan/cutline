import { Bot, Download, Loader2, Redo2, Undo2, User } from 'lucide-react';
import { useEditor, type ActivityEntry } from '@/lib/store';
import { withToken } from '@/lib/api';
import { cn } from '@/lib/utils';

function time(at: string) {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Entry({ entry }: { entry: ActivityEntry }) {
  const select = useEditor((s) => s.select);
  const agent = entry.origin.kind === 'agent';
  const Icon = entry.kind === 'undo' ? Undo2 : entry.kind === 'redo' ? Redo2 : agent ? Bot : User;
  const running = entry.status === 'started' || entry.status === 'progress';
  return (
    <li
      className={cn(
        'flex gap-2 border-b border-border/60 px-3 py-2 text-xs',
        agent && 'bg-agent/5',
        entry.status === 'failed' && 'text-danger',
      )}
    >
      {running ? (
        <Loader2
          className="mt-0.5 size-3.5 shrink-0 animate-spin text-agent"
          aria-label="in progress"
        />
      ) : (
        <Icon
          className={cn('mt-0.5 size-3.5 shrink-0', agent ? 'text-agent' : 'text-muted')}
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2 text-[10px] text-muted">
          <span className={cn('font-semibold', agent && 'text-agent')}>
            {entry.origin.name ?? (agent ? 'Agent' : 'You')}
          </span>
          <time dateTime={entry.at}>{time(entry.at)}</time>
        </div>
        <button
          type="button"
          className="text-left leading-snug text-foreground/90 hover:text-foreground disabled:cursor-default"
          disabled={entry.affectedIds.length === 0}
          onClick={() => select(entry.affectedIds)}
        >
          {entry.message}
        </button>
        {running && entry.progress !== undefined && entry.progress > 0 && (
          <div className="mt-1 h-1 overflow-hidden rounded bg-surface-2">
            <div
              className="h-full bg-agent"
              style={{ width: `${Math.round(entry.progress * 100)}%` }}
            />
          </div>
        )}
        {entry.link && (
          <a
            href={withToken(`${entry.link}${entry.link.includes('?') ? '&' : '?'}download`)}
            className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Download className="size-3" /> Download
          </a>
        )}
      </div>
    </li>
  );
}

export function ActivityFeed() {
  const activity = useEditor((s) => s.activity);
  return (
    <ol aria-label="Activity" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto">
      {activity.length === 0 && (
        <li className="p-4 text-sm text-muted">
          Changes made by you and by connected AI agents appear here. Agent edits are highlighted on
          the timeline.
        </li>
      )}
      {activity.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}
