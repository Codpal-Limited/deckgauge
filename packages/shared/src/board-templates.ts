/**
 * Board templates — the seed configuration a new board starts from.
 *
 * A template is pure data: which pipeline groups, which columns, which auxiliary
 * views (dashboard / roadmap), and which board `kind` a freshly created board gets.
 * Templates configure the *Project* board domain only. Adding a new board type =
 * adding a template here, not a new board implementation.
 *
 * The org/employee board is a SEPARATE domain (OrgEmployee, org chart hierarchy,
 * Graph sync) — it is intentionally NOT a template here; the "New board" picker
 * surfaces it as a routing entry that creates an org tree instead. See
 * planning/RECRUITMENT-PHASE-1.md.
 *
 * NOTE: distinct from board-grid-template.ts (that is the CSS grid layout).
 */

export const BOARD_KINDS = ['blank', 'development', 'recruitment'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

/**
 * Kind for a board created without an explicit template. "development" reproduces
 * the historical default board (Size column + engineering-intelligence dashboard +
 * roadmap), so existing behaviour is preserved when no template is chosen.
 */
export const DEFAULT_BOARD_KIND: BoardKind = 'development';

/** Column types supported by the board (mirrors the Prisma `ColumnType` enum). */
export type TemplateColumnType =
  | 'TEXT'
  | 'STATUS'
  | 'DATE'
  | 'NUMBER'
  | 'CHECKBOX'
  | 'DROPDOWN'
  | 'PERSON'
  | 'LINK';

/** Config for a STATUS/DROPDOWN column — its options and per-option colors. */
export interface TemplateColumnConfig {
  options: string[];
  optionColors: Record<string, string>;
}

export interface TemplateColumn {
  name: string;
  type: TemplateColumnType;
  config?: TemplateColumnConfig;
}

export interface TemplateGroup {
  name: string;
  color: string;
}

/** Richer copy for the Create dialog (the flyout preview uses `description`). */
export interface BoardTemplateExplainer {
  /** One short paragraph describing what the board is for. */
  summary: string;
  /** 2–3 "what you get" bullets. */
  highlights: readonly string[];
}

/** Auxiliary views a template seeds, beyond the always-present BOARD view. */
export interface TemplateViews {
  /** Dashboard preset to seed, or null for no dashboard (statistics). */
  dashboard: 'engineering-intelligence' | null;
  /**
   * Whether to seed the Team Focus view. Only delivery boards have the
   * tracker data it reads, so it is seeded — and its opt-in banner offered —
   * on development boards alone.
   */
  focus: boolean;
  /** Whether to seed a ROADMAP view + its config. */
  roadmap: boolean;
}

export interface BoardTemplate {
  kind: BoardKind;
  /** Shown in the "New board" template picker. */
  label: string;
  /** One-line helper text under the label. */
  description: string;
  /** Richer copy for the Create dialog (the flyout preview uses `description`). */
  explainer: BoardTemplateExplainer;
  /** Seed the default "Size" status column (the roadmap's size source). */
  includeSizeColumn: boolean;
  /** Pipeline groups to seed, in order. Empty for non-pipeline boards. */
  groups: readonly TemplateGroup[];
  /** Custom columns to seed, in order, after the Size column (if present). */
  extraColumns: readonly TemplateColumn[];
  /** Which auxiliary views to seed. */
  views: TemplateViews;
}

/** Decision-column options for the recruitment pipeline. */
export const RECRUITMENT_DECISION_OPTIONS = ['Pending', 'Pass', 'Hold', 'Fail'] as const;

const RECRUITMENT_DECISION_CONFIG: TemplateColumnConfig = {
  options: [...RECRUITMENT_DECISION_OPTIONS],
  // Drawn from the board status palette so the pill looks at home on the board.
  optionColors: {
    Pending: '#C4C4C4',
    Pass: '#00C875',
    Hold: '#FDAB3D',
    Fail: '#E44258',
  },
};

const BLANK_TEMPLATE: BoardTemplate = {
  kind: 'blank',
  label: 'Blank board',
  description: 'An empty board — just rows and the status column.',
  explainer: {
    summary: 'A clean board with just rows and a status column — shape it however you like.',
    highlights: ['Start from scratch with no preset pipeline', 'Add your own columns and groups'],
  },
  includeSizeColumn: true,
  groups: [],
  extraColumns: [],
  views: { dashboard: null, focus: false, roadmap: false },
};

const DEVELOPMENT_TEMPLATE: BoardTemplate = {
  kind: 'development',
  label: 'Development',
  description:
    'Delivery board with the engineering-intelligence dashboard and roadmap. Connect Jira/GitHub/ADO/GitLab/Bitbucket after creating.',
  explainer: {
    summary:
      'A delivery board that turns your issue tracker and git activity into live engineering-intelligence analytics and a roadmap.',
    highlights: [
      'Connect Jira, GitHub, Azure DevOps, GitLab, or Bitbucket',
      'The engineering-intelligence dashboard fills in automatically',
      'The roadmap sizes itself from your issues',
    ],
  },
  includeSizeColumn: true,
  groups: [],
  extraColumns: [],
  views: { dashboard: 'engineering-intelligence', focus: true, roadmap: true },
};

const RECRUITMENT_TEMPLATE: BoardTemplate = {
  kind: 'recruitment',
  label: 'Recruitment',
  description: 'Track candidates through interview stages, with feedback, salary, and offers.',
  explainer: {
    summary: 'Track candidates through your interview pipeline, from sourced to hired.',
    highlights: [
      'Preset interview-stage groups',
      'Role, interview date, salary, and decision columns',
      'Ingest interviews from a connected calendar',
    ],
  },
  includeSizeColumn: false,
  groups: [
    { name: 'New / Sourced', color: '#579BFC' },
    { name: 'Interviewing', color: '#FDAB3D' },
    { name: 'Offer', color: '#A25DDC' },
    { name: 'Hired', color: '#00C875' },
    { name: 'Not moving forward', color: '#E44258' },
  ],
  extraColumns: [
    { name: 'Role', type: 'TEXT' },
    { name: 'Interview date', type: 'DATE' },
    { name: 'Salary expectation', type: 'NUMBER' },
    { name: 'Target start', type: 'DATE' },
    { name: 'Decision', type: 'STATUS', config: RECRUITMENT_DECISION_CONFIG },
  ],
  views: { dashboard: null, focus: false, roadmap: false },
};

const TEMPLATES: Record<BoardKind, BoardTemplate> = {
  blank: BLANK_TEMPLATE,
  development: DEVELOPMENT_TEMPLATE,
  recruitment: RECRUITMENT_TEMPLATE,
};

/** All templates, in picker order (most-used first). */
export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  DEVELOPMENT_TEMPLATE,
  RECRUITMENT_TEMPLATE,
  BLANK_TEMPLATE,
];

/** Narrow an arbitrary string to a known BoardKind. */
export function isBoardKind(value: string): value is BoardKind {
  return (BOARD_KINDS as readonly string[]).includes(value);
}

/** Look up a template by kind. */
export function getBoardTemplate(kind: BoardKind): BoardTemplate {
  return TEMPLATES[kind];
}
