import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { supabase } from '@/integrations/supabase/client';
import { classifyEmail, normalizeEmail } from '@/lib/email-classifier';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Briefcase, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Applicant {
  id: string;
  first_name: string;
  last_name: string;
  headline?: string;
  current_title?: string;
  current_company?: string;
  location?: string;
  linkedin_url?: string;
  profile_picture_url?: string;
  has_resume?: boolean;
  [key: string]: any;
}

interface HiringProject {
  id: string;
  account_id: string;
  [key: string]: any;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicants: Applicant[];
  jobId: string;
  jobName: string;
  project: HiringProject | null;
}

type CandidateStatus = 'new' | 'reached_out' | 'back_of_resume' | 'placed';

interface ImportResult {
  id: string;
  name: string;
  status: 'success' | 'skipped' | 'error';
  message?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function callSourceApi(body: Record<string, any>, session: any) {
  const resp = await fetch('/api/source-projects', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);
  return data;
}

async function resolveUnipileInBackground(candidateId: string, linkedinUrl: string) {
  try {
    const match = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
    const slug = match ? match[1] : (/^[\w-]+$/.test(linkedinUrl.trim()) ? linkedinUrl.trim() : null);
    if (!slug) return;

    const { data: chrisAcct } = await supabase
      .from('integration_accounts')
      .select('unipile_account_id')
      .ilike('account_label', '%Chris Sullivan%')
      .eq('is_active', true)
      .maybeSingle();

    if (!chrisAcct?.unipile_account_id) return;

    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resolve-unipile-id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ linkedin_slug: slug, account_id: chrisAcct.unipile_account_id }),
      }
    );

    if (resp.ok) {
      const result = await resp.json();
      if (result.unipile_id || result.provider_id) {
        // Store Unipile classic ID directly on the candidate record (primary lookup)
        const unipileClassicId = result.unipile_id || result.provider_id || null;
        if (unipileClassicId) {
          await supabase
            .from('people')
            .update({ unipile_classic_id: unipileClassicId } as any)
            .eq('id', candidateId);
        }
      }
    }
  } catch (err) {
    console.warn('Background Unipile ID resolution failed:', err);
  }
}

