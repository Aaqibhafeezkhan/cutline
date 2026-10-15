import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ChapterInputSchema,
  ColorSchema,
  CutlineError,
  IdSchema,
  ReelRangeSchema,
  chapterList,
  detectSilences,
  ffmetadataChapters,
  groupIntoBlocks,
  loudnessPeaks,
  projectDuration,
  round3,
  summarizeWaveform,
  timelineEnvelope,
  wordsToCues,
  youtubeChapterText,
  youtubeChapterWarnings,
  type Project,
  type ProjectSettings,
  type Word,
} from '@cutline/core';
import { editPayload, guard, ok, type ToolContext } from '../context';
import { timelineWords } from './editing';
import { timelineScenes } from './perception';

const projectId = IdSchema.optional().describe(
  'Project id. Omit to use the project you created or used most recently.',
);

const MAX_LIST = 100;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output size for an aspect preset, keeping the project's long edge. */
export function aspectSize(
  settings: Pick<ProjectSettings, 'width' | 'height'>,
  aspect: '16:9' | '9:16' | '1:1',
): { width: number; height: number } {
  const base = Math.min(4320, Math.max(settings.width, settings.height));
  if (aspect === '1:1') return { width: base, height: base };
  const short = even((base * 9) / 16);
  return aspect === '9:16' ? { width: short, height: base } : { width: base, height: short };
}

function highlightRanges(project: Project) {
  return (project.markers ?? [])
    .filter((m) => m.kind === 'highlight' && m.end !== undefined)
    .map((m) => ({ start: m.time, end: m.end!, ...(m.label && { label: m.label }) }));
}

