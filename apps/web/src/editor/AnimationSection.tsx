import {
  ANIMATION_PRESETS,
  type Animation,
  type AnimationPreset,
  type OperationInput,
  type VisualClip,
} from '@cutline/core';
import { Select } from '@/components/ui/misc';
import { Field, NumberField, Section } from './fields';

const LABELS: Record<AnimationPreset, string> = {
  fade: 'Fade',
  'slide-left': 'Slide left',
  'slide-right': 'Slide right',
  'slide-up': 'Slide up',
  'slide-down': 'Slide down',
  zoom: 'Zoom',
  pop: 'Pop',
};

const OPTIONS = [
  { value: 'none', label: 'None' },
  ...ANIMATION_PRESETS.map((p) => ({ value: p, label: LABELS[p] })),
];

const DEFAULT_DURATION = 0.5;

/** Entrance/exit animation presets of a visual clip (dispatches set_animation). */
export function AnimationSection({
  clip,
  run,
}: {
  clip: VisualClip;
  run: (ops: OperationInput[]) => void;
}) {
  const edges = [
    { edge: 'in', label: 'In', current: clip.animationIn, other: clip.animationOut },
    { edge: 'out', label: 'Out', current: clip.animationOut, other: clip.animationIn },
  ] as const;
  const apply = (edge: 'in' | 'out', value: Animation | null) =>
    run([
      {
        type: 'set_animation',
        clipId: clip.id,
        ...(edge === 'in' ? { in: value } : { out: value }),
      },
    ]);

  return (
    <Section title="Animation">
      {edges.map(({ edge, label, current, other }) => {
        // Room left next to the other edge's animation (the operation enforces it).
        const room = clip.duration - (other?.duration ?? 0);
        return (
          <div key={edge} className="space-y-2">
            <Field label={label}>
              <Select
                label={`${label} animation`}
                value={current?.preset ?? 'none'}
                onValueChange={(v) =>
                  apply(
                    edge,
                    v === 'none'
                      ? null
                      : {
                          preset: v as AnimationPreset,
                          duration:
                            current?.duration ?? Math.min(DEFAULT_DURATION, Math.max(0.05, room)),
                        },
                  )
                }
                options={OPTIONS}
              />
            </Field>
            {current && (
              <NumberField
                label={`${label} duration`}
                suffix="s"
                min={0.05}
                max={Math.min(10, room)}
                step={0.1}
                value={current.duration}
                onCommit={(duration) => apply(edge, { preset: current.preset, duration })}
              />
            )}
          </div>
        );
      })}
    </Section>
  );
}
