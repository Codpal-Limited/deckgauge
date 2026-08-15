import type { PrismaClient } from '@deckgauge/db';
import { deriveSessionTitle } from '@deckgauge/shared';
import type {
  AdvisorAppendMessageInput,
  AdvisorMessageRole,
  AdvisorSessionSummaryDto,
  AdvisorSessionTranscriptDto,
} from '@deckgauge/shared';

// Shared with the panel, which derives the same title optimistically at
// ASK_START — two implementations had the header and the history dropdown
// disagreeing about the same session until a reload.
export { deriveSessionTitle };

/** Prisma stores tool names in a Json column; normalise anything else to []. */
function toToolCallNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Persistence for advisor conversations.
 *
 * Every method takes `userId` and `boardId` and filters on BOTH. Board access
 * is already enforced by the route's `requireBoardAccess` preHandler; this
 * second filter is what stops a board mate with VIEWER access from reading or
 * deleting someone else's conversation, and what makes a foreign session id
 * indistinguishable from a non-existent one.
 */
export class AdvisorSessionService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, boardId: string): Promise<AdvisorSessionSummaryDto[]> {
    const rows = await this.prisma.advisorSession.findMany({
      where: { userId, boardId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, updatedAt: true, _count: { select: { messages: true } } },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      messageCount: row._count.messages,
    }));
  }

  async create(userId: string, boardId: string): Promise<AdvisorSessionSummaryDto> {
    const row = await this.prisma.advisorSession.create({
      data: { userId, boardId },
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      messageCount: 0,
    };
  }

  async get(
    userId: string,
    boardId: string,
    sessionId: string,
  ): Promise<AdvisorSessionTranscriptDto | null> {
    const row = await this.prisma.advisorSession.findFirst({
      where: { id: sessionId, userId, boardId },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, text: true, toolCalls: true, createdAt: true },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages.map((message) => ({
        id: message.id,
        role: message.role as AdvisorMessageRole,
        text: message.text,
        toolCalls: toToolCallNames(message.toolCalls),
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  /** Returns false when the session isn't the caller's — the route maps that to 404. */
  async appendMessage(
    userId: string,
    boardId: string,
    sessionId: string,
    input: AdvisorAppendMessageInput,
  ): Promise<boolean> {
    const session = await this.prisma.advisorSession.findFirst({
      where: { id: sessionId, userId, boardId },
      select: { id: true, title: true },
    });
    if (!session) return false;

    await this.prisma.advisorMessage.create({
      data: {
        sessionId: session.id,
        role: input.role,
        text: input.text,
        toolCalls: input.role === 'assistant' ? input.toolCalls : undefined,
      },
    });

    // Always issue the update, even with no data changes: `@updatedAt` is what
    // orders the history dropdown, so an untouched timestamp would sink an
    // actively-used session below stale ones.
    const shouldTitle = session.title === '' && input.role === 'user';
    await this.prisma.advisorSession.update({
      where: { id: session.id },
      data: shouldTitle ? { title: deriveSessionTitle(input.text) } : {},
    });
    return true;
  }

  async remove(userId: string, boardId: string, sessionId: string): Promise<boolean> {
    const { count } = await this.prisma.advisorSession.deleteMany({
      where: { id: sessionId, userId, boardId },
    });
    return count > 0;
  }
}
