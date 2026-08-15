/**
 * Maps the advisor API's machine error codes onto operator-facing copy.
 *
 * The ask route (`apps/api/src/advisor/advisor.routes.ts`) answers failures
 * with a bare `{ error: "<code>" }` JSON body, and the panel used to render
 * that string verbatim — so a missing provider surfaced in the UI as the
 * literal word `advisor_not_configured`, which tells an operator nothing
 * about what to do next. Everything the API can return gets a sentence here,
 * plus a link when the operator can fix it themselves.
 */

export interface AdvisorErrorCopy {
  message: string;
  /** Set only when the operator can resolve this themselves in the app. */
  actionHref?: string;
  actionLabel?: string;
}

const SETTINGS_ACTION = {
  actionHref: '/settings/advisor',
  actionLabel: 'Open Advisor settings',
} as const;

const MALFORMED_REQUEST_MESSAGE =
  'The advisor could not understand that request. Reload the page and try again.';

const SESSION_EXPIRED_MESSAGE = 'Your session has expired — sign in again to ask the advisor.';

const KNOWN_ERRORS: Record<string, AdvisorErrorCopy> = {
  advisor_not_configured: {
    message:
      'No advisor model is configured yet. Add an Anthropic API key or a local Ollama server, ' +
      'or run the local-agent bridge with `pnpm deckgauge:advisor`.',
    ...SETTINGS_ACTION,
  },
  // `Unauthorized` comes from `board-access.middleware.ts`'s `requireBoardAccess`
  // (and the same literal kept in `advisor-help.routes.ts`'s own 401 fallback).
  // `Authentication required` is the SEPARATE 401 body the declarative policy
  // layer sends (`apps/api/src/auth/policy.ts`'s `DENY_401`, sent by
  // `buildPolicyPlugin`'s preHandler for every `board(...)`/`AUTHENTICATED`
  // route, including `/boards/:boardId/advisor/ask` and
  // `/advisor/help/ask`). Which one a caller sees depends on which layer denies
  // first, not on which route was hit — both must read as the same expired-
  // session copy, so both keys are listed here rather than only one.
  Unauthorized: { message: SESSION_EXPIRED_MESSAGE },
  'Authentication required': { message: SESSION_EXPIRED_MESSAGE },
  Forbidden: {
    message: 'You need at least viewer access to this board to ask the advisor about it.',
  },
  'invalid request': { message: MALFORMED_REQUEST_MESSAGE },
  board_id_mismatch: { message: MALFORMED_REQUEST_MESSAGE },
};

const GENERIC_MESSAGE = 'The advisor could not answer that question.';

export function describeAdvisorError(code: string | undefined): AdvisorErrorCopy {
  if (!code) {
    return { message: GENERIC_MESSAGE };
  }
  // Unrecognised codes still reach the user rather than being swallowed — a
  // future API error stays diagnosable — but as a parenthetical detail on a
  // readable sentence instead of as the entire message.
  return KNOWN_ERRORS[code] ?? { message: `${GENERIC_MESSAGE} (${code})` };
}
