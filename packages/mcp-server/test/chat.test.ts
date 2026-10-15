import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { runAgent, type ChatEvent } from '../src/chat/agent';
import { fakeChatModel, scriptedStream, type ScriptTurn } from '../src/chat/fake';
import { chatModelFromEnv, type ChatModel } from '../src/chat/model';
import { describeChatError } from '../src/chat/service';
import { toAnthropicTool, toToolOutcome, type ToolHost, type ToolOutcome } from '../src/chat/tools';
import { loadConfig } from '../src/config';
import { createServices } from '../src/services';
import { startServer, type RunningServer } from '../src/server';
import { tempDir } from './helpers';

/** A fake Anthropic client: replays scripted turns and records every request. */
function scriptedModel(script: ScriptTurn[] | ((i: number) => ScriptTurn)) {
  const requests: BetaMessageStreamParams[] = [];
  const model: ChatModel = {
    stream(params, signal) {
      // Snapshot: the agent keeps appending to the same history array.
      requests.push({ ...params, messages: structuredClone(params.messages) });
      const i = requests.length - 1;
      const turn = typeof script === 'function' ? script(i) : script[i];
      if (!turn) throw new Error(`no scripted turn #${i}`);
      return scriptedStream(turn, signal);
    },
  };
  return { model, requests };
}

function fakeHost(run: (name: string, input: unknown) => Partial<ToolOutcome> = () => ({})) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const host: ToolHost = {
    tools: [{ name: 'get_project', description: 'Read', input_schema: { type: 'object' } }],
    async call(name, input) {
      calls.push({ name, input });
      return {
        content: [{ type: 'text', text: `${name} ok` }],
        isError: false,
        summary: `${name} done`,
        ...run(name, input),
      };
    },
    async close() {},
  };
  return { host, calls };
}

function agent(model: ChatModel, host: ToolHost, extra: { maxToolCalls?: number } = {}) {
  const history: BetaMessageParam[] = [{ role: 'user', content: 'Make it a 30 second short' }];
  const events: ChatEvent[] = [];
  const controller = new AbortController();
  const run = () =>
    runAgent({
      model,
      modelId: 'claude-opus-5-5',
      effort: 'medium',
      system: 'sys',
      host,
      history,
      maxToolCalls: extra.maxToolCalls ?? 20,
      signal: controller.signal,
      emit: (e) => events.push(e),
    });
  return { history, events, controller, run };
}

const toolUse = (id: string, name = 'get_project', input: Record<string, unknown> = {}) =>
  ({ type: 'tool_use', id, name, input }) as const;

