import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CutlineError, IdSchema, round3 } from '@cutline/core';
import { describeLoudness, planDucking, planLoudness } from '../../media/mixing';
import { editPayload, guard, ok, type ToolContext } from '../context';

const projectId = IdSchema.optional().describe(
  'Project id. Omit to use the project you created or used most recently.',
);

export function registerAudioTools(server: McpServer, ctx: ToolContext): void {
  const { docs } = ctx.services;

  server.registerTool(
    'duck_music',
    {
      title: 'Duck music under speech',
      description:
        'Make the music quieter automatically while someone speaks (auto-ducking). Finds speech on the voice track(s) — from a cached transcript if one exists, otherwise from loudness (non-silent ranges) — and stores a smooth volume envelope on the music clips (one undo step). Running it again replaces the previous ducking; amountDb 0 effectively removes it. Tracks are picked automatically when omitted (music = the track named like music, or the only audio track next to a video with sound).',
      inputSchema: z.object({
        projectId,
        musicTrackId: IdSchema.optional().describe('Track to make quieter (default: auto-detect)'),
        voiceTrackId: IdSchema.optional().describe(
          'Track with speech (default: every other audible track)',
        ),
        amountDb: z
          .number()
          .min(-60)
          .max(0)
          .optional()
          .describe('Volume change while speech is heard, dB (default -12)'),
        attack: z
          .number()
          .min(0.01)
          .max(5)
          .optional()
          .describe('Seconds to fade the music down before speech (default 0.15)'),
        release: z
          .number()
          .min(0.01)
          .max(10)
          .optional()
          .describe('Seconds to fade the music back up after speech (default 0.4)'),
        source: z
          .enum(['auto', 'silence', 'transcript'])
          .optional()
          .describe(
            '"silence" = loudness only, "transcript" = word timings (transcribes if needed), "auto" (default) = cached transcript if available, else loudness',
          ),
        thresholdDb: z
          .number()
          .min(-90)
          .max(-10)
          .optional()
          .describe('Voice level counted as silence for loudness detection (default -40 dBFS)'),
      }),
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const p = ctx.progress(extra, id, 'duck_music');
      p.start('Listening for speech…');
      let plan;
      try {
        plan = await planDucking(ctx.services, id, args, extra.signal);
      } catch (err) {
        p.fail('Ducking failed.');
        throw err;
      }
      const result = await docs.apply(
        id,
        [plan.operation],
        ctx.origin(),
        'Duck music under speech',
      );
      p.done(result.summary);
      const speech = round3(plan.ranges.reduce((s, r) => s + r.end - r.start, 0));
      return ok(result.summary, {
        ...editPayload(id, result),
        musicTrackId: plan.music.id,
        voiceTrackIds: plan.voices.map((t) => t.id),
        source: plan.source,
        speechRanges: plan.ranges.length,
        speechSeconds: speech,
        firstRanges: plan.ranges.slice(0, 5),
      });
    }),
  );

  server.registerTool(
    'normalize_loudness',
    {
      title: 'Normalize loudness',
      description:
        'Measure the loudness (EBU R128 integrated LUFS and true peak, via ffmpeg) of audio/video clips and set each clip volume so it plays at the target loudness: -14 LUFS (default) suits YouTube/social, -16 podcasts, -23 broadcast. Gain is capped so the true peak stays below truePeak and the volume at most ×4 (+12 dB); such clips are reported as limited. Without clipIds/trackId all clips on unlocked tracks are normalized. One undo step; measurements are cached per asset.',
      inputSchema: z
        .object({
          projectId,
          clipIds: z.array(IdSchema).min(1).max(500).optional(),
          trackId: IdSchema.optional(),
          target: z
            .number()
            .min(-40)
            .max(-5)
            .optional()
            .describe('Integrated loudness target in LUFS (default -14)'),
          truePeak: z
            .number()
            .min(-10)
            .max(0)
            .optional()
            .describe('True-peak ceiling in dBTP (default -1)'),
        })
        .refine((a) => !(a.clipIds && a.trackId), {
          message: 'Give clipIds or trackId, not both.',
        }),
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const p = ctx.progress(extra, id, 'normalize_loudness');
      p.start('Measuring loudness…');
      let plan;
      try {
        plan = await planLoudness(ctx.services, id, args, extra.signal);
      } catch (err) {
        p.fail('Loudness measurement failed.');
        throw err;
      }
      const summary = describeLoudness(plan);
      p.done(summary);
      if (plan.operations.length === 0) {
        throw new CutlineError('INVALID_OPERATION', 'All selected clips are silent.', {
          hint: 'Pick clips with audible sound (see get_waveform_summary).',
        });
      }
      const result = await docs.apply(id, plan.operations, ctx.origin(), 'Normalize loudness');
      return ok(summary, {
        ...editPayload(id, result),
        target: plan.target,
        truePeak: plan.truePeak,
        clips: plan.clips,
      });
    }),
  );
}
