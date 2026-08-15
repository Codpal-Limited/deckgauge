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

export class RetiredProjectsService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<RetiredJiraProjectDto[]> {
    const rows = await this.prisma.retiredJiraProject.findMany({ orderBy: { projectKey: 'asc' } });
    return rows.map(toDto);
  }

  async create(input: CreateRetiredJiraProjectInput): Promise<RetiredJiraProjectDto> {
    try {
      const row = await this.prisma.retiredJiraProject.create({
        data: {
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
    projectKey: string,
    input: UpdateRetiredJiraProjectInput,
  ): Promise<RetiredJiraProjectDto | null> {
    try {
      const row = await this.prisma.retiredJiraProject.update({
        where: { projectKey },
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

  async delete(projectKey: string): Promise<boolean> {
    try {
      await this.prisma.retiredJiraProject.delete({ where: { projectKey } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return false;
      }
      throw err;
    }
  }
}
