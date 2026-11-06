import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';
import type { RawOrgRow } from '@deckgauge/shared';

type OrgField = Exclude<keyof RawOrgRow, 'rowNumber'>;

/**
 * Accepted header spellings per field, keyed by `normalizeHeader` output and
 * ordered MOST SPECIFIC FIRST — that order, not column order, decides which
 * column a field reads when several match (see `resolveColumns`).
 *
 * HR systems disagree on names: our template says "Employee ID" / "Supervisor
 * ID" / "Role", while BambooHR's org chart export says "PersonID" /
 * "SupervisorID" / "Job Title". An unrecognised ID or supervisor column is
 * silent and costly — every row still imports by Name, but with no reporting
 * line, so the "tree" arrives as a flat list.
 */
const ALIASES: Record<OrgField, string[]> = {
  // Bare `id` is last: many exports lead with a record key ("ID, Employee ID,
  // ..., Manager ID"), and taking it would resolve manager links to the WRONG
  // people while the tree still looks valid.
  employeeId: ['employeeid', 'personid', 'employeenumber', 'employeeno', 'workerid', 'id'],
  name: ['name', 'fullname', 'employeename', 'displayname'],
  supervisorId: ['supervisorid', 'supervisoreid', 'managerid', 'manageremployeeid', 'reportstoid'],
  // Bare `title` is last: UK/EU exports use it for the salutation (Mr/Ms/Dr)
  // beside a separate "Job Title".
  role: ['role', 'jobtitle', 'businesstitle', 'position', 'title'],
  email: ['email', 'workemail', 'emailaddress', 'workemailaddress'],
  photoUrl: [
    'photourl',
    'photo',
    'profilephoto',
    'profilepicture',
    'picture',
    'avatarurl',
    'avatar',
    'image',
  ],
};

/**
 * Case, whitespace, punctuation and a leading UTF-8 BOM all vary between
 * exports and carry no meaning, so a header is compared on its letters and
 * digits alone: "Employee ID", "employee_id" and "EmployeeID" are one column.
 */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Every .xlsx is a ZIP container, so its first four bytes are the local file
 * header signature `PK\x03\x04`. Sniffing that is what decides the parser —
 * NOT the filename, which arrives straight from a multipart upload and is
 * therefore chosen by whoever is uploading.
 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function isXlsx(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

/**
 * Field -> column index, for each field some header matches. When several
 * headers match one field, the one earliest in that field's alias list wins,
 * wherever it sits in the sheet.
 */
function resolveColumns(headers: unknown[]): Array<[OrgField, number]> {
  const normalized = headers.map((h) => normalizeHeader(String(h ?? '')));
  const out: Array<[OrgField, number]> = [];
  for (const [field, aliases] of Object.entries(ALIASES) as Array<[OrgField, string[]]>) {
    for (const alias of aliases) {
      const index = normalized.indexOf(alias);
      if (index !== -1) {
        out.push([field, index]);
        break;
      }
    }
  }
  return out;
}

function toRow(columns: Array<[OrgField, number]>, values: unknown[], rowNumber: number): RawOrgRow {
  const row: RawOrgRow = { rowNumber };
  for (const [field, index] of columns) row[field] = String(values[index] ?? '');
  return row;
}

/**
 * `rowNumber` is the 1-based position in the source sheet: +1 to leave
 * 0-indexing and +1 to step over the header, so the first data row reports as
 * 2 and matches what the user sees in Excel.
 */
const FIRST_DATA_ROW = 2;

export async function parseOrgChartBuffer(buf: Buffer, _filename: string): Promise<RawOrgRow[]> {
  if (buf.length === 0) return [];

  if (isXlsx(buf)) {
    // Resolves to one entry per sheet, `{ sheet, data }`. The importer has only
    // ever read the first sheet, matching the previous SheetJS implementation's
    // `wb.Sheets[wb.SheetNames[0]]`.
    const sheets = (await readXlsxFile(buf)) as unknown as Array<{ data: unknown[][] }>;
    const [headerRow, ...dataRows] = sheets[0]?.data ?? [];
    if (!headerRow) return [];
    const columns = resolveColumns(headerRow);
    return dataRows.map((values, i) => toRow(columns, values, i + FIRST_DATA_ROW));
  }

  // `header: false` keeps the raw cell grid, so a duplicated header name cannot
  // silently collapse two columns into one the way an object-keyed parse would.
  const parsed = Papa.parse<string[]>(buf.toString('utf-8'), {
    header: false,
    skipEmptyLines: true,
  });
  const [headerRow, ...dataRows] = parsed.data;
  if (!headerRow) return [];
  const columns = resolveColumns(headerRow);
  return dataRows.map((values, i) => toRow(columns, values, i + FIRST_DATA_ROW));
}
