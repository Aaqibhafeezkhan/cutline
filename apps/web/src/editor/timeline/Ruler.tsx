import { useMemo, type PointerEvent } from 'react';
import { usePlayhead } from '@/lib/store';
import { RULER_HEIGHT, rulerLabel, tickStep } from './geometry';
import { MarkerLane } from './Markers';

export function Ruler({
  width,
  zoom,
  onSeek,
}: {
  width: number;
  zoom: number;
  onSeek: (clientX: number) => void;
}) {
  const step = tickStep(zoom);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t * zoom <= width; t += step) out.push(Number(t.toFixed(3)));
    return out;
  }, [width, zoom, step]);
  const time = usePlayhead((s) => s.time);

  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onSeek(e.clientX);
  };

  return (
    <div
      role="slider"
      aria-label="Playhead position"
      aria-valuemin={0}
      aria-valuenow={Number(time.toFixed(2))}
      aria-valuetext={`${time.toFixed(2)} seconds`}
      className="relative shrink-0 cursor-ew-resize select-none border-b border-border bg-surface"
      style={{ width, height: RULER_HEIGHT }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onSeek(e.clientX);
      }}
      onPointerMove={scrub}
    >
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 h-full" style={{ left: t * zoom }}>
          <div className="h-2 w-px bg-border" />
          <span className="absolute left-1 top-1.5 text-[10px] tabular-nums text-muted">
            {rulerLabel(t, step)}
          </span>
          <div
            className="absolute top-0 h-1 w-px bg-border/60"
            style={{ left: (step * zoom) / 2 }}
          />
        </div>
      ))}
      <MarkerLane zoom={zoom} />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 size-0 -translate-x-[5px] border-x-[5px] border-b-[8px] border-x-transparent border-b-red-500"
        style={{ left: time * zoom }}
      />
    </div>
  );
}
