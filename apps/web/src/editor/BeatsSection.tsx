import { AudioWaveform } from 'lucide-react';
import type { AudioClip, VideoClip } from '@cutline/core';
import { Button } from '@/components/ui/button';
import { useBeats } from '@/lib/beats';
import { useEditor } from '@/lib/store';
import { beatTimes } from './timeline/geometry';
import { Field, Section } from './fields';

/** Tempo of the clip's music and a button to detect it; beats then show on the timeline. */
export function BeatsSection({ clip }: { clip: AudioClip | VideoClip }) {
  const projectId = useEditor((s) => s.projectId);
  const hasAudio = useEditor(
    (s) => s.project?.assets.find((a) => a.id === clip.assetId)?.hasAudio ?? false,
  );
  const info = useBeats((s) => s.byAsset[clip.assetId]);
  const busy = useBeats((s) => s.busy[clip.assetId] ?? false);
  if (!projectId || !hasAudio) return null;
  return (
    <Section title="Beats">
      {info ? (
        <Field label="Tempo">
          <span className="text-xs tabular-nums text-muted">
            {info.bpm > 0
              ? `${info.bpm} BPM · ${beatTimes(clip, info.beats).length} beats in clip`
              : 'No steady beat'}
          </span>
        </Field>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void useBeats.getState().detect(projectId, clip.assetId)}
        >
          <AudioWaveform />
          {busy ? 'Detecting beats…' : 'Detect beats'}
        </Button>
      )}
    </Section>
  );
}
