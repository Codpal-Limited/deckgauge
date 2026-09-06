import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';
import type { RawOrgRow } from '@deckgauge/shared';

const COLS: Record<string, keyof RawOrgRow> = {
  'employee id': 'employeeId',
  name: 'name',
  'supervisor id': 'supervisorId',
  role: 'role',
  email: 'email',
};

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

/** Header cell -> RawOrgRow key, for whichever headers we recognise. */
function toRow(headers: string[], values: unknown[], rowNumber: number): RawOrgRow {
  const row: RawOrgRow = { rowNumber };
  headers.forEach((header, i) => {
    const key = COLS[header.trim().toLowerCase()];
    if (!key || key === 'rowNumber') return;
    (row as unknown as Record<string, unknown>)[key] = String(values[i] ?? '');
  });
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
    const headers = headerRow.map((h) => String(h ?? ''));
    return dataRows.map((values, i) => toRow(headers, values, i + FIRST_DATA_ROW));
  }

  // `header: false` keeps the raw cell grid, so a duplicated header name cannot
  // silently collapse two columns into one the way an object-keyed parse would.
  const parsed = Papa.parse<string[]>(buf.toString('utf-8'), {
    header: false,
    skipEmptyLines: true,
  });
  const [headerRow, ...dataRows] = parsed.data;
  if (!headerRow) return [];
  return dataRows.map((values, i) => toRow(headerRow, values, i + FIRST_DATA_ROW));
}
