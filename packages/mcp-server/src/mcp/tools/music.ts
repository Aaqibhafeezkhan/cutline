import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CutlineError,
  IdSchema,
  clipSpeed,
  findAsset,
  findClip,
  hasSource,
  isVisualClip,
  projectDuration,
  type Clip,
  type Project,
} from '@cutline/core';
import { beatCutOperations, planBeatCuts, type BeatCutClip } from '../../media/beat-cuts';
import { beatsInClip, type BeatOptions } from '../../media/beats';
import { editPayload, guard, ok, type ToolContext } from '../context';

const projectId = IdSchema.optional().describe('Project id (default: active project)');
const bpm = z.number().min(30).max(300);
/** Beats listed in the text summary; the full list is in structuredContent. */
const PREVIEW = 12;

const preview = (xs: number[] | undefined) =>
  xs && xs.length > PREVIEW ? [...xs.slice(0, PREVIEW), `… ${xs.length - PREVIEW} more`] : xs;

function bpmRange(minBpm: number | undefined, maxBpm: number | undefined): BeatOptions {
  const options = { minBpm: minBpm ?? 60, maxBpm: maxBpm ?? 200 };
  if (options.maxBpm < options.minBpm * 1.5) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `BPM range ${options.minBpm}–${options.maxBpm} is too narrow.`,
      { hint: 'maxBpm must be at least 1.5 × minBpm, e.g. minBpm 80, maxBpm 160.' },
    );
  }
  return options;
}

/** The music: the given clip, or the first clip on an audio track. */
function musicClip(project: Project, clipId: string | undefined): Clip {
  if (clipId) return findClip(project, clipId).clip;
  const clip = project.tracks
    .filter((t) => t.kind === 'audio')
    .flatMap((t) => t.clips)
    .sort((a, b) => a.start - b.start)[0];
  if (!clip) {
    throw new CutlineError('INVALID_ARGUMENT', 'There is no clip on an audio track to analyse.', {
      hint: 'Pass clipId (a clip with music) or assetId, or add the music with add_clip first.',
    });
  }
  return clip;
}

