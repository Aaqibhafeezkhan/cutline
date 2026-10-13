import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const field =
  'w-full rounded-md border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted/60 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'min-h-16 py-1.5', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root className={cn('text-xs font-medium text-muted', className)} {...props} />
  );
}
