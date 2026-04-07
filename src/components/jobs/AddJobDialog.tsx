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
import { Loader2, Globe, FileUp, PenLine, ArrowLeft, ExternalLink } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const emptyForm = {
  title: '',
  company_id: '',
  company_name: '',
  location: '',
  description: '',
  compensation: '',
  status: 'open',
  job_url: '',
};

export function AddJobDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useCompanies();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'source' | 'form'>('source');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState('');
  const [form, setForm] = useState({ ...emptyForm });

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const resetDialog = () => {
    setStep('source');
    setParsing(false);
    setParseError('');
    setSaving(false);
    setUrl('');
    setForm({ ...emptyForm });
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) resetDialog();
    onOpenChange(open);
  };

  // ── Parse from URL ────────────────────────────────────────────────
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
      setForm({
        title: p.title || '',
        company_id: '',
        company_name: p.company_name || '',
        location: p.location || '',
        description: p.description || '',
        compensation: p.compensation || '',
        status: 'open',
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

  // ── Parse from file ───────────────────────────────────────────────
  const parseFromFile = async (file: File) => {
    setParsing(true);
    setParseError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
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
      if (!resp.ok) throw new Error(data.error || 'Failed to parse document');

      const p = data.parsed || {};
      setForm({
        title: p.title || '',
        company_id: '',
        company_name: p.company_name || '',
        location: p.location || '',
        description: p.description || '',
        compensation: p.compensation || '',
        status: 'open',
        job_url: '',
      });
      setStep('form');
    } catch (err: any) {
      setParseError(err.message || 'Failed to parse document');
      toast.error(err.message || 'Failed to parse document');
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

  // ── Save job ──────────────────────────────────────────────────────
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
      toast.success('Job created');
      handleOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create job');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'source' ? 'Add New Job' : 'Review & Create Job'}
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
                  <p className="text-xs text-muted-foreground">PDF, DOC, DOCX, or TXT</p>
                  <Button variant="outline" onClick={() => fileRef.current?.click()}>
                    Choose File
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) parseFromFile(file);
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

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Location</Label>
                <Input value={form.location} onChange={e => update('location', e.target.value)} placeholder="e.g. New York, NY" />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={v => update('status', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="interviewing">Interviewing</SelectItem>
                    <SelectItem value="offer">Offer</SelectItem>
                    <SelectItem value="win">Win</SelectItem>
                    <SelectItem value="lost">Lost</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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

        {step === 'form' && (
          <DialogFooter className="flex justify-between sm:justify-between">
            <Button variant="ghost" onClick={() => setStep('source')}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button variant="gold" onClick={handleSave} disabled={saving || !form.title.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Create Job
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
