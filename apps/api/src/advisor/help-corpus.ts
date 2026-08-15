import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HelpDoc {
  slug: string;
  title: string;
  body: string;
}

const DEFAULT_LIMIT = 3;
const TITLE_WEIGHT = 3;

/**
 * Acceptance bar for a hit. See `searchHelpCorpus` for the rule these two
 * constants express, and why "one body-term match" was not enough.
 */
const MIN_MATCHED_TERMS = 2;
const MIN_QUERY_TERMS_FOR_BODY_ONLY = 3;

// Words too common to carry meaning — without this, "how do I …" matches
// every doc and the model gets three irrelevant hits instead of none.
//
// The second block was added after the curated starter questions were run
// through the real corpus: every one of them matched on a filler word rather
// than on its subject ("into" in "how do sizes turn into durations", "applied"
// aside, "these" in "who can change these settings"), and a hit is worse than
// a miss here because it suppresses the tool's "not covered" note.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to', 'via', 'was', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
  'into', 'these', 'those', 'each', 'about', 'still', 'other', 'same', 'just',
  'here', 'there', 'also', 'much', 'many', 'some', 'any', 'did', 'use', 'used',
  'uses', 'using', 'mean', 'means', 'work', 'works', 'working',
]);

/**
 * Folds a simple plural onto its singular so "sizes"/"durations" match
 * "size"/"duration". A trailing-`s` strip, deliberately not a stemmer: the
 * only property that matters is that the query and the corpus fold
 * IDENTICALLY, and a real stemmer would be a dependency for seven short docs.
 *
 * `ss` is left alone so "progress" and "access" survive intact — they are
 * subject words in this corpus, not plurals.
 */
function foldPlural(term: string): string {
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

function terms(text: string): string[] {
  return (
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      // Stopwords are dropped BEFORE folding as well as after: folding first
      // would turn "this" into "thi" and "does" into "doe", smuggling both
      // past the set that exists to remove them.
      .filter((term) => !STOPWORDS.has(term))
      .map(foldPlural)
      .filter((term) => term.length > 2 && !STOPWORDS.has(term))
  );
}

/** Loads every markdown doc shipped in `./help`, titled from its first H1. */
export function loadHelpCorpus(
  dir = join(dirname(fileURLToPath(import.meta.url)), 'help'),
): HelpDoc[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Degrade to an empty corpus rather than taking the whole API down.
    // `tsc --build` does not copy `.md` files, so `node dist/index.js` resolves
    // this directory to somewhere that does not exist — and this function is
    // called from `AdvisorHelpService`'s constructor, which `advisorHelpRoutes`
    // runs in its plugin factory body, so an ENOENT here propagates out of
    // `buildServer()`. A missing documentation corpus must cost the product
    // help feature, not the entire server.
    return [];
  }

  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      let raw: string;
      try {
        raw = readFileSync(join(dir, name), 'utf8');
      } catch {
        // A single unreadable doc is not worth failing the other six for.
        return null;
      }
      const lines = raw.split('\n');
      const headingIndex = lines.findIndex((line) => line.startsWith('# '));
      const heading = headingIndex === -1 ? undefined : lines[headingIndex];
      return {
        slug: name.replace(/\.md$/, ''),
        title: heading === undefined ? name.replace(/\.md$/, '') : heading.slice(2).trim(),
        body: lines.slice(headingIndex + 1).join('\n').trim(),
      };
    })
    .filter((doc): doc is HelpDoc => doc !== null);
}

/**
 * Keyword search over the corpus, title-weighted.
 *
 * Deliberately not embeddings: seven short docs do not justify a vector
 * dependency, and returning NOTHING on a miss is a feature — it is what lets
 * the model say "the docs don't cover this" instead of quoting the closest
 * unrelated paragraph.
 *
 * ## The acceptance rule, and why it is not "score > 0"
 *
 * A doc is a hit only when EITHER:
 *
 * 1. a query term matches its **title or slug** — the doc's own curated topic
 *    label, so a match there really is evidence the doc is about the question;
 *    or
 * 2. at least `MIN_MATCHED_TERMS` distinct query terms match anywhere, AND the
 *    question had at least `MIN_QUERY_TERMS_FOR_BODY_ONLY` content terms to
 *    begin with.
 *
 * The bar used to be "one body-term match", which is why every curated starter
 * question retrieved confidently irrelevant docs: "How is the blended rate
 * applied to CAPEX?" returned the org-tree doc on the word "applied". Clause 2
 * is the "proportional to the query's term count" half — a two-word question
 * whose only two words are generic product nouns ("change", "settings") could
 * otherwise clear a flat two-term bar against three unrelated docs, and now
 * clears nothing, which is the correct answer for a topic the corpus does not
 * cover.
 *
 * The slug is folded into the title index because a slug is a hand-written
 * topic name and often carries the word the H1 doesn't: `connecting-sources`
 * supplies "source" for "How do I connect a data source?", which its own title
 * ("Connecting Jira, GitHub, GitLab, and Azure DevOps") never mentions.
 */
export function searchHelpCorpus(
  docs: readonly HelpDoc[],
  query: string,
  limit = DEFAULT_LIMIT,
): HelpDoc[] {
  // Distinct terms: a question that repeats a word must not clear the
  // two-term bar on that word alone.
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];

  return docs
    .map((doc) => {
      const labelTerms = new Set([...terms(doc.title), ...terms(doc.slug.replace(/-/g, ' '))]);
      const bodyTerms = terms(doc.body);
      const bodySet = new Set(bodyTerms);
      let score = 0;
      let titleHits = 0;
      let matchedTerms = 0;
      // Total occurrences of the query's terms in the body — the tie-break
      // below, so two docs that merely mention the same terms are separated by
      // which one actually dwells on them.
      let depth = 0;
      for (const term of queryTerms) {
        const inLabel = labelTerms.has(term);
        const inBody = bodySet.has(term);
        if (inLabel) {
          titleHits += 1;
          score += TITLE_WEIGHT;
        }
        if (inBody) score += 1;
        if (inLabel || inBody) matchedTerms += 1;
        depth += bodyTerms.reduce((total, bodyTerm) => total + (bodyTerm === term ? 1 : 0), 0);
      }
      return { doc, score, titleHits, matchedTerms, depth };
    })
    .filter(
      (hit) =>
        hit.titleHits > 0 ||
        (hit.matchedTerms >= MIN_MATCHED_TERMS &&
          queryTerms.length >= MIN_QUERY_TERMS_FOR_BODY_ONLY),
    )
    .sort(
      (a, b) => b.score - a.score || b.depth - a.depth || a.doc.slug.localeCompare(b.doc.slug),
    )
    .slice(0, limit)
    .map((hit) => hit.doc);
}
