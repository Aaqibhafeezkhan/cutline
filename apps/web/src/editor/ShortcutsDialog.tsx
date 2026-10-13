import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/misc';

export const SHORTCUTS: Array<[string[], string]> = [
  [['Space'], 'Play / pause'],
  [['S'], 'Split at playhead (selected clips, or all under the playhead)'],
  [['Del'], 'Delete selected clips'],
  [['Shift', 'Del'], 'Ripple delete (close the gap)'],
  [['Ctrl', 'Z'], 'Undo (works on agent changes too)'],
  [['Ctrl', 'Shift', 'Z'], 'Redo'],
  [['←', '→'], 'Previous / next frame'],
  [['Shift', '←/→'], 'Jump 1 second'],
  [['Alt', '←/→'], 'Nudge selected clips by one frame'],
  [['Home', 'End'], 'Go to start / end'],
  [['+', '−'], 'Zoom timeline in / out'],
  [['Ctrl', 'A'], 'Select all clips'],
  [['Esc'], 'Clear selection'],
  [['?'], 'Show this help'],
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts">
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map(([keys, label]) => (
              <tr key={label} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-4 whitespace-nowrap">
                  {keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="mx-0.5 text-muted">+</span>}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </td>
                <td className="py-1.5 text-muted">{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
