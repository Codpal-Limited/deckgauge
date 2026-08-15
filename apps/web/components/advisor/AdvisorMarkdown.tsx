import { Fragment } from 'react';
import { parseMarkdown, type InlineNode, type MarkdownBlock } from './advisor-markdown';

interface AdvisorMarkdownProps {
  text: string;
  /** Chat bubbles come in two tints; links need to stay legible on both. */
  tone?: 'light' | 'dark';
}

/**
 * Code backgrounds on the light tint.
 *
 * `surface-2`, not `surface-1`: the panel itself is `surface-1`, which is pure
 * white in light mode — code set on `surface-1` inside it had no visible
 * background at all. `surface-2` is the inset token and reads as a fill against
 * the panel in both themes.
 */
const LIGHT_CODE_SURFACE = 'bg-surface-2';

function renderInline(nodes: InlineNode[], tone: 'light' | 'dark') {
  return nodes.map((node, idx) => {
    switch (node.type) {
      case 'bold':
        return (
          <strong key={idx} className="font-semibold">
            {node.value}
          </strong>
        );
      case 'italic':
        return (
          <em key={idx} className="italic">
            {node.value}
          </em>
        );
      case 'code':
        return (
          <code
            key={idx}
            className={
              tone === 'dark'
                ? 'rounded bg-white/20 px-1 py-0.5 font-mono text-[0.85em]'
                : `rounded ${LIGHT_CODE_SURFACE} px-1 py-0.5 font-mono text-[0.85em] text-slate-900`
            }
          >
            {node.value}
          </code>
        );
      case 'link':
        return (
          <a
            key={idx}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:no-underline"
          >
            {node.value}
          </a>
        );
      default:
        return <Fragment key={idx}>{node.value}</Fragment>;
    }
  });
}

function renderBlock(block: MarkdownBlock, key: number, tone: 'light' | 'dark') {
  switch (block.type) {
    case 'heading': {
      // The panel already owns h2, so message headings start one level down.
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1];
      const size =
        block.level === 1 ? 'text-[15px]' : block.level === 2 ? 'text-sm' : 'text-[13px]';
      return (
        <Tag key={key} className={`${size} font-semibold`}>
          {renderInline(block.inline, tone)}
        </Tag>
      );
    }
    case 'list':
      return block.ordered ? (
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {block.items.map((item, idx) => (
            <li key={idx}>{renderInline(item, tone)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {block.items.map((item, idx) => (
            <li key={idx}>{renderInline(item, tone)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr>
                {block.header.map((cell, idx) => (
                  <th
                    key={idx}
                    className={`border-b px-1.5 py-1 font-semibold ${
                      tone === 'dark' ? 'border-white/40' : 'border-slate-300'
                    }`}
                  >
                    {renderInline(cell, tone)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {row.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      className={`border-b px-1.5 py-1 ${
                        tone === 'dark' ? 'border-white/20' : 'border-slate-200'
                      }`}
                    >
                      {renderInline(cell, tone)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <pre
          key={key}
          className={
            tone === 'dark'
              ? 'overflow-x-auto rounded bg-white/15 p-2 font-mono text-[12px]'
              : `overflow-x-auto rounded ${LIGHT_CODE_SURFACE} p-2 font-mono text-[12px] text-slate-900`
          }
        >
          <code>{block.value}</code>
        </pre>
      );
    default:
      return (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(block.inline, tone)}
        </p>
      );
  }
}

export function AdvisorMarkdown({ text, tone = 'light' }: AdvisorMarkdownProps) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 leading-relaxed">
      {blocks.map((block, idx) => renderBlock(block, idx, tone))}
    </div>
  );
}
