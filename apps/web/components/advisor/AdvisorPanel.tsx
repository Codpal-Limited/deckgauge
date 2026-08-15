'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useAdvisor } from './AdvisorProvider';
import { AdvisorBoardSwitcher, ADVISOR_SCOPE_CHIP_CLASS } from './AdvisorBoardSwitcher';
import { AdvisorMarkdown } from './AdvisorMarkdown';
import { AdvisorSessionList } from './AdvisorSessionList';
import { ADVISOR_GENERIC_PAGE_CONTEXT } from './advisor-page-context';
import { advisorReceiptLabels } from './advisor-tool-labels';

/**
 * Receipts show what an answer was grounded IN, so they are labelled by source
 * of truth rather than by tool: a `search_source` + `read_source` pair is one
 * "derived from source" claim, not two tool calls the reader has to interpret.
 * The count in the disclosure is the label count for the same reason — a button
 * saying "3 sources" over a single pill would just look broken.
 */
function receiptLabelsFor(toolCalls: readonly string[]): string[] {
  return advisorReceiptLabels(toolCalls);
}

/**
 * The expanded advisor chat. Owns no conversation state — everything comes
 * from `useAdvisor()`, which is what lets the panel be unmounted (docked or
 * closed) without losing an answer that is still streaming.
 *
 * Rendered once at layout level, not per entry point.
 */