describe('chat agent loop', () => {
  it('executes tool calls and feeds the results back to the model', async () => {
    const { model, requests } = scriptedModel([
      {
        content: [{ type: 'text', text: 'Looking.' }, toolUse('t1', 'get_project', { full: true })],
      },
      { content: [{ type: 'text', text: 'Done: 3 clips.' }] },
    ]);
    const { host, calls } = fakeHost();
    const a = agent(model, host);
    expect(await a.run()).toBe('end');

    expect(calls).toEqual([{ name: 'get_project', input: { full: true } }]);
    expect(requests).toHaveLength(2);
    // Request shape: model, tools, caching, effort and the refusal fallback.
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'sys',
      tools: host.tools,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    const fed = requests[1]!.messages;
    expect(fed.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const result = (fed[2]!.content as BetaToolResultBlockParam[])[0]!;
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(result.is_error).toBeUndefined();
    expect(a.history).toHaveLength(4);

    const text = a.events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Looking.Done: 3 clips.');
    expect(a.events).toContainEqual({ type: 'tool_start', id: 't1', name: 'get_project' });
    expect(a.events).toContainEqual({
      type: 'tool_end',
      id: 't1',
      name: 'get_project',
      ok: true,
      summary: 'get_project done',
    });
  });

  it('omits effort and fallbacks when not applicable', async () => {
    const { model, requests } = scriptedModel([{ content: [{ type: 'text', text: 'Hi' }] }]);
    const { host } = fakeHost();
    await runAgent({
      model,
      modelId: 'claude-haiku-4-5',
      system: 's',
      host,
      history: [{ role: 'user', content: 'hi' }],
      maxToolCalls: 5,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect(requests[0]).not.toHaveProperty('fallbacks');
    expect(requests[0]).not.toHaveProperty('output_config');
  });

  it('marks failed tools as errors so the model can correct the call', async () => {
    const { model, requests } = scriptedModel([
      { content: [toolUse('t1', 'split_clip', { clipId: 'nope' })] },
      { content: [{ type: 'text', text: 'Sorry.' }] },
    ]);
    const { host } = fakeHost(() => ({ isError: true, summary: 'clip not found' }));
    const a = agent(model, host);
    await a.run();
    const result = (requests[1]!.messages[2]!.content as BetaToolResultBlockParam[])[0]!;
    expect(result.is_error).toBe(true);
    expect(a.events).toContainEqual(
      expect.objectContaining({ type: 'tool_end', ok: false, summary: 'clip not found' }),
    );
  });

  it('turns thrown tool errors into error results', async () => {
    const { model } = scriptedModel([
      { content: [toolUse('t1')] },
      { content: [{ type: 'text', text: 'ok' }] },
    ]);
    const host: ToolHost = {
      tools: [],
      call: async () => {
        throw new Error('boom');
      },
      close: async () => undefined,
    };
    const a = agent(model, host);
    expect(await a.run()).toBe('end');
    expect(a.events).toContainEqual(
      expect.objectContaining({ type: 'tool_end', ok: false, summary: 'boom' }),
    );
  });

  it('stops at the tool-call cap and keeps the history valid', async () => {
    let n = 0;
    const { model, requests } = scriptedModel(() => ({
      content: [toolUse(`t${++n}`), toolUse(`t${++n}`)],
    }));
    const { host, calls } = fakeHost();
    const a = agent(model, host, { maxToolCalls: 3 });
    expect(await a.run()).toBe('limit');
    expect(calls).toHaveLength(3);
    expect(requests).toHaveLength(2);
    // Every tool_use is answered, the over-limit one with an error result.
    const last = a.history.at(-1)!;
    expect(last.role).toBe('user');
    const results = last.content as BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['t3', 't4']);
    expect(results[1]!.is_error).toBe(true);
    expect(a.events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('cancels between tool calls', async () => {
    const { model } = scriptedModel([{ content: [toolUse('t1'), toolUse('t2')] }]);
    const stop = new AbortController();
    const { host, calls } = fakeHost(() => {
      stop.abort();
      return {};
    });
    const a = agent(model, host);
    stop.signal.addEventListener('abort', () => a.controller.abort());
    expect(await a.run()).toBe('cancelled');
    expect(calls).toHaveLength(1);
    const results = a.history.at(-1)!.content as BetaToolResultBlockParam[];
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ tool_use_id: 't2', is_error: true });
  });

  it('cancels while streaming without storing the partial turn', async () => {
    const { model } = scriptedModel([{ content: [{ type: 'text', text: 'one two three' }] }]);
    const { host } = fakeHost();
    const a = agent(model, host);
    a.controller.abort();
    expect(await a.run()).toBe('cancelled');
    const b = agent(
      {
        stream: (_p, signal) => {
          const s = scriptedStream({ content: [{ type: 'text', text: 'one two three' }] }, signal);
          queueMicrotask(() => b.controller.abort());
          return s;
        },
      },
      host,
    );
    expect(await b.run()).toBe('cancelled');
    expect(b.history).toHaveLength(1);
  });

  it('does not run or store tool calls of a refused turn', async () => {
    const { model } = scriptedModel([{ content: [toolUse('t1')], stopReason: 'refusal' }]);
    const { host, calls } = fakeHost();
    const a = agent(model, host);
    expect(await a.run()).toBe('refusal');
    expect(calls).toHaveLength(0);
    expect(a.history).toHaveLength(1);
  });

  it('does not run a tool call truncated by max_tokens', async () => {
    const { model } = scriptedModel([{ content: [toolUse('t1')], stopReason: 'max_tokens' }]);
    const { host, calls } = fakeHost();
    const a = agent(model, host);
    expect(await a.run()).toBe('max_tokens');
    expect(calls).toHaveLength(0);
  });

  it('continues after pause_turn', async () => {
    const { model, requests } = scriptedModel([
      { content: [{ type: 'text', text: 'a' }], stopReason: 'pause_turn' },
      { content: [{ type: 'text', text: 'b' }] },
    ]);
    const a = agent(model, fakeHost().host);
    expect(await a.run()).toBe('end');
    expect(requests).toHaveLength(2);
  });

  it('re-issues a turn whose tool input was not parseable JSON, then gives up', async () => {
    let attempts = 0;
    const flaky: ChatModel = {
      stream(_p, signal) {
        attempts += 1;
        if (attempts === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield* [];
              throw new SyntaxError('Unexpected end of JSON input');
            },
            finalMessage: () => Promise.reject(new SyntaxError('x')),
          };
        }
        return scriptedStream({ content: [{ type: 'text', text: 'ok' }] }, signal);
      },
    };
    expect(await agent(flaky, fakeHost().host).run()).toBe('end');
    expect(attempts).toBe(2);

    const broken: ChatModel = {
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
          throw new SyntaxError('bad json');
        },
        finalMessage: () => Promise.reject(new SyntaxError('x')),
      }),
    };
    await expect(agent(broken, fakeHost().host).run()).rejects.toThrow('bad json');
  });
});

