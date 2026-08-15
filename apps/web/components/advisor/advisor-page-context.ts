/**
 * What the Advisor knows about the page the user is on.
 *
 * A pure function over `pathname` — no hooks, so it is unit-testable and can
 * be called from both the launcher and the panel without a provider. The
 * `key` is the stable identity used for teaser dismissal storage and sent to
 * the API as `pageContext.key`; it deliberately collapses dynamic segments
 * (every `/org/<id>` is one `org`) so a teaser is dismissed once, not once
 * per org tree.
 */
export interface AdvisorPageContext {
  key: string;
  label: string;
  starters: readonly string[];
  teaser: string;
  /** True only on the board view, where board data tools are available. */
  isBoard: boolean;
  /**
   * The standalone `Roadmap` entity's id, when the route is showing one.
   * Web-side only — this does NOT join `AdvisorPageContextDto` (`{ key,
   * label }`), which is the only slice of page context that goes over the
   * wire as `pageContext`. The id itself travels as its own top-level
   * `roadmapId` field on the help-ask request, mirroring `boardId`. Also
   * deliberately kept OUT of `key`: `key` collapses every `/roadmap/<id>` so
   * the teaser is dismissed once, not once per roadmap (see the module
   * docstring) — folding the id into it would defeat that.
   */
  entityId?: string;
}

const BOARD: AdvisorPageContext = {
  key: 'board',
  label: 'this board',
  starters: [
    'How is this team trending over the last month?',
    'Who has slowed down recently, and why?',
    'What is the AI-assisted share of our PRs?',
  ],
  teaser: 'Want a read on this board? Ask me anything about the numbers.',
  isBoard: true,
};

/**
 * The off-board fallback. Exported because `AdvisorPanel` needs it directly:
 * `resolveAdvisorPageContext` is a pure function of the pathname, so on `/` it
 * returns BOARD even in the case where no board is bound to the conversation
 * and the panel is really in product-help mode — see the panel for that case.
 */
export const ADVISOR_GENERIC_PAGE_CONTEXT: AdvisorPageContext = {
  key: 'generic',
  label: 'Deckgauge',
  starters: [
    'What can you help me with?',
    'How do I connect a data source?',
    'What does Deckgauge measure?',
  ],
  teaser: 'New here? Ask me how any part of Deckgauge works.',
  isBoard: false,
};

// Ordered longest-prefix-first: '/settings/timesheet-statuses' must be tested
// before '/settings' or it would resolve to the settings fallback.
const PAGES: readonly (readonly [string, AdvisorPageContext])[] = [
  [
    '/settings/timesheet-statuses',
    {
      key: 'timesheet-statuses',
      label: 'Status rules',
      starters: [
        'Which statuses count as in progress?',
        'How do role and employee rules override the default?',
        'Why is a status still billing hours?',
      ],
      teaser: 'Not sure which statuses count as in progress? I can explain the rules.',
      isBoard: false,
    },
  ],
  [
    '/timesheet',
    {
      key: 'timesheet',
      label: 'Timesheet',
      starters: [
        'Which statuses count as in progress here?',
        'Why are hours showing for a retired project?',
        'How is the blended rate applied to CAPEX?',
      ],
      teaser: 'Wondering how these hours are counted? Ask me.',
      isBoard: false,
    },
  ],
  [
    '/sources',
    {
      key: 'sources',
      label: 'Sources',
      starters: [
        'How do I sync from Jira?',
        'Why is a source not bringing in data?',
        'What does each sync toggle control?',
      ],
      teaser: 'Need a hand connecting Jira? I can walk you through it.',
      isBoard: false,
    },
  ],
  [
    '/connections',
    {
      key: 'connections',
      label: 'Connections',
      starters: [
        'What access does each connection need?',
        'Why did my token stop working?',
        'How do I reconnect a source?',
      ],
      teaser: 'Token trouble? Ask me what each connection needs.',
      isBoard: false,
    },
  ],
  [
    '/roadmap',
    {
      key: 'roadmap',
      label: 'Roadmap',
      starters: [
        'Why is one item scheduled after another?',
        'How do sizes turn into durations?',
        'What does a pinned date change?',
      ],
      teaser: 'Curious why an item sits where it does? Ask me.',
      isBoard: false,
    },
  ],
  [
    '/org',
    {
      key: 'org',
      label: 'Org tree',
      starters: [
        'How is the leaderboard scored?',
        'Why does someone show no activity?',
        'How are people matched to their commits?',
      ],
      teaser: 'Numbers look off for someone? Ask me how matching works.',
      isBoard: false,
    },
  ],
  [
    '/comparison',
    {
      key: 'comparison',
      label: 'Comparison',
      starters: [
        'What do these boards have in common?',
        'How are the comparison metrics calculated?',
        'Why is a board missing data here?',
      ],
      teaser: 'Comparing boards? I can explain what each metric means.',
      isBoard: false,
    },
  ],
  [
    '/boards',
    {
      key: 'boards',
      label: 'Boards',
      starters: [
        'What do the board templates give me?',
        'How do groups and views work?',
        'How do I give someone access to a board?',
      ],
      teaser: 'Setting up a board? Ask me which template fits.',
      isBoard: false,
    },
  ],
  [
    '/settings',
    {
      key: 'settings',
      label: 'Settings',
      starters: [
        'What does each setting affect?',
        'How do I configure the Advisor?',
        'Who can change these settings?',
      ],
      teaser: 'Not sure what a setting does? Ask before you change it.',
      isBoard: false,
    },
  ],
];

/**
 * The roadmap entity's id, when `pathname` is showing one.
 *
 * `/roadmap/[id]` is the standalone `Roadmap` entity page and its id is a
 * PATH SEGMENT — unlike the board's, which is a query parameter (see
 * `resolveAdvisorBoardId`'s docstring in `advisor-route.ts` for why boards
 * differ). The bare `/roadmap` route names no entity, so this returns
 * `undefined` for it.
 */
function extractRoadmapEntityId(pathname: string): string | undefined {
  const match = /^\/roadmap\/([^/]+)/.exec(pathname);
  return match ? match[1] : undefined;
}

export function resolveAdvisorPageContext(pathname: string | null): AdvisorPageContext {
  if (!pathname) return ADVISOR_GENERIC_PAGE_CONTEXT;
  if (pathname === '/') return BOARD;
  // Exact match or a full path SEGMENT match, so '/timesheets-archive' does
  // not resolve to the timesheet page.
  const match = PAGES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!match) return ADVISOR_GENERIC_PAGE_CONTEXT;
  const [prefix, page] = match;
  if (prefix === '/roadmap') {
    const entityId = extractRoadmapEntityId(pathname);
    // Only ever return a COPY when attaching an id — `page` is a shared
    // module-level PAGES entry, and mutating it in place would leak the
    // last-resolved id to every later `/roadmap/*` call.
    return entityId ? { ...page, entityId } : page;
  }
  return page;
}
