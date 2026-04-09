import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, Loader2, FileText, CheckCircle, XCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

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
  company: string;
  title: string;
  location: string;
  linkedin_url: string;
  file_name: string;
  file_path: string;
  candidate_id: string | null;
}

interface BatchResult {
  file_name: string;
  file_path: string;
  success: boolean;
  error?: string;
  candidate_id?: string;
  parsed?: Partial<ParsedData>;
}

const PROCESS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-resume`;

export function ResumeDropZone({ entityType, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState(false);

  // Single-file review mode
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [saving, setSaving] = useState(false);

  // Batch mode
  const [batchMode, setBatchMode] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDone, setBatchDone] = useState(false);
  const [isSingleParsing, setIsSingleParsing] = useState(false);

  const update = (field: keyof ParsedData, value: string) =>
    setParsed((prev) => prev ? { ...prev, [field]: value } : null);

  const reset = () => {
    setParsed(null);
    setSaving(false);
    setBatchMode(false);
    setBatchResults([]);
    setBatchProgress(0);
    setBatchTotal(0);
    setBatchDone(false);
    setIsSingleParsing(false);
  };

  // ── Upload + parse a single file, returns {file_path, file_name} ───────────
  const uploadFile = async (file: File, session: any): Promise<{ file_path: string; file_name: string }> => {
    const storagePath = `${session.user.id}/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('resumes')
      .upload(storagePath, file, { contentType: file.type || 'application/pdf', upsert: false });
    if (uploadError) throw new Error('Upload failed: ' + uploadError.message);
    return { file_path: uploadData.path, file_name: file.name };
  };

  // ── Handle one or many files dropped/selected ───────────────────────────────
  const handleFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => f.name.match(/\.(pdf|doc|docx|txt)$/i));
    if (valid.length === 0) {
      toast.error('Please upload PDF, DOC, DOCX, or TXT files');
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { toast.error('Not authenticated'); return; }

    // Single file → review mode
    if (valid.length === 1) {
      setParsed(null);
      setBatchMode(false);
      setIsSingleParsing(true);

      try {
        setBatchProgress(0);
        setBatchTotal(1);
        const { file_path, file_name } = await uploadFile(valid[0], session);

        const ctrl1 = new AbortController();
        const t1 = setTimeout(() => ctrl1.abort(), 65000);
        let resp: Response;
        try {
          resp = await fetch(PROCESS_URL, {
            method: 'POST',
            signal: ctrl1.signal,
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ file_path, file_name }),
          });
        } finally {
          clearTimeout(t1);
        }

        let result: any;
        try { result = await resp.json(); } catch { throw new Error(`HTTP ${resp.status} — parse service error`); }
        if (!resp.ok || !result.success) throw new Error(result.error || `Parse failed (HTTP ${resp.status})`);

        const data = result.parsed;
        setParsed({
          first_name:      data.first_name || '',
          last_name:       data.last_name || '',
          email:           data.email || '',
          phone:           data.phone || '',
          company: data.company || '',
          title:   data.title || '',
          location:        data.location || '',
          linkedin_url:    data.linkedin_url || '',
          file_name,
          file_path,
          candidate_id:    result.candidate_id || null,
        });
        setBatchProgress(1);
        setIsSingleParsing(false);
        toast.success(result.candidate_id ? 'Resume parsed — review below' : 'Resume parsed');
      } catch (err: any) {
        toast.error(err.message || 'Failed to process resume');
        setBatchProgress(0);
        setBatchTotal(0);
        setIsSingleParsing(false);
      }
      return;
    }

    // Multiple files → batch mode, process sequentially
    setBatchMode(true);
    setBatchResults([]);
    setBatchProgress(0);
    setBatchTotal(valid.length);
    setBatchDone(false);

    const results: BatchResult[] = [];

    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      try {
        const { file_path, file_name } = await uploadFile(file, session);

        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 65000);
        let resp: Response;
        try {
          resp = await fetch(PROCESS_URL, {
            method: 'POST',
            signal: ctrl2.signal,
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ file_path, file_name }),
          });
        } finally {
          clearTimeout(t2);
        }

        let result: any;
        try { result = await resp.json(); } catch { throw new Error(`HTTP ${resp.status}`); }
        if (!resp.ok || !result.success) throw new Error(result.error || 'Parse failed');

        // Link the uploaded resume file to the candidate
        if (result.candidate_id && file_path) {
          const mimeType = file_name.toLowerCase().endsWith('.pdf') ? 'application/pdf'
            : file_name.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : file_name.toLowerCase().endsWith('.doc') ? 'application/msword'
            : 'application/octet-stream';
          await supabase.from('resumes').insert({
            candidate_id: result.candidate_id,
            file_path,
            file_name,
            mime_type: mimeType,
            parsing_status: 'completed',
          } as any);
        }

        results.push({
          file_name,
          file_path,
          success: true,
          candidate_id: result.candidate_id,
          parsed: result.parsed,
        });
      } catch (err: any) {
        results.push({
          file_name: file.name,
          file_path: '',
          success: false,
          error: err.message,
        });
      }

      setBatchProgress(i + 1);
      setBatchResults([...results]);
    }

    setBatchDone(true);
    qc.invalidateQueries({ queryKey: ['candidates'] });
    const ok = results.filter(r => r.success).length;
    const fail = results.filter(r => !r.success).length;
    toast.success(`${ok} resume${ok !== 1 ? 's' : ''} parsed${fail > 0 ? `, ${fail} failed` : ''}`);
  }, [qc]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(Array.from(e.dataTransfer.files));
  }, [handleFiles]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(Array.from(e.target.files));
    e.target.value = '';
  };

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

  // ── Save single reviewed candidate ─────────────────────────────────────────
  const handleSave = async () => {
    if (!parsed) return;
    if (!parsed.first_name.trim() && !parsed.last_name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      let candidateId = parsed.candidate_id;

      if (parsed.candidate_id) {
        const { error } = await supabase
          .from('candidates')
          .update({
            first_name:      parsed.first_name.trim() || undefined,
            last_name:       parsed.last_name.trim() || undefined,
            full_name:       `${parsed.first_name.trim()} ${parsed.last_name.trim()}`.trim() || undefined,
            email:           parsed.email.trim() || undefined,
            phone:           parsed.phone.trim() || undefined,
            company: parsed.company.trim() || undefined,
            title:   parsed.title.trim() || undefined,
            location_text:   parsed.location.trim() || undefined,
            linkedin_url:    parsed.linkedin_url.trim() || undefined,
            updated_at:      new Date().toISOString(),
          } as any)
          .eq('id', parsed.candidate_id);
        if (error) throw error;
      } else {
        const userId = (await supabase.auth.getUser()).data.user?.id;
        const { data: inserted, error } = await supabase.from('candidates').insert({
          owner_user_id:   userId,
          first_name:      parsed.first_name.trim() || null,
          last_name:       parsed.last_name.trim() || null,
          full_name:       `${parsed.first_name.trim()} ${parsed.last_name.trim()}`.trim() || null,
          email:           parsed.email.trim() || null,
          phone:           parsed.phone.trim() || null,
          company: parsed.company.trim() || null,
          title:   parsed.title.trim() || null,
          location_text:   parsed.location.trim() || null,
          linkedin_url:    parsed.linkedin_url.trim() || null,
          status: 'new',
        } as any).select('id').single();
        if (error) throw error;
        candidateId = inserted?.id ?? null;
      }

      // Link the uploaded resume file to the candidate
      if (candidateId && parsed.file_path) {
        const mimeType = parsed.file_name.toLowerCase().endsWith('.pdf') ? 'application/pdf'
          : parsed.file_name.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : parsed.file_name.toLowerCase().endsWith('.doc') ? 'application/msword'
          : 'application/octet-stream';
        await supabase.from('resumes').insert({
          candidate_id: candidateId,
          file_path:    parsed.file_path,
          file_name:    parsed.file_name,
          mime_type:    mimeType,
          parsing_status: 'completed',
        } as any);
      }

      qc.invalidateQueries({ queryKey: ['candidates'] });
      toast.success('Candidate saved');
      reset();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (val: boolean) => {
    if (!val) reset();
    onOpenChange(val);
  };

  const isProcessing = batchTotal > 0 && !batchDone && batchMode;
  const isSingleProcessing = batchTotal === 1 && !parsed && batchProgress === 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-accent" />
            Parse Resume{batchMode ? 's' : ''} — Ask Joe
          </DialogTitle>
        </DialogHeader>

        {/* ── Drop zone (always shown unless reviewing parsed data) ── */}
        {!parsed && !batchMode && (
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
            {isSingleProcessing ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-accent" />
                <p className="text-sm text-muted-foreground">Ask Joe is parsing resume...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Upload className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">Drop resumes here or click to upload</p>
                  <p className="text-xs text-muted-foreground mt-1">PDF, DOC, DOCX or TXT · Select multiple for batch import</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Single file parsing spinner ── */}
        {isSingleProcessing && (
          <div className="flex items-center gap-3 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
            <p className="text-sm text-muted-foreground">Uploading and parsing...</p>
          </div>
        )}

        {/* ── Batch progress ── */}
        {batchMode && (
          <div className="space-y-4">
            {!batchDone && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Parsing {batchProgress} of {batchTotal}...
                  </span>
                  <span className="text-xs text-muted-foreground">{Math.round((batchProgress / batchTotal) * 100)}%</span>
                </div>
                <Progress value={(batchProgress / batchTotal) * 100} className="h-2" />
              </div>
            )}

            {batchDone && (
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">
                  {batchResults.filter(r => r.success).length} of {batchTotal} imported
                </p>
                <Button variant="outline" size="sm" onClick={() => { reset(); }}>
                  Upload More
                </Button>
              </div>
            )}

            {/* Results list */}
            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {batchResults.map((r, i) => (
                <div key={i} className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm',
                  r.success ? 'border-green-500/20 bg-green-500/5' : 'border-destructive/20 bg-destructive/5'
                )}>
                  {r.success
                    ? <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                    : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground truncate">
                      {r.success && r.parsed
                        ? `${r.parsed.first_name ?? ''} ${r.parsed.last_name ?? ''}`.trim() || r.file_name
                        : r.file_name}
                    </p>
                    {r.success && r.parsed?.title && (
                      <p className="text-xs text-muted-foreground truncate">
                        {r.parsed.title}{r.parsed.company ? ` at ${r.parsed.company}` : ''}
                      </p>
                    )}
                    {!r.success && (
                      <p className="text-xs text-destructive truncate">{r.error}</p>
                    )}
                  </div>
                </div>
              ))}

              {/* Show pending files as loading */}
              {!batchDone && Array.from({ length: batchTotal - batchResults.length }).map((_, i) => (
                <div key={`pending-${i}`} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-sm opacity-50">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  <p className="text-muted-foreground">Pending...</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Single file review form ── */}
        {parsed && !batchMode && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Ask Joe extracted this data. Review and edit before saving:
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">First Name</Label>
                <Input value={parsed.first_name} onChange={(e) => update('first_name', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last Name</Label>
                <Input value={parsed.last_name} onChange={(e) => update('last_name', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input value={parsed.email} onChange={(e) => update('email', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={parsed.phone} onChange={(e) => update('phone', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Company</Label>
                <Input value={parsed.company} onChange={(e) => update('company', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input value={parsed.title} onChange={(e) => update('title', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Location</Label>
                <Input value={parsed.location} onChange={(e) => update('location', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">LinkedIn</Label>
                <Input value={parsed.linkedin_url} onChange={(e) => update('linkedin_url', e.target.value)} />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">Source: {parsed.file_name}</p>
          </div>
        )}

        {/* ── Single file footer ── */}
        {parsed && !batchMode && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setParsed(null)}>Re-upload</Button>
            <Button variant="gold" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save Candidate
            </Button>
          </DialogFooter>
        )}

        {/* ── Batch done footer ── */}
        {batchMode && batchDone && (
          <DialogFooter>
            <Button variant="gold" onClick={() => { reset(); onOpenChange(false); }}>
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
