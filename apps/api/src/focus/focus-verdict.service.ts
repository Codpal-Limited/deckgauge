import type { PrismaClient } from '@deckgauge/db';
import { FOCUS_VERDICT_REASON_MAX, type FocusVerdictOverride } from '@deckgauge/shared';

export interface FocusVerdictDeps {
  prisma: PrismaClient;
  /**
   * Required, unlike `FocusDataDeps.organizationId` which is nullable.
   *
   * `focus_verdicts` is keyed `(organizationId, fingerprint)`, so there is no row
   * to write without one, and making it non-nullable here is what stops a null
   * reaching the query and widening the write.
   *
   * The route refuses such a caller with an explicit **403** — deliberately NOT
   * `requireOrganizationId`, whose `MissingOrganizationError` is a 500 meaning
   * "this route forgot its `orgRole` policy". `board('EDITOR')` admits a
   * membership-less `BoardAccess` holder by design, so that is a real refusal to
   * state rather than a misconfiguration to surface. See the header of
   * `focus-verdict.routes.ts`.
   */
  organizationId: string;
}

export interface FocusVerdictAuthor {
  id: string;
  name: string;
}

export interface SetHumanVerdictInput extends FocusVerdictOverride {
  fingerprint: string;
  user: FocusVerdictAuthor;
}

function fallbackReason(user: FocusVerdictAuthor, at: Date): string {
  return `Set by ${user.name} on ${at.toISOString().slice(0, 10)}.`;
}

/**
 * Record one person's judgement about one task's class.
 *
 * A HUMAN verdict is the top of the precedence order (R6.5) — above the
 * finance-maintained CAPEX flag, above the rules, above the model — so this is
 * the one write in the system that overrules everything else, and the row it
 * leaves has to say who is responsible for that.
 */
export async function setHumanVerdict(
  deps: FocusVerdictDeps,
  input: SetHumanVerdictInput,
): Promise<void> {
  const decidedAt = new Date();
  const reason = (input.reason ?? fallbackReason(input.user, decidedAt)).slice(
    0,
    FOCUS_VERDICT_REASON_MAX,
  );

  /**
   * Identical on create and update, deliberately.
   *
   * The update path is the one that overwrites an existing MODEL or RULE row,
   * and every field a previous classifier set has to be cleared rather than left
   * standing: a human call carrying a model's `model` / `promptVersion`, or a
   * rule's `ruleId`, credits that classifier for a decision a person made. The
   * ledger prints provenance precisely so a call can be challenged, and the
   * person to challenge is named in `decidedBy`.
   */
  const row = {
    class: input.class,
    // A human sets the CLASS. Which roadmap epic the work advances is a separate,
    // larger question than a class picker can ask, so this override makes no
    // claim about it — see the spec's stated limitation.
    epicKey: null,
    reason,
    source: 'HUMAN' as const,
    ruleId: null,
    model: null,
    promptVersion: null,
    decidedBy: input.user.id,
    decidedAt,
  };

  await deps.prisma.focusVerdict.upsert({
    where: {
      organizationId_fingerprint: {
        organizationId: deps.organizationId,
        fingerprint: input.fingerprint,
      },
    },
    update: row,
    create: { organizationId: deps.organizationId, fingerprint: input.fingerprint, ...row },
  });
}

/**
 * Forget the decision stored for this fingerprint, so the classifiers below a
 * human — the board's CAPEX flag, the rules, the model — decide it again.
 *
 * This also drops a cached MODEL verdict, because the row is unique per
 * `(organizationId, fingerprint)` and a human override replaced rather than
 * shadowed it. So clearing can cost a fresh model call on the next advisor run.
 * That is the honest behaviour — "clear" means the stored judgement is gone —
 * but it is a spend, which is why it is said here rather than discovered.
 *
 * `deleteMany`, not `delete`: a fingerprint is content-addressed and the same
 * hash exists across organizations, so the write has to be scoped. It also makes
 * clearing an already-absent row a no-op instead of a thrown P2025.
 *
 * Returns whether anything was actually removed.
 */
export async function clearVerdict(deps: FocusVerdictDeps, fingerprint: string): Promise<boolean> {
  const { count } = await deps.prisma.focusVerdict.deleteMany({
    where: { organizationId: deps.organizationId, fingerprint },
  });
  return count > 0;
}
