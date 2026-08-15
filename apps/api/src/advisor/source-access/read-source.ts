import { readFile } from 'node:fs/promises';
import type { PathAllowlist } from './path-allowlist.js';

/** Line budget, from the spec: "bounded excerpt, max 200 lines / 8KB". */
export const MAX_READ_LINES = 200;

/** Byte budget, independent of the line budget — see `clampToByteBudget`. */
export const MAX_READ_BYTES = 8192;

export type ReadSourceResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** Root-relative, as the allowlist reported it — never the container's absolute path. */
      path: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      text: string;
      /** True when the file continues past `endLine`, for any reason. */
      truncated: boolean;
    };

export interface ReadSourceInput {
  path: string;
  startLine?: number;
  lineCount?: number;
}

/**
 * A bounded excerpt of one allowed source file.
 *
 * Two caps apply independently, and the tighter one wins: 200 lines is the line
 * budget, 8KB the byte budget. Both are needed — a generated or minified file
 * blows 8KB long before it reaches 200 lines, while a file of short lines hits
 * 200 lines while still tiny — and a model handed a silent partial file will
 * reason about code it never saw, so `truncated` is always reported.
 */
export async function readSourceExcerpt(
  allowlist: PathAllowlist,
  input: ReadSourceInput,
): Promise<ReadSourceResult> {
  const startLine = input.startLine ?? 1;
  const requestedCount = input.lineCount ?? MAX_READ_LINES;
  if (!isPositiveInteger(startLine) || !isPositiveInteger(requestedCount)) {
    return { ok: false, reason: 'startLine and lineCount must be whole numbers of 1 or more.' };
  }

  const allowed = await allowlist.resolve(input.path);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const raw = await readFile(allowed.absolutePath, 'utf8');
  const allLines = splitLines(raw);
  const lineCount = Math.min(requestedCount, MAX_READ_LINES);

  const sliced = allLines.slice(startLine - 1, startLine - 1 + lineCount);
  const { lines: kept, byteCapped } = clampToByteBudget(sliced);
  // `endLine` is where the excerpt actually stops. With a `startLine` past the
  // end there is nothing to show, and reporting `totalLines` says so plainly
  // alongside the empty text.
  const endLine = kept.length > 0 ? startLine + kept.length - 1 : allLines.length;

  return {
    ok: true,
    path: allowed.relativePath,
    startLine,
    endLine,
    totalLines: allLines.length,
    text: kept.join('\n'),
    truncated: byteCapped || endLine < allLines.length,
  };
}

/**
 * A file ending in a newline would otherwise split into a phantom empty last
 * element, making every file look one line longer than it is — and the model
 * would cite a line number that does not exist.
 */
function splitLines(raw: string): string[] {
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Trims to `MAX_READ_BYTES` on a **line** boundary: half a line of code reads as
 * a syntax error to a model, which is worse than a shorter honest excerpt.
 *
 * The exception is a first line already over budget — a minified bundle on one
 * line. Returning nothing there would be the least useful possible answer, so
 * that single line is cut mid-line and flagged.
 */
function clampToByteBudget(lines: readonly string[]): { lines: string[]; byteCapped: boolean } {
  const kept: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    const cost = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0); // +1 for the joining newline
    if (bytes + cost > MAX_READ_BYTES) {
      if (kept.length === 0) {
        return { lines: [cutToBytes(line, MAX_READ_BYTES)], byteCapped: true };
      }
      return { lines: kept, byteCapped: true };
    }
    kept.push(line);
    bytes += cost;
  }
  return { lines: kept, byteCapped: false };
}

/** Cuts on a whole-character boundary, so the excerpt never ends mid-codepoint. */
function cutToBytes(line: string, budget: number): string {
  const buffer = Buffer.from(line, 'utf8').subarray(0, budget);
  return new TextDecoder('utf8', { fatal: false }).decode(buffer).replace(/�+$/, '');
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}
