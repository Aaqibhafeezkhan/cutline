import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState, parseSse, replay, toolIcon, type ChatEvent } from './chat';
import { parseInline, parseMarkdownLite } from './markdown-lite';

describe('chatReducer', () => {
  it('builds a reply from text deltas and tool chips in order', () => {
    const events: ChatEvent[] = [
      { type: 'user', text: 'Make it short' },
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'look.' },
      { type: 'tool_start', id: 't1', name: 'delete_range' },
      { type: 'tool_end', id: 't1', name: 'delete_range', ok: true, summary: 'Removed 3 ranges' },
      { type: 'text', delta: 'Done.' },
      { type: 'done', reason: 'end' },
    ];
    const state = replay(events);
    expect(state.streaming).toBe(false);
    expect(state.stopped).toBe('end');
    expect(state.messages).toEqual([
      { role: 'user', text: 'Make it short' },
      {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'Let me look.' },
          {
            kind: 'tool',
            tool: { id: 't1', name: 'delete_range', status: 'ok', summary: 'Removed 3 ranges' },
          },
          { kind: 'text', text: 'Done.' },
        ],
      },
    ]);
  });

  it('is streaming between user and done, and does not mutate the previous state', () => {
    const a = chatReducer(initialChatState, { type: 'user', text: 'hi' });
    expect(a.streaming).toBe(true);
    const b = chatReducer(a, { type: 'text', delta: 'x' });
    const c = chatReducer(b, { type: 'text', delta: 'y' });
    expect(b.messages[1]).toEqual({ role: 'assistant', parts: [{ kind: 'text', text: 'x' }] });
    expect(c.messages[1]).toEqual({ role: 'assistant', parts: [{ kind: 'text', text: 'xy' }] });
    expect(initialChatState.messages).toEqual([]);
  });

  it('shows failed tools and errors, and marks interrupted chips when the reply ends', () => {
    const state = replay([
      { type: 'user', text: 'go' },
      { type: 'tool_start', id: 'a', name: 'split_clip' },
      { type: 'tool_end', id: 'a', name: 'split_clip', ok: false, summary: 'clip not found' },
      { type: 'tool_end', id: 'b', name: 'get_frames', ok: true, summary: 'late' },
      { type: 'tool_start', id: 'c', name: 'export_video' },
      { type: 'error', message: 'Stopped after 20 tool calls.', hint: 'Send "continue".' },
      { type: 'done', reason: 'cancelled' },
    ]);
    const reply = state.messages[1]!;
    expect(reply.role).toBe('assistant');
    if (reply.role !== 'assistant') return;
    expect(reply.parts.map((p) => (p.kind === 'tool' ? p.tool.status : p.kind))).toEqual([
      'error',
      'ok',
      'error',
    ]);
    expect(reply.error).toEqual({
      message: 'Stopped after 20 tool calls.',
      hint: 'Send "continue".',
    });
    expect(state.stopped).toBe('cancelled');
  });

  it('starts an assistant message for an error without text', () => {
    const state = replay([
      { type: 'user', text: 'x' },
      { type: 'error', message: 'Chat is off' },
      { type: 'done', reason: 'error' },
    ]);
    expect(state.messages[1]).toEqual({
      role: 'assistant',
      parts: [],
      error: { message: 'Chat is off' },
    });
  });
});

describe('parseSse', () => {
  it('returns complete events and keeps the partial rest', () => {
    const first = parseSse('data: {"type":"text","delta":"a"}\n\ndata: {"type":"te');
    expect(first.events).toEqual([{ type: 'text', delta: 'a' }]);
    const second = parseSse(`${first.rest}xt","delta":"b"}\n\n: comment\n\ndata: nope\n\n`);
    expect(second.events).toEqual([{ type: 'text', delta: 'b' }]);
    expect(second.rest).toBe('');
  });
});

describe('markdown-lite', () => {
  it('parses paragraphs, lists, code fences and inline styles', () => {
    expect(
      parseMarkdownLite(
        '## Plan\nI will:\n\n- cut **silences**\n- add `captions`\n1. one\n```\nx\n```',
      ),
    ).toEqual([
      { kind: 'p', lines: [[{ kind: 'bold', text: 'Plan' }], [{ kind: 'text', text: 'I will:' }]] },
      {
        kind: 'ul',
        items: [
          [
            { kind: 'text', text: 'cut ' },
            { kind: 'bold', text: 'silences' },
          ],
          [
            { kind: 'text', text: 'add ' },
            { kind: 'code', text: 'captions' },
          ],
        ],
      },
      { kind: 'ol', items: [[{ kind: 'text', text: 'one' }]] },
      { kind: 'pre', text: 'x' },
    ]);
    expect(parseInline('an _aside_ and *more*')).toEqual([
      { kind: 'text', text: 'an ' },
      { kind: 'italic', text: 'aside' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'more' },
    ]);
  });

  it('icons tool chips', () => {
    expect(toolIcon('delete_range')).toBe('✂');
    expect(toolIcon('detect_silence')).toBe('🔍');
    expect(toolIcon('set_audio_volume')).toBe('⚙');
  });
});
