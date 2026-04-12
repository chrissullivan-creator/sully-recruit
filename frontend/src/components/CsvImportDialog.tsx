import { useState, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Upload, CheckCircle2, AlertCircle, Loader2, ArrowLeft } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Step = 'upload' | 'preview' | 'done';
interface MappedRow {
  first_name?: string; last_name?: string; email?: string; phone?: string;
  current_title?: string; current_company?: string; linkedin_url?: string;
  location_text?: string; stage?: string; source?: string; notes?: string; skills?: string;
  title?: string; company_name?: string;
  company?: string; location?: string; salary?: string; priority?: string; hiring_manager?: string;
}
interface ParsedResult { mapped: MappedRow; errors: string[]; raw: Record<string, string>; idx: number; }

const CANDIDATE_FIELDS: Record<string, string> = {
  first_name: 'First Name', last_name: 'Last Name', email: 'Email', phone: 'Phone',
  current_title: 'Current Title', current_company: 'Current Company',
  linkedin_url: 'LinkedIn URL', location_text: 'Location',
  stage: 'Stage', source: 'Source', notes: 'Notes', skills: 'Skills',
};
const CONTACT_FIELDS: Record<string, string> = {
  first_name: 'First Name', last_name: 'Last Name', email: 'Email', phone: 'Phone',
  title: 'Title', company_name: 'Company', linkedin_url: 'LinkedIn URL', notes: 'Notes',
};
const JOB_FIELDS: Record<string, string> = {
  title: 'Job Title', company: 'Company', location: 'Location',
  salary: 'Salary', stage: 'Stage', priority: 'Priority', hiring_manager: 'Hiring Manager', notes: 'Notes',
};
const CANDIDATE_ALIASES: Record<string, string[]> = {
  first_name: ['first_name','first','firstname','fname','given_name','given name','first name'],
  last_name: ['last_name','last','lastname','lname','surname','family_name','family name','last name'],
  email: ['email','email_address','e-mail','e_mail','email address','personal email','work email'],
  phone: ['phone','phone_number','mobile','cell','telephone','phone number','mobile_number','mobile phone','direct','direct phone'],
  current_title: ['current_title','title','job_title','position','role','current title','current position','job title'],
  current_company: ['current_company','company','employer','organization','firm','current company','current employer'],
  linkedin_url: ['linkedin_url','linkedin','linkedin_profile','linkedin url','linkedin profile','profile url','profile_url'],
  location_text: ['location','location_text','city','city state','work location','office location','geography'],
  stage: ['stage','pipeline_stage','candidate_stage'],
  source: ['source','lead_source','origin','referral','sourced_from'],
  notes: ['notes','note','comments','comment','bio','summary','additional_info'],
  skills: ['skills','skill','skill_set','skillset','technologies','tech_stack','expertise'],
};
const CONTACT_ALIASES: Record<string, string[]> = {
  first_name: ['first_name','first','firstname','fname','given name','first name'],
  last_name: ['last_name','last','lastname','lname','surname','family name','last name'],
  email: ['email','email_address','e-mail','personal email','work email','email address'],
  phone: ['phone','phone_number','mobile','cell','telephone','direct','mobile phone','phone number'],
  title: ['title','job_title','position','role','job title'],
  company_name: ['company_name','company','employer','firm','organization','account'],
  linkedin_url: ['linkedin_url','linkedin','linkedin_profile','linkedin url','profile url','profile_url'],
  notes: ['notes','note','comments','comment','bio','summary','additional_info'],
};
const JOB_ALIASES: Record<string, string[]> = {
  title: ['title','job_title','position','role','job title','opening'],
  company: ['company','company_name','employer','firm','organization','client'],
  location: ['location','city','office','site','work_location','work location'],
  salary: ['salary','compensation','comp','pay','salary_range','salary range'],
  stage: ['stage','pipeline_stage','job_stage','status'],
  priority: ['priority','urgency','importance'],
  hiring_manager: ['hiring_manager','hiring manager','manager','contact','point_of_contact'],
  notes: ['notes','note','comments','comment','description','details'],
};
const VALID_CANDIDATE_STAGES = ['back_of_resume','pitch','send_out','submitted','interview','first_round','second_round','third_plus_round','offer','accepted','declined','counter_offer','disqualified'];
const VALID_JOB_STAGES = ['lead','hot','offer_made','closed_won','closed_lost'];
const VALID_PRIORITIES = ['low','medium','high'];

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const rows = lines.slice(1).map(line => {
    const cols: string[] = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cols.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, (cols[i] || '').replace(/^"|"$/g, '').trim()]));
  });
  return { headers, rows };
}
function autoDetect(header: string, aliases: Record<string, string[]>): string | null {
  const h = header.toLowerCase().trim();
  for (const [field, list] of Object.entries(aliases)) { if (list.includes(h)) return field; }
  return null;
}
function applyMapping(rows: Record<string, string>[], columnMap: Record<string, string | null>, entityType: string): ParsedResult[] {
  return rows.filter(row => Object.values(row).some(v => v !== '')).map((row, i) => {
    const mapped: any = {};
    for (const [csvCol, field] of Object.entries(columnMap)) {
      if (field && row[csvCol] !== undefined && row[csvCol] !== '') mapped[field] = row[csvCol];
    }
    const errors: string[] = [];
    if (entityType === 'jobs') { if (!mapped.title) errors.push('Missing title'); }
    else { if (!mapped.first_name) errors.push('Missing first name'); if (!mapped.last_name) errors.push('Missing last name'); }
    return { raw: row, mapped, errors, idx: i + 2 };
  });
}

