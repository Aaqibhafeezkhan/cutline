import { useEffect, useState } from 'react';
import {
  clipEnd,
  type Clip,
  type ClipPropsPatch,
  type OperationInput,
  type ShapeClip,
  type TextClip,
} from '@cutline/core';
import { Textarea } from '@/components/ui/input';
import { Select, Switch } from '@/components/ui/misc';
import { useEditor } from '@/lib/store';
import { ColorField, Field, NumberField, Section, SliderField } from './fields';

/** Generic families: the server renderer maps them to matching font files. */
const FONT_FAMILIES = [
  { value: 'sans-serif', label: 'Sans serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
];

function findClip(id: string | undefined) {
  const project = useEditor.getState().project;
  if (!id || !project) return null;
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { clip, track };
  }
  return null;
}

export function Properties() {
  const selection = useEditor((s) => s.selection);
  // Re-render when the project changes (values come from the live document).
  useEditor((s) => s.project);
  const dispatch = useEditor((s) => s.dispatch);
  const found = findClip(selection.length === 1 ? selection[0] : undefined);

  if (selection.length > 1) {
    return <Empty text={`${selection.length} clips selected. Press S to split, Del to delete.`} />;
  }
  if (!found) {
    return <Empty text="Select a clip on the timeline to edit its properties." />;
  }
  const { clip, track } = found;
  const run = (ops: OperationInput[]) => void dispatch(ops);
  const set = (props: ClipPropsPatch) => run([{ type: 'set_clip_props', clipId: clip.id, props }]);
  const disabled = track.locked;

  return (
    <div
      className={disabled ? 'pointer-events-none opacity-50' : undefined}
      aria-disabled={disabled}
    >
      <Section title={`${clip.type} clip`}>
        <NumberField
          label="Start"
          suffix="s"
          min={0}
          value={clip.start}
          onCommit={(start) => run([{ type: 'move_clip', clipId: clip.id, start }])}
        />
        <NumberField
          label="Duration"
          suffix="s"
          min={0.04}
          value={clip.duration}
          onCommit={(d) => run([{ type: 'trim_clip', clipId: clip.id, end: clip.start + d }])}
        />
        {'sourceStart' in clip && (
          <Field label="Source">
            <span className="text-xs tabular-nums text-muted">
              {clip.sourceStart.toFixed(2)}s – {(clip.sourceStart + clip.duration).toFixed(2)}s
            </span>
          </Field>
        )}
        <Field label="End">
          <span className="text-xs tabular-nums text-muted">{clipEnd(clip).toFixed(2)}s</span>
        </Field>
      </Section>

      {(clip.type === 'text' || clip.type === 'caption') && <TextSection clip={clip} set={set} />}
      {clip.type === 'shape' && <ShapeSection clip={clip} set={set} />}
      {(clip.type === 'video' ||
        clip.type === 'image' ||
        clip.type === 'text' ||
        clip.type === 'shape') && <VisualSection clip={clip} set={set} run={run} />}
      {(clip.type === 'video' || clip.type === 'audio') && (
        <Section title="Audio">
          <SliderField
            label="Volume"
            min={0}
            max={2}
            step={0.01}
            value={clip.volume}
            onCommit={(volume) => set({ volume })}
          />
          <Field label="Muted">
            <Switch
              checked={clip.muted}
              onCheckedChange={(muted) => set({ muted })}
              aria-label="Mute clip"
            />
          </Field>
        </Section>
      )}
      {clip.type !== 'caption' && (
        <Section title="Fades">
          <NumberField
            label="Fade in"
            suffix="s"
            min={0}
            max={60}
            value={clip.fadeIn}
            onCommit={(fadeIn) => set({ fadeIn })}
          />
          <NumberField
            label="Fade out"
            suffix="s"
            min={0}
            max={60}
            value={clip.fadeOut}
            onCommit={(fadeOut) => set({ fadeOut })}
          />
        </Section>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-sm text-muted">{text}</p>;
}

function ShapeSection({ clip, set }: { clip: ShapeClip; set: (p: ClipPropsPatch) => void }) {
  return (
    <Section title="Shape">
      <Field label="Shape">
        <Select
          label="Shape"
          value={clip.shape}
          onValueChange={(v) => set({ shape: v as ShapeClip['shape'] })}
          options={[
            { value: 'rectangle', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
          ]}
        />
      </Field>
      <NumberField
        label="Width"
        suffix="px"
        min={1}
        step={10}
        value={clip.width}
        onCommit={(width) => set({ width })}
      />
      <NumberField
        label="Height"
        suffix="px"
        min={1}
        step={10}
        value={clip.height}
        onCommit={(height) => set({ height })}
      />
      {clip.shape === 'rectangle' && (
        <NumberField
          label="Corners"
          suffix="px"
          min={0}
          step={2}
          value={clip.cornerRadius}
          onCommit={(cornerRadius) => set({ cornerRadius })}
        />
      )}
      <Field label="Fill">
        <div className="flex items-center gap-2">
          <Switch
            aria-label="Fill"
            checked={clip.fill !== null}
            onCheckedChange={(on) => set({ fill: on ? '#ffffff' : null })}
          />
          {clip.fill && (
            <input
              type="color"
              aria-label="Fill color"
              value={clip.fill.slice(0, 7)}
              onChange={(e) => set({ fill: e.target.value + (clip.fill!.slice(7) || '') })}
              className="h-6 w-10 rounded border border-border bg-background"
            />
          )}
        </div>
      </Field>
      <NumberField
        label="Outline"
        suffix="px"
        min={0}
        max={500}
        step={1}
        value={clip.strokeWidth}
        onCommit={(strokeWidth) => set({ strokeWidth })}
      />
      {clip.strokeWidth > 0 && (
        <ColorField
          label="Outline color"
          value={clip.strokeColor}
          onCommit={(strokeColor) => set({ strokeColor })}
        />
      )}
    </Section>
  );
}

function TextSection({
  clip,
  set,
}: {
  clip: TextClip | Extract<Clip, { type: 'caption' }>;
  set: (p: ClipPropsPatch) => void;
}) {
  const [text, setText] = useState(clip.text);
  useEffect(() => setText(clip.text), [clip.text]);
  return (
    <Section title="Text">
      <Textarea
        aria-label="Text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && text !== clip.text && set({ text })}
      />
      {clip.type === 'text' && (
        <>
          <NumberField
            label="Font size"
            min={4}
            max={1000}
            step={1}
            value={clip.style.fontSize}
            onCommit={(fontSize) => set({ style: { fontSize } })}
          />
          <ColorField
            label="Color"
            value={clip.style.color}
            onCommit={(color) => set({ style: { color } })}
          />
          <Field label="Background">
            <div className="flex items-center gap-2">
              <Switch
                aria-label="Text background"
                checked={clip.style.backgroundColor !== null}
                onCheckedChange={(on) =>
                  set({ style: { backgroundColor: on ? '#000000b3' : null } })
                }
              />
              {clip.style.backgroundColor && (
                <input
                  type="color"
                  aria-label="Background color"
                  value={clip.style.backgroundColor.slice(0, 7)}
                  onChange={(e) => set({ style: { backgroundColor: `${e.target.value}b3` } })}
                  className="h-6 w-10 rounded border border-border bg-background"
                />
              )}
            </div>
          </Field>
          <Field label="Font">
            <Select
              label="Font family"
              value={
                FONT_FAMILIES.some((f) => f.value === clip.style.fontFamily)
                  ? clip.style.fontFamily
                  : 'sans-serif'
              }
              onValueChange={(fontFamily) => set({ style: { fontFamily } })}
              options={FONT_FAMILIES}
            />
          </Field>
          <Field label="Bold">
            <Switch
              aria-label="Bold"
              checked={clip.style.bold}
              onCheckedChange={(bold) => set({ style: { bold } })}
            />
          </Field>
          <Field label="Italic">
            <Switch
              aria-label="Italic"
              checked={clip.style.italic}
              onCheckedChange={(italic) => set({ style: { italic } })}
            />
          </Field>
          <NumberField
            label="Outline"
            suffix="px"
            min={0}
            max={50}
            step={1}
            value={clip.style.strokeWidth}
            onCommit={(strokeWidth) => set({ style: { strokeWidth } })}
          />
          {clip.style.strokeWidth > 0 && (
            <ColorField
              label="Outline color"
              value={clip.style.strokeColor}
              onCommit={(strokeColor) => set({ style: { strokeColor } })}
            />
          )}
          <Field label="Align">
            <Select
              label="Text alignment"
              value={clip.style.align}
              onValueChange={(v) => set({ style: { align: v as 'left' | 'center' | 'right' } })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
            />
          </Field>
        </>
      )}
    </Section>
  );
}

function VisualSection({
  clip,
  set,
  run,
}: {
  clip: Extract<Clip, { type: 'video' | 'image' | 'text' | 'shape' }>;
  set: (p: ClipPropsPatch) => void;
  run: (ops: OperationInput[]) => void;
}) {
  const t = clip.transform;
  const fx = clip.effects;
  return (
    <>
      <Section title="Transform">
        <NumberField
          label="X"
          step={10}
          value={t.x}
          suffix="px"
          onCommit={(x) => set({ transform: { x } })}
        />
        <NumberField
          label="Y"
          step={10}
          value={t.y}
          suffix="px"
          onCommit={(y) => set({ transform: { y } })}
        />
        <SliderField
          label="Scale"
          min={0.05}
          max={4}
          step={0.01}
          value={t.scale}
          onCommit={(scale) => set({ transform: { scale } })}
        />
        <SliderField
          label="Rotation"
          min={-180}
          max={180}
          step={1}
          value={t.rotation}
          format={(v) => `${v.toFixed(0)}°`}
          onCommit={(rotation) => set({ transform: { rotation } })}
        />
        <SliderField
          label="Opacity"
          min={0}
          max={1}
          step={0.01}
          value={t.opacity}
          onCommit={(opacity) => set({ transform: { opacity } })}
        />
      </Section>
      <Section title="Effects">
        <SliderField
          label="Brightness"
          min={-1}
          max={1}
          step={0.01}
          value={fx.brightness ?? 0}
          onCommit={(v) => set({ effects: { brightness: v === 0 ? null : v } })}
        />
        <SliderField
          label="Contrast"
          min={-1}
          max={1}
          step={0.01}
          value={fx.contrast ?? 0}
          onCommit={(v) => set({ effects: { contrast: v === 0 ? null : v } })}
        />
        <SliderField
          label="Saturation"
          min={-1}
          max={1}
          step={0.01}
          value={fx.saturation ?? 0}
          onCommit={(v) => set({ effects: { saturation: v === 0 ? null : v } })}
        />
        <SliderField
          label="Blur"
          min={0}
          max={30}
          step={0.5}
          value={fx.blur ?? 0}
          format={(v) => `${v}px`}
          onCommit={(v) => set({ effects: { blur: v === 0 ? null : v } })}
        />
      </Section>
      <Section title="Transition in">
        <Field label="Type">
          <Select
            label="Transition type"
            value={clip.transitionIn?.type ?? 'none'}
            onValueChange={(type) =>
              run([
                {
                  type: 'set_transition',
                  clipId: clip.id,
                  transition:
                    type === 'none'
                      ? null
                      : {
                          type: type as 'crossfade' | 'dipToBlack',
                          duration: clip.transitionIn?.duration ?? 1,
                        },
                },
              ])
            }
            options={[
              { value: 'none', label: 'None' },
              { value: 'crossfade', label: 'Crossfade' },
              { value: 'dipToBlack', label: 'Dip to black' },
            ]}
          />
        </Field>
        {clip.transitionIn && (
          <NumberField
            label="Duration"
            suffix="s"
            min={0.05}
            max={10}
            value={clip.transitionIn.duration}
            onCommit={(duration) =>
              run([
                {
                  type: 'set_transition',
                  clipId: clip.id,
                  transition: { type: clip.transitionIn!.type, duration },
                },
              ])
            }
          />
        )}
      </Section>
    </>
  );
}
