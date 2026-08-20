import { Prisma } from '@deckgauge/db';
import type { PrismaClient, RetiredJiraProject } from '@deckgauge/db';
import type {
  CreateRetiredJiraProjectInput,
  UpdateRetiredJiraProjectInput,
  RetiredJiraProjectDto,
} from '@deckgauge/shared';

export class RetiredProjectExistsError extends Error {
  constructor(projectKey: string) {
    super(`Project ${projectKey} is already retired`);
    this.name = 'RetiredProjectExistsError';
  }
}

function toDto(row: RetiredJiraProject): RetiredJiraProjectDto {
  return {
    projectKey: row.projectKey,
    cutoffDate: row.cutoffDate.toISOString(),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Retired Jira projects are organization property. Every method takes the
 * caller's `organizationId` first and scopes to it — this is the read path §11
 * precondition 4 of the tenancy design listed as a live leak, where any member
 * could see every organization's retired project keys, cutoffs and notes.
 *
 * The `projectKey` is unique *per organization*, not globally, so every
 * single-row lookup goes through the `organizationId_projectKey` composite key.
 * A bare `{ projectKey }` would not compile — which is the point.
 */
export class RetiredProjectsService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(organizationId: string): Promise<RetiredJiraProjectDto[]> {
    const rows = await this.prisma.retiredJiraProject.findMany({
      where: { organizationId },
      orderBy: { projectKey: 'asc' },
    });
    return rows.map(toDto);
  }

  async create(
    organizationId: string,
    input: CreateRetiredJiraProjectInput,
  ): Promise<RetiredJiraProjectDto> {
    try {
      const row = await this.prisma.retiredJiraProject.create({
        data: {
          organizationId,
          projectKey: input.projectKey,
          cutoffDate: new Date(input.cutoffDate),
          note: input.note ?? null,
        },
      });
      return toDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new RetiredProjectExistsError(input.projectKey);
      }
      throw err;
    }
  }

  async update(
    organizationId: string,
    projectKey: string,
    input: UpdateRetiredJiraProjectInput,
  ): Promise<RetiredJiraProjectDto | null> {
    try {
      const row = await this.prisma.retiredJiraProject.update({
        where: { organizationId_projectKey: { organizationId, projectKey } },
        data: {
          ...(input.cutoffDate !== undefined && { cutoffDate: new Date(input.cutoffDate) }),
          ...(input.note !== undefined && { note: input.note }),
        },
      });
      return toDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }

  async delete(organizationId: string, projectKey: string): Promise<boolean> {
    try {
      await this.prisma.retiredJiraProject.delete({
        where: { organizationId_projectKey: { organizationId, projectKey } },
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return false;
      }
      throw err;
    }
  }
}
