import {
  EmployeeStatsSchema,
  type OrgEmployeeDto,
  type OrgEmployeeAliasDto,
  type EmployeeRankingDto,
} from '@deckgauge/shared';
import type { OrgEmployee, OrgEmployeeAlias } from '@deckgauge/db';

/** Map an OrgEmployee (+aliases) to the wire DTO. Salary fields are included
 *  only when includeSalary (PII gate). The tree-relative `ranking` is computed by
 *  the caller (it needs every employee in the tree) and passed in; null = unranked.
 *  `selfPhotoUrl` is the matching member's self-chosen profile photo (see
 *  `userAvatarsByEmail`); it wins over the imported one. */
export function toOrgEmployeeDto(
  e: OrgEmployee,
  aliases: OrgEmployeeAlias[],
  includeSalary: boolean,
  ranking: EmployeeRankingDto | null = null,
  selfPhotoUrl: string | null = null,
): OrgEmployeeDto {
  const parsed = e.statsJson ? EmployeeStatsSchema.safeParse(e.statsJson) : null;
  const dto: OrgEmployeeDto = {
    id: e.id,
    externalId: e.externalId,
    name: e.name,
    role: e.role,
    email: e.email,
    managerId: e.managerId,
    isVacancy: e.isVacancy,
    matched: e.matched,
    isActive: e.isActive,
    lastContributionAt: e.lastContributionAt ? e.lastContributionAt.toISOString() : null,
    hasAssignment: e.hasAssignment,
    stats: parsed && parsed.success ? parsed.data : null,
    ranking,
    aliases: aliases.map(
      (a): OrgEmployeeAliasDto => ({
        id: a.id,
        provider: a.provider as OrgEmployeeAliasDto['provider'],
        kind: a.kind as OrgEmployeeAliasDto['kind'],
        value: a.value,
      }),
    ),
    employeeId: e.employeeDisplayId,
    businessTitle: e.businessTitle,
    hireDate: e.hireDate ? e.hireDate.toISOString() : null,
    location: e.location,
    employeeType: e.employeeType as OrgEmployeeDto['employeeType'],
    timeType: e.timeType as OrgEmployeeDto['timeType'],
    phone: e.phone,
    workAddress: e.workAddress,
    isDeparted: e.departedAt != null,
    photoUrl: selfPhotoUrl ?? (e.photoUploadId ? `/api/uploads/${e.photoUploadId}` : null),
  };
  if (includeSalary) {
    dto.salaryCurrent = e.salaryCurrent;
    dto.salaryCurrency = e.salaryCurrency;
  }
  return dto;
}
