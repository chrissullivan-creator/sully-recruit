/**
 * Tiny, dependency-free CSV utilities for the bulk-import surface.
 *
 * We don't ship papaparse, so this hand-rolled parser handles the cases that
 * actually show up in recruiter exports (Apollo, LinkedIn, Sales Nav, generic
 * spreadsheets):
 *   - quoted fields  "Doe, John"
 *   - embedded commas inside quotes
 *   - embedded newlines inside quotes (multi-line "description" cells)
 *   - escaped quotes  "" → "
 *   - CRLF or LF line endings
 *   - a trailing newline at EOF
 *
 * It is deliberately not a full RFC-4180 validator — it's lenient and never
 * throws, returning whatever rows it can parse.
 */

/** Parse raw CSV text into a matrix of string cells (header row included). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Strip a UTF-8 BOM if present — Excel loves to prepend one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      // swallow \r; the following \n (if any) ends the row
      if (text[i + 1] === "\n") {
        endRow();
        i += 2;
      } else {
        endRow();
        i++;
      }
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush the final field/row unless the file ended on a clean row break.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop fully-empty trailing rows (e.g. a blank final line).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface ParsedCsv {
  headers: string[];
  /** Each row as an object keyed by header. Ragged rows are padded/truncated. */
  rows: Record<string, string>[];
}

/** Parse CSV text into headers + objects keyed by header name. */
export function parseCsvToObjects(text: string): ParsedCsv {
  const matrix = parseCsv(text);
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = matrix[0].map((h) => h.trim());
  const rows = matrix.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows };
}

/** Canonical target fields the importer understands, per entity. */
export type PeopleField =
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "work_email"
  | "personal_email"
  | "phone"
  | "linkedin_url"
  | "title"
  | "company"
  | "location"
  | "notes";

export type JobField = "title" | "company" | "location" | "job_url" | "description";

/** Synonyms for fuzzy header → field auto-mapping. Compared after lowercasing
 *  and stripping non-alphanumerics, so "First Name", "first_name", and
 *  "FIRST-NAME" all collapse to "firstname". */
const PEOPLE_SYNONYMS: Record<PeopleField, string[]> = {
  first_name: ["firstname", "fname", "givenname", "first"],
  last_name: ["lastname", "lname", "surname", "familyname", "last"],
  full_name: ["fullname", "name", "contactname", "personname", "candidatename"],
  email: ["email", "emailaddress", "emailaddr", "primaryemail", "mail", "eaddress"],
  work_email: ["workemail", "businessemail", "companyemail", "officeemail", "professionalemail"],
  personal_email: ["personalemail", "homeemail", "privateemail"],
  phone: ["phone", "phonenumber", "mobile", "mobilephone", "cell", "cellphone", "telephone", "tel", "contactnumber", "directphone", "workphone"],
  linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl", "liurl", "profileurl", "linkedinlink"],
  title: ["title", "jobtitle", "currenttitle", "position", "role", "headline", "designation"],
  company: ["company", "companyname", "currentcompany", "employer", "organization", "organisation", "account"],
  location: ["location", "city", "region", "geo", "address", "country", "locationtext", "citystate"],
  notes: ["notes", "note", "comments", "comment", "remarks", "description"],
};

const JOB_SYNONYMS: Record<JobField, string[]> = {
  title: ["title", "jobtitle", "position", "role", "jobname", "name", "reqtitle"],
  company: ["company", "companyname", "employer", "organization", "organisation", "client", "account"],
  location: ["location", "city", "region", "geo", "address", "country", "citystate"],
  job_url: ["url", "joburl", "link", "joblink", "postingurl", "linkedinurl", "linkedin", "jobposting"],
  description: ["description", "jobdescription", "desc", "details", "summary", "jobsummary", "responsibilities"],
};

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function autoMap<F extends string>(
  headers: string[],
  synonyms: Record<F, string[]>,
): Record<F, string> {
  const result = {} as Record<F, string>;
  const normedHeaders = headers.map((h) => ({ raw: h, norm: normalize(h) }));
  const taken = new Set<string>();

  (Object.keys(synonyms) as F[]).forEach((field) => {
    const candidates = synonyms[field];
    // 1) exact normalized match against a synonym
    let hit = normedHeaders.find((h) => !taken.has(h.raw) && candidates.includes(h.norm));
    // 2) fall back to substring containment (header contains synonym or v.v.)
    if (!hit) {
      hit = normedHeaders.find(
        (h) =>
          !taken.has(h.raw) &&
          candidates.some((c) => h.norm.includes(c) || c.includes(h.norm)),
      );
    }
    if (hit) {
      result[field] = hit.raw;
      taken.add(hit.raw);
    } else {
      result[field] = "";
    }
  });
  return result;
}

export function autoMapPeople(headers: string[]): Record<PeopleField, string> {
  return autoMap<PeopleField>(headers, PEOPLE_SYNONYMS);
}

export function autoMapJobs(headers: string[]): Record<JobField, string> {
  return autoMap<JobField>(headers, JOB_SYNONYMS);
}

export const PEOPLE_FIELDS: { key: PeopleField; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name (split if no first/last)" },
  { key: "email", label: "Email (auto-routed)" },
  { key: "work_email", label: "Work email" },
  { key: "personal_email", label: "Personal email" },
  { key: "phone", label: "Phone" },
  { key: "linkedin_url", label: "LinkedIn URL" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "notes", label: "Notes" },
];

export const JOB_FIELDS: { key: JobField; label: string }[] = [
  { key: "title", label: "Title (required)" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "job_url", label: "Job URL" },
  { key: "description", label: "Description" },
];

/** Build the per-row payload sent to the import endpoints from a mapping. */
export function applyMapping<F extends string>(
  rows: Record<string, string>[],
  mapping: Record<F, string>,
): Record<F, string>[] {
  const fields = Object.keys(mapping) as F[];
  return rows.map((row) => {
    const out = {} as Record<F, string>;
    for (const f of fields) {
      const col = mapping[f];
      out[f] = col ? (row[col] ?? "") : "";
    }
    return out;
  });
}