async function triggerResumeIngestion(candidateId: string, filePath: string, fileName: string) {
  try {
    let { data: resume } = await supabase
      .from('resumes')
      .select('id')
      .eq('candidate_id', candidateId)
      .eq('file_path', filePath)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!resume) {
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

    if (!resume?.id) return;

    await fetch('/api/trigger-resume-ingestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: resume.id, candidateId, filePath, fileName }),
    });
  } catch (err) {
    console.warn('Background resume ingestion trigger failed:', err);
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function BulkAddCandidatesDialog({ open, onOpenChange, applicants, jobId, jobName, project }: Props) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CandidateStatus>('new');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportResult[]>([]);

  const reset = () => {
    setStatus('new');
    setImporting(false);
    setProgress(0);
    setResults([]);
  };

  const handleClose = (val: boolean) => {
    if (!val) reset();
    onOpenChange(val);
  };

  const handleImport = async () => {
    if (!jobId) { toast.error('No job selected'); return; }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error('Not authenticated'); return; }
    const userId = session.user.id;

    setImporting(true);
    setProgress(0);
    setResults([]);

    const importResults: ImportResult[] = [];

    for (let i = 0; i < applicants.length; i++) {
      const applicant = applicants[i];
      const name = `${applicant.first_name} ${applicant.last_name}`.trim() || `Applicant ${i + 1}`;

      try {
        // Duplicate check by linkedin_url
        let existing: any = null;
        if (applicant.linkedin_url) {
          const { data } = await supabase
            .from('people')
            .select('id')
            .eq('linkedin_url', applicant.linkedin_url)
            .maybeSingle();
          existing = data;
        }
        if (!existing && applicant.email) {
          // Plain people.email retired — match across all three address columns.
          const e = String(applicant.email).toLowerCase();
          const { data } = await supabase
            .from('people')
            .select('id')
            .or(`personal_email.ilike.${e},work_email.ilike.${e},primary_email.ilike.${e}`)
            .limit(1)
            .maybeSingle();
          existing = data;
        }

        if (existing) {
          importResults.push({ id: applicant.id, name, status: 'skipped', message: 'Already exists' });
          setProgress(i + 1);
          continue;
        }

        // Try to download and parse resume — attempt even if has_resume is false
        let parsedData: any = {};
        let resumeFilePath: string | null = null;
        let resumeFileName: string | null = null;
        let resumeImported = false;

        if (project) {
          try {
            const resumeData = await callSourceApi({
              action: 'download_resume',
              account_id: project.account_id,
              job_id: project.id,
              applicant_id: applicant.id,
            }, session);

            if (resumeData?.data_base64) {
              // Upload to Supabase Storage
              const contentType = resumeData.content_type || 'application/pdf';
              const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('docx') ? 'docx' : 'pdf';
              resumeFileName = `${applicant.first_name}_${applicant.last_name}_resume.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
              const storagePath = `${session.user.id}/${Date.now()}_${resumeFileName}`;

              const binaryData = Uint8Array.from(atob(resumeData.data_base64), c => c.charCodeAt(0));
              const { data: uploadResult, error: uploadErr } = await supabase.storage
                .from('resumes')
                .upload(storagePath, binaryData, { contentType, upsert: false });

              if (!uploadErr && uploadResult) {
                resumeFilePath = uploadResult.path;
                resumeImported = true;

                // Parse the resume
                const parseResp = await fetch('/api/parse-resume', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ filePath: resumeFilePath, fileName: resumeFileName }),
                });

                if (parseResp.ok) {
                  const parseResult = await parseResp.json();
                  parsedData = parseResult.parsed || {};
                }
              }
            }
          } catch (resumeErr: any) {
            // 404 = no resume available, not an error worth logging loudly
            if (!resumeErr?.message?.includes('404')) {
              console.warn(`Resume download/parse failed for ${name}:`, resumeErr);
            }
          }
        }

        // Merge: parsed resume data wins for email/phone, LinkedIn profile wins for title/company
        // parsedData.email = email found IN the resume = candidate's personal email
        // applicant.email from LinkedIn profile = also personal/direct email
        const resolvedEmail = normalizeEmail(parsedData.email || applicant.email);
        const resolvedPhone = parsedData.phone || applicant.phone || null;

        const candidateData = {
          first_name: applicant.first_name || parsedData.first_name || null,
          last_name: applicant.last_name || parsedData.last_name || null,
          full_name: `${applicant.first_name || parsedData.first_name || ''} ${applicant.last_name || parsedData.last_name || ''}`.trim() || null,
          // Route via classifier — LinkedIn/resume usually surfaces a personal
          // address, but corporate or .edu go to the right field (see
          // email-classifier rules). Plain `email` column was retired.
          ...classifyEmail(resolvedEmail),
          phone: resolvedPhone,
          mobile_phone: resolvedPhone,         // phone from LinkedIn/resume = mobile
          current_title: applicant.current_title || parsedData.current_title || null,
          current_company: applicant.current_company || parsedData.current_company || null,
          location_text: applicant.location || parsedData.location || null,
          linkedin_url: applicant.linkedin_url || parsedData.linkedin_url || null,
          avatar_url: applicant.profile_picture_url || null,
          status,
          roles: ['candidate'],                // always a candidate from Source import
          is_stub: false,                      // real person — not a stub
          source: 'linkedin_hiring_project',
          source_detail: project?.id ?? null,
          job_id: jobId,
          owner_user_id: userId,               // FIX: was owner_id (column doesn't exist)
        };

        const { data: inserted, error: insertErr } = await supabase
          .from('people')
          .insert(candidateData as any)
          .select('id')
          .single();

        if (insertErr) throw insertErr;

        const candidateId = inserted?.id;

        // Background tasks (non-blocking)
        if (candidateId && candidateData.linkedin_url) {
          resolveUnipileInBackground(candidateId, candidateData.linkedin_url);
        }
        if (candidateId && resumeFilePath && resumeFileName) {
          triggerResumeIngestion(candidateId, resumeFilePath, resumeFileName);
        }

        // TODO: enrichment API call here — if email or phone is missing,
        // call enrichment service to fill in contact information.
        // User will provide enrichment API details in a follow-up session.
        if (candidateId && (!candidateData.email || !candidateData.phone)) {
          console.warn(`[Source] Enrichment not configured — missing email/phone for ${name}`);
        }

        importResults.push({
          id: applicant.id,
          name,
          status: 'success',
          message: resumeImported ? 'with resume' : undefined,
        });
      } catch (err: any) {
        importResults.push({ id: applicant.id, name, status: 'error', message: err.message });
      }

      setProgress(i + 1);
      setResults([...importResults]);

      // Small delay between imports to avoid rate limiting
      if (i < applicants.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    queryClient.invalidateQueries({ queryKey: ['candidates'] });

    const succeeded = importResults.filter(r => r.status === 'success').length;
    const skipped = importResults.filter(r => r.status === 'skipped').length;
    const failed = importResults.filter(r => r.status === 'error').length;

    if (succeeded > 0) toast.success(`${succeeded} candidate${succeeded !== 1 ? 's' : ''} imported`);
    if (skipped > 0) toast.info(`${skipped} skipped (duplicates)`);
    if (failed > 0) toast.error(`${failed} failed`);

    setImporting(false);
  };

  const succeeded = results.filter(r => r.status === 'success').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const failed = results.filter(r => r.status === 'error').length;
  const isDone = !importing && results.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import as Candidates</DialogTitle>
        </DialogHeader>

        {/* Job display */}
        <div className="flex items-center gap-2 text-sm">
          <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Tagged to:</span>
          <span className="font-medium">{jobName || 'No job selected'}</span>
        </div>

        {/* Status selector */}
        {!importing && results.length === 0 && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Candidate Status</label>
            <Select value={status} onValueChange={(val) => setStatus(val as CandidateStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="reached_out">Reached Out</SelectItem>
                <SelectItem value="back_of_resume">Back of Resume</SelectItem>
                <SelectItem value="placed">Placed</SelectItem>
              </SelectContent>
            </Select>

            {/* Preview */}
            <div className="text-sm text-muted-foreground mt-2">
              {applicants.length} applicant{applicants.length !== 1 ? 's' : ''} will be imported
              {applicants.filter(a => a.has_resume).length > 0 && (
                <span> ({applicants.filter(a => a.has_resume).length} with resumes)</span>
              )}
            </div>
          </div>
        )}

        {/* Progress */}
        {(importing || results.length > 0) && (
          <div className="space-y-3">
            <Progress value={(progress / applicants.length) * 100} />
            <div className="text-xs text-muted-foreground text-center">
              {progress} / {applicants.length} processed
            </div>

            {/* Results list */}
            <div className="max-h-48 overflow-y-auto space-y-1">
              {results.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-sm">
                  {r.status === 'success' && <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                  {r.status === 'skipped' && <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />}
                  {r.status === 'error' && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                  <span className="truncate">{r.name}</span>
                  {r.message && <span className="text-xs text-muted-foreground ml-auto shrink-0">{r.message}</span>}
                </div>
              ))}
            </div>

            {isDone && (
              <div className="text-sm text-center pt-2">
                {succeeded > 0 && <Badge className="bg-green-500/10 text-green-400 mr-1">{succeeded} imported</Badge>}
                {skipped > 0 && <Badge className="bg-yellow-500/10 text-yellow-400 mr-1">{skipped} skipped</Badge>}
                {failed > 0 && <Badge className="bg-red-500/10 text-red-400">{failed} failed</Badge>}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {isDone ? (
            <Button onClick={() => handleClose(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleClose(false)} disabled={importing}>
                Cancel
              </Button>
              <Button variant="gold" onClick={handleImport} disabled={importing || !jobId}>
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    Importing…
                  </>
                ) : (
                  `Import ${applicants.length} Candidate${applicants.length !== 1 ? 's' : ''}`
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
