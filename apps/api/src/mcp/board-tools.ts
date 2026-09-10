import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { meetsBoardRole, type OrgRoleValue } from '@deckgauge/shared';
import { ADVISOR_TOOL_SPECS } from '../advisor/tools.js';
import { BoardReadsService } from '../advisor/board-reads.service.js';
import { ChangeSetService } from '../advisor/change-set/change-set.service.js';
import { AccessService } from '../access/access.service.js';
import { getBoardScope } from '../intelligence/board-scope.js';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';
import type { ChReadClient } from '../analytics/ch-read-scope.js';
import type { WidgetCache } from '../widgets/widget-cache.js';

/**
 * The MCP surface is always a user's own local coding agent — never a
 * configured server-side provider — so unlike `advisor.routes.ts` there is no
 * per-organization config to read a label from. Fixed here rather than
 * threaded through `BoardToolDeps` because it does not vary per request, per
 * caller, or per organization: every write this surface makes has the same
 * author. See `AdvisorToolDeps.verdictModelLabel`'s comment for the other half.
 */
const VERDICT_MODEL_LABEL = 'claude-code (local bridge)';

export interface BoardToolDeps {
  prisma: PrismaClient;
  intel: ClickhouseIntelligenceService;
  /**
   * The raw ClickHouse reader `focus-tools.service.ts`'s functions need
   * directly (`FocusDataDeps.clickhouse`) — they read ClickHouse themselves
   * rather than through `ClickhouseIntelligenceService`, so this cannot be
   * recovered from `intel` above. `mcp.routes.ts` threads through the SAME
   * request-scoped reader `intel` is built from.
   */
  clickhouse: ChReadClient;
  getUserId: () => string | null;
  /**
   * The caller's organization standing, or `null` for the membership-less
   * break-glass identity (`AccessService.getEffectiveRole` keeps that path:
   * with no organization to scope to, the raw grant decides alone).
   *
   * A plain value rather than a thunk like `getUserId`, because
   * `createMcpConnection` is built fresh per Fastify request — see the comment
   * on it in `mcp.server.ts` — so there is no shared instance for this to leak
   * across.
   */
  membership: { organizationId: string; role: OrgRoleValue } | null;
  /**
   * The widget-data plugin's own cache instance (Task 3-12) — the SAME one
   * `widgetDataRoutes` holds. `mcp.routes.ts` threads through the SAME
   * instance the `AdvisorToolDeps.cache` comment describes; passed here so
   * `set_focus_verdicts` (below) can evict a board's cached widget payload
   * after writing to it.
   */
  cache: WidgetCache;
}

// Minimal shape we rely on from McpServer — adapted from the installed SDK's
// registerTool signature (name, config with description + raw Zod shape, handler).
export interface ToolRegistrar {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
  ) => void;
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError };
}

/**
 * `AdvisorToolDeps.membership` is required and non-null — every handler that
 * actually dereferences it (only `propose_board_changes` today) is refused
 * before it is ever called when `BoardToolDeps.membership` is the
 * membership-less break-glass identity (`null`; see the field's own comment).
 * This value is passed through to VIEWER-floor handlers purely to satisfy
 * that required shape; none of them read it, so an unreachable placeholder is
 * honest, whereas synthesising a real-looking empty-string organizationId
 * would look like a live tenant to a future reader.
 */
const UNREACHABLE_MEMBERSHIP = { organizationId: '<unreachable: no organization>' };

export function registerBoardTools(server: ToolRegistrar, deps: BoardToolDeps): void {
  /**
   * Both stateless, so constructing them here rather than threading them
   * through `BoardToolDeps` keeps the dependency surface at what callers
   * actually have to supply. Same reason the four access route families each
   * do `new AccessService(prisma)` locally.
   */
  const access = new AccessService(deps.prisma);
  const boardReads = new BoardReadsService(deps.prisma);
  const changeSets = new ChangeSetService(deps.prisma);

  for (const spec of ADVISOR_TOOL_SPECS) {
    // MCP input schema = the spec's fields PLUS a required boardId.
    const shape = {
      boardId: z.string().min(1),
      ...(spec.inputSchema as z.ZodObject<z.ZodRawShape>).shape,
    };
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: shape },
      async (args) => {
        const userId = deps.getUserId();
        if (!userId) return textResult({ error: 'unauthorized' }, true);

        const boardId = String(args.boardId);
        /**
         * `AccessService.getEffectiveRole`, not `hasBoardAccess`.
         *
         * `hasBoardAccess` decided on a `BoardAccess` grant row alone, which made
         * this a SECOND authorization axis that could disagree with
         * `evaluatePolicy` — and did: an organization ADMIN is an implicit OWNER
         * of every board in their organization, holds no grant row, and was
         * refused here while being admitted by every other board route. Two axes
         * that can disagree is the `connectionOwner` mistake Phase C deleted.
         *
         * It failed CLOSED, so it was never a leak. The resolver is not merely
         * more permissive, though: it reads the board THROUGH the caller's
         * organization, so a board in another tenant answers "no role" rather
         * than inheriting the implicit-owner rule (tenancy §11 precondition 7).
         */
        const role = await access.getEffectiveRole('board', boardId, userId, deps.membership);
        if (!meetsBoardRole(role, spec.minRole)) {
          return textResult(
            {
              error:
                spec.minRole === 'VIEWER'
                  ? 'forbidden: no access to board'
                  : 'forbidden: no edit access to board',
            },
            true,
          );
        }

        /**
         * Above VIEWER, a tool writes into the board's tenant
         * (`propose_board_changes` today; stage 2b's other write ops later), so
         * it needs a REAL organization to stamp onto what it creates. The
         * membership-less break-glass identity has none — fail closed here
         * rather than let a fabricated tenant reach `ChangeSetService.propose`.
         */
        if (spec.minRole !== 'VIEWER' && !deps.membership) {
          return textResult({ error: 'forbidden: no organization' }, true);
        }

        const scope = await getBoardScope(
          deps.prisma,
          boardId,
          deps.membership?.organizationId ?? null,
        );
        const { boardId: _omit, ...toolInput } = args;
        // `role` is in the context for the SAME reason `boardId` is: it is
        // closure state resolved after authorization, never a tool input. This
        // surface refuses above the floor before reaching the handler (just
        // above), whereas the AI-SDK surface enforces it by COMPOSITION in
        // `buildAdvisorTools` — two mechanisms, one declared floor.
        const result = await spec.handler(toolInput, { boardId, scope, role }, {
          intel: deps.intel,
          boardReads,
          changeSets,
          userId,
          membership: deps.membership
            ? { organizationId: deps.membership.organizationId }
            : UNREACHABLE_MEMBERSHIP,
          // Same request-scoped reader and organization standing as above —
          // `set_focus_verdicts` writes into this organization's
          // `focus_verdicts`, so a membership-less caller has nowhere to write,
          // exactly like `propose_board_changes` above (`organizationId: null`
          // makes `setVerdicts` a no-op rather than fabricate a tenant).
          focusTools: {
            prisma: deps.prisma,
            clickhouse: deps.clickhouse,
            organizationId: deps.membership?.organizationId ?? null,
          },
          verdictModelLabel: VERDICT_MODEL_LABEL,
          cache: deps.cache,
        });
        return textResult(result);
      },
    );
  }
}
