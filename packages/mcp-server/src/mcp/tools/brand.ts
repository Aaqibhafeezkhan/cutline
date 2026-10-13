import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IdSchema, SetBrandOpSchema } from '@cutline/core';
import { editPayload, guard, ok, type ToolContext } from '../context';

const projectId = IdSchema.optional().describe(
  'Project id. Omit to use the project you created or used most recently.',
);

export function registerBrandTools(server: McpServer, ctx: ToolContext): void {
  const { docs } = ctx.services;

  server.registerTool(
    'set_brand_kit',
    {
      title: 'Set brand kit',
      description:
        'Define the project brand kit once: colors (primary = bars and shape fills, accent = lines and outlines, text = default text color, secondary, background; #RRGGBB), fontFamily (body text), headingFontFamily (titles, names, banners) and a logo (logoAssetId of an imported image, logoPosition corner). Call once, then add_template / add_text_overlay / add_shape pick up these colors and fonts automatically unless you pass explicit ones, and add_template { template: "logo" } places the logo in its corner for the whole video. Only the fields you pass change; null clears a field, reset=true starts over.',
      inputSchema: SetBrandOpSchema.omit({ type: true }).extend({ projectId }),
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const { projectId: _ignored, ...fields } = args;
      const result = await docs.apply(
        id,
        [{ type: 'set_brand', ...fields }],
        ctx.origin(),
        'Set brand kit',
      );
      return ok(result.summary, {
        ...editPayload(id, result),
        brand: result.project.settings.brand ?? null,
        next: 'Templates, text overlays and shapes now default to these colors and fonts.',
      });
    }),
  );
}
