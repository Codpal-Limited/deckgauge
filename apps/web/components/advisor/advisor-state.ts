import { deriveSessionTitle, type AdvisorSessionMessageDto } from '@deckgauge/shared';
import type { AdvisorErrorCopy } from './advisor-error-copy';

export type AdvisorMode = 'closed' | 'open' | 'docked';

export interface AdvisorChatMessage {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: string[];
}

export interface AdvisorState {
  mode: AdvisorMode;
  boardId: string | null;
  sessionId: string | null;
  title: string;
  messages: AdvisorChatMessage[];
  streamingAnswer: string;
  /** Tools reported for the answer currently streaming. */
  toolCalls: string[];
  isAsking: boolean;
  error: AdvisorErrorCopy | null;
  /** Scopes only the NEXT question; cleared once that question is sent. */
  widgetType?: string;
  /** An answer landed while docked and hasn't been looked at yet. */
  hasUnseenAnswer: boolean;
}

export type AdvisorAction =
  | { type: 'OPEN'; boardId: string; widgetType?: string }
  /**
   * Reload restore, in ONE dispatch. Deliberately not `OPEN` (+ `DOCK`)
   * followed by a `RESUME`: those leave a window in which `sessionId` is
   * still null while `mode`/`boardId` are already set, and the provider's
   * persist effect fires in that window and overwrites the saved pointer
   * with `sessionId: null` — destroying the only reference to the session
   * the transcript fetch is still in flight for.
   */
  | { type: 'RESTORE'; mode: 'open' | 'docked'; boardId: string; sessionId: string | null }
  /**
   * The user navigated to a different board. Keeps `mode` (a docked advisor
   * stays docked) and swaps the conversation, because sessions are per board.
   */
  | { type: 'REBIND_BOARD'; boardId: string }
  | { type: 'RAISE' }
  | { type: 'DOCK' }
  | { type: 'CLOSE' }
  | { type: 'NEW_SESSION' }
  | { type: 'SESSION_STARTED'; sessionId: string }
  | { type: 'RESUME'; sessionId: string; title: string; messages: AdvisorSessionMessageDto[] }
  | { type: 'CLEAR_WIDGET_SCOPE' }
  | { type: 'ASK_START'; question: string }
  | { type: 'DELTA'; text: string }
  | { type: 'TOOL_CALL'; name: string }
  | { type: 'ASK_DONE' }
  | { type: 'ASK_ERROR'; error: AdvisorErrorCopy };

export const INITIAL_ADVISOR_STATE: AdvisorState = {
  mode: 'closed',
  boardId: null,
  sessionId: null,
  title: '',
  messages: [],
  streamingAnswer: '',
  toolCalls: [],
  isAsking: false,
  error: null,
  widgetType: undefined,
  hasUnseenAnswer: false,
};

/**
 * Everything that belongs to one conversation, reset when we leave it.
 *
 * A function, not a shared object literal: each reset path (`OPEN` onto a
 * different board, `NEW_SESSION`, `RESUME`) needs its own fresh `messages`
 * and `toolCalls` array instances. A single module-level object would hand
 * every one of those states the *same* array by reference — harmless today
 * since no case here mutates in place, but a consumer in Tasks 9-11 that
 * mutates `state.messages` instead of dispatching would silently corrupt
 * every other state still holding that reference.
 */
function blankConversation(): Pick<
  AdvisorState,
  | 'sessionId'
  | 'title'
  | 'messages'
  | 'streamingAnswer'
  | 'toolCalls'
  | 'isAsking'
  | 'error'
  | 'hasUnseenAnswer'
> {
  return {
    sessionId: null,
    title: '',
    messages: [],
    streamingAnswer: '',
    toolCalls: [],
    isAsking: false,
    error: null,
    hasUnseenAnswer: false,
  };
}

export function advisorReducer(state: AdvisorState, action: AdvisorAction): AdvisorState {
  switch (action.type) {
    case 'OPEN': {
      // Reopening on the board we're already on RAISES the live conversation —
      // clicking the header button (or a widget chip) must never be a way to
      // silently destroy an answer in flight.
      const sameBoard = state.boardId === action.boardId;
      return {
        ...state,
        ...(sameBoard ? {} : blankConversation()),
        mode: 'open',
        boardId: action.boardId,
        widgetType: action.widgetType,
        hasUnseenAnswer: false,
      };
    }

    case 'RESTORE':
      return {
        ...state,
        ...blankConversation(),
        mode: action.mode,
        boardId: action.boardId,
        sessionId: action.sessionId,
      };

    case 'REBIND_BOARD':
      return {
        ...state,
        ...blankConversation(),
        boardId: action.boardId,
        widgetType: undefined,
      };

    case 'RAISE':
      return { ...state, mode: 'open', hasUnseenAnswer: false };

    case 'DOCK':
      // Deliberately touches nothing but `mode`: a stream in flight keeps
      // running, because the provider owns it, not the panel.
      return { ...state, mode: 'docked' };

    case 'CLOSE':
      // Non-destructive — everything is already persisted, and reopening on
      // this board resumes exactly here.
      return { ...state, mode: 'closed' };

    case 'NEW_SESSION':
      return { ...state, ...blankConversation(), widgetType: undefined };

    case 'SESSION_STARTED':
      return { ...state, sessionId: action.sessionId };

    case 'RESUME':
      return {
        ...state,
        ...blankConversation(),
        sessionId: action.sessionId,
        title: action.title,
        messages: action.messages.map((message) => ({
          role: message.role,
          text: message.text,
          toolCalls: message.toolCalls,
        })),
        widgetType: undefined,
      };

    case 'CLEAR_WIDGET_SCOPE':
      return { ...state, widgetType: undefined };

    case 'ASK_START':
      return {
        ...state,
        messages: [...state.messages, { role: 'user', text: action.question, toolCalls: [] }],
        // Same derivation the server applies when it titles the session, so
        // the panel header and the history dropdown agree immediately rather
        // than only after a reload.
        title: state.title === '' ? deriveSessionTitle(action.question) : state.title,
        streamingAnswer: '',
        toolCalls: [],
        isAsking: true,
        error: null,
        // The scope was for this question; the next one starts unscoped.
        widgetType: undefined,
      };

    case 'DELTA':
      return { ...state, streamingAnswer: state.streamingAnswer + action.text };

    case 'TOOL_CALL':
      return { ...state, toolCalls: [...state.toolCalls, action.name] };

    case 'ASK_DONE': {
      const answered = state.streamingAnswer !== '';
      return {
        ...state,
        messages: answered
          ? [
              ...state.messages,
              { role: 'assistant', text: state.streamingAnswer, toolCalls: state.toolCalls },
            ]
          : state.messages,
        streamingAnswer: '',
        isAsking: false,
        // Only meaningful if nobody was looking — an open panel already showed it.
        hasUnseenAnswer: answered && state.mode === 'docked',
      };
    }

    case 'ASK_ERROR':
      // The partial answer is dropped but the question stays, so a retry still
      // has the full conversation behind it.
      return { ...state, streamingAnswer: '', isAsking: false, error: action.error };

    default: {
      // Exhaustiveness check: if a new AdvisorAction variant is added without
      // a case above, `action` is no longer `never` here and this fails to
      // compile instead of silently falling through to a no-op.
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}
