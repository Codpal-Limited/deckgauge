/**
 * A deliberately small Markdown subset — enough for what the advisor actually
 * emits (paragraphs, lists, headings, tables, code, and inline emphasis) and
 * nothing more. Parsing to a node tree rather than to HTML keeps the renderer
 * free of `dangerouslySetInnerHTML`.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; href: string };

export interface ParagraphBlock {
  type: 'paragraph';
  inline: InlineNode[];
}

export interface HeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3;
  inline: InlineNode[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: InlineNode[][];
}

export interface TableBlock {
  type: 'table';
  header: InlineNode[][];
  rows: InlineNode[][][];
}

export interface CodeBlock {
  type: 'code';
  value: string;
}

export type MarkdownBlock = ParagraphBlock | HeadingBlock | ListBlock | TableBlock | CodeBlock;

const FENCE = /^\s*```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.+)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.+)$/;
const TABLE_DELIMITER = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;
const SAFE_HREF = /^(https?:|mailto:|\/)/i;

// Ordered so the greedier/most-literal forms win: a code span swallows its
// contents verbatim, and `**bold**` is tried before `*italic*`.
const INLINE = new RegExp(
  [
    '`([^`]+)`',
    '\\[([^\\]]+)\\]\\(([^)\\s]+)\\)',
    '\\*\\*([^*]+)\\*\\*',
    '__([^_]+)__',
    '\\*([^*\\n]+)\\*',
    '_([^_\\n]+)_',
  ].join('|'),
  'g'
);

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let lastIndex = 0;

  const pushText = (value: string) => {
    if (value) nodes.push({ type: 'text', value });
  };

  for (const match of source.matchAll(INLINE)) {
    const [raw, code, linkText, href, boldStar, boldUnderscore, italicStar, italicUnderscore] =
      match;
    const start = match.index ?? 0;
    pushText(source.slice(lastIndex, start));
    lastIndex = start + raw.length;

    if (code !== undefined) {
      nodes.push({ type: 'code', value: code });
    } else if (linkText !== undefined) {
      // An unsafe protocol loses its link but keeps its words — the reader
      // still sees the text, just not something clickable.
      if (SAFE_HREF.test(href)) nodes.push({ type: 'link', value: linkText, href });
      else pushText(linkText);
    } else if (boldStar !== undefined || boldUnderscore !== undefined) {
      nodes.push({ type: 'bold', value: boldStar ?? boldUnderscore });
    } else {
      nodes.push({ type: 'italic', value: italicStar ?? italicUnderscore });
    }
  }

  pushText(source.slice(lastIndex));
  return nodes;
}

function splitTableRow(line: string): InlineNode[][] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => parseInline(cell.trim()));
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', inline: parseInline(text) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', value: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        inline: parseInline(heading[2]),
      });
      continue;
    }

    // A table is only a table when the row after the header is a delimiter —
    // otherwise a sentence containing a pipe would be swallowed.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: InlineNode[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const bullet = BULLET_ITEM.exec(line);
    const item = bullet ?? ORDERED_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = bullet === null;
      const items: InlineNode[][] = [parseInline(item[1])];
      while (i + 1 < lines.length) {
        const next = ordered ? ORDERED_ITEM.exec(lines[i + 1]) : BULLET_ITEM.exec(lines[i + 1]);
        if (!next) break;
        items.push(parseInline(next[1]));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}
