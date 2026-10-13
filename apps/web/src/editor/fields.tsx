import { useEffect, useId, useState, type ReactNode } from 'react';
import { Input, Label } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';

export function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** Numeric input that commits on Enter/blur (one undo step per change). */
export function NumberField({
  label,
  value,
  onCommit,
  step = 0.1,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (Math.abs(clamped - value) > 1e-9) onCommit(clamped);
    else setDraft(String(value));
  };
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          type="number"
          step={step}
          min={min}
          max={max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="h-7 tabular-nums"
        />
        {suffix && <span className="text-xs text-muted">{suffix}</span>}
      </div>
    </Field>
  );
}

/** Slider showing live values while dragging; commits once on release. */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  format = (v) => v.toFixed(2),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  format?: (v: number) => string;
}) {
  const [live, setLive] = useState(value);
  useEffect(() => setLive(value), [value]);
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Slider
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={[live]}
          onValueChange={([v]) => setLive(v!)}
          onValueCommit={([v]) => v !== value && onCommit(v!)}
        />
        <span className="w-10 text-right text-[11px] tabular-nums text-muted">{format(live)}</span>
      </div>
    </Field>
  );
}

export function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        type="color"
        value={value.slice(0, 7)}
        onChange={(e) => onCommit(e.target.value)}
        className="h-7 w-full cursor-pointer rounded border border-border bg-background"
      />
    </Field>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border px-3 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}
