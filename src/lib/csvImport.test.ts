import { describe, it, expect } from 'vitest';
import { parseCSV, mapRow, validateRow } from './csvImport';

// ─── parseCSV ─────────────────────────────────────────────────────────────────

describe('parseCSV', () => {
  it('parses basic CSV with headers and rows', () => {
    const csv = 'First Name,Last Name,Email\nJohn,Doe,john@example.com\nJane,Smith,jane@example.com';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(['first name', 'last name', 'email']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      'first name': 'John',
      'last name': 'Doe',
      'email': 'john@example.com',
    });
  });

  it('returns empty for single-line input (header only)', () => {
    const result = parseCSV('Name,Email');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('returns empty for empty string', () => {
    const result = parseCSV('');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('handles quoted fields with commas inside', () => {
    const csv = 'Name,Title\nJohn,"VP, Engineering"\nJane,"Director, Sales"';
    const result = parseCSV(csv);
    expect(result.rows[0]['title']).toBe('VP, Engineering');
    expect(result.rows[1]['title']).toBe('Director, Sales');
  });

  it('handles quoted headers', () => {
    const csv = '"First Name","Last Name"\nJohn,Doe';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(['first name', 'last name']);
  });

  it('lowercases and trims headers', () => {
    const csv = '  First_Name , EMAIL , Phone \nJohn,john@test.com,555-1234';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(['first_name', 'email', 'phone']);
  });

  it('handles Windows-style line endings (\\r\\n)', () => {
    const csv = 'Name,Email\r\nJohn,john@test.com\r\nJane,jane@test.com';
    const result = parseCSV(csv);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]['name']).toBe('John');
  });

  it('handles missing columns in rows gracefully', () => {
    const csv = 'A,B,C\n1,2\n4,5,6';
    const result = parseCSV(csv);
    expect(result.rows[0]).toEqual({ a: '1', b: '2', c: '' });
    expect(result.rows[1]).toEqual({ a: '4', b: '5', c: '6' });
  });
});

// ─── mapRow ───────────────────────────────────────────────────────────────────

describe('mapRow', () => {
  it('maps candidate aliases correctly', () => {
    const row = { first_name: 'John', last_name: 'Doe', email: 'john@test.com', title: 'Engineer' };
    const result = mapRow(row, 'candidates');
    expect(result.first_name).toBe('John');
    expect(result.last_name).toBe('Doe');
    expect(result.email).toBe('john@test.com');
    expect(result.title).toBe('Engineer');
  });

  it('resolves alternative aliases for candidates', () => {
    const row = { fname: 'Jane', surname: 'Smith', 'e-mail': 'jane@test.com', employer: 'Acme' };
    const result = mapRow(row, 'candidates');
    expect(result.first_name).toBe('Jane');
    expect(result.last_name).toBe('Smith');
    expect(result.email).toBe('jane@test.com');
    expect(result.company).toBe('Acme');
  });

  it('maps job aliases correctly', () => {
    const row = { title: 'Software Engineer', company: 'Acme', city: 'NYC', compensation: '150k' };
    const result = mapRow(row, 'jobs');
    expect(result.title).toBe('Software Engineer');
    expect(result.company).toBe('Acme');
    expect(result.location).toBe('NYC');
    expect(result.salary).toBe('150k');
  });

  it('maps contact aliases correctly', () => {
    const row = { firstname: 'Bob', lname: 'Jones', company: 'BigCorp', mobile: '555-0000' };
    const result = mapRow(row, 'contacts');
    expect(result.first_name).toBe('Bob');
    expect(result.last_name).toBe('Jones');
    expect(result.company_name).toBe('BigCorp');
    expect(result.phone).toBe('555-0000');
  });

  it('ignores unmapped columns', () => {
    const row = { first_name: 'John', last_name: 'Doe', random_column: 'ignored' };
    const result = mapRow(row, 'candidates');
    expect(result.first_name).toBe('John');
    expect((result as any).random_column).toBeUndefined();
  });

  it('skips empty values', () => {
    const row = { first_name: '', fname: 'John', last_name: 'Doe' };
    const result = mapRow(row, 'candidates');
    expect(result.first_name).toBe('John');
  });

  it('uses first matching alias (priority order)', () => {
    const row = { first_name: 'Primary', fname: 'Fallback' };
    const result = mapRow(row, 'candidates');
    expect(result.first_name).toBe('Primary');
  });
});

// ─── validateRow ──────────────────────────────────────────────────────────────

describe('validateRow', () => {
  describe('candidates', () => {
    it('returns no errors for valid candidate', () => {
      const errors = validateRow({ first_name: 'John', last_name: 'Doe' }, 'candidates');
      expect(errors).toEqual([]);
    });

    it('reports missing first name', () => {
      const errors = validateRow({ last_name: 'Doe' }, 'candidates');
      expect(errors).toContain('Missing first name');
    });

    it('reports missing last name', () => {
      const errors = validateRow({ first_name: 'John' }, 'candidates');
      expect(errors).toContain('Missing last name');
    });

    it('reports both missing names', () => {
      const errors = validateRow({}, 'candidates');
      expect(errors).toContain('Missing first name');
      expect(errors).toContain('Missing last name');
    });

    it('accepts valid candidate stage', () => {
      const errors = validateRow({ first_name: 'John', last_name: 'Doe', stage: 'interview' }, 'candidates');
      expect(errors).toEqual([]);
    });

    it('rejects invalid candidate stage', () => {
      const errors = validateRow({ first_name: 'John', last_name: 'Doe', stage: 'bogus' }, 'candidates');
      expect(errors).toContain('Invalid stage: "bogus"');
    });

    it('allows missing stage (optional)', () => {
      const errors = validateRow({ first_name: 'John', last_name: 'Doe' }, 'candidates');
      expect(errors).toEqual([]);
    });
  });

  describe('jobs', () => {
    it('returns no errors for valid job', () => {
      const errors = validateRow({ title: 'Engineer' }, 'jobs');
      expect(errors).toEqual([]);
    });

    it('reports missing title', () => {
      const errors = validateRow({}, 'jobs');
      expect(errors).toContain('Missing title');
    });

    it('accepts valid job stage', () => {
      const errors = validateRow({ title: 'Engineer', stage: 'hot' }, 'jobs');
      expect(errors).toEqual([]);
    });

    it('rejects invalid job stage', () => {
      const errors = validateRow({ title: 'Engineer', stage: 'invalid_stage' }, 'jobs');
      expect(errors).toContain('Invalid stage: "invalid_stage"');
    });

    it('accepts valid priority', () => {
      const errors = validateRow({ title: 'Engineer', priority: 'high' }, 'jobs');
      expect(errors).toEqual([]);
    });

    it('rejects invalid priority', () => {
      const errors = validateRow({ title: 'Engineer', priority: 'urgent' }, 'jobs');
      expect(errors).toContain('Invalid priority: "urgent"');
    });
  });

  describe('contacts', () => {
    it('returns no errors for valid contact', () => {
      const errors = validateRow({ first_name: 'John', last_name: 'Doe' }, 'contacts');
      expect(errors).toEqual([]);
    });

    it('reports missing first name', () => {
      const errors = validateRow({ last_name: 'Doe' }, 'contacts');
      expect(errors).toContain('Missing first name');
    });

    it('reports missing last name', () => {
      const errors = validateRow({ first_name: 'John' }, 'contacts');
      expect(errors).toContain('Missing last name');
    });
  });
});
