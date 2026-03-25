import { useState, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Upload, CheckCircle2, AlertCircle, Loader2, FileText,
  ChevronRight, X, ArrowLeft,
} from 'lucide-react';
import {
  type MappedRow,
  type ParsedResult,
  VALID_CANDIDATE_STAGES,
  VALID_JOB_STAGES,
  VALID_PRIORITIES,
  CANDIDATE_ALIASES,
  JOB_ALIASES,
  CONTACT_ALIASES,
  parseCSV,
  mapRow,
  validateRow,
} from '@/lib/csvImport';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'preview' | 'done';

// ─── Main Component ───────────────────────────────────────────────────────────

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'candidates' | 'contacts' | 'jobs';
}

export function CsvImportDialog({ open, onOpenChange, entityType }: CsvImportDialogProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [results, setResults] = useState<ParsedResult[]>([]);
  const [activeTab, setActiveTab] = useState<'valid' | 'issues' | 'mapping'>('valid');
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  const valid = results.filter((r) => r.errors.length === 0);
  const invalid = results.filter((r) => r.errors.length > 0);

  const reset = () => {
    setStep('upload');
    setFileName('');
    setHeaders([]);
    setResults([]);
    setActiveTab('valid');
    setImportedCount(0);
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const processFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv')) {
      toast.error('Please upload a .csv file');
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: h, rows } = parseCSV(text);
      setHeaders(h);
      const parsed = rows
        .filter((row) => Object.values(row).some((v) => v !== ''))
        .map((row, i) => {
          const mapped = mapRow(row, entityType);
          const errors = validateRow(mapped, entityType);
          return { raw: row, mapped, errors, idx: i + 2 };
        });
      setResults(parsed);
      setStep('preview');
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleImport = async () => {
    if (!user || valid.length === 0) return;
    setImporting(true);

    try {
      if (entityType === 'candidates') {
        const rows = valid.map((r) => {
          const c = r.mapped;
          const stage = c.stage
            ? c.stage.toLowerCase().replace(/\s/g, '_')
            : 'back_of_resume';
          const safeStage = VALID_CANDIDATE_STAGES.includes(stage) ? stage : 'back_of_resume';
          const skills = c.skills
            ? c.skills.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
            : [];
          const row: Record<string, any> = {
            user_id: user.id,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email || '',
            stage: safeStage,
            status: 'new',
            skills,
          };
          if (c.phone) row.phone = c.phone;
          if (c.current_title) row.current_title = c.current_title;
          if (c.current_company) row.current_company = c.current_company;
          if (c.linkedin_url) row.linkedin_url = c.linkedin_url;
          if (c.source) row.source = c.source;
          if (c.notes) row.notes = c.notes;
          return row;
        });

        const BATCH = 100;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error } = await supabase.from('candidates').insert(batch as any);
          if (error) throw error;
          inserted += batch.length;
        }
        setImportedCount(inserted);
        queryClient.invalidateQueries({ queryKey: ['candidates'] });

      } else if (entityType === 'jobs') {
        const rows = valid.map((r) => {
          const j = r.mapped;
          const stage = j.stage
            ? j.stage.toLowerCase().replace(/\s/g, '_')
            : 'warm';
          const safeStage = VALID_JOB_STAGES.includes(stage) ? stage : 'warm';
          const priority = j.priority
            ? j.priority.toLowerCase()
            : 'medium';
          const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
          const row: Record<string, any> = {
            user_id: user.id,
            title: j.title || '',
            company: j.company || '',
            location: j.location || '',
            stage: safeStage,
            priority: safePriority,
          };
          if (j.salary) row.salary = j.salary;
          if (j.hiring_manager) row.hiring_manager = j.hiring_manager;
          if (j.notes) row.notes = j.notes;
          return row;
        });

        const BATCH = 100;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error } = await supabase.from('jobs').insert(batch as any);
          if (error) throw error;
          inserted += batch.length;
        }
        setImportedCount(inserted);
        queryClient.invalidateQueries({ queryKey: ['jobs'] });

      } else if (entityType === 'contacts') {
        const rows = valid.map((r) => {
          const c = r.mapped;
          const row: Record<string, any> = {
            owner_id: user.id,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email || '',
            status: 'active',
          };
          if (c.phone) row.phone = c.phone;
          if (c.title) row.title = c.title;
          if (c.company_name) row.company_name = c.company_name;
          if (c.linkedin_url) row.linkedin_url = c.linkedin_url;
          return row;
        });

        const BATCH = 100;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error } = await supabase.from('contacts').upsert(batch as any, { onConflict: 'email', ignoreDuplicates: false });
          if (error) throw error;
          inserted += batch.length;
        }
        setImportedCount(inserted);
        queryClient.invalidateQueries({ queryKey: ['contacts'] });
      }

      setStep('done');
    } catch (err: any) {
      toast.error(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // ── Column mapping display ──
  const activeAliases = entityType === 'jobs' ? JOB_ALIASES : entityType === 'contacts' ? CONTACT_ALIASES : CANDIDATE_ALIASES;
  const columnMappings = headers.map((h) => {
    const match = Object.entries(activeAliases).find(([, aliases]) => aliases.includes(h));
    return { header: h, field: match?.[0] ?? null };
  });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-6 py-5 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            {step === 'preview' && (
              <Button variant="ghost" size="icon" className="h-7 w-7 -ml-1" onClick={reset}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <DialogTitle className="text-base">
              {step === 'upload' && `Import ${entityType.charAt(0).toUpperCase() + entityType.slice(1)} via CSV`}
              {step === 'preview' && `Review Import — ${fileName}`}
              {step === 'done' && 'Import Complete'}
            </DialogTitle>
            {step === 'preview' && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-muted-foreground">{valid.length} ready</span>
                {invalid.length > 0 && (
                  <span className="text-xs text-destructive">{invalid.length} issues</span>
                )}
              </div>
            )}
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">

          {/* ── UPLOAD STEP ── */}
          {step === 'upload' && (
            <div className="flex-1 flex flex-col items-center justify-center p-10 gap-6">
              <div
                className={cn(
                  'w-full max-w-lg rounded-xl border-2 border-dashed p-12 text-center cursor-pointer transition-all',
                  dragging
                    ? 'border-accent bg-accent/5'
                    : 'border-border hover:border-accent/50 hover:bg-muted/30'
                )}
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 mx-auto mb-4">
                  <Upload className="h-6 w-6 text-accent" />
                </div>
                <p className="text-sm font-medium text-foreground mb-1">
                  Drop your CSV here or <span className="text-accent">browse</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {entityType === 'jobs'
                    ? 'Supports any standard jobs CSV with title, company, location, etc.'
                    : entityType === 'contacts'
                    ? 'Supports any standard contacts CSV with name, title, company, email, etc.'
                    : 'Supports Recruiterflow exports and any standard candidate CSV'}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); }}
                />
              </div>

              {/* Field reference */}
              <div className="w-full max-w-lg rounded-lg border border-border bg-secondary/50 p-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                  Recognized column names
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-muted-foreground">
                  {Object.entries(entityType === 'jobs' ? JOB_ALIASES : entityType === 'contacts' ? CONTACT_ALIASES : CANDIDATE_ALIASES).map(([field, aliases]) => (
                    <div key={field} className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground w-28 shrink-0">{field}</span>
                      <span className="truncate opacity-60">{aliases.slice(0, 3).join(', ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── PREVIEW STEP ── */}
          {step === 'preview' && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Tabs */}
              <div className="flex border-b border-border shrink-0 px-6">
                {([
                  ['valid', `Ready (${valid.length})`],
                  ['issues', `Issues (${invalid.length})`],
                  ['mapping', 'Column Map'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={cn(
                      'py-3 px-4 text-xs font-medium border-b-2 transition-colors',
                      activeTab === key
                        ? 'border-accent text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-auto">

                {/* Valid rows */}
                {activeTab === 'valid' && (
                  valid.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <AlertCircle className="h-8 w-8 mb-3 opacity-40" />
                      <p className="text-sm">No valid rows found</p>
                    </div>
                  ) : entityType === 'jobs' ? (
                    <table className="w-full text-xs">
                      <thead className="bg-secondary sticky top-0">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">#</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Title</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Company</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Location</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Stage</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Priority</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {valid.map((r, i) => (
                          <tr key={i} className="hover:bg-muted/40 transition-colors">
                            <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
                            <td className="px-4 py-2.5 font-medium text-foreground">{r.mapped.title || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.company || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.location || '—'}</td>
                            <td className="px-4 py-2.5">
                              <span className="stage-badge bg-success/10 text-success border border-success/20">
                                {r.mapped.stage || 'warm'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.priority || 'medium'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : entityType === 'contacts' ? (
                    <table className="w-full text-xs">
                      <thead className="bg-secondary sticky top-0">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">#</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Name</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Title</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Company</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Email</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Phone</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {valid.map((r, i) => (
                          <tr key={i} className="hover:bg-muted/40 transition-colors">
                            <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
                            <td className="px-4 py-2.5 font-medium text-foreground">{r.mapped.first_name} {r.mapped.last_name}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.title || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.company_name || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.email || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.phone || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="bg-secondary sticky top-0">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">#</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Name</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Email</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Title</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Company</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Stage</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {valid.map((r, i) => (
                          <tr key={i} className="hover:bg-muted/40 transition-colors">
                            <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
                            <td className="px-4 py-2.5 font-medium text-foreground">
                              {r.mapped.first_name} {r.mapped.last_name}
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.email || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.current_title || '—'}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.current_company || '—'}</td>
                            <td className="px-4 py-2.5">
                              <span className="stage-badge bg-success/10 text-success border border-success/20">
                                {r.mapped.stage || 'back_of_resume'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              <span className="stage-badge bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                new
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {/* Issues */}
                {activeTab === 'issues' && (
                  invalid.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <CheckCircle2 className="h-8 w-8 mb-3 opacity-40 text-success" />
                      <p className="text-sm">No issues — all rows are valid!</p>
                    </div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="bg-secondary sticky top-0">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Row</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Name</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Email</th>
                          <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Issues</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {invalid.map((r, i) => (
                          <tr key={i} className="hover:bg-muted/40">
                            <td className="px-4 py-2.5 text-muted-foreground">{r.idx}</td>
                            <td className="px-4 py-2.5 text-foreground">
                              {entityType === 'jobs'
                                ? r.mapped.title || '—'
                                : [r.mapped.first_name, r.mapped.last_name].filter(Boolean).join(' ') || '—'}                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.mapped.email || '—'}</td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {r.errors.map((e, j) => (
                                  <span key={j} className="stage-badge bg-destructive/10 text-destructive border border-destructive/20">
                                    {e}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {/* Column mapping */}
                {activeTab === 'mapping' && (
                  <table className="w-full text-xs">
                    <thead className="bg-secondary sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Your CSV Column</th>
                        <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Maps To</th>
                        <th className="text-left px-4 py-2.5 text-muted-foreground font-medium uppercase tracking-wide">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {columnMappings.map(({ header, field }, i) => (
                        <tr key={i} className="hover:bg-muted/40">
                          <td className="px-4 py-2.5 font-mono text-foreground">{header}</td>
                          <td className="px-4 py-2.5 font-mono text-accent">{field ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="px-4 py-2.5">
                            {field ? (
                              <span className="stage-badge bg-success/10 text-success border border-success/20">matched</span>
                            ) : (
                              <span className="stage-badge bg-muted text-muted-foreground border border-border">skipped</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* ── DONE STEP ── */}
          {step === 'done' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-5 p-10">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </div>
              <div className="text-center">
                <p className="text-lg font-semibold text-foreground">
                  {importedCount} {entityType === 'jobs' ? `job${importedCount !== 1 ? 's' : ''}` : entityType === 'contacts' ? `contact${importedCount !== 1 ? 's' : ''}` : `candidate${importedCount !== 1 ? 's' : ''}`} imported
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {entityType === 'jobs' ? "They'll appear in your jobs list now." : entityType === 'contacts' ? "They'll appear in your contacts list now." : "They'll appear in your candidates list now."}
                </p>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" onClick={reset}>Import Another File</Button>
                <Button variant="gold" onClick={handleClose}>Done</Button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {step === 'preview' && (
          <div className="px-6 py-4 border-t border-border shrink-0 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {invalid.length > 0 && `${invalid.length} rows with issues will be skipped. `}
              {valid.length} row{valid.length !== 1 ? 's' : ''} will be imported.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button
                variant="gold"
                onClick={handleImport}
                disabled={importing || valid.length === 0}
              >
                {importing ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Importing...</>
                ) : (
                  <>Import {valid.length} {entityType.slice(0, -1)}{valid.length !== 1 ? 's' : ''}</>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
