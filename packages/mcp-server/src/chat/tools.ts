import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  BetaImageBlockParam,
  BetaTextBlockParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { createMcpServer } from '../mcp/server';
import type { Services } from '../services';
import { VERSION } from '../version';

/** Tools the in-editor chat does not offer: the conversation is bound to one project. */
const EXCLUDED = new Set(['create_project']);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface ToolOutcome {
  content: Array<BetaTextBlockParam | BetaImageBlockParam>;
  isError: boolean;
  /** One line for the tool chip in the chat panel. */
  summary: string;
}

/** The MCP tools of one project, called in-process. */
export interface ToolHost {
  readonly tools: BetaTool[];
  call(name: string, input: unknown, signal: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}

const clip = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Converts an MCP tool definition to an Anthropic tool, without the projectId argument. */
export function toAnthropicTool(tool: Tool): { tool: BetaTool; scoped: boolean } {
  const schema = structuredClone(tool.inputSchema) as Record<string, unknown> & {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  delete schema.$schema;
  const scoped = Boolean(schema.properties && 'projectId' in schema.properties);
  if (scoped) {
    delete schema.properties!.projectId;
    if (schema.required) schema.required = schema.required.filter((r) => r !== 'projectId');
  }
  return {
    scoped,
    tool: {
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      input_schema: { ...schema, type: 'object' } as BetaTool['input_schema'],
      // Large inputs (apply_operations batches) stream as they are generated.
      eager_input_streaming: true,
    },
  };
}

/** Converts an MCP tool result to tool_result content (text + images for get_frames). */
export function toToolOutcome(result: CallToolResult): ToolOutcome {
  const content: ToolOutcome['content'] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') content.push({ type: 'text', text: item.text });
    else if (item.type === 'image' && IMAGE_TYPES.has(item.mimeType)) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: item.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: item.data,
        },
      });
    } else content.push({ type: 'text', text: JSON.stringify(item) });
  }
  if (content.length === 0) content.push({ type: 'text', text: '(no output)' });
  const structured = result.structuredContent as { summary?: unknown } | undefined;
  const firstText = content.find((c): c is BetaTextBlockParam => c.type === 'text')?.text ?? '';
  const summary =
    typeof structured?.summary === 'string' ? structured.summary : (firstText.split('\n')[0] ?? '');
  return { content, isError: result.isError === true, summary: clip(summary) };
}

/**
 * Connects an in-memory MCP client to a fresh Cutline MCP server, so chat
 * tool calls take exactly the same path as Claude Desktop's: same schemas,
 * same validation, same operations, same live agent highlight in the editor.
 */
export async function connectToolHost(services: Services, projectId: string): Promise<ToolHost> {
  const sessionId = `chat-${projectId}`;
  const server = createMcpServer(services, { id: sessionId });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  // The name makes edits show up as "Claude" in the editor's activity feed.
  const client = new Client({ name: 'Claude (editor chat)', version: VERSION });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const { tools: mcpTools } = await client.listTools();
  const scoped = new Set<string>();
  const tools: BetaTool[] = [];
  for (const t of mcpTools) {
    if (EXCLUDED.has(t.name)) continue;
    const converted = toAnthropicTool(t);
    if (converted.scoped) scoped.add(t.name);
    tools.push(converted.tool);
  }
  const known = new Set(tools.map((t) => t.name));

  return {
    tools,
    async call(name, input, signal) {
      if (!known.has(name)) {
        return {
          content: [{ type: 'text', text: `Error: unknown tool "${name}".` }],
          isError: true,
          summary: `Unknown tool ${name}`,
        };
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
          content: [{ type: 'text', text: 'Error: tool input must be a JSON object.' }],
          isError: true,
          summary: 'Invalid input',
        };
      }
      const args = scoped.has(name) ? { ...input, projectId } : { ...input };
      const result = (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        // Transcription and exports can take minutes; progress keeps the call alive.
        timeout: 15 * 60 * 1000,
        resetTimeoutOnProgress: true,
      })) as CallToolResult;
      return toToolOutcome(result);
    },
    async close() {
      services.presence.leave(sessionId);
      await client.close();
      await server.close();
    },
  };
}
