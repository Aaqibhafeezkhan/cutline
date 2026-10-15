import { AlertTriangle, Bot, Check, Eye, EyeOff, X } from 'lucide-react';
import { agentModeOf, describeChanges, formatChange, type Proposal } from '@cutline/core';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';

const MAX_LINES = 6;

function time(at: string) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const previewing = useEditor((s) => s.preview?.id === proposal.id);
  const { togglePreview, acceptProposal, rejectProposal, select } = useEditor.getState();
  const stale = proposal.status === 'stale';
  const lines = proposal.changes.map(formatChange);
  return (
    <li
      aria-label={`Suggestion ${proposal.label}`}
      className={cn(
        'border-b border-border/60 px-3 py-2.5 text-xs',
        previewing ? 'bg-agent/10' : 'bg-agent/5',
      )}
    >
      <div className="flex justify-between gap-2 text-[10px] text-muted">
        <span className="flex items-center gap-1 font-semibold text-agent">
          <Bot className="size-3" aria-hidden /> {proposal.origin.name ?? 'Agent'}
        </span>
        <time dateTime={proposal.createdAt}>{time(proposal.createdAt)}</time>
      </div>
      <button
        type="button"
        className="mt-0.5 text-left font-medium leading-snug text-foreground hover:underline"
        onClick={() => select(proposal.affectedIds)}
      >
        {proposal.label}
      </button>
      <p className="mt-0.5 text-muted">{describeChanges(proposal.changes)}</p>
      {lines.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-foreground/80" aria-label="Changes">
          {lines.slice(0, MAX_LINES).map((line, i) => (
            <li key={i} className="truncate" title={line}>
              {line}
            </li>
          ))}
          {lines.length > MAX_LINES && (
            <li className="text-muted">… and {lines.length - MAX_LINES} more</li>
          )}
        </ul>
      )}
      {stale && (
        <p role="alert" className="mt-1 flex items-start gap-1 text-danger">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          No longer applies: {proposal.error?.message}
        </p>
      )}
      <div className="mt-2 flex gap-1">
        <Button
          variant={previewing ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={previewing}
          disabled={stale}
          onClick={() => togglePreview(proposal.id)}
        >
          {previewing ? <EyeOff /> : <Eye />} {previewing ? 'Hide' : 'Preview'}
        </Button>
        <Button
          size="sm"
          disabled={stale}
          onClick={() => void acceptProposal(proposal.id)}
          aria-label={`Accept ${proposal.label}`}
        >
          <Check /> Accept
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void rejectProposal(proposal.id)}
          aria-label={`Reject ${proposal.label}`}
        >
          <X /> Reject
        </Button>
      </div>
    </li>
  );
}

/** Agent edits waiting for review (suggest mode). */
export function SuggestionsPanel() {
  const proposals = useEditor((s) => s.proposals);
  const suggest = useEditor((s) => (s.project ? agentModeOf(s.project) === 'suggest' : false));
  const { acceptProposal, rejectProposal } = useEditor.getState();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {proposals.length > 0 && (
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <span className="flex-1 text-xs text-muted">
            {proposals.length} suggestion{proposals.length === 1 ? '' : 's'}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void acceptProposal()}>
            <Check /> Accept all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void rejectProposal()}>
            Reject all
          </Button>
        </div>
      )}
      <ol aria-label="Suggestions" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto">
        {proposals.length === 0 && (
          <li className="p-4 text-sm text-muted">
            {suggest
              ? 'Nothing to review. Edits from connected agents will appear here as suggestions you can preview, accept or reject.'
              : 'Agent edits apply directly. Switch Agent to Suggest in the top bar to review them here before they change your timeline.'}
          </li>
        )}
        {proposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} />
        ))}
      </ol>
    </div>
  );
}
