import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={6}
        align="start"
        className={cn(
          'z-50 min-w-48 rounded-md border border-border bg-surface-2 p-1 text-sm shadow-xl',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  icon,
  shortcut,
  children,
  className,
  ...props
}: ComponentProps<typeof Menu.Item> & { icon?: ReactNode; shortcut?: string }) {
  return (
    <Menu.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface [&_svg]:size-4 [&_svg]:text-muted',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[11px] text-muted">{shortcut}</span>}
    </Menu.Item>
  );
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <Menu.Label className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
      {children}
    </Menu.Label>
  );
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-border" />;
}
