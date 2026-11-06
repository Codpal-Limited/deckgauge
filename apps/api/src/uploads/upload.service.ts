import type { PrismaClient } from '@deckgauge/db';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

interface SaveFileInput {
  projectId?: string;
  orgEmployeeId?: string;
  /** A profile photo: owned through `User.avatarUploadId`, not a project or employee. */
  avatar?: boolean;
  mimeType: string;
  buffer: Buffer;
}

export interface UploadRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  commentId: string | null;
  projectId: string | null;
  orgEmployeeId: string | null;
  employeeCommentId: string | null;
  createdAt: Date;
}

export class UploadService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly uploadsDir: string,
  ) {}

  get dir(): string {
    return this.uploadsDir;
  }

  protected async writeBuffer(filePath: string, buffer: Buffer): Promise<void> {
    await writeFile(filePath, buffer);
  }

  async saveFile(input: SaveFileInput): Promise<UploadRow> {
    if (!input.avatar && !input.projectId && !input.orgEmployeeId) {
      throw new Error('projectId or orgEmployeeId is required');
    }

    if (input.orgEmployeeId) {
      const emp = await this.prisma.orgEmployee.findUnique({ where: { id: input.orgEmployeeId } });
      if (!emp) throw new Error('Employee not found');
    } else if (input.projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new Error('Project not found');
    }

    const id = randomUUID();
    const ext = MIME_TO_EXT[input.mimeType] ?? '.bin';
    const filename = `${id}${ext}`;
    await this.writeBuffer(join(this.uploadsDir, filename), input.buffer);

    const row = await this.prisma.upload.create({
      data: {
        id,
        filename,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.byteLength,
        projectId: input.projectId ?? null,
        orgEmployeeId: input.orgEmployeeId ?? null,
        commentId: null,
        employeeCommentId: null,
      },
    });

    return row as UploadRow;
  }

  async findById(id: string): Promise<UploadRow | null> {
    const row = await this.prisma.upload.findUnique({ where: { id } });
    return row as UploadRow | null;
  }

  /** Remove one upload: its file (a missing file is fine) and its row. */
  async deleteUpload(id: string): Promise<void> {
    const row = await this.prisma.upload.findUnique({ where: { id } });
    if (!row) return;
    await unlink(join(this.uploadsDir, row.filename)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await this.prisma.upload.delete({ where: { id } });
  }

  async linkToComment(commentId: string, uploadIds: string[]): Promise<void> {
    if (uploadIds.length === 0) return;
    await this.prisma.upload.updateMany({
      // Never a profile photo or an imported org-chart photo: deleting the
      // comment deletes its attachments, so linking one would let any
      // commenter remove someone else's picture. Their ids are visible to every
      // org-chart viewer, so this cannot rely on them being unguessable.
      where: { id: { in: uploadIds }, avatarOf: { is: null }, photoOf: { is: null } },
      data: { commentId },
    });
  }

  async deleteForComment(commentId: string): Promise<void> {
    const uploads = await this.prisma.upload.findMany({
      where: { commentId },
    });
    await Promise.all(
      uploads.map((u) =>
        unlink(join(this.uploadsDir, u.filename)).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        }),
      ),
    );
  }

  async linkToEmployeeComment(employeeCommentId: string, uploadIds: string[]): Promise<void> {
    if (uploadIds.length === 0) return;
    await this.prisma.upload.updateMany({
      // Never a profile photo or an imported org-chart photo: deleting the
      // comment deletes its attachments, so linking one would let any
      // commenter remove someone else's picture. Their ids are visible to every
      // org-chart viewer, so this cannot rely on them being unguessable.
      where: { id: { in: uploadIds }, avatarOf: { is: null }, photoOf: { is: null } },
      data: { employeeCommentId },
    });
  }

  async deleteForEmployeeComment(employeeCommentId: string): Promise<void> {
    const uploads = await this.prisma.upload.findMany({ where: { employeeCommentId } });
    await Promise.all(
      uploads.map((u) =>
        unlink(join(this.uploadsDir, u.filename)).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        }),
      ),
    );
  }
}
