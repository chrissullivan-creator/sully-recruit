// ─── Types ────────────────────────────────────────────────────────────────────

export interface MappedRow {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  current_title?: string;
  current_company?: string;
  linkedin_url?: string;
  stage?: string;
  source?: string;
  notes?: string;
  skills?: string;
  // jobs
  title?: string;
  company?: string;
  company_name?: string;
  location?: string;
  salary?: string;
  priority?: string;
  hiring_manager?: string;
}

export interface ParsedResult {
  mapped: MappedRow;
  errors: string[];
  raw: Record<string, string>;
  idx: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const VALID_CANDIDATE_STAGES = [
  'back_of_resume', 'pitch', 'send_out', 'submitted', 'interview',
  'first_round', 'second_round', 'third_plus_round', 'offer',
  'accepted', 'declined', 'counter_offer', 'disqualified',
];

export const VALID_JOB_STAGES = [
  'warm', 'hot', 'interviewing', 'offer', 'win', 'declined', 'lost', 'on_hold',
];

export const VALID_PRIORITIES = ['low', 'medium', 'high'];

// Alias map: schema_field → accepted CSV column names (lowercase)
export const CANDIDATE_ALIASES: Record<string, string[]> = {
  first_name: ['first_name', 'first', 'firstname', 'fname', 'given_name', 'given name', 'first name'],
  last_name: ['last_name', 'last', 'lastname', 'lname', 'surname', 'family_name', 'family name', 'last name'],
  email: ['email', 'email_address', 'e-mail', 'e_mail', 'email address'],
  phone: ['phone', 'phone_number', 'mobile', 'cell', 'telephone', 'phone number', 'mobile_number'],
  current_title: ['current_title', 'title', 'job_title', 'position', 'role', 'current title', 'current position', 'job title'],
  current_company: ['current_company', 'company', 'employer', 'organization', 'firm', 'current company', 'current employer'],
  linkedin_url: ['linkedin_url', 'linkedin', 'linkedin_profile', 'linkedin url', 'linkedin profile', 'profile_url'],
  stage: ['stage', 'pipeline_stage', 'candidate_stage'],
  source: ['source', 'lead_source', 'origin', 'referral', 'sourced_from'],
  notes: ['notes', 'note', 'comments', 'comment', 'bio', 'summary', 'additional_info'],
  skills: ['skills', 'skill', 'skill_set', 'skillset', 'technologies', 'tech_stack', 'expertise'],
};

export const JOB_ALIASES: Record<string, string[]> = {
  title: ['title', 'job_title', 'position', 'role', 'job title', 'job name', 'opening'],
  company: ['company', 'company_name', 'employer', 'firm', 'organization', 'client', 'current company'],
  location: ['location', 'city', 'office', 'site', 'work_location', 'work location'],
  salary: ['salary', 'compensation', 'comp', 'pay', 'salary_range', 'salary range', 'base_salary'],
  stage: ['stage', 'pipeline_stage', 'job_stage', 'status'],
  priority: ['priority', 'urgency', 'importance'],
  hiring_manager: ['hiring_manager', 'hiring manager', 'manager', 'contact', 'point_of_contact'],
  notes: ['notes', 'note', 'comments', 'comment', 'description', 'details', 'additional_info'],
};

export const CONTACT_ALIASES: Record<string, string[]> = {
  first_name:   ['first_name', 'first', 'firstname', 'fname', 'given_name', 'given name', 'first name'],
  last_name:    ['last_name', 'last', 'lastname', 'lname', 'surname', 'family name', 'last name'],
  email:        ['email', 'email_address', 'e-mail', 'e_mail', 'email address'],
  phone:        ['phone', 'phone_number', 'mobile', 'cell', 'telephone', 'direct', 'phone number'],
  title:        ['title', 'job_title', 'position', 'role', 'job title'],
  company_name: ['company_name', 'company', 'employer', 'firm', 'organization', 'account'],
  linkedin_url: ['linkedin_url', 'linkedin', 'linkedin_profile', 'linkedin url', 'profile_url'],
  _skip:        ['user_id', 'owner', 'owner_id', 'id', 'created_at', 'updated_at'],
};

// ─── CSV Parser ───────────────────────────────────────────────────────────────

export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols: string[] = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    cols.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, (cols[i] || '').replace(/^"|"$/g, '').trim()]));
  });
  return { headers, rows };
}

export function mapRow(row: Record<string, string>, entityType: string): MappedRow {
  const aliases = entityType === 'jobs' ? JOB_ALIASES : entityType === 'contacts' ? CONTACT_ALIASES : CANDIDATE_ALIASES;
  const mapped: Partial<MappedRow> = {};
  for (const [field, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      if (row[alias] !== undefined && row[alias] !== '') {
        (mapped as any)[field] = row[alias];
        break;
      }
    }
  }
  return mapped as MappedRow;
}

export function validateRow(mapped: MappedRow, entityType: string): string[] {
  const errors: string[] = [];
  if (entityType === 'jobs') {
    if (!mapped.title) errors.push('Missing title');
    if (mapped.stage) {
      const norm = mapped.stage.toLowerCase().replace(/\s/g, '_');
      if (!VALID_JOB_STAGES.includes(norm)) errors.push(`Invalid stage: "${mapped.stage}"`);
    }
    if (mapped.priority) {
      const norm = mapped.priority.toLowerCase();
      if (!VALID_PRIORITIES.includes(norm)) errors.push(`Invalid priority: "${mapped.priority}"`);
    }
  } else if (entityType === 'contacts') {
    if (!mapped.first_name) errors.push('Missing first name');
    if (!mapped.last_name) errors.push('Missing last name');
  } else {
    if (!mapped.first_name) errors.push('Missing first name');
    if (!mapped.last_name) errors.push('Missing last name');
    if (mapped.stage) {
      const norm = mapped.stage.toLowerCase().replace(/\s/g, '_');
      if (!VALID_CANDIDATE_STAGES.includes(norm)) errors.push(`Invalid stage: "${mapped.stage}"`);
    }
  }
  return errors;
}