describe('chat tool bridge', () => {
  it('strips projectId from tool schemas', () => {
    const { tool, scoped } = toAnthropicTool({
      name: 'split_clip',
      description: 'Split',
      inputSchema: {
        type: 'object',
        $schema: 'x',
        properties: { projectId: { type: 'string' }, clipId: { type: 'string' } },
        required: ['projectId', 'clipId'],
      } as never,
    });
    expect(scoped).toBe(true);
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: { clipId: { type: 'string' } },
      required: ['clipId'],
    });
    expect(tool.eager_input_streaming).toBe(true);
  });

  it('passes get_frames images to the model as image blocks', () => {
    const outcome = toToolOutcome({
      content: [
        { type: 'text', text: '1 frame(s) of the timeline' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      ],
    });
    expect(outcome.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
    expect(outcome.summary).toBe('1 frame(s) of the timeline');
    expect(toToolOutcome({ content: [], isError: true })).toMatchObject({ isError: true });
  });
});

describe('chat service', () => {
  it('runs real MCP tools in-process, scoped to the project, as an agent edit', async () => {
    const dataDir = await tempDir();
    const config = loadConfig({ dataDir, mediaRoots: [dataDir] }, {});
    const { model, requests } = scriptedModel([
      {
        content: [
          { type: 'text', text: 'Adding a title.' },
          toolUse('t1', 'add_text_overlay', { text: 'Hello', start: 0, duration: 2 }),
        ],
      },
      { content: [{ type: 'text', text: 'Added.' }] },
    ]);
    const services = createServices(config, { chatModel: model });
    const other = await services.docs.create({ name: 'Other' });
    const project = await services.docs.create({ name: 'Chat' });
    // The "most recent" project is a different one: scoping must not depend on it.
    await services.docs.get(other.id);

    const events: ChatEvent[] = [];
    const texts = services.chat.prepare(project.id, {
      messages: [{ role: 'user', content: 'Add a title' }],
    });
    await services.chat.send(project.id, texts, (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end' });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
    const tools = requests[0]!.tools!.map((t) => ('name' in t ? t.name : ''));
    expect(tools).toContain('get_frames');
    expect(tools).not.toContain('create_project');

    const { project: edited, history } = await services.docs.get(project.id);
    const clips = edited.tracks.flatMap((t) => t.clips);
    expect(clips.some((c) => c.type === 'text')).toBe(true);
    expect(history.canUndo).toBe(true);
    expect((await services.docs.get(other.id)).project.tracks.flatMap((t) => t.clips)).toEqual([]);

    // The panel can restore the conversation (text deltas merged).
    const log = services.chat.events(project.id);
    expect(log[0]).toEqual({ type: 'user', text: 'Add a title' });
    expect(log.filter((e) => e.type === 'text').map((e) => e.delta)).toEqual([
      'Adding a title.',
      'Added.',
    ]);

    await services.chat.reset(project.id);
    expect(services.chat.events(project.id)).toEqual([]);
    expect(services.chat.cancel(project.id)).toBe(false);
    await services.chat.close();
    await services.docs.flush();
  });

  it('reports model errors as chat events without throwing', async () => {
    const dataDir = await tempDir();
    const services = createServices(loadConfig({ dataDir }, {}), {
      chatModel: {
        stream: () => {
          throw new Error('kaput');
        },
      },
    });
    const project = await services.docs.create({ name: 'P' });
    const events: ChatEvent[] = [];
    await services.chat.send(project.id, ['hi'], (e) => events.push(e));
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'kaput' },
      { type: 'done', reason: 'error' },
    ]);
    await services.chat.close();
    await services.docs.flush();
  });

  it('validates requests', async () => {
    const services = createServices(loadConfig({ dataDir: await tempDir() }, {}), {
      chatModel: scriptedModel([]).model,
    });
    expect(() => services.chat.prepare('p', { messages: [] })).toThrow(/Body must be/);
    expect(() =>
      services.chat.prepare('p', { messages: [{ role: 'assistant', content: 'x' }] }),
    ).toThrow();
    expect(services.chat.prepare('p', { messages: [{ role: 'user', content: ' hi ' }] })).toEqual([
      'hi',
    ]);
  });

  it('describes API errors without internals', () => {
    expect(describeChatError(new Error('x'))).toEqual({ message: 'x' });
    expect(describeChatError('y')).toEqual({ message: 'y' });
  });

  it('is disabled without ANTHROPIC_API_KEY and uses the fake only when asked', () => {
    const config = loadConfig({}, {});
    expect(chatModelFromEnv(config, {})).toBeNull();
    expect(chatModelFromEnv(config, { ANTHROPIC_API_KEY: '  ' })).toBeNull();
    expect(chatModelFromEnv(config, { ANTHROPIC_API_KEY: 'sk-test' })).not.toBeNull();
    expect(chatModelFromEnv({ ...config, chatFake: true }, {})).not.toBeNull();
    expect(config.chatModel).toBe('claude-opus-5-5');
    expect(config.chatEffort).toBe('medium');
    expect(loadConfig({}, { CUTLINE_CHAT_EFFORT: 'default' }).chatEffort).toBeUndefined();
    expect(loadConfig({}, { CUTLINE_CHAT_MODEL: 'claude-sonnet-5-5' }).chatModel).toBe(
      'claude-sonnet-5-5',
    );
  });

  it('the dev fake model looks at the project and answers', async () => {
    const dataDir = await tempDir();
    const services = createServices(loadConfig({ dataDir }, {}), { chatModel: fakeChatModel(0) });
    const project = await services.docs.create({ name: 'Fake' });
    const events: ChatEvent[] = [];
    await services.chat.send(project.id, ['What is in my project?'], (e) => events.push(e));
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'get_project' });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end' });
    await services.chat.close();
    await services.docs.flush();
  });
});

