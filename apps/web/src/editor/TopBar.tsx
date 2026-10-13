import { ArrowLeft, Bot, Download, Keyboard, Plug, Redo2, Undo2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/misc';
import { navigate } from '@/lib/router';
import { useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';

export function TopBar({
  onExport,
  onConnect,
  onShortcuts,
}: {
  onExport: () => void;
  onConnect: () => void;
  onShortcuts: () => void;
}) {
  const project = useEditor((s) => s.project);
  const history = useEditor((s) => s.history);
  const connection = useEditor((s) => s.connection);
  const participants = useEditor((s) => s.participants);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  // One badge per agent name (a client may hold several MCP sessions).
  const agents = [
    ...new Map(participants.filter((p) => p.kind === 'agent').map((p) => [p.name, p])).values(),
  ];

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="All projects"
        onClick={() => navigate('/')}
      >
        <ArrowLeft />
      </Button>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{project?.name ?? 'Loading…'}</span>
        {project && (
          <span className="text-xs text-muted">
            {project.settings.width}×{project.settings.height} · {project.settings.fps} fps
          </span>
        )}
      </div>
      <div className="ml-2 flex items-center">
        <Tooltip
          content={history.undoLabel ? `Undo: ${history.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Undo"
            disabled={!history.canUndo}
            onClick={undo}
          >
            <Undo2 />
          </Button>
        </Tooltip>
        <Tooltip
          content={
            history.redoLabel ? `Redo: ${history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Redo"
            disabled={!history.canRedo}
            onClick={redo}
          >
            <Redo2 />
          </Button>
        </Tooltip>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-1" aria-label="Connected participants">
          {agents.length === 0 ? (
            <Tooltip content="No AI agent has used this project yet. Click Connect agent for setup instructions.">
              <span className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                <Bot className="size-3.5" /> no agent
              </span>
            </Tooltip>
          ) : (
            agents.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1 rounded-full border border-agent/50 bg-agent/10 px-2 py-0.5 text-xs text-agent"
              >
                <Bot className="size-3.5" /> {a.name}
              </span>
            ))
          )}
          {participants
            .filter((p) => p.kind === 'browser')
            .slice(0, 3)
            .map((p) => (
              <span
                key={p.id}
                title={p.name}
                className="rounded-full border border-border p-1 text-muted"
              >
                <User className="size-3" />
              </span>
            ))}
        </div>
        <span
          role="status"
          className={cn(
            'size-2 rounded-full',
            connection === 'open'
              ? 'bg-emerald-400'
              : connection === 'connecting'
                ? 'bg-amber-400'
                : 'bg-danger',
          )}
          title={`Server connection: ${connection}`}
          aria-label={`Server connection ${connection}`}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Keyboard shortcuts (?)"
          onClick={onShortcuts}
        >
          <Keyboard />
        </Button>
        <Button variant="secondary" size="sm" onClick={onConnect}>
          <Plug /> Connect agent
        </Button>
        <Button size="sm" onClick={onExport}>
          <Download /> Export
        </Button>
      </div>
    </header>
  );
}