export function registerChapterTools(server: McpServer, ctx: ToolContext): void {
  const { docs, analysis } = ctx.services;

  server.registerTool(
    'get_chapters_input',
    {
      title: 'Get chapters input',
      description:
        'One-call outline of the edited timeline for choosing chapters and highlights: transcript sentences grouped into ~20–60 s blocks (timeline seconds), scene cuts, silences (≥ 1 s), the loudest moments, and the existing chapters/highlights. Read it, decide the structure yourself, then call set_chapters, mark_highlights or create_highlight_reel.',
      inputSchema: z.object({
        projectId,
        language: z.string().min(2).max(10).optional().describe('e.g. "en" (default: auto)'),
        minBlock: z
          .number()
          .min(5)
          .max(300)
          .optional()
          .describe('Shortest block in seconds (default 20)'),
        maxBlock: z
          .number()
          .min(10)
          .max(600)
          .optional()
          .describe('Longest block in seconds (default 60)'),
        sceneThreshold: z
          .number()
          .min(0.05)
          .max(0.9)
          .optional()
          .describe('Scene change sensitivity (default 0.3)'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const duration = projectDuration(project);
      if (duration <= 0) {
        throw new CutlineError('INVALID_OPERATION', 'The timeline is empty.', {
          hint: 'Add clips first; chapters describe the edited timeline.',
        });
      }
      const notes: string[] = [];
      let words: Word[] = [];
      try {
        words = await timelineWords(ctx, id, args.language, extra);
      } catch (err) {
        notes.push(`No transcript: ${err instanceof Error ? err.message : String(err)}`);
      }
      const { scenes } = await timelineScenes(
        ctx,
        project,
        args.sceneThreshold ?? 0.3,
        extra.signal,
      );
      let silences: Array<{ start: number; end: number }> = [];
      let loud: Array<{ start: number; end: number; rmsDb: number }> = [];
      try {
        const env = timelineEnvelope(
          project,
          await analysis.envelopes(project, extra.signal),
          0.01,
          duration,
        );
        silences = detectSilences(env, { thresholdDb: -40, minDuration: 1, padding: 0 }).map(
          (r) => ({ start: round3(r.start), end: round3(r.end) }),
        );
        const buckets = Math.max(4, Math.min(200, Math.ceil(duration / 2)));
        loud = loudnessPeaks(summarizeWaveform(env, buckets)).map((b) => ({
          start: round3(b.start),
          end: round3(b.end),
          rmsDb: b.rmsDb,
        }));
      } catch (err) {
        notes.push(`No audio analysis: ${err instanceof Error ? err.message : String(err)}`);
      }
      const sentences = wordsToCues(words, { maxChars: 160, maxDuration: 15 });
      const breaks = [...scenes.map((s) => s.time), ...silences.flatMap((s) => [s.start, s.end])];
      const blocks = sentences.length
        ? groupIntoBlocks(sentences, {
            minDuration: args.minBlock ?? 20,
            maxDuration: args.maxBlock ?? 60,
            breaks,
          })
        : [];
      if (!sentences.length)
        notes.push('No speech found: choose chapters from scenes and loudness.');
      const chapters = chapterList(project);
      return ok(
        `Outline of the ${round3(duration)}s timeline: ${blocks.length} transcript block(s), ${scenes.length} scene cut(s), ${silences.length} silence(s), ${loud.length} loud moment(s).`,
        {
          projectId: id,
          duration: round3(duration),
          blocks,
          scenes: scenes.slice(0, MAX_LIST).map((s) => s.time),
          silences: silences.slice(0, MAX_LIST),
          loudMoments: loud,
          ...(chapters.length && { chapters }),
          ...(highlightRanges(project).length && { highlights: highlightRanges(project) }),
          ...(notes.length && { notes }),
          rules:
            'YouTube chapters: first at 0, at least 3, each at least 10 s long. Highlights work best at 5–60 s each.',
          next: 'Call set_chapters { chapters: [{ time, title }] } and/or mark_highlights { ranges } / create_highlight_reel { ranges }.',
        },
      );
    }),
  );

  server.registerTool(
    'set_chapters',
    {
      title: 'Set chapters',
      description:
        'Replace the chapter markers of the timeline. Chapters must be in time order and inside the timeline; with youtube=true (default) also: the first at 0, at least 3 chapters, each at least 10 s long. They appear on the editor ruler, in export_chapters (YouTube description text) and as chapters inside exported MP4s. Pass [] to remove all chapters.',
      inputSchema: z.object({
        projectId,
        chapters: z.array(ChapterInputSchema).max(500).describe('{ time (seconds), title }[]'),
        youtube: z
          .boolean()
          .optional()
          .describe('Enforce the YouTube rules (default true); false only needs increasing times'),
      }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const result = await docs.apply(
        id,
        [{ type: 'set_chapters', chapters: args.chapters, youtube: args.youtube ?? true }],
        ctx.origin(),
        'Set chapters',
      );
      const duration = projectDuration(result.project);
      const chapters = chapterList(result.project);
      return ok(result.summary, {
        ...editPayload(id, result),
        chapters,
        ...(chapters.length && { youtube: youtubeChapterText(chapters, duration) }),
      });
    }),
  );

  server.registerTool(
    'export_chapters',
    {
      title: 'Export chapters',
      description:
        'Return the chapter markers as text: "youtube" (lines like "00:00 Intro" for a video description, with warnings when YouTube would ignore them), "ffmetadata" (ffmpeg FFMETADATA1 chapters) or "json". Exported MP4s (export_video) already contain these chapters.',
      inputSchema: z.object({
        projectId,
        format: z.enum(['youtube', 'ffmetadata', 'json']).optional().describe('Default "youtube"'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const duration = projectDuration(project);
      const chapters = chapterList(project);
      if (!chapters.length) {
        throw new CutlineError('NOT_FOUND', 'The project has no chapters.', {
          hint: 'Call get_chapters_input, then set_chapters { chapters: [{ time: 0, title: "Intro" }, …] }.',
        });
      }
      const format = args.format ?? 'youtube';
      const warnings = youtubeChapterWarnings(chapters, duration);
      const text =
        format === 'youtube'
          ? youtubeChapterText(chapters, duration)
          : format === 'ffmetadata'
            ? ffmetadataChapters(chapters, duration, project.name)
            : JSON.stringify(
                chapters.map((c, i) => ({
                  start: round3(c.time),
                  end: round3(chapters[i + 1]?.time ?? duration),
                  title: c.title,
                })),
              );
      return ok(
        `${chapters.length} chapter(s) as ${format}${warnings.length && format === 'youtube' ? ` (${warnings.length} warning(s))` : ''}:\n${text}`,
        {
          projectId: id,
          format,
          text,
          ...(warnings.length && { warnings }),
        },
      );
    }),
  );

  server.registerTool(
    'mark_highlights',
    {
      title: 'Mark highlights',
      description:
        'Mark highlight ranges (timeline seconds) as coloured spans on the editor ruler, e.g. the best moments you found with get_chapters_input. replace=true (default) clears earlier highlights first. create_highlight_reel without ranges then uses them.',
      inputSchema: z.object({
        projectId,
        ranges: z.array(ReelRangeSchema).min(1).max(500),
        color: ColorSchema.optional().describe('Span color (default: editor highlight color)'),
        replace: z
          .boolean()
          .optional()
          .describe('Remove existing highlight markers first (default true)'),
      }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const clear =
        (args.replace ?? true) && (project.markers ?? []).some((m) => m.kind === 'highlight');
      const result = await docs.apply(
        id,
        [
          ...(clear ? [{ type: 'remove_markers', kind: 'highlight' }] : []),
          {
            type: 'add_markers',
            markers: args.ranges.map((r) => ({
              time: r.start,
              end: r.end,
              label: r.label ?? '',
              kind: 'highlight',
              ...(args.color && { color: args.color }),
            })),
          },
        ],
        ctx.origin(),
        `Mark ${args.ranges.length} highlight(s)`,
      );
      return ok(`Marked ${args.ranges.length} highlight(s).`, {
        ...editPayload(id, result),
        highlights: highlightRanges(result.project),
        next: 'create_highlight_reel (without ranges) assembles them into a reel.',
      });
    }),
  );

  server.registerTool(
    'create_highlight_reel',
    {
      title: 'Create highlight reel',
      description:
        'Assemble timeline ranges back-to-back into a highlight reel, keeping everything each range shows (video, audio, text, overlays, captions) cut to the range. target "new-project" (default) creates a separate project and makes it active; "append" adds the reel after the end of this timeline (one undo step). Ranges play in the given order; without ranges the highlight markers are used. Labels become chapters. fadeBetween crossfades between ranges; aspect only changes the output size (no smart reframing).',
      inputSchema: z.object({
        projectId,
        ranges: z
          .array(ReelRangeSchema)
          .min(1)
          .max(200)
          .optional()
          .describe('{ start, end, label? }[] in timeline seconds (default: highlight markers)'),
        target: z.enum(['new-project', 'append']).optional(),
        title: z.string().min(1).max(200).optional().describe('Name of the new project'),
        fadeBetween: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe('Crossfade seconds between ranges (default 0)'),
        aspect: z
          .enum(['16:9', '9:16', '1:1'])
          .optional()
          .describe('Change the output aspect ratio, e.g. "9:16" for Shorts (default: keep)'),
      }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const ranges = args.ranges ?? highlightRanges(project);
      if (!ranges.length) {
        throw new CutlineError('INVALID_ARGUMENT', 'No ranges given and no highlights marked.', {
          hint: 'Pass ranges: [{ start, end, label? }] or call mark_highlights first.',
        });
      }
      const ops: unknown[] = [
        {
          type: 'assemble_ranges',
          ranges,
          mode: args.target === 'append' ? 'append' : 'replace',
          fadeBetween: args.fadeBetween ?? 0,
        },
      ];
      if (args.aspect) {
        ops.push({ type: 'update_project', settings: aspectSize(project.settings, args.aspect) });
      }
      if (args.target === 'append') {
        const result = await docs.apply(id, ops, ctx.origin(), 'Append highlight reel');
        return ok(result.summary, editPayload(id, result));
      }
      const name = args.title ?? `${project.name} – Highlights`.slice(0, 200);
      const created = await docs.createFrom(project, name, ops);
      await ctx.projectId(created.project.id);
      return ok(
        `Created highlight reel "${name}" (${created.project.id}, ${round3(projectDuration(created.project))}s). It is now the active project; the user can watch at ${ctx.editorUrl(created.project.id)}.`,
        {
          projectId: created.project.id,
          sourceProjectId: id,
          editorUrl: ctx.editorUrl(created.project.id),
          duration: round3(projectDuration(created.project)),
          settings: {
            width: created.project.settings.width,
            height: created.project.settings.height,
          },
          ...(created.project.markers?.length && { chapters: chapterList(created.project) }),
          next: 'Check it with get_frames, then export_video.',
        },
      );
    }),
  );
}
