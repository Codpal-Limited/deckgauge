import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';
import type { BoardScope } from '../intelligence/board-scope.js';

export interface AdvisorToolDeps {
  intel: ClickhouseIntelligenceService;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AdvisorToolSpec<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, scope: BoardScope, deps: AdvisorToolDeps) => Promise<unknown>;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// The single source of truth for the read-only, board-scoped advisor tools.
// Both the AI-SDK loop (buildAdvisorTools) and the MCP server derive from this.
// `scope` is deliberately NOT part of any inputSchema — the model cannot widen it.
export const ADVISOR_TOOL_SPECS: AdvisorToolSpec[] = [
  {
    name: 'get_team_overview',
    description:
      'Team KPIs (PRs merged, median cycle time, active devs, AI-assisted %) over the last N days for this board.',
    inputSchema: z.object({ fromDays: z.number().int().min(1).max(365).default(90) }),
    handler: ({ fromDays }, scope, { intel }) =>
      intel.getTeamOverview(daysAgo(fromDays), new Date(), scope),
  },
  {
    name: 'find_slowdowns',
    description: 'Developers whose merge throughput dropped sharply recently vs. their baseline.',
    inputSchema: z.object({ thresholdPct: z.number().max(0).default(-0.4) }),
    handler: ({ thresholdPct }, scope, { intel }) => intel.detectSlowdownAnomalies(thresholdPct, scope),
  },
  {
    name: 'get_ai_breakdown',
    description: 'AI-assisted PR share per developer over the last N days.',
    inputSchema: z.object({ fromDays: z.number().int().min(1).max(365).default(90) }),
    handler: ({ fromDays }, scope, { intel }) => intel.getAiBreakdownByDeveloper(daysAgo(fromDays), scope),
  },
  {
    name: 'get_ticket_timeline',
    description: 'Unified activity timeline (Jira/GitHub/GitLab/ADO) for one ticket key.',
    inputSchema: z.object({ ticketKey: z.string().min(1) }),
    handler: ({ ticketKey }, scope, { intel }) => intel.getTicketTimeline(ticketKey, scope),
  },
];

// `scope` is captured from the closure; never a tool input field.
export function buildAdvisorTools(deps: AdvisorToolDeps, scope: BoardScope): ToolSet {
  const out: ToolSet = {};
  for (const spec of ADVISOR_TOOL_SPECS) {
    out[spec.name] = tool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (input) => spec.handler(input, scope, deps),
    });
  }
  return out;
}
