import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ANIMATION_PRESETS,
  ClipPropsPatchSchema,
  CaptionStylePatchSchema,
  ColorSchema,
  CueSchema,
  CutlineError,
  DEFAULT_FILLERS,
  DurationSchema,
  IdSchema,
  OperationSchema,
  SpeedSchema,
  TEMPLATE_LABELS,
  TemplateParamsSchema,
  TextStylePatchSchema,
  TimeSchema,
  TransformPatchSchema,
  clipEnd,
  isFreeze,
  summarizeProject,
  templateOperations,
  wordsToCues,
  type Project,
  type Word,
} from '@cutline/core';
import { planFillerCut, transcribeTimeline } from '../../media/timeline-transcript';
import { editPayload, guard, ok, type ToolContext } from '../context';

const projectId = IdSchema.optional().describe(
  'Project id. Omit to use the project you created or used most recently.',
);

const placement = z
  .enum(['error', 'overwrite', 'insert'])
  .optional()
  .describe(
    'If the range is occupied: "error" (default), "overwrite" existing material, or "insert" (push later clips right)',
  );

/** Topmost visible, non-frozen video clip at timeline time `t`. */
function videoClipAt(project: Project, t: number): string {
  for (const track of [...project.tracks].reverse()) {
    if (track.kind !== 'video' || track.hidden) continue;
    const hit = track.clips.find(
      (c) => c.type === 'video' && !isFreeze(c) && t >= c.start && t < clipEnd(c),
    );
    if (hit) return hit.id;
  }
  throw new CutlineError('NOT_FOUND', `No video clip plays at ${t}s.`, {
    hint: 'Pass a time inside a video clip, or give clipId explicitly (see get_project).',
  });
}

