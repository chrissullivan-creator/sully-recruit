import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { supabase } from '@/integrations/supabase/client';
import { classifyEmail } from '@/lib/email-classifier';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

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
  email?: string;
  phone?: string;
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
  project: HiringProject | null;
}

interface ImportResult {
  id: string;
  name: string;
  status: 'success' | 'skipped' | 'error';
  message?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function resolveUnipileInBackground(contactId: string, linkedinUrl: string) {
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
        const unipileClassicId = result.unipile_id || result.provider_id || null;
        if (unipileClassicId) {
          await supabase
            .from('contacts')
            .update({ unipile_classic_id: unipileClassicId } as any)
            .eq('id', contactId);
        }
      }
    }
  } catch (err) {
    console.warn('Background Unipile ID resolution failed:', err);
  }
}

/** Find or create a company by name, returns company_id */
async function resolveCompany(companyName: string): Promise<string | null> {
  if (!companyName?.trim()) return null;

  const trimmed = companyName.trim();

  // Check for existing company (case-insensitive)
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .ilike('name', trimmed)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return existing.id;

  // Create new company
  const { data: inserted, error } = await supabase
    .from('companies')
    .insert({
      name: trimmed,
      status: 'target',
    } as any)
    .select('id')
    .single();

  if (error) {
    console.warn(`Failed to create company "${trimmed}":`, error.message);
    return null;
  }

  return inserted?.id || null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function BulkAddContactsDialog({ open, onOpenChange, applicants, project }: Props) {
  const queryClient = useQueryClient();
  const [department, setDepartment] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportResult[]>([]);

  const reset = () => {
    setDepartment('');
    setImporting(false);
    setProgress(0);
    setResults([]);
  };

  const handleClose = (val: boolean) => {
    if (!val) reset();
    onOpenChange(val);
  };

  const handleImport = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error('Not authenticated'); return; }
    const userId = session.user.id;

    setImporting(true);
    setProgress(0);
    setResults([]);

    // Pre-resolve unique companies in batch to avoid repeated queries
    const companyNames = [...new Set(applicants.map(a => a.current_company).filter(Boolean))] as string[];
    const companyCache: Record<string, string | null> = {};
    for (const name of companyNames) {
      companyCache[name] = await resolveCompany(name);
    }

    const importResults: ImportResult[] = [];

    for (let i = 0; i < applicants.length; i++) {
      const applicant = applicants[i];
      const name = `${applicant.first_name} ${applicant.last_name}`.trim() || `Applicant ${i + 1}`;

      try {
        // Duplicate check by linkedin_url or email
        let existing: any = null;
        if (applicant.linkedin_url) {
          const { data } = await supabase
            .from('contacts')
            .select('id')
            .eq('linkedin_url', applicant.linkedin_url)
            .maybeSingle();
          existing = data;
        }
        if (!existing && applicant.email) {
          const { data } = await supabase
            .from('contacts')
            .select('id')
            .eq('email', applicant.email)
            .maybeSingle();
          existing = data;
        }

        if (existing) {
          importResults.push({ id: applicant.id, name, status: 'skipped', message: 'Already exists' });
          setProgress(i + 1);
          continue;
        }

        // Resolve company
        const companyName = applicant.current_company?.trim() || null;
        const companyId = companyName ? (companyCache[companyName] ?? await resolveCompany(companyName)) : null;

        // Insert contact
        const firstName = applicant.first_name || '';
        const lastName = applicant.last_name || '';
        const contactData = {
          first_name: firstName || null,
          last_name: lastName || null,
          full_name: `${firstName} ${lastName}`.trim() || null,
          email: applicant.email || null,
          // Classify — contacts are typically client-side (work email), but
          // if only a personal/.edu address is surfaced route it correctly.
          ...classifyEmail(applicant.email),
          phone: applicant.phone || null,
          mobile_phone: applicant.phone || null,
          title: applicant.current_title || applicant.headline || null,
          department: department.trim() || null,
          company_id: companyId,
          company_name: companyName,
          linkedin_url: applicant.linkedin_url || null,
          avatar_url: applicant.profile_picture_url || null,
          status: 'active',
          roles: ['client'],                    // LinkedIn hiring project imports = clients/contacts
          is_stub: false,
          owner_user_id: userId,                // FIX: was owner_id
        };

        const { data: inserted, error: insertErr } = await supabase
          .from('contacts')
          .insert(contactData as any)
          .select('id')
          .single();

        if (insertErr) throw insertErr;

        const contactId = inserted?.id;

        // Background: resolve Unipile ID
        if (contactId && contactData.linkedin_url) {
          resolveUnipileInBackground(contactId, contactData.linkedin_url);
        }

        // TODO: enrichment API call here — if email is missing,
        // call enrichment service to fill in email address and mobile numbers.
        // User will provide enrichment API details in a follow-up session.
        if (contactId && !contactData.email) {
          console.warn(`[Source] Enrichment not configured — missing email for ${name}`);
        }

        importResults.push({ id: applicant.id, name, status: 'success' });
      } catch (err: any) {
        importResults.push({ id: applicant.id, name, status: 'error', message: err.message });
      }

      setProgress(i + 1);
      setResults([...importResults]);

      // Small delay between imports
      if (i < applicants.length - 1) await new Promise(r => setTimeout(r, 300));
    }

    queryClient.invalidateQueries({ queryKey: ['contacts'] });
    queryClient.invalidateQueries({ queryKey: ['companies'] });

    const succeeded = importResults.filter(r => r.status === 'success').length;
    const skipped = importResults.filter(r => r.status === 'skipped').length;
    const failed = importResults.filter(r => r.status === 'error').length;

    if (succeeded > 0) toast.success(`${succeeded} contact${succeeded !== 1 ? 's' : ''} imported`);
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
          <DialogTitle>Import as Contacts</DialogTitle>
        </DialogHeader>

        {/* Department input */}
        {!importing && results.length === 0 && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Department</label>
            <Input
              placeholder="e.g. Engineering, Sales, HR…"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />

            {/* Preview */}
            <div className="text-sm text-muted-foreground mt-2">
              {applicants.length} applicant{applicants.length !== 1 ? 's' : ''} will be imported as contacts
            </div>

            {/* Company breakdown */}
            {(() => {
              const companies = [...new Set(applicants.map(a => a.current_company).filter(Boolean))];
              if (companies.length === 0) return null;
              return (
                <div className="text-xs text-muted-foreground">
                  Companies: {companies.slice(0, 5).join(', ')}
                  {companies.length > 5 && ` +${companies.length - 5} more`}
                </div>
              );
            })()}
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
              <Button variant="gold" onClick={handleImport} disabled={importing}>
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    Importing…
                  </>
                ) : (
                  `Import ${applicants.length} Contact${applicants.length !== 1 ? 's' : ''}`
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
