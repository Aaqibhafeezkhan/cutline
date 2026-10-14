import { useState } from 'react';
import {
  MAX_SPEED,
  MIN_SPEED,
  clipSpeed,
  isFreeze,
  isReversed,
  type AudioClip,
  type OperationInput,
  type VideoClip,
} from '@cutline/core';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { Field, NumberField, Section } from './fields';

const PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

/** Playback speed and direction of a video/audio clip (dispatches set_speed). */
export function SpeedSection({
  clip,
  run,
}: {
  clip: VideoClip | AudioClip;
  run: (ops: OperationInput[]) => void;
}) {
  // Push later clips when the clip gets longer/shorter (what editors usually do).
  const [ripple, setRipple] = useState(true);
  if (isFreeze(clip)) {
    return (
      <Section title="Speed">
        <p className="text-xs text-muted">
          Freeze frame: holds the source frame at {clip.sourceStart.toFixed(2)}s (silent). Change
          its length with Duration.
        </p>
      </Section>
    );
  }
  const speed = clipSpeed(clip);
  const setSpeed = (next: number) =>
    run([{ type: 'set_speed', clipId: clip.id, speed: next, ripple }]);
  return (
    <Section title="Speed">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Speed presets">
        {PRESETS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={Math.abs(p - speed) < 1e-9 ? 'default' : 'secondary'}
            aria-pressed={Math.abs(p - speed) < 1e-9}
            className={cn('h-6 px-2 tabular-nums')}
            onClick={() => setSpeed(p)}
          >
            {p}×
          </Button>
        ))}
      </div>
      <NumberField
        label="Custom"
        suffix="×"
        min={MIN_SPEED}
        max={MAX_SPEED}
        step={0.05}
        value={speed}
        onCommit={setSpeed}
      />
      <Field label="Reverse">
        <Switch
          aria-label="Play backwards"
          checked={isReversed(clip)}
          onCheckedChange={(reverse) => run([{ type: 'set_speed', clipId: clip.id, reverse }])}
        />
      </Field>
      <Field label="Ripple">
        <Switch
          aria-label="Move later clips when the speed changes the length"
          checked={ripple}
          onCheckedChange={setRipple}
        />
      </Field>
      {speed !== 1 && (
        <p className="text-[11px] text-muted">
          Preview audio changes pitch with the speed; server exports keep the pitch.
        </p>
      )}
    </Section>
  );
}
