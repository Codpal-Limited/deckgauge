/**
 * Turns bare http(s) URLs in Tiptap text nodes into `link`-marked text.
 *
 * The composer's Link extension autolinks as you type, but comments written
 * before that (or pasted text the autolinker skipped) were stored as plain
 * text. Linking at render time covers those without a data migration.
 * Trailing sentence punctuation is left outside the link.
 */
type Node = { type?: string; text?: string; marks?: Mark[]; content?: Node[]; [k: string]: unknown };
type Mark = { type: string; attrs?: Record<string, unknown> };

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

function linkMark(href: string): Mark {
  return { type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow' } };
}

function splitText(node: Node): Node[] {
  const text = node.text ?? '';
  if (node.marks?.some((m) => m.type === 'link' || m.type === 'code')) return [node];
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCT, '');
    if (!url || url.endsWith('//')) continue;
    const start = match.index ?? 0;
    if (start > last) out.push({ ...node, text: text.slice(last, start) });
    out.push({ ...node, text: url, marks: [...(node.marks ?? []), linkMark(url)] });
    last = start + url.length;
  }
  if (out.length === 0) return [node];
  if (last < text.length) out.push({ ...node, text: text.slice(last) });
  return out;
}

export function linkifyCommentContent<T>(doc: T): T {
  const walk = (node: Node): Node => {
    if (node.type === 'codeBlock' || !Array.isArray(node.content)) return node;
    return {
      ...node,
      content: node.content.flatMap((child) =>
        child && child.type === 'text' ? splitText(child) : [walk(child)],
      ),
    };
  };
  if (!doc || typeof doc !== 'object') return doc;
  return walk(doc as Node) as T;
}
