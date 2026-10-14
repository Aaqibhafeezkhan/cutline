/** Inline spans: **bold**, *italic* / _italic_, `code`. */
export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code'; text: string };

export type Block =
  | { kind: 'p'; lines: Inline[][] }
  | { kind: 'ul' | 'ol'; items: Inline[][] }
  | { kind: 'pre'; text: string };

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*|\b_[^_\n]+_\b)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const token = m[0];
    const at = m.index;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    if (token.startsWith('**')) out.push({ kind: 'bold', text: token.slice(2, -2) });
    else if (token.startsWith('`')) out.push({ kind: 'code', text: token.slice(1, -1) });
    else out.push({ kind: 'italic', text: token.slice(1, -1) });
    last = at + token.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * A deliberately small markdown subset for chat replies: paragraphs, "- " and
 * "1. " lists, ``` code fences and inline bold/italic/code. Everything else is
 * plain text (rendered as React text nodes, never as HTML).
 */
export function parseMarkdownLite(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let para: Inline[][] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', lines: para });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) {
        code.push(lines[i]!);
      }
      blocks.push({ kind: 'pre', text: code.join('\n') });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const prev = blocks.at(-1);
      const parsed = parseInline(item[1]!);
      if (prev && prev.kind === kind) prev.items.push(parsed);
      else blocks.push({ kind, items: [parsed] });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // Headings degrade to bold lines.
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    para.push(heading ? [{ kind: 'bold', text: heading[1]! }] : parseInline(line));
  }
  flush();
  return blocks;
}