export function AdvisorPanel() {
  const advisor = useAdvisor();
  const { state, pageContext } = advisor;
  const [draft, setDraft] = useState('');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // Which answer's tool receipts are expanded, by message index — keyed per
  // message (not a single boolean) so two answers with tools can be expanded
  // independently of each other.
  const [expandedReceipts, setExpandedReceipts] = useState<number | null>(null);

  // A message INDEX is only meaningful against the transcript it was taken
  // from, so it has to be dropped whenever that transcript is replaced —
  // resuming another session, or starting a new one. Without this, switching
  // sessions left an expanded receipts disclosure sitting on whatever answer
  // happened to land at the same index in the new conversation.
  useEffect(() => {
    setExpandedReceipts(null);
  }, [state.sessionId]);

  // No board gate: off-board the panel runs in product-help mode. The scope
  // row below is what tells the user which mode they are in.
  if (state.mode !== 'open') return null;

  const isBoardMode = Boolean(state.boardId) && advisor.routeBoardId !== null;

  /**
   * The context whose copy this panel should actually present.
   *
   * `pageContext` is a pure function of the pathname, so on `/` it is the BOARD
   * context — even when no board is bound and `isBoardMode` is therefore false.
   * That state is reachable on a first visit to a bare `/`: the route binder's
   * last-board cookie read races the board page's own write, so `routeBoardId`
   * stays null for the life of the page, the launcher just `raise()`s, and the
   * panel would offer "How is this team trending over the last month?" and the
   * board teaser while its own chip read "product help" and every question went
   * to the documentation-only help route. Whatever mode the chrome is in, the
   * starters and the scope label must be in the same one.
   */
  const context =
    !isBoardMode && pageContext.isBoard ? ADVISOR_GENERIC_PAGE_CONTEXT : pageContext;

  const submit = () => {
    const question = draft.trim();
    if (!question || state.isAsking) return;
    setDraft('');
    void advisor.send(question);
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Ask the advisor"
      // `surface-1`, not `surface-0`: `surface-0` is the APP BACKGROUND in both
      // themes, so a panel painted with it renders at exactly the page colour
      // and stops reading as a lifted surface. `surface-1` is the card/panel
      // token — white in light mode, one step up from the page in dark.
      className={
        advisor.panelSize === 'drawer'
          ? 'fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-slate-200 bg-surface-1 shadow-xl animate-slide-in-right'
          : 'fixed bottom-20 right-4 z-50 flex h-[min(560px,70vh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-slate-200 bg-surface-1 shadow-2xl animate-slide-up'
      }
    >
      <div className="relative flex items-start justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="truncate text-sm font-semibold text-slate-900">
            {state.title || 'Ask the Advisor'}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {isBoardMode ? (
              <AdvisorBoardSwitcher
                boardId={state.boardId as string}
                onSelect={(boardId) => advisor.switchBoard(boardId)}
              />
            ) : (
              <span className={ADVISOR_SCOPE_CHIP_CLASS}>{context.label} · product help</span>
            )}
            {advisor.bridgeStatus === 'ready' && (
              <span className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {advisor.bridgeAgent}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => advisor.setPanelSize(advisor.panelSize === 'card' ? 'drawer' : 'card')}
            // "Shrink", not "Collapse", in drawer mode: the dock button below
            // is unconditionally named "Collapse advisor" (its action never
            // changes with size), so this name must not share that substring
            // or the two controls stop being distinguishable by name.
            aria-label={advisor.panelSize === 'card' ? 'Expand advisor' : 'Shrink advisor to a card'}
            title={advisor.panelSize === 'card' ? 'Expand' : 'Shrink'}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ⤡
          </button>
          {/* Board mode only: help conversations are ephemeral, so there is
              no session history to offer off-board. */}
          {isBoardMode && (
            <button
              type="button"
              onClick={() => setIsHistoryOpen((open) => !open)}
              aria-label="Session history"
              aria-expanded={isHistoryOpen}
              title="Session history"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              ⌄
            </button>
          )}
          <button
            type="button"
            onClick={() => advisor.dock()}
            // Invariant across both sizes: this control's action never
            // changes, so its accessible name shouldn't either.
            aria-label="Collapse advisor"
            title="Collapse"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        {isHistoryOpen && isBoardMode && (
          <AdvisorSessionList
            boardId={state.boardId as string}
            activeSessionId={state.sessionId}
            onNewSession={() => {
              advisor.newSession();
              setIsHistoryOpen(false);
            }}
            onResume={(sessionId) => void advisor.resume(sessionId)}
            onDeleted={(sessionId) => advisor.sessionDeleted(sessionId)}
            onClose={() => setIsHistoryOpen(false)}
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3" aria-label="Advisor conversation">
        {state.messages.length === 0 && !state.streamingAnswer && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-slate-400">
              {isBoardMode
                ? 'Ask a question about this board — the advisor answers using real, grounded numbers from your connected data.'
                : `Ask how ${context.label} works — this conversation isn't saved yet, so start one on a board if you want to keep it.`}
            </p>
            {context.starters.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => void advisor.send(starter)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
              >
                <span aria-hidden="true" className="mr-1.5 font-semibold text-indigo-500">
                  ›
                </span>
                {starter}
              </button>
            ))}
          </div>
        )}

        <ul className="flex flex-col gap-4">
          {state.messages.map((message, idx) =>
            message.role === 'user' ? (
              <li
                key={idx}
                className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white"
              >
                <AdvisorMarkdown text={message.text} tone="dark" />
              </li>
            ) : (
              <li key={idx} className="flex gap-2">
                <span aria-hidden="true" className="pt-0.5 text-indigo-500">
                  ✦
                </span>
                <div className="min-w-0 flex-1 text-sm text-slate-800">
                  <AdvisorMarkdown text={message.text} tone="light" />
                  {receiptLabelsFor(message.toolCalls).length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedReceipts((open) => (open === idx ? null : idx))
                        }
                        aria-expanded={expandedReceipts === idx}
                        // `surface-2`: this pill sits INSIDE the panel, which is
                        // `surface-1` — sharing that token would give it no fill
                        // to distinguish it from its own parent.
                        className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200 hover:text-slate-700"
                      >
                        ✓ Grounded in {receiptLabelsFor(message.toolCalls).length}{' '}
                        {receiptLabelsFor(message.toolCalls).length === 1 ? 'source' : 'sources'}
                        <span aria-hidden="true">⌄</span>
                      </button>
                      {expandedReceipts === idx && (
                        <div
                          className="mt-1.5 flex flex-wrap gap-1.5"
                          aria-label="Tools run for this answer"
                        >
                          {receiptLabelsFor(message.toolCalls).map((label) => (
                            <span
                              key={label}
                              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            ),
          )}

          {state.streamingAnswer && (
            <li className="flex gap-2">
              <span aria-hidden="true" className="pt-0.5 text-indigo-500">
                ✦
              </span>
              <div className="min-w-0 flex-1 text-sm text-slate-800">
                <AdvisorMarkdown text={state.streamingAnswer} />
              </div>
            </li>
          )}

          {state.isAsking && !state.streamingAnswer && (
            <li className="flex items-center gap-2 text-xs font-medium text-indigo-700">
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
              {/* Honest per mode: in product-help mode the only thing being
                  read is the documentation corpus — no board data tool is even
                  available on that route. */}
              {isBoardMode ? 'Reading your data…' : 'Checking the documentation…'}
            </li>
          )}
        </ul>

        {state.error && (
          <div role="alert" className="mt-3 text-sm font-medium text-rose-600">
            <p>{state.error.message}</p>
            {state.error.actionHref && (
              <Link
                href={state.error.actionHref}
                className="mt-1 inline-block underline hover:no-underline"
              >
                {state.error.actionLabel}
              </Link>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-slate-100 p-3">
        {state.widgetType && (
          <div className="mb-2 flex w-fit items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200">
            <span>scoped to {state.widgetType}</span>
            <button
              type="button"
              aria-label="Clear widget scope"
              onClick={() => advisor.clearWidgetScope()}
              className="rounded-full px-1 hover:bg-indigo-100"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Ask the advisor a question"
            className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-slate-200 bg-surface-0 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
            placeholder={isBoardMode ? 'Ask about this board…' : 'Ask how Deckgauge works…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKeyDown}
            disabled={state.isAsking}
            rows={2}
          />
          <button
            type="button"
            onClick={submit}
            disabled={state.isAsking || !draft.trim()}
            aria-label="Send question"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500 text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
    </div>
  );
}
