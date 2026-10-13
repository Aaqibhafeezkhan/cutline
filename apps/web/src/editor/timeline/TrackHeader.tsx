import { useState } from 'react';
import { Captions, Eye, EyeOff, Film, Lock, Music, Unlock, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '@cutline/core';
import { useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';
import { TRACK_HEIGHT } from './geometry';

const ICON = { video: Film, audio: Music, caption: Captions };

export function TrackHeader({ track }: { track: Track }) {
  const dispatch = useEditor((s) => s.dispatch);
  const [editing, setEditing] = useState(false);
  const Icon = ICON[track.kind];
  const update = (props: Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>>) =>
    void dispatch([{ type: 'update_track', trackId: track.id, ...props }]);

  const toggle = (
    on: boolean,
    label: string,
    OnIcon: typeof Eye,
    OffIcon: typeof Eye,
    onClick: () => void,
  ) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        'rounded p-1 hover:bg-surface-2',
        on ? 'text-primary' : 'text-muted hover:text-foreground',
      )}
    >
      {on ? <OnIcon className="size-3.5" /> : <OffIcon className="size-3.5" />}
    </button>
  );

  return (
    <div
      className="flex items-center gap-1 border-b border-border/60 px-2"
      style={{ height: TRACK_HEIGHT[track.kind] }}
    >
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
      {editing ? (
        <input
          autoFocus
          aria-label="Track name"
          defaultValue={track.name}
          className="w-14 rounded bg-background px-1 text-xs"
          onBlur={(e) => {
            setEditing(false);
            const name = e.currentTarget.value.trim();
            if (name && name !== track.name) update({ name });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs font-medium"
          title="Double-click to rename"
          onDoubleClick={() => setEditing(true)}
        >
          {track.name}
        </button>
      )}
      <div className="ml-auto flex">
        {track.kind !== 'caption' &&
          toggle(track.muted, track.muted ? 'Unmute track' : 'Mute track', VolumeX, Volume2, () =>
            update({ muted: !track.muted }),
          )}
        {track.kind !== 'audio' &&
          toggle(track.hidden, track.hidden ? 'Show track' : 'Hide track', EyeOff, Eye, () =>
            update({ hidden: !track.hidden }),
          )}
        {toggle(track.locked, track.locked ? 'Unlock track' : 'Lock track', Lock, Unlock, () =>
          update({ locked: !track.locked }),
        )}
      </div>
    </div>
  );
}
