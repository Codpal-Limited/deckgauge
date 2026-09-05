import { normalizeName, nameFromEmail } from './org-employee-matcher.js';

export interface EmployeeIdentities {
  logins: string[];
  emails: string[];
  names: string[];
}

const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

/**
 * Resolve the set of identity values used to match an employee against
 * ClickHouse activity rows: provider logins, lowercased emails, and
 * normalized full names (from name aliases, the employee's own name, the
 * employee's own profile email, and email local parts).
 *
 * The profile `email` is folded in alongside email-kind aliases so a
 * directory/Workday-synced org tree (which populates the profile email but
 * creates no aliases) still matches GitHub/ADO/Jira activity by author email
 * without requiring a hand-added alias.
 */
export function resolveEmployeeIdentities(employee: {
  name: string;
  email?: string | null;
  aliases: { provider: string; kind: string; value: string }[];
}): EmployeeIdentities {
  const logins: string[] = [];
  const emails: string[] = [];
  const names: string[] = [];

  const selfName = normalizeName(employee.name);
  if (selfName) names.push(selfName);

  const addEmail = (raw: string): void => {
    const lower = raw.toLowerCase();
    emails.push(lower);
    const fromEmail = nameFromEmail(lower);
    if (fromEmail) names.push(fromEmail);
  };

  if (employee.email) addEmail(employee.email);

  for (const a of employee.aliases) {
    if (a.kind === 'login') logins.push(a.value);
    else if (a.kind === 'email') {
      addEmail(a.value);
    } else if (a.kind === 'name') {
      const n = normalizeName(a.value);
      if (n) names.push(n);
    }
  }

  return { logins: uniq(logins), emails: uniq(emails), names: uniq(names) };
}

export function isEmptyIdentities(ids: EmployeeIdentities): boolean {
  return ids.logins.length === 0 && ids.emails.length === 0 && ids.names.length === 0;
}
