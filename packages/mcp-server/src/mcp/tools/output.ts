import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IdSchema, TimeSchema, projectDuration, round3 } from '@cutline/core';
import { guard, ok, type ToolContext } from '../context';

const projectId = IdSchema.optional().describe('Project id (default: active project)');

export function registerOutputTools(server: McpServer, ctx: ToolContext): void {
  const { docs, exports, config } = ctx.services;
  const absolute = (path: string) => `${config.publicUrl.replace(/\/$/, '')}${path}`;

  server.registerTool(
    'render_preview',
    {
      title: 'Render preview',
      description:
        'Quickly render a low-resolution MP4 of the timeline (or a range) to check timing and sound. Returns a URL the user can open and the file path. Use get_frames to look at stills yourself.',
      inputSchema: z.object({
        projectId,
        start: TimeSchema.optional(),
        end: TimeSchema.optional(),
        width: z.number().int().min(160).max(1280).optional().describe('Default 640'),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const range =
        args.start !== undefined || args.end !== undefined
          ? {
              start: args.start ?? 0,
              end: args.end ?? projectDuration((await docs.get(id)).project),
            }
          : undefined;
      const job = await exports.run(
        id,
        { quality: 'preview', width: args.width ?? 640, range },
        ctx.origin(),
        progressReporter(extra),
        extra.signal,
      );
      return ok(`Rendered a ${round3(job.duration ?? 0)}s preview: ${absolute(job.url!)}`, {
        projectId: id,
        url: absolute(job.url!),
        path: job.path,
        sizeBytes: job.sizeBytes,
        width: job.width,
        height: job.height,
        ...(job.warnings?.length && { warnings: job.warnings }),
      });
    }),
  );

  server.registerTool(
    'export_video',
    {
      title: 'Export video',
      description:
        'Render the final MP4 (H.264/AAC) on the server with ffmpeg. Returns a download URL and the file path. Quality: "draft" (fast), "standard" (default), "high" (slow, best). The user can also export in the browser from the Export dialog.',
      inputSchema: z.object({
        projectId,
        quality: z.enum(['draft', 'standard', 'high']).optional(),
        width: z.number().int().min(160).max(7680).optional().describe('Default: project width'),
        fps: z.number().positive().max(120).optional().describe('Default: project fps'),
        start: TimeSchema.optional(),
        end: TimeSchema.optional(),
        fileName: z
          .string()
          .max(80)
          .optional()
          .describe('File name prefix (default: project name)'),
      }),
    },
    guard(async (args, extra) => {
      const id = await ctx.projectId(args.projectId);
      const range =
        args.start !== undefined || args.end !== undefined
          ? {
              start: args.start ?? 0,
              end: args.end ?? projectDuration((await docs.get(id)).project),
            }
          : undefined;
      const job = await exports.run(
        id,
        {
          quality: args.quality ?? 'standard',
          width: args.width,
          fps: args.fps,
          range,
          name: args.fileName,
        },
        ctx.origin(),
        progressReporter(extra),
        extra.signal,
      );
      return ok(
        `Exported ${job.fileName} (${round3(job.duration ?? 0)}s, ${job.width}×${job.height}, ${((job.sizeBytes ?? 0) / 1048576).toFixed(1)} MB). Download: ${absolute(job.url!)}`,
        {
          projectId: id,
          url: absolute(job.url!),
          path: job.path,
          fileName: job.fileName,
          sizeBytes: job.sizeBytes,
          duration: job.duration,
          width: job.width,
          height: job.height,
          ...(job.warnings?.length && { warnings: job.warnings }),
        },
      );
    }),
  );
}

function progressReporter(extra: Parameters<ReturnType<typeof guard>>[1]) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let last = -1;
  return (fraction: number) => {
    const pct = Math.round(fraction * 100);
    if (pct === last) return;
    last = pct;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: pct, total: 100, message: `Rendering ${pct}%` },
      })
      .catch(() => undefined);
  };
}
