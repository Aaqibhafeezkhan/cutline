import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CutlineError,
  IdSchema,
  TimeSchema,
  clipEnd,
  clipSpeed,
  detectSilences,
  findAsset,
  isReversed,
  mapSourceRangeToTimeline,
  projectDuration,
  round3,
  sourceSpan,
  summarizeWaveform,
  timelineEnvelope,
  wordsToCues,
} from '@cutline/core';
import { guard, ok, type ToolContext } from '../context';
import { timelineWords } from './editing';

const projectId = IdSchema.optional().describe('Project id (default: active project)');
const assetId = IdSchema.optional().describe(
  'Analyse one source asset (source time) instead of the edited timeline (default: the timeline)',
);

export function registerPerceptionTools(server: McpServer, ctx: ToolContext): void {
  const { docs, analysis, renderer, ffmpeg, blobs } = ctx.services;

  server.registerTool(
    'get_transcript',
    {
      title: 'Get transcript',
      description:
        'Speech-to-text of the edited timeline (default) or of one asset, with timestamps in seconds. format "segments" (default) returns sentence-like lines with start/end; "words" adds word-level timings (use them to cut precisely, e.g. remove filler words with delete_range); "text" returns plain text. Uses local Whisper; results are cached per asset.',
      inputSchema: z.object({
        projectId,
        assetId,
        language: z
          .string()
          .min(2)
          .max(10)
          .optional()
          .describe('e.g. "en", "de" (default: auto-detect)'),
        format: z.enum(['segments', 'words', 'text']).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      let words;
      if (args.assetId) {
        const { project } = await docs.get(id);
        const asset = findAsset(project, args.assetId);
        const p = ctx.progress(extra, id, 'get_transcript');
        p.start(`Transcribing ${asset.name}…`);
        words = await analysis.transcript(asset, { language: args.language, signal: extra.signal });
        p.done('Transcription finished.');
      } else {
        words = await timelineWords(ctx, id, args.language, extra);
      }
      const format = args.format ?? 'segments';
      const text = words.map((w) => w.text).join(' ');
      const segments = wordsToCues(words, { maxChars: 80, maxDuration: 10 }).map((c) => ({
        start: c.start,
        end: c.end,
        text: c.text,
      }));
      const scope = args.assetId ? `asset ${args.assetId} (source time)` : 'timeline';
      return ok(`Transcript of the ${scope}: ${words.length} words.`, {
        projectId: id,
        scope: args.assetId ? 'asset' : 'timeline',
        text,
        ...(format !== 'text' && { segments }),
        ...(format === 'words' && { words }),
      });
    }),
  );

  server.registerTool(
    'get_frames',
    {
      title: 'Get frames',
      description:
        'Look at the video: returns JPEG thumbnails of the composited timeline (all layers, text and captions) at evenly spaced times between start and end, or at explicit times. With assetId, returns frames of that source file instead.',
      inputSchema: z.object({
        projectId,
        assetId,
        start: TimeSchema.optional().describe('Default 0'),
        end: TimeSchema.optional().describe('Default: end of timeline / asset'),
        count: z.number().int().min(1).max(24).optional().describe('Number of frames (default 6)'),
        times: z
          .array(TimeSchema)
          .max(24)
          .optional()
          .describe('Exact times instead of start/end/count'),
        width: z
          .number()
          .int()
          .min(64)
          .max(1280)
          .optional()
          .describe('Thumbnail width in px (default 320)'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra): Promise<CallToolResult> => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const width = args.width ?? 320;
      const asset = args.assetId ? findAsset(project, args.assetId) : null;
      const total = asset ? (asset.duration ?? 5) : projectDuration(project);
      if (total <= 0) {
        throw new CutlineError(
          'INVALID_OPERATION',
          'The timeline is empty; there is nothing to look at.',
          {
            hint: 'Add clips first, or pass an assetId to look at a source file.',
          },
        );
      }
      const start = Math.min(args.start ?? 0, total);
      const end = Math.min(args.end ?? total, total);
      const count = args.count ?? 6;
      const times = (
        args.times ??
        Array.from({ length: count }, (_, i) => start + ((end - start) * (i + 0.5)) / count)
      ).map((t) => round3(Math.min(Math.max(0, t), Math.max(0, total - 0.01))));
      const p = ctx.progress(extra, id, 'get_frames');
      p.start(`Looking at ${times.length} frame(s)…`);
      const images = asset
        ? await Promise.all(
            times.map(async (t) => ffmpeg.frameAt(await blobs.localPath(asset.src), t, width)),
          )
        : await renderer.frames(project, times, width);
      p.done(`Looked at ${times.length} frame(s).`);
      const content: CallToolResult['content'] = [
        {
          type: 'text',
          text: `${times.length} frame(s) of the ${asset ? `asset ${asset.id}` : 'timeline'} at ${times.map((t) => `${t}s`).join(', ')}.`,
        },
      ];
      images.forEach((img, i) => {
        content.push({ type: 'text', text: `t=${times[i]}s` });
        content.push({ type: 'image', data: img.toString('base64'), mimeType: 'image/jpeg' });
      });
      return { content, structuredContent: { projectId: id, times, width } };
    }),
  );

  server.registerTool(
    'detect_silence',
    {
      title: 'Detect silence',
      description:
        'Find pauses in the edited timeline audio (default) or in one asset. Returns silent ranges in seconds, already shrunk by `padding` so cuts keep a natural breath. To remove them, pass `ranges` straight to delete_range. Tune thresholdDb (-50 = only near-digital silence, -30 = also quiet room noise).',
      inputSchema: z.object({
        projectId,
        assetId,
        thresholdDb: z
          .number()
          .min(-90)
          .max(-10)
          .optional()
          .describe('RMS level counted as silence (default -40 dBFS)'),
        minDuration: z
          .number()
          .min(0.05)
          .max(60)
          .optional()
          .describe('Ignore shorter pauses (default 0.5s)'),
        padding: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe('Audio kept on each side (default 0.15s)'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const opts = {
        thresholdDb: args.thresholdDb ?? -40,
        minDuration: args.minDuration ?? 0.5,
        padding: args.padding ?? 0.15,
      };
      const p = ctx.progress(extra, id, 'detect_silence');
      p.start('Listening for silence…');
      if (args.assetId) {
        const asset = findAsset(project, args.assetId);
        const env = await analysis.envelope(asset, extra.signal);
        const ranges = detectSilences(env, opts);
        p.done(`Found ${ranges.length} silent range(s) in ${asset.name}.`);
        return ok(
          `Found ${ranges.length} silent range(s) in asset ${asset.id} (source time). "timeline" lists where those parts are used on the timeline.`,
          {
            projectId: id,
            scope: 'asset',
            ...opts,
            ranges: ranges.map((r) => ({ start: r.start, end: r.end })),
            timeline: ranges.flatMap((r) => mapSourceRangeToTimeline(project, asset.id, r)),
          },
        );
      }
      const duration = projectDuration(project);
      const env = timelineEnvelope(
        project,
        await analysis.envelopes(project, extra.signal),
        0.01,
        duration,
      );
      const ranges = detectSilences(env, opts);
      const total = round3(ranges.reduce((s, r) => s + r.end - r.start, 0));
      p.done(`Found ${ranges.length} silent range(s), ${total}s in total.`);
      return ok(
        ranges.length
          ? `Found ${ranges.length} silent range(s) totalling ${total}s in a ${round3(duration)}s timeline. Remove them with delete_range({ ranges }).`
          : `No silences longer than ${opts.minDuration}s below ${opts.thresholdDb} dBFS.`,
        {
          projectId: id,
          scope: 'timeline',
          ...opts,
          timelineDuration: round3(duration),
          totalSilence: total,
          ranges,
        },
      );
    }),
  );

  server.registerTool(
    'detect_scenes',
    {
      title: 'Detect scenes',
      description:
        'Find shot changes (visual cuts) in the timeline video (default) or in one asset. Returns cut times in seconds; for the timeline, also the clip boundaries (edits that already exist).',
      inputSchema: z.object({
        projectId,
        assetId,
        threshold: z
          .number()
          .min(0.05)
          .max(0.9)
          .optional()
          .describe('Scene change sensitivity, lower = more cuts (default 0.3)'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const threshold = args.threshold ?? 0.3;
      const p = ctx.progress(extra, id, 'detect_scenes');
      p.start('Looking for scene changes…');
      if (args.assetId) {
        const asset = findAsset(project, args.assetId);
        const cuts = (await analysis.scenes(asset, threshold, extra.signal)).map(round3);
        p.done(`Found ${cuts.length} scene change(s).`);
        return ok(`Found ${cuts.length} scene change(s) in asset ${asset.id} (source time).`, {
          projectId: id,
          scope: 'asset',
          threshold,
          scenes: cuts,
        });
      }
      const scenes: Array<{ time: number; clipId: string; sourceTime: number }> = [];
      const edits = new Set<number>();
      for (const track of project.tracks) {
        if (track.kind !== 'video' || track.hidden) continue;
        for (const clip of track.clips) {
          if (clip.type !== 'video') continue;
          edits.add(round3(clip.start));
          edits.add(round3(clipEnd(clip)));
          const asset = project.assets.find((a) => a.id === clip.assetId);
          if (!asset) continue;
          for (const s of await analysis.scenes(asset, threshold, extra.signal)) {
            if (s > clip.sourceStart + 0.05 && s < clip.sourceStart + sourceSpan(clip) - 0.05) {
              const offset = (s - clip.sourceStart) / clipSpeed(clip);
              scenes.push({
                time: round3(clip.start + (isReversed(clip) ? clip.duration - offset : offset)),
                clipId: clip.id,
                sourceTime: round3(s),
              });
            }
          }
        }
      }
      scenes.sort((a, b) => a.time - b.time);
      p.done(`Found ${scenes.length} scene change(s).`);
      return ok(
        `Found ${scenes.length} scene change(s) inside clips, plus ${edits.size} clip boundaries.`,
        {
          projectId: id,
          scope: 'timeline',
          threshold,
          scenes,
          clipBoundaries: [...edits].sort((a, b) => a - b),
        },
      );
    }),
  );

  server.registerTool(
    'get_waveform_summary',
    {
      title: 'Get waveform summary',
      description:
        'Loudness overview of the timeline audio (default) or one asset: overall peak/RMS in dBFS and per-bucket levels, plus the loudest and quietest parts. Useful to spot music, speech, silence or clipping without listening.',
      inputSchema: z.object({
        projectId,
        assetId,
        buckets: z
          .number()
          .int()
          .min(4)
          .max(200)
          .optional()
          .describe('Number of time buckets (default 40)'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const env = args.assetId
        ? await analysis.envelope(findAsset(project, args.assetId), extra.signal)
        : timelineEnvelope(
            project,
            await analysis.envelopes(project, extra.signal),
            0.01,
            projectDuration(project),
          );
      const summary = summarizeWaveform(env, args.buckets ?? 40);
      return ok(
        `Audio of the ${args.assetId ? `asset ${args.assetId}` : 'timeline'}: ${summary.duration}s, peak ${summary.peakDb} dBFS, RMS ${summary.rmsDb} dBFS.`,
        { projectId: id, scope: args.assetId ? 'asset' : 'timeline', ...summary },
      );
    }),
  );
}
