import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, Loader2, FileText, CheckCircle, XCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { classifyEmail, normalizeEmail } from '@/lib/email-classifier';
import { cn } from '@/lib/utils';
import { invalidatePersonScope } from '@/lib/invalidate';

interface Props {
  entityType: 'candidate';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  current_company: string;
  current_title: string;
  location: string;
  linkedin_url: string;
  file_name: string;
  file_path: string;
  candidate_id: string | null;
  match_label: string | null;
  saved?: boolean;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function uploadFile(file: File, session: any) {
  const storagePath = `${session.user.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  console.log('[ResumeDropZone] uploading to storage:', storagePath);
  const { data, error } = await supabase.storage
    .from('resumes')
    .upload(storagePath, file, { contentType: file.type || 'application/pdf', upsert: false });
  if (error) throw new Error('Upload failed: ' + error.message);
  console.log('[ResumeDropZone] upload success, path:', data.path);
  return { file_path: data.path, file_name: file.name };
}

async function parseFile(file_path: string, file_name: string, session: any): Promise<any> {
  // Call the Vercel API route (bypasses broken process-resume edge function)
  const resp = await fetch('/api/parse-resume', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filePath: file_path, fileName: file_name }),
  });

  const result = await resp.json();
  if (!resp.ok || result.error) throw new Error(result.error || `Parse failed (HTTP ${resp.status})`);

  const p = result.parsed || {};
  return {
    first_name:      p.first_name || '',
    last_name:       p.last_name || '',
    email:           p.email || '',
    phone:           p.phone || '',
    current_company: p.current_company || '',
    current_title:   p.current_title || '',
    location:        p.location || '',
    linkedin_url:    p.linkedin_url || '',
    _candidate_id:   null, // No DB writes during parse — candidate created on save
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function ResumeDropZone({ entityType, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState(false);

  // Parse phase
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [parseTotal, setParseTotal] = useState(0);

  // Review phase — unified queue for single and batch
  const [queue, setQueue] = useState<ParsedData[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [allDone, setAllDone] = useState(false);

  const current = queue[reviewIndex] ?? null;

  const updateField = (field: keyof ParsedData, value: string) => {
    setQueue(prev => prev.map((item, i) => i === reviewIndex ? { ...item, [field]: value } : item));
  };

  const reset = () => {
    setParsing(false);
    setParseProgress(0);
    setParseTotal(0);
    setQueue([]);
    setReviewIndex(0);
    setSaving(false);
    setSavedCount(0);
    setAllDone(false);
  };

  // ── Parse all dropped files, then transition to review ─────────────────────
  const handleFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => f.name.match(/\.(pdf|doc|docx|txt)$/i));
    if (valid.length === 0) {
      toast.error('Please upload PDF, DOC, DOCX, or TXT files');
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { toast.error('Not authenticated'); return; }

    // Start parse phase
    reset();
    setParsing(true);
    setParseTotal(valid.length);

    const parsed: ParsedData[] = [];

    for (let i = 0; i < valid.length; i++) {
      // Add delay between files to avoid rate limiting (skip first)
      if (i > 0) await new Promise(r => setTimeout(r, 3000));

      const file = valid[i];
      try {
        const { file_path, file_name } = await uploadFile(file, session);
        const data = await parseFile(file_path, file_name, session);

        const entry: ParsedData = {
          first_name:      data?.first_name || '',
          last_name:       data?.last_name || '',
          email:           data?.email || '',
          phone:           data?.phone || '',
          current_company: data?.current_company || '',
          current_title:   data?.current_title || '',
          location:        data?.location || '',
          linkedin_url:    data?.linkedin_url || '',
          file_name,
          file_path,
          candidate_id:    data?._candidate_id ?? null,
          match_label:     data?._candidate_id ? `${data.first_name} ${data.last_name}`.trim() : null,
        };

        parsed.push(entry);
      } catch (err: any) {
        parsed.push({
          first_name: '', last_name: '', email: '', phone: '',
          current_company: '', current_title: '', location: '', linkedin_url: '',
          file_name: file.name, file_path: '',
          candidate_id: null, match_label: null,
          error: err.message,
        });
      }
      setParseProgress(i + 1);
    }

    // Transition to review phase
    setParsing(false);
    setQueue(parsed);
    setReviewIndex(0);

    const ok = parsed.filter(p => !p.error).length;
    if (ok > 0) {
      toast.success(`${ok} resume${ok !== 1 ? 's' : ''} parsed — review and save`);
    }
  }, []);

  // ── Resolve Unipile ID in background after save ────────────────────────────
  const resolveUnipileInBackground = async (candidateId: string, linkedinUrl: string) => {
    try {
      // Extract slug from LinkedIn URL
      const match = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
      const slug = match ? match[1] : (/^[\w-]+$/.test(linkedinUrl.trim()) ? linkedinUrl.trim() : null);
      if (!slug) return;

      // Use the first active LinkedIn integration account (not hardcoded to a specific user)
      const { data: linkedinAcct } = await supabase
        .from('integration_accounts')
        .select('unipile_account_id')
        .or('account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter')
        .eq('is_active', true)
        .not('unipile_account_id', 'is', null)
        .limit(1)
        .maybeSingle();

      if (!linkedinAcct?.unipile_account_id) return;

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resolve-unipile-id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ linkedin_slug: slug, account_id: linkedinAcct.unipile_account_id }),
        }
      );

      if (resp.ok) {
        const result = await resp.json();
        if (result.unipile_id || result.provider_id) {
          // Store in candidate_channels (not on candidates table)
          await supabase
            .from('candidate_channels')
            .upsert({
              candidate_id: candidateId,
              channel: 'linkedin',
              unipile_id: result.unipile_id || null,
              provider_id: result.provider_id || null,
              is_connected: true,
            }, { onConflict: 'candidate_id,channel' });
        }
      }
    } catch (err: any) {
      console.warn('Background Unipile ID resolution failed:', err?.message || err);
    }
  };

  // ── Trigger resume ingestion (embedding + vector storage) in background ────
  const triggerResumeIngestion = async (candidateId: string, filePath: string, fileName: string) => {
    try {
      // Find or create the resume record for this candidate/file
      let { data: resume } = await supabase
        .from('resumes')
        .select('id')
        .eq('candidate_id', candidateId)
        .eq('file_path', filePath)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!resume) {
        // Create resume record
        const { data: urlData } = await supabase.storage.from('resumes').createSignedUrl(filePath, 3600);
        const mimeType = fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf'
          : fileName.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/octet-stream';
        const { data: inserted } = await supabase.from('resumes').insert({
          candidate_id: candidateId,
          file_path: filePath,
          file_name: fileName,
          file_url: urlData?.signedUrl || null,
          mime_type: mimeType,
          parse_status: 'pending',
        } as any).select('id').single();
        resume = inserted;
      }

      const resumeId = resume?.id;
      if (!resumeId) {
        console.warn('[ResumeDropZone] Could not find or create resume record');
        return;
      }

      await fetch('/api/trigger-resume-ingestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeId, candidateId, filePath, fileName }),
      });
    } catch (err) {
      console.warn('Background resume ingestion trigger failed:', err);
    }
  };

  // ── Save a single entry (update user-edited fields, or insert if no candidate_id) ──
  const saveCandidate = async (entry: ParsedData): Promise<void> => {
    if (!entry.first_name.trim() && !entry.last_name.trim()) {
      throw new Error('Name is required');
    }

    let savedId = entry.candidate_id;

    if (entry.candidate_id) {
      // process-resume already created/updated the record — just apply user edits
      const { error } = await supabase
        .from('people')
        .update({
          first_name:      entry.first_name.trim() || undefined,
          last_name:       entry.last_name.trim() || undefined,
          full_name:       `${entry.first_name.trim()} ${entry.last_name.trim()}`.trim() || undefined,
          // Plain `email` column was retired — route via classifier so the
          // address lands in personal_email or work_email by domain.
          ...(entry.email.trim() ? classifyEmail(normalizeEmail(entry.email.trim())) : {}),
          phone:           entry.phone.trim() || undefined,
          current_company: entry.current_company.trim() || undefined,
          current_title:   entry.current_title.trim() || undefined,
          location_text:   entry.location.trim() || undefined,
          linkedin_url:    entry.linkedin_url.trim() || undefined,
          updated_at:      new Date().toISOString(),
        } as any)
        .eq('id', entry.candidate_id);
      if (error) throw error;
    } else {
      // Check if candidate with this email already exists. Plain `email`
      // is gone; OR across all three address columns.
      let existing: any = null;
      if (entry.email.trim()) {
        const e = entry.email.trim().toLowerCase();
        const { data } = await supabase
          .from('people')
          .select('id')
          .or(`personal_email.ilike.${e},work_email.ilike.${e},primary_email.ilike.${e}`)
          .limit(1)
          .maybeSingle();
        existing = data;
      }

      if (existing) {
        // Update existing candidate
        const { error } = await supabase.from('people').update({
          first_name:      entry.first_name.trim() || undefined,
          last_name:       entry.last_name.trim() || undefined,
          full_name:       `${entry.first_name.trim()} ${entry.last_name.trim()}`.trim() || undefined,
          phone:           entry.phone.trim() || undefined,
          current_company: entry.current_company.trim() || undefined,
          current_title:   entry.current_title.trim() || undefined,
          location_text:   entry.location.trim() || undefined,
          linkedin_url:    entry.linkedin_url.trim() || undefined,
          updated_at:      new Date().toISOString(),
        } as any).eq('id', existing.id);
        if (error) throw error;
        savedId = existing.id;
      } else {
        // Insert new candidate (owner_id is auto-set by DB trigger)
        const { data: inserted, error } = await supabase.from('people').insert({
          first_name:      entry.first_name.trim() || null,
          last_name:       entry.last_name.trim() || null,
          full_name:       `${entry.first_name.trim()} ${entry.last_name.trim()}`.trim() || null,
          // Plain `email` retired — split into personal/work via classifier.
          ...classifyEmail(normalizeEmail(entry.email.trim())),
          phone:           entry.phone.trim() || null,
          current_company: entry.current_company.trim() || null,
          current_title:   entry.current_title.trim() || null,
          location_text:   entry.location.trim() || null,
          linkedin_url:    entry.linkedin_url.trim() || null,
          status:          'new',
        } as any).select('id').single();
        if (error) throw error;
        savedId = inserted?.id || null;
      }
    }

    // Resolve Unipile ID in background after save (non-blocking)
    if (savedId && entry.linkedin_url.trim()) {
      resolveUnipileInBackground(savedId, entry.linkedin_url.trim());
    }

    // Trigger resume ingestion (embedding + vector storage) in background
    if (savedId && entry.file_path) {
      triggerResumeIngestion(savedId, entry.file_path, entry.file_name);
    }
  };

  // ── Save current and advance ───────────────────────────────────────────────
  const handleSaveCurrent = async () => {
    if (!current) return;
    setSaving(true);
    try {
      await saveCandidate(current);
      setQueue(prev => prev.map((item, i) => i === reviewIndex ? { ...item, saved: true } : item));
      setSavedCount(prev => prev + 1);
      invalidatePersonScope(qc);

      const label = current.candidate_id ? 'updated' : 'created';
      toast.success(`${current.first_name} ${current.last_name} ${label}`);

      // Advance or finish
      if (queue.length === 1) {
        reset();
        onOpenChange(false);
      } else if (reviewIndex < queue.length - 1) {
        setReviewIndex(prev => prev + 1);
      } else {
        setAllDone(true);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ── Skip current entry ─────────────────────────────────────────────────────
  const handleSkip = () => {
    if (reviewIndex < queue.length - 1) {
      setReviewIndex(prev => prev + 1);
    } else {
      setAllDone(true);
    }
  };

  // ── Save all remaining unsaved entries ─────────────────────────────────────
  const handleSaveAll = async () => {
    setSaving(true);
    let saved = 0;
    let failed = 0;
    for (let i = reviewIndex; i < queue.length; i++) {
      const entry = queue[i];
      if (entry.saved || entry.error) continue;
      if (!entry.first_name.trim() && !entry.last_name.trim()) continue;
      try {
        await saveCandidate(entry);
        setQueue(prev => prev.map((item, j) => j === i ? { ...item, saved: true } : item));
        saved++;
      } catch {
        failed++;
      }
    }
    setSaving(false);
    setSavedCount(prev => prev + saved);
    qc.invalidateQueries({ queryKey: ['candidates'] });
    toast.success(`${saved} saved${failed > 0 ? `, ${failed} failed` : ''}`);
    setAllDone(true);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(Array.from(e.dataTransfer.files));
  }, [handleFiles]);

  const triggerFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.doc,.docx,.txt';
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) handleFiles(Array.from(files));
    };
    input.click();
  };

  const handleClose = (val: boolean) => {
    if (!val) reset();
    onOpenChange(val);
  };

  const showDropZone = !parsing && queue.length === 0;
  const showParsing = parsing;
  const showReview = !parsing && queue.length > 0 && !allDone;
  const isBatch = queue.length > 1;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-accent" />
            Parse Resume{isBatch ? 's' : ''} — Ask Joe
          </DialogTitle>
        </DialogHeader>

        {/* ── Drop zone ── */}
        {showDropZone && (
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer',
              dragging ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'
            )}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={triggerFilePicker}
          >
            <div className="flex flex-col items-center gap-3">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">Drop resumes here or click to upload</p>
                <p className="text-xs text-muted-foreground mt-1">PDF, DOC, DOCX or TXT — select multiple for batch import</p>
              </div>
            </div>
          </div>
        )}

        {/* ── Parsing progress ── */}
        {showParsing && (
          <div className="space-y-3 py-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Parsing {parseProgress} of {parseTotal}...
              </span>
              <span className="text-xs text-muted-foreground">
                {parseTotal > 0 ? Math.round((parseProgress / parseTotal) * 100) : 0}%
              </span>
            </div>
            <Progress value={parseTotal > 0 ? (parseProgress / parseTotal) * 100 : 0} className="h-2" />
          </div>
        )}

        {/* ── Review form ── */}
        {showReview && current && (
          <div className="space-y-3">
            {/* Batch navigation header */}
            {isBatch && (
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReviewIndex(prev => prev - 1)}
                  disabled={reviewIndex === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  Resume {reviewIndex + 1} of {queue.length}
                  {savedCount > 0 && <span className="ml-2 text-green-600">({savedCount} saved)</span>}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReviewIndex(prev => prev + 1)}
                  disabled={reviewIndex >= queue.length - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* Match badge */}
            {current.candidate_id && (
              <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-sm text-blue-700">
                <CheckCircle className="h-4 w-4 shrink-0" />
                Updating existing candidate: {current.match_label}
              </div>
            )}

            {/* Error badge */}
            {current.error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <XCircle className="h-4 w-4 shrink-0" />
                Parse error: {current.error} — fill in manually
              </div>
            )}

            {/* Saved badge */}
            {current.saved && (
              <div className="flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/5 px-3 py-2 text-sm text-green-700">
                <CheckCircle className="h-4 w-4 shrink-0" />
                Saved
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Review and edit before saving:
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">First Name</Label>
                <Input value={current.first_name} onChange={(e) => updateField('first_name', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last Name</Label>
                <Input value={current.last_name} onChange={(e) => updateField('last_name', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input value={current.email} onChange={(e) => updateField('email', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={current.phone} onChange={(e) => updateField('phone', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Company</Label>
                <Input value={current.current_company} onChange={(e) => updateField('current_company', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input value={current.current_title} onChange={(e) => updateField('current_title', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Location</Label>
                <Input value={current.location} onChange={(e) => updateField('location', e.target.value)} disabled={current.saved} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">LinkedIn</Label>
                <Input value={current.linkedin_url} onChange={(e) => updateField('linkedin_url', e.target.value)} disabled={current.saved} />
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground">Source: {current.file_name}</p>
          </div>
        )}

        {/* ── Review footer ── */}
        {showReview && current && !current.saved && (
          <DialogFooter className="flex-row gap-2 sm:justify-between">
            <div className="flex gap-2">
              {isBatch && (
                <Button variant="ghost" size="sm" onClick={handleSkip}>
                  Skip
                </Button>
              )}
              {!isBatch && (
                <Button variant="ghost" onClick={() => reset()}>Re-upload</Button>
              )}
            </div>
            <div className="flex gap-2">
              {isBatch && (
                <Button variant="outline" size="sm" onClick={handleSaveAll} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Save All
                </Button>
              )}
              <Button variant="gold" onClick={handleSaveCurrent} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                {isBatch ? 'Save & Next' : 'Save Candidate'}
              </Button>
            </div>
          </DialogFooter>
        )}

        {/* Already saved — show nav only for batch */}
        {showReview && current?.saved && isBatch && (
          <DialogFooter>
            {reviewIndex < queue.length - 1 ? (
              <Button variant="gold" onClick={() => setReviewIndex(prev => prev + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="gold" onClick={() => { reset(); onOpenChange(false); }}>
                Done
              </Button>
            )}
          </DialogFooter>
        )}

        {/* ── All done ── */}
        {allDone && (
          <>
            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {queue.map((entry, i) => (
                <div key={i} className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm',
                  entry.saved ? 'border-green-500/20 bg-green-500/5' : 'border-muted bg-muted/5'
                )}>
                  {entry.saved
                    ? <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                    : <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground truncate">
                      {`${entry.first_name} ${entry.last_name}`.trim() || entry.file_name}
                    </p>
                    {entry.current_title && (
                      <p className="text-xs text-muted-foreground truncate">
                        {entry.current_title}{entry.current_company ? ` at ${entry.current_company}` : ''}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {entry.saved ? (entry.candidate_id ? 'Updated' : 'Created') : 'Skipped'}
                  </span>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => reset()}>Upload More</Button>
              <Button variant="gold" onClick={() => { reset(); onOpenChange(false); }}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