interface CsvImportDialogProps { open: boolean; onOpenChange: (open: boolean) => void; entityType: 'candidates' | 'contacts' | 'jobs'; }

export function CsvImportDialog({ open, onOpenChange, entityType }: CsvImportDialogProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [columnMap, setColumnMap] = useState<Record<string, string | null>>({});
  const [results, setResults] = useState<ParsedResult[]>([]);
  const [activeTab, setActiveTab] = useState<'valid' | 'issues' | 'mapping'>('mapping');
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [updatedCount, setUpdatedCount] = useState(0);

  const aliases = entityType === 'jobs' ? JOB_ALIASES : entityType === 'contacts' ? CONTACT_ALIASES : CANDIDATE_ALIASES;
  const fieldLabels = entityType === 'jobs' ? JOB_FIELDS : entityType === 'contacts' ? CONTACT_FIELDS : CANDIDATE_FIELDS;
  const valid = results.filter(r => r.errors.length === 0);
  const invalid = results.filter(r => r.errors.length > 0);
  const mappedCount = Object.values(columnMap).filter(Boolean).length;
  const unmappedCount = Object.values(columnMap).filter(v => v === null).length;

  const reset = () => { setStep('upload'); setFileName(''); setRawHeaders([]); setRawRows([]); setColumnMap({}); setResults([]); setActiveTab('mapping'); setImportedCount(0); setUpdatedCount(0); };
  const handleClose = () => { reset(); onOpenChange(false); };

  const processFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv')) { toast.error('Please upload a .csv file'); return; }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const { headers, rows } = parseCSV(text);
      setRawHeaders(headers); setRawRows(rows);
      const map: Record<string, string | null> = {};
      for (const h of headers) map[h] = autoDetect(h, aliases);
      setColumnMap(map);
      setResults(applyMapping(rows, map, entityType));
      setActiveTab(Object.values(map).some(v => v === null) ? 'mapping' : 'valid');
      setStep('preview');
    };
    reader.readAsText(file);
  }, [entityType, aliases]);

  const handleMapChange = (csvCol: string, newField: string | null) => {
    const updated = { ...columnMap, [csvCol]: newField };
    setColumnMap(updated);
    setResults(applyMapping(rawRows, updated, entityType));
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer?.files?.[0]; if (file) processFile(file);
  }, [processFile]);

  const handleImport = async () => {
    if (!user || valid.length === 0) return;
    setImporting(true);
    try {
      const BATCH = 50;
      let processed = 0;

      if (entityType === 'candidates') {
        const buildRow = (r: ParsedResult) => {
          const c = r.mapped as any;
          const csvStage = c.stage ? c.stage.toLowerCase().replace(/\s/g, '_') : 'back_of_resume';
          const skills = c.skills ? c.skills.split(/[,;|]/).map((s: string) => s.trim()).filter(Boolean) : [];
          const row: Record<string, any> = {
            user_id: user.id, first_name: c.first_name, last_name: c.last_name,
            full_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
            email: c.email || '',
            status: VALID_CANDIDATE_STAGES.includes(csvStage) ? csvStage : 'new',
            skills,
          };
          if (c.phone) row.phone = c.phone;
          if (c.current_title) row.current_title = c.current_title;
          if (c.current_company) row.current_company = c.current_company;
          if (c.linkedin_url) row.linkedin_url = c.linkedin_url;
          if (c.location_text) row.location_text = c.location_text;
          if (c.source) row.source = c.source;
          if (c.notes) row.notes = c.notes;
          return row;
        };

        // Prefetch existing emails
        const emailsInCsv = valid.map(r => (r.mapped as any).email?.toLowerCase().trim()).filter(Boolean);
        const { data: existing } = await supabase
          .from('candidates').select('id, email').in('email', emailsInCsv);
        const existingMap = new Map((existing ?? []).map((e: any) => [e.email?.toLowerCase().trim(), e.id]));

        const toUpdate = valid.filter(r => {
          const e = (r.mapped as any).email?.toLowerCase().trim();
          return e && existingMap.has(e);
        });
        const toInsert = valid.filter(r => {
          const e = (r.mapped as any).email?.toLowerCase().trim();
          return !e || !existingMap.has(e);
        });

        // Update existing records one by one (update by id to avoid constraint issues)
        for (const r of toUpdate) {
          const e = (r.mapped as any).email?.toLowerCase().trim();
          const id = existingMap.get(e);
          const row = buildRow(r);
          delete row.user_id; delete row.status; delete row.skills;
          await supabase.from('candidates').update(row).eq('id', id);
          processed++;
        }

        // Insert new records in batches
        if (toInsert.length > 0) {
          const rows = toInsert.map(buildRow);
          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase.from('candidates').insert(rows.slice(i, i + BATCH) as any);
            if (error) throw error;
            processed += Math.min(BATCH, rows.length - i);
          }
        }
        queryClient.invalidateQueries({ queryKey: ['candidates'] });

      } else if (entityType === 'contacts') {
        const buildRow = (r: ParsedResult) => {
          const c = r.mapped as any;
          const row: Record<string, any> = {
            user_id: user.id, first_name: c.first_name, last_name: c.last_name,
            full_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
            email: c.email || '',
          };
          if (c.phone) row.phone = c.phone;
          if (c.title) row.title = c.title;
          if (c.company_name) row.company_name = c.company_name;
          if (c.linkedin_url) row.linkedin_url = c.linkedin_url;
          if (c.notes) row.notes = c.notes;
          return row;
        };

        const emailsInCsv = valid.map(r => (r.mapped as any).email?.toLowerCase().trim()).filter(Boolean);
        const { data: existing } = await supabase
          .from('contacts').select('id, email').in('email', emailsInCsv);
        const existingMap = new Map((existing ?? []).map((e: any) => [e.email?.toLowerCase().trim(), e.id]));

        const toUpdate = valid.filter(r => {
          const e = (r.mapped as any).email?.toLowerCase().trim();
          return e && existingMap.has(e);
        });
        const toInsert = valid.filter(r => {
          const e = (r.mapped as any).email?.toLowerCase().trim();
          return !e || !existingMap.has(e);
        });

        for (const r of toUpdate) {
          const e = (r.mapped as any).email?.toLowerCase().trim();
          const id = existingMap.get(e);
          const row = buildRow(r);
          delete row.user_id;
          await supabase.from('contacts').update(row).eq('id', id);
          processed++;
        }

        if (toInsert.length > 0) {
          const rows = toInsert.map(buildRow);
          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase.from('contacts').insert(rows.slice(i, i + BATCH) as any);
            if (error) throw error;
            processed += Math.min(BATCH, rows.length - i);
          }
        }
        queryClient.invalidateQueries({ queryKey: ['contacts'] });

      } else {
        const rows = valid.map(r => {
          const j = r.mapped as any;
          const stage = j.stage ? j.stage.toLowerCase().replace(/\s/g, '_') : 'lead';
          const priority = j.priority ? j.priority.toLowerCase() : 'medium';
          const row: Record<string, any> = {
            user_id: user.id, title: j.title || '', company: j.company || '',
            location: j.location || '', status: VALID_JOB_STAGES.includes(stage) ? stage : 'lead',
            priority: VALID_PRIORITIES.includes(priority) ? priority : 'medium',
          };
          if (j.salary) row.salary = j.salary;
          if (j.hiring_manager) row.hiring_manager = j.hiring_manager;
          if (j.notes) row.notes = j.notes;
          return row;
        });
        for (let i = 0; i < rows.length; i += BATCH) {
          const { error } = await supabase.from('jobs').insert(rows.slice(i, i + BATCH) as any);
          if (error) throw error;
          processed += Math.min(BATCH, rows.length - i);
        }
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
      }

      setImportedCount(processed);
      setStep('done');
    } catch (err: any) {
      toast.error(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-5 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            {step === 'preview' && <Button variant="ghost" size="icon" className="h-7 w-7 -ml-1" onClick={reset}><ArrowLeft className="h-4 w-4" /></Button>}
            <DialogTitle className="text-base">
              {step === 'upload' && `Import ${entityType.charAt(0).toUpperCase() + entityType.slice(1)} via CSV`}
              {step === 'preview' && `Review Import — ${fileName}`}
              {step === 'done' && 'Import Complete'}
            </DialogTitle>
            {step === 'preview' && (
              <div className="flex items-center gap-3 ml-auto">
                <span className="text-xs text-muted-foreground">{valid.length} ready</span>
                {invalid.length > 0 && <span className="text-xs text-destructive">{invalid.length} issues</span>}
                {unmappedCount > 0 && <span className="text-xs text-yellow-500">{unmappedCount} unmapped</span>}
              </div>
            )}
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {step === 'upload' && (
            <div className="flex-1 flex flex-col items-center justify-center p-10">
              <div className={cn('w-full max-w-lg rounded-xl border-2 border-dashed p-12 text-center cursor-pointer transition-all', dragging ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50 hover:bg-muted/30')}
                onDrop={handleDrop} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onClick={() => fileInputRef.current?.click()}>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 mx-auto mb-4"><Upload className="h-6 w-6 text-accent" /></div>
                <p className="text-sm font-medium text-foreground mb-1">Drop your CSV here or <span className="text-accent">browse</span></p>
                <p className="text-xs text-muted-foreground">After uploading you can manually map any columns that weren't auto-detected.</p>
                <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); }} />
              </div>
            </div>
          )}
          {step === 'preview' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex border-b border-border shrink-0 px-6">
                {(['mapping', 'valid', 'issues'] as const).map(key => (
                  <button key={key} onClick={() => setActiveTab(key)} className={cn('py-3 px-4 text-xs font-medium border-b-2 transition-colors', activeTab === key ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                    {key === 'mapping' ? `Column Map (${mappedCount}/${rawHeaders.length})` : key === 'valid' ? `Ready (${valid.length})` : `Issues (${invalid.length})`}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-auto">
                {activeTab === 'mapping' && (
                  <div>
                    {unmappedCount > 0 && <div className="px-4 py-3 bg-yellow-500/5 border-b border-yellow-500/20 text-xs text-yellow-400 flex items-center gap-2"><AlertCircle className="h-3.5 w-3.5 shrink-0" />{unmappedCount} column{unmappedCount !== 1 ? 's' : ''} not auto-detected — use the dropdowns to map them.</div>}
                    <table className="w-full text-xs">
                      <thead className="table-header-green sticky top-0"><tr>
                        <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide w-5/12">Your CSV Column</th>
                        <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide w-5/12">Maps To</th>
                        <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Status</th>
                      </tr></thead>
                      <tbody className="divide-y divide-border">
                        {rawHeaders.map(header => {
                          const cur = columnMap[header]; const sample = rawRows[0]?.[header] ?? '';
                          return (
                            <tr key={header} className={cn('hover:bg-muted/40 transition-colors', !cur && 'bg-yellow-500/5')}>
                              <td className="px-4 py-2.5"><div className="font-mono text-foreground">{header}</div>{sample && <div className="text-muted-foreground mt-0.5 truncate max-w-[200px]">e.g. {sample}</div>}</td>
                              <td className="px-4 py-2.5">
                                <Select value={cur ?? '__skip__'} onValueChange={val => handleMapChange(header, val === '__skip__' ? null : val)}>
                                  <SelectTrigger className="h-7 text-xs w-full max-w-[220px]"><SelectValue placeholder="— skip —" /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__skip__">— skip this column —</SelectItem>
                                    {Object.entries(fieldLabels).map(([f, l]) => <SelectItem key={f} value={f}>{l}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="px-4 py-2.5">{cur ? <span className="stage-badge bg-success/10 text-success border border-success/20">matched</span> : <span className="stage-badge bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">skipped</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {activeTab === 'valid' && (valid.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground"><AlertCircle className="h-8 w-8 mb-3 opacity-40" /><p className="text-sm">No valid rows yet — check the Column Map tab</p></div>
                ) : entityType === 'candidates' ? (
                  <table className="w-full text-xs"><thead className="table-header-green sticky top-0"><tr>{['#','Name','Email','Phone','Title','Company','Location'].map(h => <th key={h} className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-border">{valid.map((r,i) => <tr key={i} className="hover:bg-muted/40"><td className="px-4 py-2.5 text-muted-foreground">{i+1}</td><td className="px-4 py-2.5 font-medium text-foreground">{(r.mapped as any).first_name} {(r.mapped as any).last_name}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).email||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).phone||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).current_title||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).current_company||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).location_text||'—'}</td></tr>)}</tbody></table>
                ) : entityType === 'contacts' ? (
                  <table className="w-full text-xs"><thead className="table-header-green sticky top-0"><tr>{['#','Name','Title','Company','Email','Phone'].map(h => <th key={h} className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-border">{valid.map((r,i) => <tr key={i} className="hover:bg-muted/40"><td className="px-4 py-2.5 text-muted-foreground">{i+1}</td><td className="px-4 py-2.5 font-medium text-foreground">{(r.mapped as any).first_name} {(r.mapped as any).last_name}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).title||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).company_name||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).email||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).phone||'—'}</td></tr>)}</tbody></table>
                ) : (
                  <table className="w-full text-xs"><thead className="table-header-green sticky top-0"><tr>{['#','Title','Company','Location','Stage','Priority'].map(h => <th key={h} className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-border">{valid.map((r,i) => <tr key={i} className="hover:bg-muted/40"><td className="px-4 py-2.5 text-muted-foreground">{i+1}</td><td className="px-4 py-2.5 font-medium text-foreground">{(r.mapped as any).title||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).company||'—'}</td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).location||'—'}</td><td className="px-4 py-2.5"><span className="stage-badge bg-success/10 text-success border border-success/20">{(r.mapped as any).stage||'lead'}</span></td><td className="px-4 py-2.5 text-muted-foreground">{(r.mapped as any).priority||'medium'}</td></tr>)}</tbody></table>
                ))}
                {activeTab === 'issues' && (invalid.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground"><CheckCircle2 className="h-8 w-8 mb-3 opacity-40 text-success" /><p className="text-sm">No issues — all rows are valid!</p></div>
                ) : (
                  <table className="w-full text-xs"><thead className="table-header-green sticky top-0"><tr>{['Row','Name','Issues'].map(h => <th key={h} className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-border">{invalid.map((r,i) => <tr key={i} className="hover:bg-muted/40"><td className="px-4 py-2.5 text-muted-foreground">{r.idx}</td><td className="px-4 py-2.5 text-foreground">{entityType==='jobs'?(r.mapped as any).title||'—':[(r.mapped as any).first_name,(r.mapped as any).last_name].filter(Boolean).join(' ')||'—'}</td><td className="px-4 py-2.5"><div className="flex flex-wrap gap-1">{r.errors.map((e,j) => <span key={j} className="stage-badge bg-destructive/10 text-destructive border border-destructive/20">{e}</span>)}</div></td></tr>)}</tbody></table>
                ))}
              </div>
            </div>
          )}
          {step === 'done' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-5 p-10">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10"><CheckCircle2 className="h-8 w-8 text-success" /></div>
              <div className="text-center">
                <p className="text-lg font-semibold text-foreground">{importedCount} {entityType==='jobs'?`job${importedCount!==1?'s':''}`:entityType==='contacts'?`contact${importedCount!==1?'s':''}` :`candidate${importedCount!==1?'s':''}`} processed</p>
                <p className="text-sm text-muted-foreground mt-1">New records added + existing records updated by email match.</p>
              </div>
              <div className="flex gap-3"><Button variant="outline" onClick={reset}>Import Another File</Button><Button variant="gold" onClick={handleClose}>Done</Button></div>
            </div>
          )}
        </div>
        {step === 'preview' && (
          <div className="px-6 py-4 border-t border-border shrink-0 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {invalid.length > 0 && `${invalid.length} rows with issues will be skipped. `}{valid.length} row{valid.length!==1?'s':''} will be imported.{unmappedCount > 0 && <span className="text-yellow-400 ml-1">({unmappedCount} columns skipped)</span>}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button variant="gold" onClick={handleImport} disabled={importing||valid.length===0}>
                {importing?<><Loader2 className="h-4 w-4 animate-spin mr-1"/>Importing...</>:<>Import {valid.length} {entityType==='jobs'?'job':entityType==='contacts'?'contact':'candidate'}{valid.length!==1?'s':''}</>}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
