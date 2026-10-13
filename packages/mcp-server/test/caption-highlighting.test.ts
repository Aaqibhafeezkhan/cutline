import { describe, expect, it } from 'vitest';
import { applyOperations, createProject, sequentialContext } from '@cutline/core';
import { buildRenderGraph } from '../src/render/graph';

function captionGraph(
  options: {
    words?: Array<{ text: string; start: number; end: number }> | null;
    start?: number;
  } = {},
) {
  const ctx = sequentialContext();
  const base = createProject(
    { name: 'Caption highlight', settings: { width: 640, height: 360 } },
    ctx,
  );
  const defaultWords = [
    { text: 'Hello', start: 1.1, end: 1.4 },
    { text: 'there', start: 1.4, end: 1.8 },
    { text: 'friend', start: 1.8, end: 2.4 },
  ];
  const words = options.words === undefined ? defaultWords : options.words ?? undefined;
  const project = applyOperations(
    base,
    [
      {
        type: 'add_captions',
        cues: [
          {
            start: 1,
            end: 4,
            text: 'Hello there friend',
            ...(words !== undefined && { words }),
          },
        ],
        style: {
          highlightColor: '#ffcc00',
          fontSize: 32,
          backgroundColor: null,
          position: 'top',
        },
      },
    ],
    ctx,
  ).project;
  const textFiles: string[] = [];
  const start = options.start ?? 0;
  const graph = buildRenderGraph(project, new Map(), {
    start,
    end: 4,
    width: 640,
    height: 360,
    fps: 30,
    includeAudio: false,
    textFile: (content) => {
      textFiles.push(content);
      return `text${textFiles.length}.txt`;
    },
  });
  return { graph, textFiles };
}

describe('server caption word highlighting', () => {
  it('adds timed highlight overlays and removes the preview-only warning', () => {
    const { graph, textFiles } = captionGraph();
    expect(graph.warnings).not.toContain('caption word highlighting is preview-only');
    expect(textFiles).toEqual(['Hello there friend', 'Hello', 'there', 'friend']);
    expect(graph.filter.match(/drawtext=/g)).toHaveLength(4);
    expect(graph.filter).toContain('fontcolor=0xffcc00@1');
    expect(graph.filter).toContain('text_w-');
    expect(graph.filter).toContain('gte(t,1.1)*lt(t,1.4)');
    expect(graph.filter).toContain('gte(t,1.4)*lt(t,1.8)');
    expect(graph.filter).toContain('gte(t,1.8)*lt(t,2.4)');
  });

  it('keeps plain captions when word timings are absent or do not match tokens', () => {
    const untimed = captionGraph({ words: null });
    expect(untimed.textFiles).toEqual(['Hello there friend']);
    expect(untimed.graph.filter.match(/drawtext=/g)).toHaveLength(1);

    const empty = captionGraph({ words: [] });
    expect(empty.textFiles).toEqual(['Hello there friend']);
    expect(empty.graph.filter.match(/drawtext=/g)).toHaveLength(1);

    const mismatched = captionGraph({
      words: [{ text: 'Hello', start: 1.1, end: 1.4 }],
    });
    expect(mismatched.textFiles).toEqual(['Hello there friend']);
    expect(mismatched.graph.filter.match(/drawtext=/g)).toHaveLength(1);
    expect(mismatched.graph.warnings).not.toContain('caption word highlighting is preview-only');
  });

  it('shifts word timing into the selected render range', () => {
    const { graph } = captionGraph({
      start: 1.25,
      words: [
        { text: 'Hello', start: 1.1, end: 1.4 },
        { text: 'there', start: 1.5, end: 1.8 },
        { text: 'friend', start: 1.8, end: 2.4 },
      ],
    });
    expect(graph.filter).toContain('gte(t,0.25)*lt(t,0.55)');
  });
});