function musicSource(project: Project, clip: Clip) {
  if (!hasSource(clip)) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Clip ${clip.id} is a ${clip.type} clip; it has no audio.`,
      {
        hint: 'Use an audio clip or a video clip with sound.',
      },
    );
  }
  return { clip, asset: findAsset(project, clip.assetId) };
}

export function registerMusicTools(server: McpServer, ctx: ToolContext): void {
  const { docs, analysis } = ctx.services;

  server.registerTool(
    'detect_beats',
    {
      title: 'Detect beats',
      description:
        'Find the tempo (BPM) and beat times of music. Pass assetId (beats in source time) or clipId (also returns timelineBeats: where the beats fall on the timeline within that clip); default: the first clip on an audio track. downbeats are likely bar starts (assumes 4/4), included only when clear. Results are cached per asset. To cut visuals to the music, use cut_to_beats.',
      inputSchema: z
        .object({
          projectId,
          assetId: IdSchema.optional().describe('Analyse this asset'),
          clipId: IdSchema.optional().describe('Analyse the media under this clip'),
          minBpm: bpm.optional().describe('Slowest tempo considered (default 60)'),
          maxBpm: bpm.optional().describe('Fastest tempo considered (default 200)'),
        })
        .refine((a) => !(a.assetId && a.clipId), {
          message: 'Give at most one of assetId or clipId.',
        }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra): Promise<CallToolResult> => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const options = bpmRange(args.minBpm, args.maxBpm);
      const source = args.assetId ? null : musicSource(project, musicClip(project, args.clipId));
      const clip = source?.clip;
      const asset = source?.asset ?? findAsset(project, args.assetId!);
      const p = ctx.progress(extra, id, 'detect_beats');
      p.start(`Listening for the beat of ${asset.name}…`);
      const result = await analysis.beats(asset, options, extra.signal);
      const timeline: { timelineBeats?: number[]; timelineDownbeats?: number[] } = clip
        ? {
            timelineBeats: beatsInClip(result.beats, clip),
            ...(result.downbeats && { timelineDownbeats: beatsInClip(result.downbeats, clip) }),
          }
        : {};
      const inClip = clip
        ? `; ${timeline.timelineBeats!.length} fall inside clip ${clip.id} (timelineBeats)`
        : '';
      const summary = result.beats.length
        ? `${result.bpm} BPM (confidence ${result.confidence}), ${result.beats.length} beats in asset ${asset.id} (source time)${inClip}.`
        : `No steady beat found in asset ${asset.id}.`;
      p.done(summary);
      const data = {
        projectId: id,
        assetId: asset.id,
        ...(clip && { clipId: clip.id }),
        ...options,
        ...result,
        ...timeline,
      };
      const brief = {
        ...data,
        beats: preview(data.beats),
        downbeats: preview(data.downbeats),
        timelineBeats: preview(data.timelineBeats),
        timelineDownbeats: preview(data.timelineDownbeats),
      };
      return {
        content: [{ type: 'text', text: `${summary}\n${JSON.stringify(brief)}` }],
        structuredContent: { summary, ...data },
      };
    }),
  );

  server.registerTool(
    'cut_to_beats',
    {
      title: 'Cut to the beat',
      description:
        'Lay visual clips back-to-back so every cut lands on a beat of the music. Clips keep their in-points and are trimmed (or extended, if media remains) to span everyNBeats beats each, starting where the first clip starts now; a clip whose media runs out spans fewer whole beats. Default clips: those on the main (lowest) video track, in timeline order. Default music: the first clip on an audio track. One undo step.',
      inputSchema: z.object({
        projectId,
        musicClipId: IdSchema.optional().describe(
          'Clip whose music sets the beat (default: first clip on an audio track)',
        ),
        clipIds: z
          .array(IdSchema)
          .min(1)
          .max(500)
          .optional()
          .describe('Visual clips to lay out, in this order (default: main video track)'),
        everyNBeats: z
          .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
          .optional()
          .describe('Beats per clip (default 4 = one bar in 4/4)'),
        minBpm: bpm.optional().describe('Slowest tempo considered (default 60)'),
        maxBpm: bpm.optional().describe('Fastest tempo considered (default 200)'),
      }),
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const options = bpmRange(args.minBpm, args.maxBpm);
      const { clip: music, asset } = musicSource(project, musicClip(project, args.musicClipId));
      const clips = targetClips(project, args.clipIds, music.id);
      const p = ctx.progress(extra, id, 'cut_to_beats');
      p.start(`Listening for the beat of ${asset.name}…`);
      const result = await analysis.beats(asset, options, extra.signal);
      const beats = beatsInClip(result.beats, music);
      let plan;
      try {
        plan = planBeatCuts(clips, beats, args.everyNBeats ?? 4);
      } catch (err) {
        p.fail('Could not cut to the beat.');
        throw err;
      }
      const ops = beatCutOperations(clips, plan, projectDuration(project));
      const edit = await docs.apply(
        id,
        ops,
        ctx.origin(),
        `Cut ${plan.length} clip(s) to the beat (${result.bpm} BPM)`,
      );
      const musicEnd = music.start + music.duration;
      const beyond = plan.filter((c) => c.end > musicEnd + 1e-3).length;
      const summary = `Laid out ${plan.length} clip(s) on the beat at ${result.bpm} BPM, every ${args.everyNBeats ?? 4} beat(s); cuts at ${plan
        .slice(0, 8)
        .map((c) => `${c.end}s`)
        .join(
          ', ',
        )}${plan.length > 8 ? ', …' : ''}.${beyond ? ` ${beyond} clip(s) run past the end of the music.` : ''}`;
      p.done(summary);
      return ok(summary, {
        ...editPayload(id, edit),
        bpm: result.bpm,
        musicClipId: music.id,
        cuts: plan,
      });
    }),
  );
}

/** Visual clips to lay out: the given ids in order, or the main video track's clips. */
function targetClips(project: Project, ids: string[] | undefined, musicId: string): BeatCutClip[] {
  let clips: Clip[];
  if (ids) {
    if (new Set(ids).size !== ids.length) {
      throw new CutlineError('INVALID_ARGUMENT', 'clipIds lists a clip more than once.', {
        hint: 'Give each clip once, in the order they should play.',
      });
    }
    clips = ids.map((cid) => findClip(project, cid).clip);
  } else {
    const main = project.tracks.find(
      (t) => t.kind === 'video' && t.clips.some((c) => c.type === 'video' || c.type === 'image'),
    );
    if (!main) {
      throw new CutlineError('INVALID_ARGUMENT', 'There are no video or image clips to cut.', {
        hint: 'Add footage with add_clip first, or pass clipIds.',
      });
    }
    clips = main.clips.filter((c) => c.id !== musicId && isVisualClip(c));
  }
  return clips.map((clip) => {
    if (!isVisualClip(clip) || clip.id === musicId) {
      throw new CutlineError(
        'INVALID_ARGUMENT',
        `Clip ${clip.id} (${clip.type}) cannot be cut to the beat.`,
        { hint: 'clipIds must be visual clips (video, image, text, shape), not the music clip.' },
      );
    }
    const asset = clip.type === 'video' ? findAsset(project, clip.assetId) : null;
    const maxDuration =
      clip.type === 'video' && asset?.duration != null
        ? (asset.duration - clip.sourceStart) / clipSpeed(clip)
        : Infinity;
    return { id: clip.id, start: clip.start, duration: clip.duration, maxDuration };
  });
}
