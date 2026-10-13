import type { ReactNode } from 'react';
import {
  Circle,
  Heading1,
  ImageIcon,
  LayoutPanelTop,
  MessageSquareQuote,
  Plus,
  Square,
  SquareUser,
  Type,
} from 'lucide-react';
import { templateColors, type TemplateKind } from '@cutline/core';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { useEditor } from '@/lib/store';
import { addShape, addTemplate, addText } from './commands';

const TEMPLATES: Array<{ kind: TemplateKind; label: string; icon: ReactNode }> = [
  { kind: 'title', label: 'Title', icon: <Heading1 /> },
  { kind: 'lower-third', label: 'Lower third', icon: <SquareUser /> },
  { kind: 'banner', label: 'Banner', icon: <LayoutPanelTop /> },
  { kind: 'callout', label: 'Callout', icon: <MessageSquareQuote /> },
];

/** Accent and text color a template will use (brand kit aware), as a tiny preview. */
function Swatch({ accent, text }: { accent: string; text: string }) {
  return (
    <span
      aria-hidden
      className="flex h-3.5 w-6 items-center justify-center rounded-sm text-[8px] font-bold leading-none"
      style={{ backgroundColor: accent, color: text }}
    >
      Aa
    </span>
  );
}

/** "Add" menu: text, graphics templates and shapes, inserted at the playhead. */
export function AddMenu() {
  const brand = useEditor((s) => s.project?.settings.brand);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" aria-label="Add text, graphics or shapes">
          <Plus /> Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem icon={<Type />} shortcut="T" onSelect={() => void addText()}>
          Text
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Templates</DropdownMenuLabel>
        {TEMPLATES.map(({ kind, label, icon }) => (
          <DropdownMenuItem key={kind} icon={icon} onSelect={() => void addTemplate(kind)}>
            <span className="flex items-center justify-between gap-3">
              {label}
              {brand && <Swatch {...templateColors(kind, { brand })} />}
            </span>
          </DropdownMenuItem>
        ))}
        {brand?.logoAssetId && (
          <DropdownMenuItem icon={<ImageIcon />} onSelect={() => void addTemplate('logo')}>
            Logo
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Shapes</DropdownMenuLabel>
        <DropdownMenuItem icon={<Square />} onSelect={() => void addShape('rectangle')}>
          Rectangle
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Circle />} onSelect={() => void addShape('ellipse')}>
          Ellipse
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
