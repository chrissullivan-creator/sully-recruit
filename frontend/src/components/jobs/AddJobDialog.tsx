import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCompanies } from '@/hooks/useData';
import { toast } from 'sonner';
import { Loader2, Globe, FileUp, PenLine, ArrowLeft, ExternalLink, Check, Briefcase } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type JobForm = {
  title: string;
  company_id: string;
  company_name: string;
  location: string;
  description: string;
  compensation: string;
  status: string;
  job_url: string;
};

const emptyForm: JobForm = {
  title: '',
  company_id: '',
  company_name: '',
  location: '',
  description: '',
  compensation: '',
  status: 'lead',
  job_url: '',
};

type Step = 'source' | 'pick' | 'form';

export function AddJobDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useCompanies();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('source');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState('');
  const [form, setForm] = useState<JobForm>({ ...emptyForm });

  // Multi-job state
  const [parsedJobs, setParsedJobs] = useState<JobForm[]>([]);
  const [selectedJobIndexes, setSelectedJobIndexes] = useState<Set<number>>(new Set());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const resetDialog = () => {
    setStep('source');
    setParsing(false);
    setParseError('');
    setSaving(false);
    setUrl('');
    setForm({ ...emptyForm });
    setParsedJobs([]);
    setSelectedJobIndexes(new Set());
    setEditingIndex(null);
  };

  const handleOpenChange = (val: boolean) => {
    if (!val) resetDialog();
    onOpenChange(val);
  };

  const matchCompany = (name: string): { id: string; name: string } | null => {
    if (!name) return null;
    const match = companies.find((c: any) => c.name.toLowerCase() === name.toLowerCase());
    return match ? { id: match.id, name: match.name } : null;
  };

  // ── Parse from URL (single job) ─────────────────────────────────
  const parseFromUrl = async () => {
    if (!url.trim()) { toast.error('Please enter a URL'); return; }
    setParsing(true);
    setParseError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-job`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: url.trim() }),
        }
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to parse URL');

      const p = data.parsed || {};
      const co = matchCompany(p.company_name);
      setForm({
        title: p.title || '',
        company_id: co?.id || '',
        company_name: p.company_name || '',
        location: p.location || '',
        description: p.description || '',
        compensation: p.compensation || '',
        status: 'lead',
        job_url: url.trim(),
      });
      setStep('form');
    } catch (err: any) {
      setParseError(err.message || 'Failed to parse job posting');
      toast.error(err.message || 'Failed to parse job posting');
    } finally {
      setParsing(false);
    }
  };

  // ── Parse from file (multi-job) ─────────────────────────────────
  // Parse a single file and return parsed jobs
  const parseSingleFile = async (file: File, session: any): Promise<JobForm[]> => {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-job`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: fd,
      }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Failed to parse ${file.name}`);

    const jobs: any[] = data.jobs || [data.parsed || {}];
    return jobs.map((p: any) => {
      const co = matchCompany(p.company_name);
      return {
        title: p.title || '',
        company_id: co?.id || '',
        company_name: p.company_name || '',
        location: p.location || '',
        description: p.description || '',
        compensation: p.compensation || '',
        status: 'lead',
        job_url: '',
      };
    });
  };

  // ── Parse from file(s) (multi-job) ──────────────────────────────
  const parseFromFiles = async (files: File[]) => {
    setParsing(true);
    setParseError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const allJobs: JobForm[] = [];

      let failCount = 0;
      for (const file of files) {
        try {
          const jobs = await parseSingleFile(file, session);
          // Filter out empty results (failed parses return empty title)
          const valid = jobs.filter(j => j.title.trim());
          allJobs.push(...valid);
          if (allJobs.length >= 10) break;
        } catch (fileErr: any) {
          console.error(`Failed to parse ${file.name}:`, fileErr);
          failCount++;
          // Continue with remaining files
        }
      }

      const mapped = allJobs.slice(0, 10);

      if (mapped.length === 0) {
        const msg = failCount > 0
          ? `Failed to parse ${failCount} file${failCount > 1 ? 's' : ''}. No jobs found.`
          : 'No jobs found in the uploaded file(s).';
        setParseError(msg);
        toast.error(msg);
      } else if (mapped.length > 1) {
        setParsedJobs(mapped);
        setSelectedJobIndexes(new Set(mapped.map((_, i) => i)));
        setStep('pick');
        if (failCount > 0) toast.warning(`${failCount} file${failCount > 1 ? 's' : ''} failed to parse`);
        toast.success(`Found ${mapped.length} job${mapped.length > 1 ? 's' : ''}`);
      } else {
        setForm(mapped[0]);
        setStep('form');
        if (failCount > 0) toast.warning(`${failCount} file${failCount > 1 ? 's' : ''} failed to parse`);
        toast.success('Found 1 job');
      }
    } catch (err: any) {
      setParseError(err.message || 'Failed to parse documents');
      toast.error(err.message || 'Failed to parse documents');
    } finally {
      setParsing(false);
    }
  };

  // ── Company handling ──────────────────────────────────────────────
  const handleCompanyChange = (companyId: string) => {
    if (companyId === 'none') {
      update('company_id', '');
      return;
    }
    const company = companies.find((c: any) => c.id === companyId);
    setForm(prev => ({
      ...prev,
      company_id: companyId,
      company_name: company?.name ?? '',
    }));
  };

  // Toggle job selection in pick step
  const toggleJobSelection = (index: number) => {
    setSelectedJobIndexes(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // Open a specific job for editing from the pick list
  const editJob = (index: number) => {
    setEditingIndex(index);
    setForm({ ...parsedJobs[index] });
    setStep('form');
  };

  // ── Save single job ──────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      const insert: any = {
        title: form.title.trim(),
        company_name: form.company_name.trim() || null,
        company_id: form.company_id || null,
        location: form.location.trim() || null,
        description: form.description || null,
        compensation: form.compensation.trim() || null,
        status: form.status,
        job_url: form.job_url.trim() || null,
      };
      const { error } = await supabase.from('jobs').insert(insert);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['jobs'] });

      // If editing one from multi-job list, go back to pick step
      if (editingIndex !== null) {
        // Update the parsedJobs list with edits
        setParsedJobs(prev => prev.map((j, i) => i === editingIndex ? { ...form } : j));
        toast.success(`"${form.title}" created`);
        // Remove from selection since it's created
        setSelectedJobIndexes(prev => {
          const next = new Set(prev);
          next.delete(editingIndex);
          return next;
        });
        setEditingIndex(null);
        setStep('pick');
      } else {
        toast.success('Job created');
        handleOpenChange(false);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to create job');
    } finally {
      setSaving(false);
    }
  };

  // ── Save all selected jobs at once ───────────────────────────────
  const handleSaveAll = async () => {
    const selected = parsedJobs.filter((_, i) => selectedJobIndexes.has(i));
    if (selected.length === 0) { toast.error('No jobs selected'); return; }
    setSaving(true);
    try {
      const inserts = selected.map(j => ({
        title: j.title.trim(),
        company_name: j.company_name.trim() || null,
        company_id: j.company_id || null,
        location: j.location.trim() || null,
        description: j.description || null,
        compensation: j.compensation.trim() || null,
        status: j.status,
        job_url: j.job_url.trim() || null,
      }));
      const { error } = await supabase.from('jobs').insert(inserts);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success(`${selected.length} job${selected.length > 1 ? 's' : ''} created`);
      handleOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create jobs');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'source' ? 'Add New Job' : step === 'pick' ? `${parsedJobs.length} Jobs Found` : 'Review & Create Job'}
          </DialogTitle>
        </DialogHeader>

        {/* ── Step 1: Source Selection ─────────────────────────────── */}
        {step === 'source' && (
          <div className="space-y-6 py-2">
            {parsing ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-accent" />
                <p className="text-sm text-muted-foreground">Parsing job posting with AI...</p>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Import a job posting automatically or fill in details manually.
                </p>

                {/* URL option */}
                <div className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Globe className="h-4 w-4 text-accent" />
                    Paste Job Posting URL
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                      placeholder="https://careers.example.com/job/12345"
                      onKeyDown={e => e.key === 'Enter' && parseFromUrl()}
                    />
                    <Button variant="gold" onClick={parseFromUrl} disabled={!url.trim()}>
                      Parse
                    </Button>
                  </div>
                </div>

                {/* File upload option */}
                <div className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FileUp className="h-4 w-4 text-accent" />
                    Upload Job Description
                  </div>
                  <p className="text-xs text-muted-foreground">PDF, DOC, DOCX, or TXT — select multiple files or one file with up to 10 jobs</p>
                  <Button variant="outline" onClick={() => fileRef.current?.click()}>
                    Choose File(s)
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    multiple
                    className="hidden"
                    onChange={e => {
                      const files = Array.from(e.target.files || []).slice(0, 10);
                      if (files.length > 0) parseFromFiles(files);
                      e.target.value = '';
                    }}
                  />
                </div>

                {/* Manual option */}
                <div
                  className="flex items-center gap-2 rounded-lg border border-border p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setStep('form')}
                >
                  <PenLine className="h-4 w-4 text-accent" />
                  <span className="text-sm font-medium">Continue Manually</span>
                  <span className="text-xs text-muted-foreground ml-auto">Skip import</span>
                </div>

                {parseError && (
                  <p className="text-sm text-destructive">{parseError}</p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Step 1.5: Pick from multiple jobs ──────────────────── */}
        {step === 'pick' && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Select the jobs you want to create. Click a job to review/edit before saving.
            </p>
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {parsedJobs.map((job, i) => {
                const isSelected = selectedJobIndexes.has(i);
                return (
                  <div
                    key={i}
                    className={cn(
                      'rounded-lg border p-3 flex items-start gap-3 transition-colors',
                      isSelected ? 'border-accent/50 bg-accent/5' : 'border-border bg-card/40 opacity-60',
                    )}
                  >
                    <button
                      onClick={() => toggleJobSelection(i)}
                      className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                        isSelected ? 'bg-accent border-accent text-white' : 'border-border',
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </button>
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => editJob(i)}>
                      <p className="text-sm font-medium text-foreground truncate">{job.title || 'Untitled'}</p>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                        {job.company_name && <span>{job.company_name}</span>}
                        {job.location && <span>{job.location}</span>}
                        {job.compensation && <span>{job.compensation}</span>}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" className="shrink-0 text-xs" onClick={() => editJob(i)}>
                      Review
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 2: Preview / Edit Form ─────────────────────────── */}
        {step === 'form' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={form.title} onChange={e => update('title', e.target.value)} placeholder="e.g. Senior Software Engineer" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Company</Label>
                <Select value={form.company_id || 'none'} onValueChange={handleCompanyChange}>
                  <SelectTrigger><SelectValue placeholder="Select company" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No company</SelectItem>
                    {companies.map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Company Name</Label>
                <Input value={form.company_name} onChange={e => update('company_name', e.target.value)} placeholder="Or type company name" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Location</Label>
              <Input value={form.location} onChange={e => update('location', e.target.value)} placeholder="e.g. New York, NY" />
            </div>

            <div className="space-y-2">
              <Label>Compensation</Label>
              <Input value={form.compensation} onChange={e => update('compensation', e.target.value)} placeholder="e.g. $120,000 - $150,000" />
            </div>

            <div className="space-y-2">
              <Label>Job Posting URL</Label>
              <div className="flex gap-2">
                <Input value={form.job_url} onChange={e => update('job_url', e.target.value)} placeholder="https://..." className="flex-1" />
                {form.job_url && (
                  <a href={form.job_url} target="_blank" rel="noopener noreferrer" className="flex items-center">
                    <Button variant="ghost" size="icon" type="button" className="h-9 w-9">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </a>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <RichTextEditor
                value={form.description}
                onChange={val => update('description', val)}
                placeholder="Job description, requirements, qualifications..."
                minHeight="180px"
              />
            </div>
          </div>
        )}

        {/* ── Footers ──────────────────────────────────────────────── */}
        {step === 'form' && (
          <DialogFooter className="flex justify-between sm:justify-between">
            <Button variant="ghost" onClick={() => {
              if (editingIndex !== null) {
                // Save edits back to parsedJobs and go to pick
                setParsedJobs(prev => prev.map((j, i) => i === editingIndex ? { ...form } : j));
                setEditingIndex(null);
                setStep('pick');
              } else {
                setStep('source');
              }
            }}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button variant="gold" onClick={handleSave} disabled={saving || !form.title.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {editingIndex !== null ? 'Create This Job' : 'Create Job'}
              </Button>
            </div>
          </DialogFooter>
        )}

        {step === 'pick' && (
          <DialogFooter className="flex justify-between sm:justify-between">
            <Button variant="ghost" onClick={() => { setParsedJobs([]); setStep('source'); }}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button variant="gold" onClick={handleSaveAll} disabled={saving || selectedJobIndexes.size === 0}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Briefcase className="h-4 w-4 mr-1" />}
                Create {selectedJobIndexes.size} Job{selectedJobIndexes.size !== 1 ? 's' : ''}
              </Button>
            </div>
          </DialogFooter>
        )}

        {step === 'source' && !parsing && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>Cancel</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
