export interface RawOrgRow {
  employeeId?: string;
  name?: string;
  supervisorId?: string;
  role?: string;
  email?: string;
  /** Source URL of the person's photo, as exported (BambooHR's `Photo`). */
  photoUrl?: string;
  rowNumber: number;
}
export interface ParsedEmployee {
  externalId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  managerExternalId: string | null;
  photoUrl: string | null;
  isVacancy: boolean;
  rowNumber: number;
}

const VACANCY = /vacant|^hire\b|appointed|await|create jr|\bjr\d{3,}|^tb[cd]\b|^new\b/i;

export function isVacancyRow(name: string): boolean {
  return VACANCY.test(name.trim());
}

function clean(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeOrgRows(raw: RawOrgRow[]): {
  employees: ParsedEmployee[];
  vacancies: number;
  rejectedRows: { row: number; reason: string }[];
} {
  const employees: ParsedEmployee[] = [];
  const rejectedRows: { row: number; reason: string }[] = [];
  let vacancies = 0;
  for (const r of raw) {
    const name = clean(r.name);
    if (!name) {
      rejectedRows.push({ row: r.rowNumber, reason: 'missing Name' });
      continue;
    }
    // Vacancies are imported as placeholder nodes (not skipped) so that real
    // employees who report through a vacant intermediate manager stay attached
    // to the hierarchy instead of being orphaned to the root.
    const isVacancy = isVacancyRow(name);
    if (isVacancy) vacancies += 1;
    employees.push({
      externalId: clean(r.employeeId) || null,
      name,
      role: clean(r.role) || null,
      email: clean(r.email).toLowerCase() || null,
      managerExternalId: clean(r.supervisorId) || null,
      photoUrl: clean(r.photoUrl) || null,
      isVacancy,
      rowNumber: r.rowNumber,
    });
  }
  return { employees, vacancies, rejectedRows };
}

export function resolveHierarchy(employees: ParsedEmployee[]): {
  withManager: ParsedEmployee[];
  orphanWarnings: string[];
} {
  const known = new Set(
    employees.map((e) => e.externalId).filter((x): x is string => !!x)
  );
  const orphanWarnings: string[] = [];
  const withManager = employees.map((e) => {
    if (e.managerExternalId && !known.has(e.managerExternalId)) {
      orphanWarnings.push(
        `${e.name}: unknown supervisor id ${e.managerExternalId} — attached to root`
      );
      return { ...e, managerExternalId: null };
    }
    return e;
  });
  return { withManager, orphanWarnings };
}
