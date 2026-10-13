import type { ShapeClip } from '@cutline/core';
import { num } from './expr';

function rgba(hex: string | null): [number, number, number, number] {
  if (!hex) return [0, 0, 0, 0];
  const h = hex.replace('#', '');
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/**
 * ffmpeg source chain that draws a shape once (rectangle / rounded rectangle
 * / ellipse, fill + inside stroke, anti-aliased via a signed distance field)
 * and repeats that frame for `duration` seconds. Size is in output pixels.
 */
export function shapeSource(
  clip: ShapeClip,
  sx: number,
  sy: number,
  fps: number,
  duration: number,
): { filter: string; width: number; height: number } {
  const w = Math.max(2, Math.round(clip.width * sx));
  const h = Math.max(2, Math.round(clip.height * sy));
  const r = Math.min(clip.cornerRadius * sx, w / 2, h / 2);
  const sw = Math.min(clip.strokeWidth * sx, w / 2, h / 2);
  const cx = '(X+0.5-W/2)';
  const cy = '(Y+0.5-H/2)';
  // d < 0 inside the shape, in pixels from the edge.
  const d =
    clip.shape === 'ellipse'
      ? `(hypot(${cx}/(W/2),${cy}/(H/2))-1)*min(W,H)/2`
      : `(hypot(max(abs(${cx})-(W/2-${num(r)}),0),max(abs(${cy})-(H/2-${num(r)}),0))+min(max(abs(${cx})-(W/2-${num(r)}),abs(${cy})-(H/2-${num(r)})),0)-${num(r)})`;
  const coverage = `clip(0.5-${d},0,1)`;
  const inStroke = sw > 0 ? `gt(${d},-${num(sw)})` : '0';
  const fill = rgba(clip.fill);
  const stroke = rgba(clip.strokeColor);
  const channel = (i: number) => `if(${inStroke},${stroke[i]},${fill[i]})`;
  const alpha = `${coverage}*if(${inStroke},${stroke[3]},${fill[3]})`;
  const frames = Math.max(1, Math.ceil(duration * fps)) + 1;
  const filter =
    `color=c=black@0:s=${w}x${h}:r=${num(fps)}:d=${num(1 / fps)},format=rgba,` +
    `geq=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}':a='${alpha}',` +
    `loop=loop=${frames}:size=1:start=0,setpts=N/(${num(fps)}*TB)`;
  return { filter, width: w, height: h };
}
