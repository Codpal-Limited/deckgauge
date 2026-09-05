import type { EmployeeBoardMemberDto } from './employee-board-schemas.js';
import type { EmployeeBoardColumnKey } from './employee-board-columns.js';

export interface EmployeeSortConfig {
  column: string;
  direction: 'asc' | 'desc';
}
export interface EmployeeFilterRule {
  column: string;
  condition: string;
  value: string;
}

type ResolveManager = (managerId: string | null) => string;

/** Display/comparable string for a column key. salary → numeric string. */
export function valueForColumn(
  member: EmployeeBoardMemberDto,
  key: string,
  resolveManager: ResolveManager
): string {
  if (!KEY_SET.has(key)) return member.fieldValues[key] ?? '';
  const e = member.employee;
  switch (key) {
    case 'name':
      return e.name ?? '';
    case 'businessTitle':
      return e.businessTitle ?? '';
    case 'email':
      return e.email ?? '';
    case 'manager':
      return resolveManager(e.managerId);
    case 'hireDate':
      return e.hireDate ? e.hireDate.slice(0, 10) : '';
    case 'employeeType':
      return e.employeeType ?? '';
    case 'timeType':
      return e.timeType ?? '';
    case 'location':
      return e.location ?? '';
    case 'phone':
      return e.phone ?? '';
    case 'salary':
      return e.salaryCurrent != null ? String(e.salaryCurrent) : '';
    // Contribution "Rating" = the tree-relative leaderboard score (0–100). Empty
    // when unranked, so unranked people sort to the bottom regardless of direction.
    case 'rating':
      return e.ranking ? String(e.ranking.score) : '';
    default:
      return '';
  }
}

const KEY_SET = new Set<string>([
  'name',
  'businessTitle',
  'email',
  'manager',
  'hireDate',
  'employeeType',
  'timeType',
  'location',
  'phone',
  'salary',
  'rating',
]);

export function sortEmployeeRows(
  rows: EmployeeBoardMemberDto[],
  sort: EmployeeSortConfig | null,
  resolveManager: ResolveManager
): EmployeeBoardMemberDto[] {
  if (!sort) return [...rows];
  const mod = sort.direction === 'asc' ? 1 : -1;
  const numeric = sort.column === 'salary' || sort.column === 'rating';
  return [...rows].sort((a, b) => {
    const av = valueForColumn(a, sort.column, resolveManager);
    const bv = valueForColumn(b, sort.column, resolveManager);
    if (av === '' && bv === '') return 0;
    if (av === '') return 1; // empties last
    if (bv === '') return -1;
    if (numeric) return (Number(av) - Number(bv)) * mod;
    return av.toLowerCase().localeCompare(bv.toLowerCase()) * mod;
  });
}

export function filterEmployeeRows(
  rows: EmployeeBoardMemberDto[],
  rules: EmployeeFilterRule[],
  resolveManager: ResolveManager
): EmployeeBoardMemberDto[] {
  if (rules.length === 0) return [...rows];
  return rows.filter((row) =>
    rules.every((rule) => {
      const v = valueForColumn(row, rule.column, resolveManager).toLowerCase();
      const target = rule.value.toLowerCase();
      switch (rule.condition) {
        case 'is':
          return v === target;
        case 'is_not':
          return v !== target;
        case 'contains':
          return v.includes(target);
        case 'is_empty':
          return v === '';
        default:
          return true;
      }
    })
  );
}

export function searchEmployeeRows(
  rows: EmployeeBoardMemberDto[],
  query: string,
  resolveManager: ResolveManager
): EmployeeBoardMemberDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const keys: EmployeeBoardColumnKey[] = [
    'name',
    'businessTitle',
    'email',
    'manager',
    'location',
    'phone',
  ];
  return rows.filter((row) => {
    if (keys.some((k) => valueForColumn(row, k, resolveManager).toLowerCase().includes(q)))
      return true;
    return Object.values(row.fieldValues).some((v) => v.toLowerCase().includes(q));
  });
}
