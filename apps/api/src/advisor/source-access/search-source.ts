import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PathAllowlist } from './path-allowlist.js';
import { ALLOWED_SOURCE_EXTENSIONS } from './source-roots.js';

/** From the spec: "up to 20 hits as `path:line` with a one-line window". */
export const MAX_HITS = 20;

/** Per-file share of those 20, so one long file cannot hide every other root. */
export const MAX_HITS_PER_FILE = 3;

/** Hard bound on the walk, so a pathological tree cannot turn one question into a full scan. */
export const MAX_FILES_SCANNED = 3000;

/** "each capped in length" — a minified line would otherwise be the whole answer. */
export const MAX_HIT_LINE_CHARS = 200;

/** Directories that are never source, and would dominate the walk if visited. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

export interface SourceHit {
  /** Root-relative path, as `path:line` is more readable than an absolute one. */
  path: string;
  line: number;
  text: string;
}

export interface SearchSourceResult {
  hits: SourceHit[];
  hitsTruncated: boolean;
  filesScanned: number;
  note?: string;
}

/**
 * Case-insensitive substring search across the allowed source roots.
 *
 * **No ripgrep.** The api image is `node:20`-based with no `rg`, and adding a
 * binary would be a new supply-chain dependency for a tool the spec already
 * orders last. A Node walk over three source trees is a few thousand `readFile`s
 * worst case, bounded by `MAX_FILES_SCANNED`.
 *
 * **Whole-query substring, not term splitting.** A natural-language question
 * matches nothing under AND and everything under OR, and both failure modes look
 * like a working search from the outside — the model would either wrongly
 * conclude the feature does not exist, or drown in noise. So the contract is the
 * one a developer already understands: pass an identifier or an exact phrase.
 * A zero-hit result says exactly that, so the retry is obvious rather than
 * guessed.
 *
 * Symlinks are skipped for files AND directories: a symlinked directory is how a
 * walk leaves the tree, which the per-path allowlist alone would not prevent
 * here because the walk never asks it about directories.
 *
 * Results are sorted by path then line, so the same question twice gives the
 * same answer — a tool whose output reorders between calls makes an answer
 * impossible to reproduce when someone disputes it.
 */
export async function searchSourceLines(
  allowlist: PathAllowlist,
  input: { query: string },
): Promise<SearchSourceResult> {
  const needle = input.query.trim().toLowerCase();
  if (!needle) {
    return {
      hits: [],
      hitsTruncated: false,
      filesScanned: 0,
      note: 'Give an identifier, symbol name, or exact phrase to search for.',
    };
  }

  const hits: SourceHit[] = [];
  let filesScanned = 0;
  let hitsTruncated = false;

  for (const root of allowlist.roots) {
    for await (const absolutePath of walkSourceFiles(root)) {
      if (filesScanned >= MAX_FILES_SCANNED) {
        hitsTruncated = true;
        break;
      }
      filesScanned += 1;

      const found = await matchesInFile(absolutePath, root, needle);
      for (const hit of found) {
        if (hits.length >= MAX_HITS) {
          hitsTruncated = true;
          break;
        }
        hits.push(hit);
      }
    }
  }

  hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));

  return {
    hits,
    hitsTruncated,
    filesScanned,
    note:
      hits.length === 0
        ? `No line in the readable source contains "${input.query.trim()}". Try a single identifier or symbol name rather than a sentence, or answer without the source.`
        : undefined,
  };
}

async function* walkSourceFiles(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // Unreadable directory: skip it rather than failing the whole search.
  }

  for (const entry of entries) {
    // Rejected before any stat: a symlink is never followed, in either
    // direction, so the walk cannot be steered out of the source tree.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walkSourceFiles(full);
    } else if (entry.isFile() && ALLOWED_SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

async function matchesInFile(
  absolutePath: string,
  root: string,
  needle: string,
): Promise<SourceHit[]> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, 'utf8');
  } catch {
    return []; // A file that vanished or is unreadable is not an error worth failing on.
  }

  const relative = path.relative(root, absolutePath);
  const found: SourceHit[] = [];
  const lines = raw.split('\n');

  for (let index = 0; index < lines.length && found.length < MAX_HITS_PER_FILE; index += 1) {
    const line = lines[index]!;
    if (!line.toLowerCase().includes(needle)) continue;
    found.push({ path: relative, line: index + 1, text: capLine(line) });
  }
  return found;
}

/** Indentation carries no information in a one-line window, so the cap spends its budget on code. */
function capLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_HIT_LINE_CHARS ? `${trimmed.slice(0, MAX_HIT_LINE_CHARS - 1)}…` : trimmed;
}