describe('chat HTTP route', () => {
  let disabled: RunningServer;
  let enabled: RunningServer;

  beforeAll(async () => {
    disabled = await startServer({ port: 0, dataDir: await tempDir() }, { chatModel: null });
    const { model } = scriptedModel(() => ({ content: [{ type: 'text', text: 'Hi there!' }] }));
    enabled = await startServer({ port: 0, dataDir: await tempDir() }, { chatModel: model });
  });

  afterAll(async () => {
    await disabled?.close();
    await enabled?.close();
  });

  function post(server: RunningServer, path: string, body: unknown, headers = {}) {
    return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request(
        `${server.url}${path}`,
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type']),
              body: text,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  it('explains how to enable chat when no key is configured', async () => {
    const { id } = await disabled.services.docs.create({ name: 'P' });
    const status = (await (await fetch(`${disabled.url}/api/projects/${id}/chat`)).json()) as {
      enabled: boolean;
      hint: string;
    };
    expect(status.enabled).toBe(false);
    expect(status.hint).toMatch(/ANTHROPIC_API_KEY/);
    const res = await post(disabled, `/api/projects/${id}/chat`, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('streams the reply as server-sent events', async () => {
    const { id } = await enabled.services.docs.create({ name: 'P' });
    const res = await post(enabled, `/api/projects/${id}/chat`, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/text\/event-stream/);
    const events = res.body
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as ChatEvent);
    expect(events[0]).toEqual({ type: 'user', text: 'hi' });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end' });

    const status = (await (await fetch(`${enabled.url}/api/projects/${id}/chat`)).json()) as {
      enabled: boolean;
      events: ChatEvent[];
    };
    expect(status.enabled).toBe(true);
    expect(status.events[1]).toEqual({ type: 'text', delta: 'Hi there!' });

    const cancel = await post(enabled, `/api/projects/${id}/chat/cancel`, {});
    expect(JSON.parse(cancel.body)).toEqual({ cancelled: false });
    const reset = await fetch(`${enabled.url}/api/projects/${id}/chat`, { method: 'DELETE' });
    expect(reset.status).toBe(200);
  });

  it('applies the Host/Origin checks and 404s unknown projects', async () => {
    const res = await post(
      enabled,
      '/api/projects/x/chat',
      { messages: [{ role: 'user', content: 'hi' }] },
      { origin: 'http://evil.example' },
    );
    expect(res.status).toBe(403);
    const missing = await post(enabled, '/api/projects/missing/chat', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(missing.status).toBe(404);
  });
});
