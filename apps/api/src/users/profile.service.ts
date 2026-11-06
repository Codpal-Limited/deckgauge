import type { PrismaClient } from '@deckgauge/db';
import type { MyProfile, MyOrgChartEntry } from '@deckgauge/shared';
import type { UploadService, UploadRow } from '../uploads/upload.service.js';
import { sniffImageType } from '../uploads/image-sniff.js';
import { accessibleOrgTreeIds } from '../auth/board-access.js';
import { userAvatarUrl, userAvatarsByEmail } from './user-avatars.js';

export interface CallerMembership {
  organizationId: string;
  role: string;
}

export class NotAnImageError extends Error {
  constructor() {
    super('not a supported image (PNG, JPEG, GIF or WebP)');
  }
}

/** The signed-in person's own profile: what the system knows, and their photo. */
export class ProfileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly uploads: UploadService,
  ) {}

  async getProfile(userId: string, membership: CallerMembership | null, isAdmin: boolean): Promise<MyProfile> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const base = {
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.avatarUploadId ? userAvatarUrl(user.avatarUploadId) : null,
    };
    if (!membership) return { ...base, organization: null, orgChart: [] };

    const organization = await this.prisma.organization.findUnique({
      where: { id: membership.organizationId },
      select: { id: true, name: true },
    });
    if (!organization) return { ...base, organization: null, orgChart: [] };

    // The same rule as GET /org-trees: an admin sees every tree in the
    // organization, anyone else the trees they hold a grant on.
    const treeIds = isAdmin
      ? undefined
      : await accessibleOrgTreeIds(this.prisma, userId, { organizationId: organization.id });
    const rows = await this.prisma.orgEmployee.findMany({
      where: {
        isVacancy: false,
        email: { equals: user.email, mode: 'insensitive' },
        orgTree: { organizationId: organization.id, ...(treeIds ? { id: { in: treeIds } } : {}) },
      },
      include: {
        orgTree: { select: { id: true, name: true, position: true } },
        manager: { select: { id: true, name: true } },
        _count: { select: { reports: true } },
      },
      orderBy: [{ orgTree: { position: 'asc' } }, { name: 'asc' }],
    });

    const selfPhoto = (await userAvatarsByEmail(this.prisma, organization.id, [user.email])).get(
      user.email.toLowerCase(),
    );
    const orgChart: MyOrgChartEntry[] = rows.map((e) => ({
      orgTreeId: e.orgTree.id,
      orgTreeName: e.orgTree.name,
      employeeId: e.id,
      name: e.name,
      role: e.role,
      businessTitle: e.businessTitle,
      employeeDisplayId: e.employeeDisplayId,
      email: e.email,
      location: e.location,
      phone: e.phone,
      hireDate: e.hireDate ? e.hireDate.toISOString() : null,
      manager: e.manager ? { id: e.manager.id, name: e.manager.name } : null,
      directReports: e._count.reports,
      photoUrl: selfPhoto ?? (e.photoUploadId ? `/api/uploads/${e.photoUploadId}` : null),
      isDeparted: e.departedAt != null,
    }));

    return {
      ...base,
      organization: { ...organization, role: membership.role as 'ADMIN' | 'MEMBER' | 'VIEWER' },
      orgChart,
    };
  }

  /** Store `buffer` as the person's photo, replacing (and deleting) any previous one. */
  async setAvatar(userId: string, buffer: Buffer): Promise<{ avatarUrl: string }> {
    const mimeType = sniffImageType(buffer);
    if (!mimeType) throw new NotAnImageError();

    const previous = (
      await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarUploadId: true } })
    ).avatarUploadId;
    const upload = await this.uploads.saveFile({ avatar: true, mimeType, buffer });
    const avatarUrl = userAvatarUrl(upload.id);
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { avatarUploadId: upload.id, avatarUrl } });
    } catch (err) {
      await this.uploads.deleteUpload(upload.id).catch(() => undefined);
      throw err;
    }
    if (previous) await this.uploads.deleteUpload(previous).catch(() => undefined);
    return { avatarUrl };
  }

  async removeAvatar(userId: string): Promise<void> {
    const { avatarUploadId } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarUploadId: true },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUploadId: null, avatarUrl: null } });
    if (avatarUploadId) await this.uploads.deleteUpload(avatarUploadId).catch(() => undefined);
  }

  /**
   * The upload behind `uploadId` iff it is some user's CURRENT photo and the
   * caller may see it: they are its owner, or they and the owner are both
   * ACTIVE members of the organization the caller is acting in. Anything else
   * is `null` — the route answers 404 either way, so this is no oracle.
   */
  async findReadableAvatar(
    callerId: string,
    callerOrganizationId: string | null,
    uploadId: string,
  ): Promise<UploadRow | null> {
    const owner = await this.prisma.user.findUnique({
      where: { avatarUploadId: uploadId },
      select: { id: true },
    });
    if (!owner) return null;
    if (owner.id !== callerId) {
      if (!callerOrganizationId) return null;
      const shared = await this.prisma.orgMembership.findFirst({
        where: { organizationId: callerOrganizationId, userId: owner.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!shared) return null;
    }
    return this.uploads.findById(uploadId);
  }
}
