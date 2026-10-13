import {
  Circle,
  Heading1,
  LayoutPanelTop,
  MessageSquareQuote,
  Plus,
  Square,
  SquareUser,
  Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { addShape, addTemplate, addText } from './commands';

/** "Add" menu: text, graphics templates and shapes, inserted at the playhead. */
export function AddMenu() {
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
        <DropdownMenuItem icon={<Heading1 />} onSelect={() => void addTemplate('title')}>
          Title
        </DropdownMenuItem>
        <DropdownMenuItem icon={<SquareUser />} onSelect={() => void addTemplate('lower-third')}>
          Lower third
        </DropdownMenuItem>
        <DropdownMenuItem icon={<LayoutPanelTop />} onSelect={() => void addTemplate('banner')}>
          Banner
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<MessageSquareQuote />}
          onSelect={() => void addTemplate('callout')}
        >
          Callout
        </DropdownMenuItem>
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
