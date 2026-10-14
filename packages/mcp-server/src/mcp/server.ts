import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeChanges, formatChange, type Proposal } from '@cutline/core';
import { VERSION } from '../version';
import type { Services } from '../services';
import { toolScope } from '../tool-scope';
import { ToolContext, type SessionInfo } from './context';
import { registerAudioTools } from './tools/audio';
import { registerBrandTools } from './tools/brand';
import { registerChapterTools } from './tools/chapters';
import { registerEditingTools } from './tools/editing';
import { registerMusicTools } from './tools/music';
import { registerOutputTools } from './tools/output';
import { registerPerceptionTools } from './tools/perception';
import { registerReviewTools } from './tools/review';

export const INSTRUCTIONS = `Cutline is a video editor. The timeline is a JSON document that a human is watching live in a browser; every change you make appears there immediately (highlighted), and they may edit too.

How to work:
- All times are in seconds. Tracks are stacked bottom (index 0) to top. Clips never overlap on one track.
- Start with get_project (or create_project), then add_asset for media and add_clip to place it.
- Ids (clip_…, track_…, asset_…) come from tool results; call get_project again when unsure, since ranges and ids change after cuts.
- To remove silences: detect_silence, then delete_range with the returned ranges (it ripples all tracks so audio, video and captions stay in sync).
- To remove "um"/"uh"/"äh" fillers from speech: remove_filler_words (dryRun=true first to review).
- To cut spoken words or sentences ("remove 'as I said before'"): delete_words with the exact text.
- To cut to music: cut_to_beats lays the footage out so every cut lands on a beat (detect_beats shows tempo and beat times).
- To add subtitles: add_captions with fromTranscript=true (do this AFTER cutting, so captions match the final timing).
- For background music: duck_music lowers it under speech; normalize_loudness evens out clip levels (-14 LUFS by default).
- For on-brand graphics: set_brand_kit once (colors, fonts, logo), then add_template / add_text_overlay / add_shape use it by default; add_template with template "logo" places the logo.
- For chapters and highlights: get_chapters_input gives a compact outline (transcript blocks, scene cuts, silences, loud moments); pick the structure yourself, then set_chapters (YouTube rules; export_chapters gives the description text, MP4 exports embed them), mark_highlights, and create_highlight_reel to assemble the best ranges into a new project (or append them).
- To check your work: get_frames (look at stills), get_waveform_summary, get_transcript.
- Finish with export_video (server-side MP4) and give the user the download URL.
- Everything is undoable (undo/redo), including the human's edits. apply_operations batches many edits into one undo step.
- Suggest mode: if get_project shows agentMode "suggest", your edits are NOT applied; each editing call becomes a proposal the user previews and accepts or rejects in the editor. Group related edits into one call (apply_operations) so they are reviewed together, build on the current timeline (not on pending proposals), and check list_proposals to see what is still waiting. Only the user can switch the mode.
- Errors include a hint describing how to fix the call.`;

type ToolHandler = (...args: unknown[]) => Promise<CallToolResult>;

/**
 * Runs every tool handler inside a tool-call scope: edits proposed in suggest
 * mode are labelled with the tool name, and the result tells the agent that
 * nothing was applied yet.
 */
function scopeTools(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: ToolHandler,
  ) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: ToolHandler,
  ) =>
    register(name, config, (...args: unknown[]) => {
      const scope = { tool: name, proposals: [] as Proposal[] };
      return toolScope.run(scope, async () => {
        const result = await cb(...args);
        return scope.proposals.length && !result.isError
          ? asProposed(result, scope.proposals)
          : result;
      });
    });
}

/** Rewrites an edit result so the agent knows it was only proposed. */
export function asProposed(result: CallToolResult, proposals: Proposal[]): CallToolResult {
  const ids = proposals.map((p) => p.id).join(', ');
  const changes = proposals.flatMap((p) => p.changes);
  const headline = `Proposed as ${ids}, waiting for the user's review: nothing has changed yet. The user previews it in the editor and accepts or rejects it (list_proposals shows its status). If accepted: ${describeChanges(changes)}`;
  const details = changes.slice(0, 20).map((c) => `- ${formatChange(c)}`);
  if (changes.length > 20) details.push(`- … and ${changes.length - 20} more`);
  const content = result.content.map((c, i) =>
    i === 0 && c.type === 'text'
      ? { ...c, text: [headline, ...details, `Would do: ${c.text}`].join('\n') }
      : c,
  );
  return {
    ...result,
    content,
    structuredContent: {
      ...result.structuredContent,
      summary: headline,
      status: 'proposed',
      proposals: proposals.map((p) => ({
        id: p.id,
        label: p.label,
        status: p.status,
        changes: p.changes.map(formatChange),
      })),
    },
  };
}

/** Creates an MCP server instance for one client session. */
export function createMcpServer(services: Services, session: SessionInfo): McpServer {
  const server = new McpServer(
    { name: 'cutline', title: 'Cutline video editor', version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  scopeTools(server);
  const ctx = new ToolContext(services, server, session);
  registerEditingTools(server, ctx);
  registerBrandTools(server, ctx);
  registerPerceptionTools(server, ctx);
  registerMusicTools(server, ctx);
  registerOutputTools(server, ctx);
  registerAudioTools(server, ctx);
  registerChapterTools(server, ctx);
  registerReviewTools(server, ctx);
  return server;
}
