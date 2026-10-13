import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../version';
import type { Services } from '../services';
import { ToolContext, type SessionInfo } from './context';
import { registerAudioTools } from './tools/audio';
import { registerEditingTools } from './tools/editing';
import { registerMusicTools } from './tools/music';
import { registerOutputTools } from './tools/output';
import { registerPerceptionTools } from './tools/perception';

export const INSTRUCTIONS = `Cutline is a video editor. The timeline is a JSON document that a human is watching live in a browser; every change you make appears there immediately (highlighted), and they may edit too.

How to work:
- All times are in seconds. Tracks are stacked bottom (index 0) to top. Clips never overlap on one track.
- Start with get_project (or create_project), then add_asset for media and add_clip to place it.
- Ids (clip_…, track_…, asset_…) come from tool results; call get_project again when unsure, since ranges and ids change after cuts.
- To remove silences: detect_silence, then delete_range with the returned ranges (it ripples all tracks so audio, video and captions stay in sync).
- To remove "um"/"uh"/"äh" fillers from speech: remove_filler_words (dryRun=true first to review).
- To cut to music: cut_to_beats lays the footage out so every cut lands on a beat (detect_beats shows tempo and beat times).
- To add subtitles: add_captions with fromTranscript=true (do this AFTER cutting, so captions match the final timing).
- For background music: duck_music lowers it under speech; normalize_loudness evens out clip levels (-14 LUFS by default).
- To check your work: get_frames (look at stills), get_waveform_summary, get_transcript.
- Finish with export_video (server-side MP4) and give the user the download URL.
- Everything is undoable (undo/redo), including the human's edits. apply_operations batches many edits into one undo step.
- Errors include a hint describing how to fix the call.`;

/** Creates an MCP server instance for one client session. */
export function createMcpServer(services: Services, session: SessionInfo): McpServer {
  const server = new McpServer(
    { name: 'cutline', title: 'Cutline video editor', version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  const ctx = new ToolContext(services, server, session);
  registerEditingTools(server, ctx);
  registerPerceptionTools(server, ctx);
  registerMusicTools(server, ctx);
  registerOutputTools(server, ctx);
  registerAudioTools(server, ctx);
  return server;
}
