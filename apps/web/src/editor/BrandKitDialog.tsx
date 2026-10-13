import { useId } from 'react';
import { ImagePlus, RotateCcw, X } from 'lucide-react';
import {
  BRAND_COLOR_KEYS,
  LOGO_POSITIONS,
  type BrandColorKey,
  type OperationInput,
} from '@cutline/core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/misc';
import { useEditor } from '@/lib/store';
import { addTemplate } from './commands';
import { Field } from './fields';
import { FONT_FAMILIES } from './fonts';

const COLOR_LABELS: Record<BrandColorKey, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  accent: 'Accent',
  text: 'Text',
  background: 'Background',
};

const COLOR_HINTS: Record<BrandColorKey, string> = {
  primary: 'Template bars, new shape fills',
  secondary: 'Second brand color',
  accent: 'Accent lines and outlines',
  text: 'Default color of new text',
  background: 'Branded backdrops',
};

const POSITION_LABELS: Record<(typeof LOGO_POSITIONS)[number], string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};

const NONE = '__none';

function BrandColorField({
  name,
  value,
  onChange,
}: {
  name: BrandColorKey;
  value: string | undefined;
  onChange: (v: string | null) => void;
}) {
  const id = useId();
  return (
    <Field label={COLOR_LABELS[name]} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={(value ?? '#808080').slice(0, 7)}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-12 shrink-0 cursor-pointer rounded border border-border bg-background"
          aria-describedby={`${id}-hint`}
        />
        <span id={`${id}-hint`} className="min-w-0 flex-1 truncate text-xs text-muted">
          {value ? <span className="font-mono text-foreground">{value}</span> : 'not set'} ·{' '}
          {COLOR_HINTS[name]}
        </span>
        {value && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Clear ${COLOR_LABELS[name].toLowerCase()} color`}
            onClick={() => onChange(null)}
          >
            <X />
          </Button>
        )}
      </div>
    </Field>
  );
}

/** Font options: the generic families plus a custom family an agent may have set. */
function fontOptions(current: string | undefined) {
  const options = [{ value: NONE, label: 'Default' }, ...FONT_FAMILIES];
  if (current && !FONT_FAMILIES.some((f) => f.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

/** Project brand kit: colors, fonts and logo used by templates and new overlays. */
export function BrandKitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const project = useEditor((s) => s.project);
  const dispatch = useEditor((s) => s.dispatch);
  if (!project) return null;
  const brand = project.settings.brand;
  const images = project.assets.filter((a) => a.kind === 'image');
  const set = (patch: Omit<Extract<OperationInput, { type: 'set_brand' }>, 'type'>) =>
    void dispatch([{ type: 'set_brand', ...patch }], 'Edit brand kit');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Brand kit"
        description="Define colors, fonts and a logo once. Templates and new text and shapes use them automatically, for you and for connected agents."
      >
        <div className="space-y-5">
          <section className="space-y-2" aria-label="Brand colors">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Colors</h3>
            {BRAND_COLOR_KEYS.map((key) => (
              <BrandColorField
                key={key}
                name={key}
                value={brand?.colors[key]}
                onChange={(v) => set({ colors: { [key]: v } })}
              />
            ))}
          </section>

          <section className="space-y-2" aria-label="Brand fonts">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Fonts</h3>
            <Field label="Body">
              <Select
                label="Body font"
                value={brand?.fontFamily ?? NONE}
                options={fontOptions(brand?.fontFamily)}
                onValueChange={(v) => set({ fontFamily: v === NONE ? null : v })}
              />
            </Field>
            <Field label="Headings">
              <Select
                label="Heading font"
                value={brand?.headingFontFamily ?? NONE}
                options={fontOptions(brand?.headingFontFamily).map((o) =>
                  o.value === NONE ? { ...o, label: 'Same as body' } : o,
                )}
                onValueChange={(v) => set({ headingFontFamily: v === NONE ? null : v })}
              />
            </Field>
          </section>

          <section className="space-y-2" aria-label="Brand logo">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Logo</h3>
            <Field label="Image">
              <Select
                label="Logo image"
                value={brand?.logoAssetId ?? NONE}
                options={[
                  { value: NONE, label: images.length ? 'No logo' : 'Import an image first' },
                  ...images.map((a) => ({ value: a.id, label: a.name })),
                ]}
                onValueChange={(v) => set({ logoAssetId: v === NONE ? null : v })}
              />
            </Field>
            <Field label="Position">
              <Select
                label="Logo position"
                value={brand?.logoPosition ?? 'top-right'}
                options={LOGO_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }))}
                onValueChange={(v) => set({ logoPosition: v as (typeof LOGO_POSITIONS)[number] })}
              />
            </Field>
          </section>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={!brand}
              onClick={() => set({ reset: true })}
            >
              <RotateCcw /> Reset
            </Button>
            <Button
              size="sm"
              disabled={!brand?.logoAssetId}
              onClick={() => {
                void addTemplate('logo');
                onOpenChange(false);
              }}
            >
              <ImagePlus /> Add logo to video
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