export function registerEditingTools(server: McpServer, ctx: ToolContext): void {
  const { docs, assets } = ctx.services;

  const edit = async (pid: string | undefined, ops: unknown[], label?: string) => {
    const id = await ctx.projectId(pid);
    const result = await docs.apply(id, ops, ctx.origin(), label);
    return { id, result };
  };

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        'Create a new, empty video project (with tracks V1 and A1) and make it the active project. Returns the project id and the URL where the user can watch edits live.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('Project name'),
        width: z
          .number()
          .int()
          .min(16)
          .max(7680)
          .optional()
          .describe('Output width in px (default 1920)'),
        height: z
          .number()
          .int()
          .min(16)
          .max(4320)
          .optional()
          .describe('Output height in px (default 1080)'),
        fps: z.number().positive().max(240).optional().describe('Frame rate (default 30)'),
        backgroundColor: ColorSchema.optional(),
      }),
    },
    guard(async (args) => {
      const settings = {
        ...(args.width && { width: args.width }),
        ...(args.height && { height: args.height }),
        ...(args.fps && { fps: args.fps }),
        ...(args.backgroundColor && { backgroundColor: args.backgroundColor }),
      };
      const project = await docs.create({ name: args.name, settings });
      await ctx.projectId(project.id);
      return ok(
        `Created project "${project.name}" (${project.id}). The user can watch at ${ctx.editorUrl(project.id)}.`,
        {
          projectId: project.id,
          editorUrl: ctx.editorUrl(project.id),
          settings: project.settings,
          tracks: project.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
          next: 'Add media with add_asset, then place it with add_clip.',
        },
      );
    }),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description:
        'Read the timeline: tracks (bottom to top), clips with ids, timeline start/end and source in/out (seconds), assets and settings. Call this to find clip ids before editing. Without a projectId it uses the active project and also lists the other projects.',
      inputSchema: z.object({
        projectId,
        full: z
          .boolean()
          .optional()
          .describe('Return the complete raw JSON document instead of the compact summary'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => {
      const list = await docs.list();
      if (list.length === 0) {
        return ok('There are no projects yet. Call create_project to start one.', { projects: [] });
      }
      const id = await ctx.projectId(args.projectId);
      const { project, version, history } = await docs.get(id);
      const others = list.filter((p) => p.id !== id).map((p) => ({ id: p.id, name: p.name }));
      const summary = summarizeProject(project);
      return ok(
        `Project "${project.name}" (${id}): ${summary.duration}s, ${summary.tracks.length} tracks, ${project.assets.length} assets.`,
        {
          version,
          editorUrl: ctx.editorUrl(id),
          history,
          project: args.full ? project : summary,
          ...(others.length && { otherProjects: others }),
        },
      );
    }),
  );

  server.registerTool(
    'add_asset',
    {
      title: 'Add asset',
      description:
        'Import a media file (video, audio or image) into the project from an absolute local path on the server machine or from an http(s) URL. Returns the asset id plus duration, size and whether it has audio/video. Importing does not put anything on the timeline: use add_clip next.',
      inputSchema: z
        .object({
          projectId,
          path: z
            .string()
            .optional()
            .describe('Absolute file path on the machine running the Cutline server'),
          url: z.string().url().optional().describe('http(s) URL to download'),
          name: z.string().max(256).optional().describe('Display name (default: file name)'),
        })
        .refine((a) => Boolean(a.path) !== Boolean(a.url), {
          message: 'Give exactly one of path or url.',
        }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const asset = args.path
        ? await assets.importFromPath(id, args.path, ctx.origin(), args.name)
        : await assets.importFromUrl(id, args.url!, ctx.origin(), args.name);
      const length = asset.duration === null ? 'still image' : `${asset.duration.toFixed(2)}s`;
      return ok(
        `Imported ${asset.kind} "${asset.name}" as ${asset.id} (${length}). Place it with add_clip.`,
        {
          projectId: id,
          asset: {
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            duration: asset.duration,
            width: asset.width,
            height: asset.height,
            fps: asset.fps,
            hasVideo: asset.hasVideo,
            hasAudio: asset.hasAudio,
          },
        },
      );
    }),
  );

  server.registerTool(
    'add_clip',
    {
      title: 'Add clip',
      description:
        'Place an asset on the timeline. Defaults: appended at the end of the first suitable track, using the whole asset (images: 5s). Video assets keep their audio on the same clip. Use clipType "audio" to place only the audio of a video. Returns the new clip id.',
      inputSchema: z.object({
        projectId,
        assetId: IdSchema,
        trackId: IdSchema.optional().describe(
          'Target track (default: first suitable track with room, or a new one)',
        ),
        start: TimeSchema.optional().describe(
          'Timeline position in seconds (default: end of the track)',
        ),
        sourceStart: TimeSchema.optional().describe(
          'In-point within the asset in seconds (default 0)',
        ),
        duration: DurationSchema.optional().describe(
          'Length in seconds (default: rest of the asset)',
        ),
        clipType: z.enum(['video', 'audio', 'image']).optional(),
        mode: placement,
        volume: z.number().min(0).max(4).optional().describe('Linear gain, 1 = unchanged'),
        transform: TransformPatchSchema.optional().describe(
          'Position offset from center (px), scale, rotation (deg), opacity',
        ),
      }),
    },
    guard(async (args) => {
      const props = {
        ...(args.volume !== undefined && { volume: args.volume }),
        ...(args.transform && { transform: args.transform }),
      };
      const { id, result } = await edit(args.projectId, [
        {
          type: 'add_clip',
          assetId: args.assetId,
          trackId: args.trackId,
          start: args.start,
          sourceStart: args.sourceStart,
          duration: args.duration,
          clipType: args.clipType,
          mode: args.mode,
          ...(Object.keys(props).length && { props }),
        },
      ]);
      return ok(result.summary, { ...editPayload(id, result), clipId: result.createdIds[0] });
    }),
  );

  server.registerTool(
    'split_clip',
    {
      title: 'Split clip',
      description:
        'Cut a clip in two at a timeline time (seconds). The left part keeps the id; the right part gets a new id (returned as newClipId).',
      inputSchema: z.object({
        projectId,
        clipId: IdSchema,
        time: TimeSchema.describe('Timeline time of the cut'),
      }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'split_clip', clipId: args.clipId, time: args.time },
      ]);
      return ok(result.summary, { ...editPayload(id, result), newClipId: result.createdIds[0] });
    }),
  );

  server.registerTool(
    'trim_clip',
    {
      title: 'Trim clip',
      description:
        'Change where a clip starts and/or ends on the timeline. Moving the start also moves the source in-point (like dragging the clip edge in an editor). ripple=true shifts the following clips on the same track to keep the gap closed.',
      inputSchema: z
        .object({
          projectId,
          clipId: IdSchema,
          start: TimeSchema.optional().describe('New timeline start'),
          end: TimeSchema.optional().describe('New timeline end'),
          ripple: z.boolean().optional(),
        })
        .refine((a) => a.start !== undefined || a.end !== undefined, {
          message: 'Give start and/or end.',
        }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'trim_clip', ...args, projectId: undefined },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'move_clip',
    {
      title: 'Move clip',
      description: 'Move a clip to a new timeline start, optionally onto another compatible track.',
      inputSchema: z.object({
        projectId,
        clipId: IdSchema,
        start: TimeSchema,
        trackId: IdSchema.optional(),
        mode: placement,
      }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'move_clip', ...args, projectId: undefined },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'delete_clip',
    {
      title: 'Delete clips',
      description:
        'Delete one or more clips. ripple=true closes the gaps on their tracks. To cut a time range out of the whole timeline (all tracks), use delete_range instead.',
      inputSchema: z.object({
        projectId,
        clipIds: z.array(IdSchema).min(1).max(1000),
        ripple: z.boolean().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'delete_clips', clipIds: args.clipIds, ripple: args.ripple },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'delete_range',
    {
      title: 'Delete time ranges',
      description:
        'Cut timeline ranges (seconds) out of all unlocked tracks at once, splitting clips as needed, and close the gaps (ripple) so video, audio and captions stay in sync. This is the tool for removing silences, filler or mistakes: pass the ranges from detect_silence or get_transcript directly. Ranges may be given in any order and may overlap.',
      inputSchema: z.object({
        projectId,
        ranges: z
          .array(z.object({ start: TimeSchema, end: TimeSchema }))
          .min(1)
          .max(2000)
          .describe('Timeline ranges to remove, in the CURRENT timeline time'),
        trackIds: z
          .array(IdSchema)
          .optional()
          .describe('Only these tracks (default: all unlocked tracks)'),
        ripple: z.boolean().optional().describe('Close the gaps (default true)'),
      }),
      annotations: { destructiveHint: true },
    },
    guard(async (args) => {
      const ranges = args.ranges.filter((r) => r.end > r.start);
      if (ranges.length === 0) {
        throw new CutlineError('INVALID_ARGUMENT', 'Every range has end <= start.', {
          hint: 'Each range needs end > start (seconds).',
        });
      }
      const { id, result } = await edit(args.projectId, [
        { type: 'delete_range', ranges, trackIds: args.trackIds, ripple: args.ripple },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'remove_filler_words',
    {
      title: 'Remove filler words',
      description: `Cut hesitation sounds ("um", "uh", "äh", "ähm", …) out of talking-head footage in one step. Transcribes the timeline audio (local Whisper, word timestamps, cached), finds the fillers and removes them with ONE delete_range (one undo step, ripples all unlocked tracks so audio, video and captions stay in sync). Matching ignores case and punctuation ("Um," matches). Default list: ${DEFAULT_FILLERS.join(', ')}. repeats=true also cuts stutters like "I I think". Use dryRun=true first to review what would be cut. Limitation: Whisper often omits disfluencies from its transcript, so fillers it did not write down cannot be found; pair with detect_silence for pauses.`,
      inputSchema: z.object({
        projectId,
        fillers: z
          .array(z.string().min(1).max(40))
          .min(1)
          .max(200)
          .optional()
          .describe('Words to remove; replaces the default list (case/punctuation-insensitive)'),
        repeats: z
          .boolean()
          .optional()
          .describe('Also cut immediate word repetitions such as "I I think" (default false)'),
        padding: z
          .number()
          .min(0)
          .max(0.5)
          .optional()
          .describe('Seconds also cut around each filler, never into kept words (default 0.05)'),
        language: z
          .string()
          .min(2)
          .max(10)
          .optional()
          .describe('Spoken language for transcription, e.g. "en", "de" (default: auto-detect)'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Only report what would be cut, change nothing (default false)'),
      }),
      annotations: { destructiveHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const words = await timelineWords(ctx, id, args.language, extra);
      const plan = planFillerCut(words, {
        fillers: args.fillers,
        repeats: args.repeats,
        padding: args.padding ?? 0.05,
      });
      const base = {
        projectId: id,
        dryRun: Boolean(args.dryRun),
        wordCount: words.length,
        found: plan.found,
        ranges: plan.ranges,
        removedDuration: plan.removed,
      };
      if (plan.ranges.length === 0) {
        return ok(
          words.length === 0
            ? 'No speech found in the timeline audio, so there are no filler words to remove.'
            : `No filler words found in ${words.length} transcribed words. Whisper often leaves out hesitations; check get_transcript or cut by hand with delete_range.`,
          base,
        );
      }
      const listed = plan.found.map((f) => `"${f.text}" at ${f.start}s`).join(', ');
      if (args.dryRun) {
        return ok(
          `Would remove ${plan.found.length} filler word(s), ${plan.removed}s in ${plan.ranges.length} cut(s): ${listed}. Call again without dryRun to cut.`,
          base,
        );
      }
      const result = await docs.apply(
        id,
        [{ type: 'delete_range', ranges: plan.ranges }],
        ctx.origin(),
        `Remove ${plan.found.length} filler word(s)`,
      );
      return ok(
        `Removed ${plan.found.length} filler word(s), ${plan.removed}s in ${plan.ranges.length} cut(s): ${listed}.`,
        { ...base, ...editPayload(id, result) },
      );
    }),
  );

  server.registerTool(
    'set_clip_property',
    {
      title: 'Set clip properties',
      description:
        'Change clip properties: transform {x, y (px offset from center), scale, rotation (deg), opacity 0..1}, effects {brightness, contrast, saturation (-1..1), blur (px); null removes}, keyframes per property (clip-relative seconds; [] removes), fadeIn/fadeOut (s), volume/muted, speed/reverse for video and audio (see set_clip_speed), text and style for text clips, words for captions, transitionIn, animationIn/animationOut ({preset, duration}; null removes; see animate_clip). Only the fields you pass are changed.',
      inputSchema: z.object({ projectId, clipId: IdSchema, props: ClipPropsPatchSchema }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'set_clip_props', clipId: args.clipId, props: args.props },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'set_clip_speed',
    {
      title: 'Set clip speed / reverse',
      description:
        'Change the playback speed of a video or audio clip (0.1–16: 0.5 = slow motion, 2 = twice as fast; constant speed, no ramps) and/or play it backwards (reverse). By default the clip keeps its source material, so its timeline length becomes source length / speed (a 10 s clip at 2× lasts 5 s); keepDuration=true keeps the timeline length and uses more/less source instead. When a slower clip would run into the next clip, pass ripple=true to push later clips on the track (shrinking with ripple=true pulls them in). Sped-up audio keeps its pitch in server renders (atempo) but changes pitch in the browser preview. Images, text and shapes have no speed: use trim_clip.',
      inputSchema: z
        .object({
          projectId,
          clipId: IdSchema,
          speed: SpeedSchema.optional().describe('0.1–16, 1 = normal speed'),
          reverse: z.boolean().optional().describe('true = backwards, false = forwards'),
          keepDuration: z
            .boolean()
            .optional()
            .describe('Keep the timeline length instead of the source material (default false)'),
          ripple: z
            .boolean()
            .optional()
            .describe('Shift later clips on the track when the length changes (default false)'),
        })
        .refine((a) => a.speed !== undefined || a.reverse !== undefined, {
          message: 'Give speed and/or reverse.',
        }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'set_speed', ...args, projectId: undefined },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'freeze_frame',
    {
      title: 'Freeze frame',
      description:
        'Hold the video frame shown at a timeline time for a few seconds: the clip is split at `time`, a silent freeze-frame clip is inserted there, and the rest of the clip plus all later clips on that track move later by `duration` (other tracks are not moved). Omit clipId to use the topmost visible video clip at that time. The freeze frame can be trimmed, moved, faded or animated like any clip. Returns its id as freezeClipId.',
      inputSchema: z.object({
        projectId,
        clipId: IdSchema.optional().describe(
          'Video clip to freeze (default: topmost visible video clip at `time`)',
        ),
        time: TimeSchema.describe('Timeline time of the frame to hold'),
        duration: z.number().positive().max(600).optional().describe('Seconds to hold (default 2)'),
      }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      let clipId = args.clipId;
      if (!clipId) {
        const { project } = await docs.get(id);
        clipId = videoClipAt(project, args.time);
      }
      const result = await docs.apply(
        id,
        [{ type: 'freeze_frame', clipId, time: args.time, duration: args.duration }],
        ctx.origin(),
      );
      return ok(result.summary, {
        ...editPayload(id, result),
        freezeClipId: result.createdIds[0],
      });
    }),
  );

  const presetOrNone = z
    .enum([...ANIMATION_PRESETS, 'none'])
    .optional()
    .describe('Preset name, or "none" to remove; omit to leave unchanged');
  const seconds = z.number().positive().max(10);

  server.registerTool(
    'animate_clip',
    {
      title: 'Animate clip in/out',
      description:
        'Give a visual clip (text, shape, image or video) an entrance ("in") and/or exit ("out") animation preset, without writing keyframes. Presets: "fade" (opacity), "slide-left" / "slide-right" / "slide-up" / "slide-down" (moves in that direction by a quarter of the frame while fading: slide-up enters from below and exits upward), "zoom" (scales from 50% while fading), "pop" (scales up from 30% with a small overshoot). The in animation plays over the first `duration` seconds of the clip, the out animation over the last; they follow the clip when it is trimmed or split and combine with its transform and keyframes. "none" removes an animation.',
      inputSchema: z
        .object({
          projectId,
          clipId: IdSchema,
          in: presetOrNone.describe('Entrance preset, or "none" to remove'),
          out: presetOrNone.describe('Exit preset, or "none" to remove'),
          duration: seconds
            .optional()
            .describe('Seconds for both animations (default 0.5, max 10)'),
          inDuration: seconds.optional().describe('Seconds for the entrance (overrides duration)'),
          outDuration: seconds.optional().describe('Seconds for the exit (overrides duration)'),
        })
        .refine((a) => a.in !== undefined || a.out !== undefined, {
          message: 'Give in and/or out (a preset name, or "none" to remove).',
        }),
    },
    guard(async (args) => {
      const animation = (preset: string | undefined, secs: number | undefined) =>
        preset === undefined
          ? undefined
          : preset === 'none'
            ? null
            : { preset, duration: secs ?? args.duration ?? 0.5 };
      const { id, result } = await edit(args.projectId, [
        {
          type: 'set_animation',
          clipId: args.clipId,
          in: animation(args.in, args.inDuration),
          out: animation(args.out, args.outDuration),
        },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'add_text_overlay',
    {
      title: 'Add text overlay',
      description:
        'Add a text title/overlay. By default it is centered on screen on a text track above the video; use transform.y to move it (positive = down, in px at project resolution, e.g. y=400 for a lower third at 1080p). Font and color default to the brand kit (set_brand_kit), if one is set.',
      inputSchema: z.object({
        projectId,
        text: z.string().min(1).max(2000),
        start: TimeSchema,
        duration: DurationSchema.optional().describe('Seconds (default 3)'),
        trackId: IdSchema.optional(),
        style: TextStylePatchSchema.optional().describe(
          'fontSize (px), color, backgroundColor, bold, align, …',
        ),
        transform: TransformPatchSchema.optional(),
        mode: placement,
      }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'add_text', ...args, projectId: undefined },
      ]);
      return ok(result.summary, {
        ...editPayload(id, result),
        clipId: result.createdIds.find((c) => c.startsWith('clip')),
      });
    }),
  );

  server.registerTool(
    'add_shape',
    {
      title: 'Add shape',
      description:
        'Add a rectangle (optionally rounded) or ellipse as an overlay, e.g. a lower-third bar, a box behind text, a highlight frame (fill null + strokeWidth) or a dot. Sizes are project pixels; it is centered on screen unless transform.x/y move it (offsets from the center, positive y = down). It goes on an overlay track above the video; text added afterwards at the same time stacks above it.',
      inputSchema: z.object({
        projectId,
        shape: z.enum(['rectangle', 'ellipse']).optional().describe('Default rectangle'),
        start: TimeSchema,
        duration: DurationSchema.optional().describe('Seconds (default 3)'),
        width: z.number().positive().max(16384).optional().describe('Pixels (default 400)'),
        height: z.number().positive().max(16384).optional().describe('Pixels (default 200)'),
        fill: ColorSchema.nullable()
          .optional()
          .describe('Fill color, null for none (default: brand-kit primary color, else #ffffff)'),
        strokeColor: ColorSchema.optional().describe(
          'Outline color (default: brand-kit accent color, else #000000)',
        ),
        strokeWidth: z
          .number()
          .min(0)
          .max(500)
          .optional()
          .describe('Outline width in pixels (default 0)'),
        cornerRadius: z
          .number()
          .min(0)
          .max(8192)
          .optional()
          .describe('Rounded corners for rectangles'),
        transform: TransformPatchSchema.optional(),
        trackId: IdSchema.optional(),
        mode: placement,
      }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'add_shape', ...args, projectId: undefined },
      ]);
      return ok(result.summary, {
        ...editPayload(id, result),
        clipId: result.createdIds.find((c) => c.startsWith('clip')),
      });
    }),
  );

  server.registerTool(
    'add_template',
    {
      title: 'Add graphics template',
      description:
        'Add ready-made on-screen graphics in one undo step: "title" (big centered heading with accent line, optional subtitle), "lower-third" (name bar at the bottom left, subtitle for role/location), "banner" (full-width bar at the top), "callout" (outlined box with a label to highlight something) or "logo" (the brand-kit logo as an image in a corner, by default for the whole timeline; no text needed). Built from shapes, text and images, so every part can be edited afterwards. Colors and fonts come from the brand kit (set_brand_kit) unless accentColor/textColor are given.',
      inputSchema: TemplateParamsSchema.extend({ projectId }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const { projectId: _ignored, ...params } = args;
      const ops = templateOperations(params, project.settings);
      const label = TEMPLATE_LABELS[params.template].toLowerCase();
      const result = await docs.apply(id, ops, ctx.origin(), `Add ${label}`);
      const clipIds = result.createdIds.filter((c) => c.startsWith('clip'));
      return ok(
        params.template === 'logo' ? result.summary : `Added a ${label} (${clipIds.length} clips).`,
        { ...editPayload(id, result), clipIds },
      );
    }),
  );

  server.registerTool(
    'add_captions',
    {
      title: 'Add captions',
      description:
        'Add subtitles on a caption track. Either pass cues [{start, end, text}] in timeline seconds, or set fromTranscript=true to transcribe the current timeline audio (speech-to-text, word timings) and generate readable cues automatically — the usual choice for "add captions". Replaces existing captions on the track unless replace=false.',
      inputSchema: z
        .object({
          projectId,
          cues: z.array(CueSchema).max(5000).optional(),
          fromTranscript: z
            .boolean()
            .optional()
            .describe('Generate cues from the timeline transcript'),
          language: z
            .string()
            .min(2)
            .max(10)
            .optional()
            .describe('Spoken language for transcription, e.g. "en", "de" (default: auto-detect)'),
          maxChars: z
            .number()
            .int()
            .min(10)
            .max(120)
            .optional()
            .describe('Max characters per cue (default 42)'),
          style: CaptionStylePatchSchema.optional(),
          replace: z.boolean().optional(),
          trackId: IdSchema.optional(),
        })
        .refine((a) => Boolean(a.cues?.length) !== Boolean(a.fromTranscript), {
          message: 'Give either cues or fromTranscript=true.',
        }),
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      let cues = args.cues ?? [];
      if (args.fromTranscript) {
        const words = await timelineWords(ctx, id, args.language, extra);
        if (words.length === 0) {
          throw new CutlineError('INVALID_OPERATION', 'No speech found in the timeline audio.', {
            hint: 'Check that clips with spoken audio are on the timeline and not muted.',
          });
        }
        cues = wordsToCues(words, { maxChars: args.maxChars });
      }
      const result = await docs.apply(
        id,
        [
          {
            type: 'add_captions',
            cues,
            trackId: args.trackId,
            replace: args.replace,
            style: args.style,
          },
        ],
        ctx.origin(),
        `Add ${cues.length} captions`,
      );
      return ok(result.summary, {
        ...editPayload(id, result),
        cueCount: cues.length,
        firstCues: cues.slice(0, 3).map((c) => ({ start: c.start, end: c.end, text: c.text })),
      });
    }),
  );

  server.registerTool(
    'add_transition',
    {
      title: 'Add transition',
      description:
        'Add a transition INTO a clip from the clip right before it on the same track: "crossfade" (dissolve, centered on the cut) or "dipToBlack". Without a preceding clip it fades in from transparent. type "none" removes it. Audio follows the transition.',
      inputSchema: z.object({
        projectId,
        clipId: IdSchema.describe('The clip the transition leads into'),
        type: z.enum(['crossfade', 'dipToBlack', 'none']),
        duration: z.number().positive().max(10).optional().describe('Seconds (default 1)'),
      }),
    },
    guard(async (args) => {
      const transition =
        args.type === 'none' ? null : { type: args.type, duration: args.duration ?? 1 };
      const { id, result } = await edit(args.projectId, [
        { type: 'set_transition', clipId: args.clipId, transition },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'set_audio_volume',
    {
      title: 'Set audio volume',
      description:
        'Set the volume (linear gain: 0 = silent, 1 = unchanged, 2 ≈ +6 dB), mute, or fades of a clip, or the volume/mute of a whole track. Give exactly one of clipId or trackId.',
      inputSchema: z
        .object({
          projectId,
          clipId: IdSchema.optional(),
          trackId: IdSchema.optional(),
          volume: z.number().min(0).max(4).optional(),
          muted: z.boolean().optional(),
          fadeIn: z.number().min(0).max(60).optional().describe('Seconds (clips only)'),
          fadeOut: z.number().min(0).max(60).optional().describe('Seconds (clips only)'),
        })
        .refine((a) => (a.clipId === undefined) !== (a.trackId === undefined), {
          message: 'Give exactly one of clipId or trackId.',
        }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, [
        { type: 'set_volume', ...args, projectId: undefined },
      ]);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'apply_operations',
    {
      title: 'Apply operations',
      description:
        'Apply a batch of low-level operations atomically as ONE undo step (all or nothing). Covers everything the editor UI can do, including tracks (add_track, update_track: name/mute/hide/lock/volume/captionStyle, remove_track, move_track), project settings (update_project), and remove_asset, plus all clip operations. Use the dedicated tools for single edits.',
      inputSchema: z.object({
        projectId,
        operations: z.array(OperationSchema).min(1).max(2000),
        label: z.string().max(200).optional().describe('Name of the undo step'),
      }),
    },
    guard(async (args) => {
      const { id, result } = await edit(args.projectId, args.operations, args.label);
      return ok(result.summary, editPayload(id, result));
    }),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      description:
        'Undo the most recent change to the project, whoever made it (you or the human in the editor).',
      inputSchema: z.object({ projectId }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const r = await docs.undo(id, ctx.origin());
      return ok(r.summary, { projectId: id, version: r.version, ...r.history });
    }),
  );

  server.registerTool(
    'redo',
    {
      title: 'Redo',
      description: 'Redo the change that was last undone (by you or by the human in the editor).',
      inputSchema: z.object({ projectId }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const r = await docs.redo(id, ctx.origin());
      return ok(r.summary, { projectId: id, version: r.version, ...r.history });
    }),
  );
}

/** Timeline transcript with progress reported to the client and the editor. */
export async function timelineWords(
  ctx: ToolContext,
  projectId: string,
  language: string | undefined,
  extra: Parameters<ReturnType<typeof guard>>[1],
): Promise<Word[]> {
  const progress = ctx.progress(extra, projectId, 'get_transcript');
  progress.start('Transcribing the timeline audio…');
  try {
    const words = await transcribeTimeline(ctx.services, projectId, {
      language,
      signal: extra.signal,
      progress,
    });
    progress.done(`Transcription finished (${words.length} words).`);
    return words;
  } catch (err) {
    progress.fail('Transcription failed.');
    throw err;
  }
}
