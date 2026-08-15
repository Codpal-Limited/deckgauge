/**
 * Wording shared by more than one resolver, so the payloads cannot drift into
 * describing the same thing two different ways.
 */

/**
 * Every id in a page-state payload is a Deckgauge-internal identifier, and
 * none of them can be matched to the person asking. `PageStateDeps` does carry
 * the caller's `userId`, but purely as an authorization input — it decides what
 * the roadmap read may return, and nothing in any payload is keyed by it
 * (`employeeId` and `orgTreeId` are not user ids, and there is no join here
 * from a `User` to either). So a payload row still cannot be attributed to
 * "you" by this tool, and a model that guesses will confidently describe
 * someone else's configuration as the user's own. The note says that in the
 * payload itself rather than trusting the system prompt to cover it, because
 * the prompt does not know which fields are ids.
 *
 * `fields` names the id fields of the payload it is attached to, so the model
 * is told about the exact fields it can see rather than a generic warning.
 */
export function internalIdentifiersNote(fields: string): string {
  return (
    `${fields} are Deckgauge-internal identifiers, not names or logins. None of them can be matched to the person asking: ` +
    'it cannot tell which of these records is theirs, and nothing in this payload marks one as "yours". ' +
    "Do not claim that a specific person's rules or settings apply unless the user supplied a name that matches a name " +
    'present in this payload — otherwise describe which layers exist and say plainly that you cannot tell which one covers them.'
  );
}

/**
 * What a `*Truncated: true` flag means. Instance-wide reads are capped (see
 * `MAX_CONFIG_ROWS`), so a partial list must never be presented as the whole
 * configuration.
 */
export const TRUNCATION_NOTE =
  'Any field ending in Truncated means the list next to it was capped: more rows exist than are shown, so do not treat that list as complete or answer "there are only N" from it.';

/**
 * Bound on every instance-wide configuration list a resolver reports.
 *
 * Deliberately larger than the roadmap resolver's per-chain cap of 20: these
 * are instance-wide configuration tables (org trees, status rules, retired
 * projects) where the complete list is usually the useful answer and is still
 * small, whereas a roadmap chain is one of potentially many per board. The
 * shape of the bound is the same either way — a cap plus an explicit
 * truncation flag — which is what keeps the surface consistent.
 */
export const MAX_CONFIG_ROWS = 50;
