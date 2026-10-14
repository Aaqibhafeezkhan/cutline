import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IdSchema, agentModeOf, formatChange, type Proposal } from '@cutline/core';
import { guard, ok, type ToolContext } from '../context';

/** A proposal as agents see it. */
export function proposalInfo(p: Proposal) {
  return {
    id: p.id,
    label: p.label,
    status: p.status,
    createdAt: p.createdAt,
    author: p.origin.name ?? 'agent',
    changes: p.changes.map(formatChange),
    ...(p.error && { error: p.error.message }),
  };
}

export function registerReviewTools(server: McpServer, ctx: ToolContext): void {
  const { docs } = ctx.services;

  server.registerTool(
    'list_proposals',
    {
      title: 'List proposals',
      description:
        'List the edits waiting for the user\'s review. When the project is in suggest mode (agentMode "suggest" in get_project), editing tools do not change the timeline; each call becomes a proposal the user previews and accepts or rejects in the editor. Accepted proposals disappear from this list and show up in the timeline; "stale" ones no longer apply because the project changed. Only the user can accept, reject or switch the mode.',
      inputSchema: z.object({
        projectId: IdSchema.optional().describe(
          'Project id. Omit to use the project you created or used most recently.',
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => {
      const id = await ctx.projectId(args.projectId);
      const { project } = await docs.get(id);
      const proposals = await docs.proposals(id);
      const mode = agentModeOf(project);
      const modeNote =
        mode === 'suggest'
          ? 'Suggest mode is on: your edits are proposed for review.'
          : 'Direct mode is on: your edits apply immediately.';
      return ok(`${proposals.length} proposal(s) waiting for review. ${modeNote}`, {
        projectId: id,
        agentMode: mode,
        proposals: proposals.map(proposalInfo),
      });
    }),
  );
}
