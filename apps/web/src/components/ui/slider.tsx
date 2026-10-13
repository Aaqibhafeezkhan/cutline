import * as SliderPrimitive from '@radix-ui/react-slider';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn('relative flex h-5 w-full touch-none select-none items-center', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-surface-2">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={props['aria-label']}
        className="block size-3.5 rounded-full border-2 border-primary bg-background shadow transition-colors focus-visible:outline-2 focus-visible:outline-ring"
      />
    </SliderPrimitive.Root>
  );
}
